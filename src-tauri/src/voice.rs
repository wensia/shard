//! Account-independent, device-local speech configuration and cancellable jobs.
//! Secrets never enter the vault, localStorage, logs, or returned settings.
use crate::voice_recording::{self, RecordingStatus, Stop};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::{multipart, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;

const CANCELLED: &str = "语音操作已取消。";
const MAX_RESPONSE: usize = 24 * 1024 * 1024;
/// Longer than a full recording plus transcription retries, and than one
/// playback segment; only abandoned sessions stay untouched this long.
const SESSION_IDLE: Duration = Duration::from_secs(10 * 60);
static CONFIG_GATE: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Mimo,
    Openai,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSettings {
    mode: Mode,
    base_url: String,
    transcription_model: String,
    speech_model: String,
    voice: String,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            mode: Mode::Mimo,
            base_url: "https://api.xiaomimimo.com/v1".into(),
            transcription_model: "mimo-v2.5-asr".into(),
            speech_model: "mimo-v2.5-tts".into(),
            voice: "冰糖".into(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    #[serde(flatten)]
    settings: VoiceSettings,
    has_key: bool,
}

struct Credentials {
    settings: VoiceSettings,
    key: String,
}

struct Session {
    /// Label of the webview that started this interaction. A reload of that
    /// page can no longer finish or cancel it, so the backend does.
    owner: String,
    cancel: CancellationToken,
    credentials: Arc<Credentials>,
    recording: Option<watch::Receiver<RecordingStatus>>,
    stop: Option<mpsc::Sender<Stop>>,
    busy: AtomicBool,
    last_used: Mutex<Instant>,
}

impl Session {
    fn new(
        owner: &str,
        credentials: Arc<Credentials>,
        recording: Option<watch::Receiver<RecordingStatus>>,
        stop: Option<mpsc::Sender<Stop>>,
    ) -> Self {
        Self {
            owner: owner.into(),
            cancel: CancellationToken::new(),
            credentials,
            recording,
            stop,
            busy: AtomicBool::new(false),
            last_used: Mutex::new(Instant::now()),
        }
    }

    fn touch(&self) {
        if let Ok(mut last_used) = self.last_used.lock() {
            *last_used = Instant::now();
        }
    }

    fn idle(&self, now: Instant) -> bool {
        !self.busy.load(Ordering::SeqCst)
            && self
                .last_used
                .lock()
                .map(|last_used| now.saturating_duration_since(*last_used) >= SESSION_IDLE)
                .unwrap_or(true)
    }

    /// Aborts in-flight requests and releases the microphone.
    fn shut_down(&self) {
        self.cancel.cancel();
        if let Some(stop) = &self.stop {
            let _ = stop.send(Stop::Cancel);
        }
    }
}

#[derive(Default)]
struct Sessions {
    active: HashMap<String, Arc<Session>>,
    // Reject late commands belonging to a cancelled interaction.
    cancelled: VecDeque<String>,
}

impl Sessions {
    fn tombstone(&mut self, id: String) {
        if !self.cancelled.contains(&id) {
            self.cancelled.push_back(id);
        }
        while self.cancelled.len() > 128 {
            self.cancelled.pop_front();
        }
    }

    /// Sessions nobody has used for a while belong to a page that went away
    /// without cancelling. They are not tombstoned: a live reader resuming a
    /// long pause simply starts a fresh synthesis session under the same id.
    fn evict_idle(&mut self, now: Instant) {
        self.active.retain(|_, session| {
            let idle = session.idle(now);
            if idle {
                session.shut_down();
            }
            !idle
        });
    }
}

#[derive(Clone, Default)]
pub struct VoiceRuntime {
    sessions: Arc<Mutex<Sessions>>,
    recording_active: Arc<AtomicBool>,
}

struct BusyGuard(Arc<Session>);
impl BusyGuard {
    fn acquire(session: &Arc<Session>) -> Result<Self, String> {
        session
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "此语音操作正在处理中。".to_string())?;
        Ok(Self(session.clone()))
    }
}
impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::SeqCst);
    }
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|_| "无法打开本机设置目录。")?
        .join("voice-settings.json"))
}

fn normalize_settings(mut settings: VoiceSettings) -> Result<VoiceSettings, String> {
    let mut url = Url::parse(settings.base_url.trim()).map_err(|_| "API 地址无效。")?;
    let loopback = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err("API 地址需使用 HTTPS；本机服务可使用 HTTP。".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("API 地址不能包含账号、密码、查询参数或锚点。".into());
    }
    let path = url.path().trim_end_matches('/').to_string();
    if [
        "/chat/completions",
        "/audio/speech",
        "/audio/transcriptions",
    ]
    .iter()
    .any(|suffix| path.ends_with(suffix))
    {
        return Err("请填写 API 基础地址，例如 https://api.xiaomimimo.com/v1。".into());
    }
    url.set_path(&path);
    settings.base_url = url.as_str().trim_end_matches('/').to_string();
    for value in [
        &mut settings.transcription_model,
        &mut settings.speech_model,
        &mut settings.voice,
    ] {
        *value = value.trim().to_string();
        if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
            return Err("请填写有效的语音模型和音色。".into());
        }
    }
    Ok(settings)
}

fn read_settings(path: &Path) -> Result<VoiceSettings, String> {
    match fs::read(path) {
        Ok(bytes) => normalize_settings(
            serde_json::from_slice(&bytes).map_err(|_| "语音设置无法读取，请重新配置。")?,
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(VoiceSettings::default()),
        Err(_) => Err("无法读取语音设置。".into()),
    }
}

fn key_entry(settings: &VoiceSettings) -> Result<keyring::Entry, String> {
    let account = format!(
        "endpoint-{:x}",
        Sha256::digest(settings.base_url.as_bytes())
    );
    keyring::Entry::new("dev.shard.desktop.voice", &account)
        .map_err(|_| "无法访问系统钥匙串。".into())
}

fn read_key(entry: &keyring::Entry) -> Result<Option<String>, String> {
    match entry.get_password() {
        Ok(key) if !key.is_empty() => Ok(Some(key)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取系统钥匙串，请解锁或允许 Shard 访问。".into()),
    }
}

fn write_key(entry: &keyring::Entry, key: Option<&str>) -> Result<(), String> {
    match key {
        Some(key) => entry
            .set_password(key)
            .map_err(|_| "无法保存 API Key 到系统钥匙串。".into()),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("无法删除系统钥匙串中的 API Key。".into()),
        },
    }
}

async fn credentials(app: tauri::AppHandle) -> Result<Arc<Credentials>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = CONFIG_GATE.lock().map_err(|_| "语音设置暂不可用。")?;
        let settings = read_settings(&config_path(&app)?)?;
        let key = read_key(&key_entry(&settings)?)?.ok_or("请先配置语音 API Key。")?;
        Ok(Arc::new(Credentials { settings, key }))
    })
    .await
    .map_err(|_| "读取语音设置失败。".to_string())?
}

#[tauri::command]
pub async fn voice_get_settings(app: tauri::AppHandle) -> Result<SettingsView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = CONFIG_GATE.lock().map_err(|_| "语音设置暂不可用。")?;
        let settings = read_settings(&config_path(&app)?)?;
        let has_key = read_key(&key_entry(&settings)?)?.is_some();
        Ok(SettingsView { settings, has_key })
    })
    .await
    .map_err(|_| "读取语音设置失败。".to_string())?
}

#[tauri::command]
pub async fn voice_save_settings(
    app: tauri::AppHandle,
    settings: VoiceSettings,
    api_key: Option<String>,
) -> Result<SettingsView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = CONFIG_GATE.lock().map_err(|_| "语音设置暂不可用。")?;
        let settings = normalize_settings(settings)?;
        let path = config_path(&app)?;
        let entry = key_entry(&settings)?;
        let previous_key = read_key(&entry)?;
        let updated_key = api_key.as_ref().map(|key| key.trim());
        if let Some(key) = updated_key {
            if key.len() > 4096 || reqwest::header::HeaderValue::from_str(key).is_err() {
                return Err("API Key 格式无效。".into());
            }
        }
        // Stage the file before changing the key. If atomic replacement fails,
        // restore the previous credential and report rollback failure explicitly.
        let staged = path.with_extension("pending.json");
        let bytes = serde_json::to_vec_pretty(&settings).map_err(|_| "无法保存语音设置。")?;
        shard_core::write_bytes_atomically(&staged, &bytes).map_err(|_| "无法写入语音设置。")?;
        if let Some(key) = updated_key {
            if let Err(error) = write_key(&entry, (!key.is_empty()).then_some(key)) {
                let _ = fs::remove_file(&staged);
                return Err(error);
            }
        }
        if fs::rename(&staged, &path).is_err() {
            let _ = fs::remove_file(&staged);
            if updated_key.is_some() && write_key(&entry, previous_key.as_deref()).is_err() {
                return Err("设置文件保存失败，API Key 回滚也失败；请重新设置 API Key。".into());
            }
            return Err("语音设置保存失败，原设置已保留。".into());
        }
        let has_key = match updated_key {
            Some(key) => !key.is_empty(),
            None => previous_key.is_some(),
        };
        Ok(SettingsView { settings, has_key })
    })
    .await
    .map_err(|_| "保存语音设置失败。".to_string())?
}

fn validate_session_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("语音会话无效。".into());
    }
    Ok(())
}

impl VoiceRuntime {
    fn insert(&self, id: &str, session: Arc<Session>) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|_| "语音服务暂不可用。")?;
        if sessions.cancelled.iter().any(|value| value == id) {
            return Err(CANCELLED.into());
        }
        if sessions.active.contains_key(id) {
            return Err("语音会话已存在。".into());
        }
        sessions.evict_idle(Instant::now());
        if sessions.active.len() >= 8 {
            return Err("请先结束当前语音操作。".into());
        }
        sessions.active.insert(id.into(), session);
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Option<Arc<Session>>, String> {
        let sessions = self.sessions.lock().map_err(|_| "语音服务暂不可用。")?;
        if sessions.cancelled.iter().any(|value| value == id) {
            return Err(CANCELLED.into());
        }
        let session = sessions.active.get(id).cloned();
        if let Some(session) = &session {
            session.touch();
        }
        Ok(session)
    }

    /// A completed transcription frees its recording at once instead of
    /// waiting for the frontend's cleanup call.
    fn finish(&self, id: &str, session: &Arc<Session>) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if sessions
                .active
                .get(id)
                .is_some_and(|current| Arc::ptr_eq(current, session))
            {
                sessions.active.remove(id);
            }
        }
    }

    fn cancel(&self, id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|_| "语音服务暂不可用。")?;
        if let Some(session) = sessions.active.remove(id) {
            session.shut_down();
        }
        sessions.tombstone(id.into());
        Ok(())
    }

    /// Called when a webview starts loading a page or its window closes: the
    /// previous page can no longer stop its microphone or playback requests.
    pub fn cancel_owner(&self, owner: &str) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let ids: Vec<String> = sessions
            .active
            .iter()
            .filter(|(_, session)| session.owner == owner)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(session) = sessions.active.remove(&id) {
                session.shut_down();
            }
            sessions.tombstone(id);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoppedEvent {
    session_id: String,
    reason: String,
    error: Option<String>,
}

#[tauri::command]
pub async fn voice_start_recording(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    runtime: tauri::State<'_, VoiceRuntime>,
    session_id: String,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let credentials = credentials(app.clone()).await?;
    runtime
        .recording_active
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "另一个录音尚未结束。")?;
    let (stop_tx, stop_rx) = mpsc::channel();
    let (status_tx, status_rx) = watch::channel(RecordingStatus::Starting);
    let session = Arc::new(Session::new(
        webview.label(),
        credentials,
        Some(status_rx),
        Some(stop_tx),
    ));
    if let Err(error) = runtime.insert(&session_id, session.clone()) {
        runtime.recording_active.store(false, Ordering::SeqCst);
        return Err(error);
    }
    let (ready_tx, ready_rx) = oneshot::channel();
    let active = runtime.recording_active.clone();
    let event_id = session_id.clone();
    let stopped = move |reason: &str, error: Option<String>| {
        let _ = app.emit(
            "voice-recording-stopped",
            StoppedEvent {
                session_id: event_id.clone(),
                reason: reason.into(),
                error,
            },
        );
    };
    // The guard is captured by the worker closure, not tied to the frontend
    // command future: cancellation during a permission prompt cannot open a
    // second microphone until the first native stream has actually shut down.
    let active_guard = RecordingActiveGuard(active);
    let result = voice_recording::spawn(stop_rx, status_tx, ready_tx, move |reason, error| {
        let _keep_alive = &active_guard;
        stopped(reason, error);
    });
    if let Err(error) = result {
        runtime
            .sessions
            .lock()
            .map_err(|_| "语音服务暂不可用。")?
            .active
            .remove(&session_id);
        return Err(error);
    }
    tokio::select! {
        _ = session.cancel.cancelled() => Err(CANCELLED.into()),
        result = ready_rx => result.map_err(|_| "录音线程意外停止。".to_string())?,
    }
}

struct RecordingActiveGuard(Arc<AtomicBool>);
impl Drop for RecordingActiveGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

async fn stopped_audio(session: &Session) -> Result<Arc<Vec<u8>>, String> {
    let mut state = session.recording.clone().ok_or("没有可识别的录音。")?;
    if let Some(stop) = &session.stop {
        let _ = stop.send(Stop::Finish);
    }
    loop {
        let value = state.borrow().clone();
        match value {
            RecordingStatus::Ready(wav) => return Ok(wav),
            RecordingStatus::Failed(error) => return Err(error),
            RecordingStatus::Cancelled => return Err(CANCELLED.into()),
            _ => {}
        }
        tokio::select! {
            _ = session.cancel.cancelled() => return Err(CANCELLED.into()),
            result = state.changed() => result.map_err(|_| "录音线程已停止。")?,
        }
    }
}

fn client() -> Result<Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(90))
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .build()
                .map_err(|_| "无法初始化语音网络服务。".into())
        })
        .clone()
}

fn transcription_request(
    creds: &Credentials,
    audio: &[u8],
) -> Result<reqwest::RequestBuilder, String> {
    let client = client()?;
    let settings = &creds.settings;
    Ok(match settings.mode {
        Mode::Mimo => client
            .post(format!("{}/chat/completions", settings.base_url))
            .bearer_auth(&creds.key)
            .json(&mimo_transcription_body(settings, audio)),
        Mode::Openai => client
            .post(format!("{}/audio/transcriptions", settings.base_url))
            .bearer_auth(&creds.key)
            .multipart(
                multipart::Form::new()
                    .text("model", settings.transcription_model.clone())
                    .text("response_format", "json")
                    .part(
                        "file",
                        multipart::Part::bytes(audio.to_vec())
                            .file_name("recording.wav")
                            .mime_str("audio/wav")
                            .map_err(|_| "无法打包录音。")?,
                    ),
            ),
    })
}

fn mimo_transcription_body(settings: &VoiceSettings, audio: &[u8]) -> Value {
    json!({"model": settings.transcription_model, "stream": false,
        "messages": [{"role":"user", "content":[{"type":"input_audio", "input_audio":{"data":format!("data:audio/wav;base64,{}", BASE64.encode(audio))}}]}],
        "asr_options":{"language":"auto"}})
}

fn speech_body(settings: &VoiceSettings, text: &str) -> Value {
    match settings.mode {
        Mode::Mimo => json!({"model": settings.speech_model, "stream":false,
            "messages":[{"role":"assistant","content":text}], "audio":{"format":"wav","voice":settings.voice}}),
        Mode::Openai => {
            json!({"model":settings.speech_model,"input":text,"voice":settings.voice,"response_format":"wav"})
        }
    }
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "语音请求超时，请重试。".into()
    } else if error.is_connect() {
        "无法连接语音服务，请检查 API 地址和网络。".into()
    } else {
        "语音请求失败，请检查网络后重试。".into()
    }
}

async fn response_bytes(request: reqwest::RequestBuilder) -> Result<Vec<u8>, String> {
    let mut response = request.send().await.map_err(network_error)?;
    let status = response.status();
    if !status.is_success() {
        // Do not echo upstream messages: some proxies include request bodies,
        // headers, or document text in error responses.
        let guidance = match status.as_u16() {
            401 | 403 => "请检查 API Key 和模型权限。",
            404 => "请检查 API 基础地址和模型名称。",
            413 => "录音或文本过长，请缩短后重试。",
            429 => "请求过于频繁或额度不足，请稍后重试。",
            400 | 422 => "请求参数不受支持，请检查接口模式、模型和音色。",
            _ => "请稍后重试。",
        };
        let code = tokio::time::timeout(Duration::from_secs(2), async {
            let mut body = Vec::new();
            while let Ok(Some(chunk)) = response.chunk().await {
                if body.len() + chunk.len() > 8192 {
                    return None;
                }
                body.extend_from_slice(&chunk);
            }
            safe_error_code(&body)
        })
        .await
        .ok()
        .flatten();
        let code = code.map(|value| format!("（{value}）")).unwrap_or_default();
        return Err(format!(
            "语音服务返回 HTTP {}{code}。{guidance}",
            status.as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE as u64)
    {
        return Err("语音响应过大，请缩短文本后重试。".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("语音响应过大，请缩短文本后重试。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn safe_error_code(body: &[u8]) -> Option<String> {
    let body: Value = serde_json::from_slice(body).ok()?;
    let code = body
        .pointer("/error/code")
        .or_else(|| body.pointer("/error/type"))?
        .as_str()?;
    // Only known machine codes can leave the backend; arbitrary upstream fields
    // may contain the submitted credential or document text.
    [
        "invalid_api_key",
        "authentication_error",
        "invalid_request_error",
        "model_not_found",
        "insufficient_quota",
        "rate_limit_exceeded",
        "permission_denied",
        "invalid_model",
        "invalid_voice",
        "invalid_parameter",
        "content_filter",
        "server_error",
    ]
    .contains(&code)
    .then(|| code.to_string())
}

fn transcription_text(mode: &Mode, bytes: &[u8]) -> Result<String, String> {
    let body: Value = serde_json::from_slice(bytes).map_err(|_| "语音服务返回了无效响应。")?;
    let text = match mode {
        Mode::Mimo => body.pointer("/choices/0/message/content"),
        Mode::Openai => body.get("text"),
    }
    .and_then(Value::as_str)
    .unwrap_or("")
    .trim();
    if text.is_empty() {
        return Err("没有识别到文字，可以重试或重新录音。".into());
    }
    Ok(text.to_string())
}

#[derive(Serialize)]
pub struct Transcription {
    text: String,
}

#[tauri::command]
pub async fn voice_transcribe(
    runtime: tauri::State<'_, VoiceRuntime>,
    session_id: String,
) -> Result<Transcription, String> {
    validate_session_id(&session_id)?;
    let session = runtime
        .get(&session_id)?
        .ok_or("录音已结束，请重新录音。")?;
    let result = transcribe_session(session.clone()).await;
    // Failures keep the recording so the user can retry without re-recording.
    if result.is_ok() {
        runtime.finish(&session_id, &session);
    }
    result
}

async fn transcribe_session(session: Arc<Session>) -> Result<Transcription, String> {
    let _busy = BusyGuard::acquire(&session)?;
    let audio = stopped_audio(&session).await?;
    let creds = session.credentials.clone();
    let work = async move {
        let request =
            tauri::async_runtime::spawn_blocking(move || transcription_request(&creds, &audio))
                .await
                .map_err(|_| "无法准备语音请求。")??;
        let bytes = response_bytes(request).await?;
        let mode = session.credentials.settings.mode.clone();
        tauri::async_runtime::spawn_blocking(move || transcription_text(&mode, &bytes))
            .await
            .map_err(|_| "无法解析语音结果。")?
    };
    let cancel = _busy.0.cancel.clone();
    tokio::select! { biased;
        _ = cancel.cancelled() => Err(CANCELLED.into()),
        result = work => result.map(|text| Transcription { text }),
    }
}

fn parse_speech(mode: &Mode, bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let bytes = if *mode == Mode::Mimo {
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| "语音合成返回了无效响应。")?;
        let audio = body
            .pointer("/choices/0/message/audio/data")
            .and_then(Value::as_str)
            .ok_or("语音服务没有返回音频。")?;
        BASE64
            .decode(audio)
            .map_err(|_| "语音服务返回了无效音频。")?
    } else {
        bytes
    };
    // Both API modes explicitly request WAV; avoid treating JSON or arbitrary
    // content as playable media, even when a proxy responds with HTTP 200.
    if bytes.len() < 44 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("语音服务没有返回有效的 WAV 音频。".into());
    }
    Ok(bytes)
}

/// Returns the WAV bytes as a raw IPC payload (an `ArrayBuffer` in the
/// webview), so audio is never re-encoded as base64 or parsed as JSON.
#[tauri::command]
pub async fn voice_synthesize(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    runtime: tauri::State<'_, VoiceRuntime>,
    session_id: String,
    text: String,
) -> Result<tauri::ipc::Response, String> {
    validate_session_id(&session_id)?;
    let text = text.trim().to_string();
    if text.is_empty() || text.chars().count() > 1500 {
        return Err("每段朗读内容应为 1–1500 字。".into());
    }
    let session = match runtime.get(&session_id)? {
        Some(session) => session,
        None => {
            let session = Arc::new(Session::new(
                webview.label(),
                credentials(app).await?,
                None,
                None,
            ));
            runtime.insert(&session_id, session.clone())?;
            session
        }
    };
    let _busy = BusyGuard::acquire(&session)?;
    let creds = session.credentials.clone();
    let work = async move {
        let mode = creds.settings.mode.clone();
        let request = tauri::async_runtime::spawn_blocking(move || {
            let settings = &creds.settings;
            let endpoint = if settings.mode == Mode::Mimo {
                "chat/completions"
            } else {
                "audio/speech"
            };
            Ok::<_, String>(
                client()?
                    .post(format!("{}/{endpoint}", settings.base_url))
                    .bearer_auth(&creds.key)
                    .json(&speech_body(settings, &text)),
            )
        })
        .await
        .map_err(|_| "无法准备语音请求。")??;
        let bytes = response_bytes(request).await?;
        tauri::async_runtime::spawn_blocking(move || parse_speech(&mode, bytes))
            .await
            .map_err(|_| "无法解析语音结果。")?
    };
    tokio::select! { biased;
        _ = session.cancel.cancelled() => Err(CANCELLED.into()),
        result = work => result.map(tauri::ipc::Response::new),
    }
}

#[tauri::command]
pub async fn voice_cancel(
    runtime: tauri::State<'_, VoiceRuntime>,
    session_id: String,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    runtime.cancel(&session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn http_fixture(
        responses: Vec<(u16, &'static str)>,
    ) -> (String, std::thread::JoinHandle<Vec<Vec<u8>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let size = stream.read(&mut buffer).unwrap();
                    if size == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..size]);
                    if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(request);
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        (url, worker)
    }

    fn recorded_session(mode: Mode, url: String) -> Arc<Session> {
        let settings = VoiceSettings {
            mode,
            base_url: url,
            ..VoiceSettings::default()
        };
        let wav = voice_recording::encode_wav(&[0.25; 3200], 16_000).unwrap();
        let (_, recording) = watch::channel(RecordingStatus::Ready(Arc::new(wav)));
        Arc::new(Session::new(
            "main",
            fixture_credentials(settings),
            Some(recording),
            None,
        ))
    }

    fn fixture_credentials(settings: VoiceSettings) -> Arc<Credentials> {
        Arc::new(Credentials {
            settings,
            key: "fixture-key".into(),
        })
    }

    /// A live recording session whose microphone thread is represented by the
    /// returned receiver.
    fn microphone_session(owner: &str) -> (Arc<Session>, mpsc::Receiver<Stop>) {
        let (stop, stopped) = mpsc::channel();
        let (_, recording) = watch::channel(RecordingStatus::Recording);
        let session = Session::new(
            owner,
            fixture_credentials(VoiceSettings::default()),
            Some(recording),
            Some(stop),
        );
        (Arc::new(session), stopped)
    }

    fn age(session: &Session) {
        *session.last_used.lock().unwrap() = Instant::now()
            .checked_sub(SESSION_IDLE + Duration::from_secs(1))
            .unwrap();
    }

    #[tokio::test]
    async fn failed_transcription_retries_same_recording_and_uses_openai_multipart() {
        let (url, server) = http_fixture(vec![
            (500, r#"{"error":{"code":"server_error"}}"#),
            (200, r#"{"text":"recovered"}"#),
        ]);
        let session = recorded_session(Mode::Openai, url);
        assert!(transcribe_session(session.clone())
            .await
            .err()
            .unwrap()
            .contains("HTTP 500"));
        assert_eq!(transcribe_session(session).await.unwrap().text, "recovered");
        let requests = server.join().unwrap();
        for request in requests {
            let body = String::from_utf8_lossy(&request);
            assert!(body.starts_with("POST /v1/audio/transcriptions HTTP/1.1"));
            assert!(body.contains("authorization: Bearer fixture-key"));
            assert!(body.contains("multipart/form-data; boundary="));
            assert!(body.contains("name=\"model\""));
            assert!(body.contains("filename=\"recording.wav\""));
            assert!(body.contains("audio/wav"));
            assert!(body.contains("RIFF"));
        }
    }

    #[tokio::test]
    async fn mimo_request_and_http_error_redaction() {
        let (url, server) = http_fixture(vec![(
            401,
            r#"{"error":{"code":"invalid_api_key","message":"fixture-key PRIVATE DOCUMENT"}}"#,
        )]);
        let error = transcribe_session(recorded_session(Mode::Mimo, url))
            .await
            .err()
            .unwrap();
        assert!(error.contains("HTTP 401"));
        assert!(error.contains("invalid_api_key"));
        assert!(!error.contains("fixture-key"));
        assert!(!error.contains("PRIVATE DOCUMENT"));
        let requests = server.join().unwrap();
        let request = String::from_utf8_lossy(&requests[0]);
        assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
        assert!(request.contains("data:audio/wav;base64,"));
    }

    #[tokio::test]
    async fn cancellation_before_transcription_does_not_start_network_request() {
        let session = recorded_session(Mode::Mimo, "http://127.0.0.1:1/v1".into());
        session.cancel.cancel();
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            transcribe_session(session.clone()),
        )
        .await
        .unwrap();
        assert_eq!(result.err().unwrap(), CANCELLED);
        assert!(!session.busy.load(Ordering::SeqCst));
    }
    #[test]
    fn settings_normalize_without_credentials_or_query() {
        let mut settings = VoiceSettings::default();
        settings.base_url = " https://api.xiaomimimo.com/v1/// ".into();
        assert_eq!(
            normalize_settings(settings.clone()).unwrap().base_url,
            "https://api.xiaomimimo.com/v1"
        );
        for url in [
            "https://key@example.com/v1",
            "https://example.com/v1?key=secret",
            "http://example.com/v1",
            "https://example.com/v1/chat/completions",
        ] {
            settings.base_url = url.into();
            assert!(normalize_settings(settings.clone()).is_err());
        }
        settings.base_url = "http://127.0.0.1:8080/v1".into();
        assert!(normalize_settings(settings).is_ok());
    }
    #[test]
    fn mimo_audio_contract_uses_input_audio_and_assistant_tts() {
        let settings = VoiceSettings::default();
        let body = mimo_transcription_body(&settings, b"wav");
        assert_eq!(
            body["messages"][0]["content"][0]["input_audio"]["data"],
            "data:audio/wav;base64,d2F2"
        );
        assert_eq!(body["asr_options"]["language"], "auto");
        let body = speech_body(&settings, "测试");
        assert_eq!(body["messages"][0]["role"], "assistant");
        assert_eq!(body["messages"][0]["content"], "测试");
        assert_eq!(body["audio"]["voice"], "冰糖");
    }
    #[test]
    fn openai_speech_contract_and_both_transcription_responses() {
        let mut settings = VoiceSettings::default();
        settings.mode = Mode::Openai;
        let body = speech_body(&settings, "hello");
        assert_eq!(body["input"], "hello");
        assert_eq!(body["response_format"], "wav");
        assert!(body.get("messages").is_none());
        assert_eq!(
            transcription_text(&Mode::Openai, br#"{"text":" hello "}"#).unwrap(),
            "hello"
        );
        assert_eq!(
            transcription_text(
                &Mode::Mimo,
                br#"{"choices":[{"message":{"content":"hello"}}]}"#
            )
            .unwrap(),
            "hello"
        );
        assert!(transcription_text(&Mode::Mimo, br#"{"choices":[]}"#).is_err());
        assert!(transcription_text(&Mode::Openai, br#"{"text":" "}"#).is_err());
    }
    #[test]
    fn wav_output_is_validated_for_both_modes() {
        let wav = voice_recording::encode_wav(&[0.0; 100], 16_000).unwrap();
        let json = serde_json::to_vec(
            &json!({"choices":[{"message":{"audio":{"data":BASE64.encode(&wav)}}}]}),
        )
        .unwrap();
        // The bytes go to the webview as-is: the WAV itself, never base64 text.
        assert_eq!(parse_speech(&Mode::Mimo, json).unwrap(), wav);
        assert_eq!(parse_speech(&Mode::Openai, wav.clone()).unwrap(), wav);
        assert!(parse_speech(&Mode::Openai, b"not audio".to_vec()).is_err());
        assert!(parse_speech(&Mode::Mimo, br#"{"choices":[]}"#.to_vec()).is_err());
    }
    #[test]
    fn cancelled_sessions_cannot_be_resurrected() {
        let runtime = VoiceRuntime::default();
        runtime
            .sessions
            .lock()
            .unwrap()
            .cancelled
            .push_back("late".into());
        assert!(runtime.get("late").is_err());
        assert!(runtime.get("new").unwrap().is_none());
    }

    #[test]
    fn finished_transcription_releases_only_its_own_session() {
        let runtime = VoiceRuntime::default();
        let session = recorded_session(Mode::Mimo, "http://127.0.0.1:1/v1".into());
        runtime.insert("done", session.clone()).unwrap();
        runtime.finish(
            "done",
            &recorded_session(Mode::Mimo, "http://127.0.0.1:1/v1".into()),
        );
        assert!(runtime.get("done").unwrap().is_some());
        runtime.finish("done", &session);
        assert!(runtime.get("done").unwrap().is_none());
        // A cleanup call arriving afterwards is still harmless.
        runtime.cancel("done").unwrap();
        assert!(runtime.get("done").is_err());
    }

    #[test]
    fn page_reload_stops_only_that_pages_microphone() {
        let runtime = VoiceRuntime::default();
        let (reloaded, reloaded_mic) = microphone_session("main");
        let (other, other_mic) = microphone_session("other");
        runtime.insert("reloaded", reloaded.clone()).unwrap();
        runtime.insert("other", other.clone()).unwrap();
        runtime.cancel_owner("main");
        assert!(matches!(reloaded_mic.try_recv(), Ok(Stop::Cancel)));
        assert!(reloaded.cancel.is_cancelled());
        assert!(runtime.get("reloaded").is_err());
        assert!(other_mic.try_recv().is_err());
        assert!(!other.cancel.is_cancelled());
        assert!(runtime.get("other").unwrap().is_some());
    }

    #[test]
    fn abandoned_sessions_are_evicted_but_busy_ones_survive() {
        let runtime = VoiceRuntime::default();
        let (abandoned, abandoned_mic) = microphone_session("main");
        let (working, working_mic) = microphone_session("main");
        runtime.insert("abandoned", abandoned.clone()).unwrap();
        runtime.insert("working", working.clone()).unwrap();
        age(&abandoned);
        age(&working);
        let _busy = BusyGuard::acquire(&working).unwrap();
        // Eviction runs when the next interaction starts.
        runtime
            .insert(
                "next",
                recorded_session(Mode::Mimo, "http://127.0.0.1:1/v1".into()),
            )
            .unwrap();
        assert!(matches!(abandoned_mic.try_recv(), Ok(Stop::Cancel)));
        assert!(abandoned.cancel.is_cancelled());
        // Not tombstoned: a reader resuming after a long pause can start over.
        assert!(runtime.get("abandoned").unwrap().is_none());
        assert!(working_mic.try_recv().is_err());
        assert!(runtime.get("working").unwrap().is_some());
    }

    #[test]
    fn eviction_frees_capacity_left_by_abandoned_pages() {
        let runtime = VoiceRuntime::default();
        let stale: Vec<_> = (0..8)
            .map(|index| {
                let (session, _) = microphone_session("main");
                runtime
                    .insert(&format!("stale-{index}"), session.clone())
                    .unwrap();
                session
            })
            .collect();
        let fresh = recorded_session(Mode::Mimo, "http://127.0.0.1:1/v1".into());
        assert!(runtime.insert("fresh", fresh.clone()).is_err());
        stale.iter().for_each(|session| age(session));
        runtime.insert("fresh", fresh).unwrap();
        assert_eq!(runtime.sessions.lock().unwrap().active.len(), 1);
    }
}
