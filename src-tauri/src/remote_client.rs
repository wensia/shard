//! 桌面在线客户端（S8a）：连接服务器后，前端命令由这里带设备令牌转发到 `/api/rpc`，
//! 图片经 `shard-asset` 协议代理 `/api/files`（见 `vault_asset_protocol`），服务器的 SSE 转成 Tauri 事件。
//!
//! 配对、令牌存取、RPC 与 SSE 都用共享的 `shard-remote`（与命令行同一份）。令牌存钥匙串
//! `dev.shard.desktop`，与命令行（`dev.shard.cli`）分开，网页「设置 → 设备」里可以单独吊销。
//! 离线（副本 + outbox）是 S8b，在这层转发底下接入。

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use serde::Serialize;
use serde_json::{json, Value};
use shard_remote::{
    start_pairing, Client, ClientOptions, CredentialStore, Pairing, PairingRequest, PollStatus, RemoteConfig,
    RemoteError, TokenBackend,
};
use tauri::{AppHandle, Emitter, Manager, State};

pub const KEYCHAIN_SERVICE: &str = "dev.shard.desktop";
/// 设备令牌失效（被吊销）：前端提示重新连接。
pub const REMOTE_AUTH_REQUIRED_EVENT: &str = "remote-auth-required";
/// 与服务器实时通道的状态：connecting / connected / reconnecting / signedOut，状态栏显示。
pub const REMOTE_CONNECTION_EVENT: &str = "remote-connection";
pub const LOCKBOX_CHANGED_EVENT: &str = "lockbox-changed";
pub const VAULT_RESYNC_EVENT: &str = "vault-resync";

fn user_agent() -> String {
    format!("shard-desktop/{}", env!("CARGO_PKG_VERSION"))
}

fn client_options() -> ClientOptions {
    // 与网页端一致：网络失败与 502–504 重试 3 次，300 · 2^n 毫秒。
    let mut options = ClientOptions::new(user_agent(), "desktop");
    options.retry_delays = vec![Duration::from_millis(300), Duration::from_millis(600), Duration::from_millis(1200)];
    options
}

/// 令牌与配置的存放处：`<App 配置目录>/remote`。测试可用 `SHARD_DESKTOP_TOKEN_STORE=file` 改用文件后备。
fn credential_store(app: &AppHandle) -> CredentialStore {
    let dir = app.path().app_config_dir().ok().map(|dir| dir.join("remote"));
    let backend = if std::env::var("SHARD_DESKTOP_TOKEN_STORE").as_deref() == Ok("file") {
        TokenBackend::File
    } else {
        TokenBackend::platform_default(KEYCHAIN_SERVICE)
    };
    CredentialStore::new(dir, backend)
}

struct Connected {
    client: Client,
    config: RemoteConfig,
    stop: Arc<AtomicBool>,
    /// 实时通道最近一次的状态（同 [`REMOTE_CONNECTION_EVENT`]）。webview 订阅事件之前发出的状态会丢，
    /// 前端启动时从 [`remote_status`] 补读。
    link: LinkState,
}

/// 实时通道的状态：桥接线程写，`remote_status` 读。
#[derive(Clone)]
struct LinkState(Arc<Mutex<&'static str>>);

impl LinkState {
    fn new() -> Self {
        Self(Arc::new(Mutex::new("connecting")))
    }

    fn set(&self, state: &'static str) {
        *self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = state;
    }

    fn get(&self) -> &'static str {
        *self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Default)]
struct RemoteState {
    connected: Option<Connected>,
    pairing: Option<Pairing>,
}

#[derive(Default)]
pub struct RemoteRuntime {
    state: Mutex<RemoteState>,
}

impl RemoteRuntime {
    fn lock(&self) -> std::sync::MutexGuard<'_, RemoteState> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 已连接时的客户端（克隆很便宜）。
    pub fn client(&self) -> Option<Client> {
        self.lock().connected.as_ref().map(|connected| connected.client.clone())
    }

    fn connect(&self, app: &AppHandle, client: Client, config: RemoteConfig) {
        let stop = Arc::new(AtomicBool::new(false));
        let link = LinkState::new();
        spawn_event_bridge(app.clone(), client.clone(), Arc::clone(&stop), link.clone());
        let previous = self.lock().connected.replace(Connected { client, config, stop, link });
        if let Some(previous) = previous {
            previous.stop.store(true, Ordering::SeqCst);
        }
    }

    fn disconnect(&self) {
        if let Some(previous) = self.lock().connected.take() {
            previous.stop.store(true, Ordering::SeqCst);
        }
    }
}

/// 启动时：有配置与令牌就直接连上。
pub fn restore(app: &AppHandle) {
    let store = credential_store(app);
    let Ok(Some(config)) = store.load_config() else {
        return;
    };
    let token = match store.load_token(&config.server) {
        Ok(Some(token)) => token,
        _ => return,
    };
    match Client::new(&config.server, token, client_options()) {
        Ok(client) => app.state::<RemoteRuntime>().connect(app, client, config),
        Err(error) => eprintln!("远程配置里的服务器地址无效：{error}"),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    connected: bool,
    server: Option<String>,
    device_id: Option<String>,
    name: Option<String>,
    /// 实时通道当前的状态（connecting / connected / reconnecting / signedOut）；未连接时为空。
    connection: Option<&'static str>,
}

#[tauri::command]
pub fn remote_status(runtime: State<'_, RemoteRuntime>) -> RemoteStatus {
    let state = runtime.lock();
    match &state.connected {
        Some(connected) => RemoteStatus {
            connected: true,
            server: Some(connected.config.server.clone()),
            device_id: Some(connected.config.device_id.clone()),
            name: Some(connected.config.name.clone()),
            connection: Some(connected.link.get()),
        },
        None => RemoteStatus { connected: false, server: None, device_id: None, name: None, connection: None },
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    server: String,
    user_code: String,
    /// 在已登录的浏览器里打开它、输入配对码并验证通行密钥。
    verification_uri: String,
    expires_in: u64,
    interval_ms: u64,
}

/// 发起配对：返回配对码与网页地址，前端展示后按 `intervalMs` 轮询 [`remote_pair_poll`]。
#[tauri::command]
pub async fn remote_pair_start(
    runtime: State<'_, RemoteRuntime>,
    server: String,
    name: String,
) -> Result<PairingInfo, String> {
    let pairing = tauri::async_runtime::spawn_blocking(move || {
        start_pairing(&server, PairingRequest { name: &name, kind: "desktop" }, &user_agent())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    let info = PairingInfo {
        server: pairing.server().to_string(),
        user_code: pairing.user_code().to_string(),
        verification_uri: pairing.verification_uri().to_string(),
        expires_in: pairing.expires_in(),
        interval_ms: pairing.interval().as_millis() as u64,
    };
    runtime.lock().pairing = Some(pairing);
    Ok(info)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "status")]
pub enum PairPollResult {
    Pending { interval_ms: u64 },
    Connected { server: String, name: String },
    Expired,
}

/// 轮询一次配对结果；批准后存好令牌与配置并连上服务器。
#[tauri::command]
pub async fn remote_pair_poll(app: AppHandle, runtime: State<'_, RemoteRuntime>) -> Result<PairPollResult, String> {
    let Some(mut pairing) = runtime.lock().pairing.take() else {
        return Err("没有进行中的配对，请重新发起。".to_string());
    };
    if pairing.is_expired() {
        return Ok(PairPollResult::Expired);
    }
    let (pairing, polled) = tauri::async_runtime::spawn_blocking(move || {
        let polled = pairing.poll_once();
        (pairing, polled)
    })
    .await
    .map_err(|error| error.to_string())?;
    match polled {
        Ok(PollStatus::Pending) => {
            let interval_ms = pairing.interval().as_millis() as u64;
            runtime.lock().pairing = Some(pairing);
            Ok(PairPollResult::Pending { interval_ms })
        }
        Ok(PollStatus::Issued(credentials)) => {
            let store = credential_store(&app);
            let config = RemoteConfig {
                server: credentials.server.clone(),
                device_id: credentials.device_id.clone(),
                name: credentials.name.clone(),
            };
            // 先存新令牌与配置，再连；换了服务器时删掉旧服务器的令牌（按服务器分开存，不会删到新的）。
            let previous = store.load_config().ok().flatten();
            store.save_token(&config.server, &credentials.token).map_err(|error| error.to_string())?;
            store.save_config(&config).map_err(|error| error.to_string())?;
            if let Some(previous) = previous.filter(|previous| previous.server != config.server) {
                let _ = store.delete_token(&previous.server);
            }
            let client = Client::new(&config.server, credentials.token, client_options()).map_err(|error| error.to_string())?;
            runtime.connect(&app, client, config.clone());
            Ok(PairPollResult::Connected { server: config.server, name: config.name })
        }
        Err(shard_remote::PairingError::Expired | shard_remote::PairingError::Gone) => Ok(PairPollResult::Expired),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn remote_pair_cancel(runtime: State<'_, RemoteRuntime>) {
    runtime.lock().pairing = None;
}

/// 断开：删掉本机令牌与配置，停掉实时通道。服务器上的设备记录要到网页「设置 → 设备」吊销。
#[tauri::command]
pub fn remote_disconnect(app: AppHandle, runtime: State<'_, RemoteRuntime>) -> Result<(), String> {
    let store = credential_store(&app);
    if let Ok(Some(config)) = store.load_config() {
        let _ = store.delete_token(&config.server);
    }
    store.remove_config_file().map_err(|error| error.to_string())?;
    runtime.disconnect();
    let _ = app.emit(REMOTE_CONNECTION_EVENT, json!({ "state": "signedOut" }));
    Ok(())
}

/// 给前端的错误：与网页端 `readError` 同形——有结构化错误就给它，否则给说明文字。
fn frontend_error(app: &AppHandle, error: RemoteError) -> Value {
    failure_value(app, error, false)
}

/// `detailed` 为真时（密匣客户端的服务器通道）与网页端 `readFailure` 同形：`{status, code, detail}`，
/// `detail` 即 [`frontend_error`] 的值；没拿到 HTTP 响应（网络失败）时与网页一样只给说明文字。
fn failure_value(app: &AppHandle, error: RemoteError, detailed: bool) -> Value {
    if error.is_unauthenticated() {
        let _ = app.emit(REMOTE_AUTH_REQUIRED_EVENT, json!({ "server": error.server }));
    }
    failure_payload(error, detailed)
}

fn failure_payload(error: RemoteError, detailed: bool) -> Value {
    let status = error.status;
    let code = error.code.clone();
    let detail = match error.detail {
        Some(detail) => *detail,
        None => Value::String(error.message),
    };
    match status {
        Some(status) if detailed => json!({ "status": status, "code": code, "detail": detail }),
        _ => detail,
    }
}

fn not_connected() -> Value {
    Value::String("还没有连接服务器。".to_string())
}

/// 不转发 RPC、由这里直接读的「命令」：一条修订的原始字节（`GET /api/history/{revId}`）。
/// 网页端直接 fetch 这个地址；桌面 webview 与服务器不同源、也没有会话，只能带设备令牌在这里读。
/// 名字带冒号，不会与服务器注册的命令重名。
pub const REVISION_BYTES_COMMAND: &str = "remote:revision_bytes";

/// 修订原文 → `{sha, contentType, data(base64)}`；sha 按收到的字节重算，前端据此核对。
fn revision_bytes_payload(server: &str, fetched: shard_remote::FetchedBytes) -> Result<Value, RemoteError> {
    use base64::Engine as _;
    use sha2::Digest as _;
    if !fetched.is_ok() {
        let status = fetched.status;
        let (code, message) = match status {
            401 => ("UNAUTHENTICATED".to_string(), "登录已失效。".to_string()),
            404 => ("NOT_FOUND".to_string(), "找不到这个版本。".to_string()),
            _ => (format!("HTTP_{status}"), format!("读取旧版本失败（{status}）")),
        };
        return Err(RemoteError {
            server: server.to_string(),
            command: REVISION_BYTES_COMMAND.to_string(),
            status: Some(status),
            code,
            message,
            detail: None,
        });
    }
    let sha: String = sha2::Sha256::digest(&fetched.bytes).iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(json!({
        "sha": sha,
        "contentType": fetched.content_type,
        "data": base64::engine::general_purpose::STANDARD.encode(&fetched.bytes),
    }))
}

fn read_revision_bytes(client: &Client, args: &Value) -> Result<Value, RemoteError> {
    let rev_id = args.get("revId").and_then(Value::as_i64).ok_or_else(|| RemoteError {
        server: client.server().to_string(),
        command: REVISION_BYTES_COMMAND.to_string(),
        status: Some(400),
        code: "INVALID_ARGS".to_string(),
        message: "需要 revId。".to_string(),
        detail: None,
    })?;
    revision_bytes_payload(client.server(), client.get_bytes(&format!("api/history/{rev_id}"))?)
}

/// 把一个命令原样转发到服务器（`POST /api/rpc/{command}`）。每次都带新的幂等键：读命令服务器忽略它，
/// 写命令据此保证重试只提交一次。`detailed` 见 [`failure_value`]；[`REVISION_BYTES_COMMAND`] 在这里直接读。
#[tauri::command]
pub async fn remote_invoke(
    app: AppHandle,
    runtime: State<'_, RemoteRuntime>,
    command: String,
    args: Option<Value>,
    detailed: Option<bool>,
) -> Result<Value, Value> {
    let client = runtime.client().ok_or_else(not_connected)?;
    let args = args.unwrap_or_else(|| json!({}));
    let result = tauri::async_runtime::spawn_blocking(move || {
        if command == REVISION_BYTES_COMMAND {
            read_revision_bytes(&client, &args)
        } else {
            client.write(&command, args)
        }
    })
    .await
    .map_err(|error| Value::String(error.to_string()))?;
    result.map_err(|error| failure_value(&app, error, detailed.unwrap_or(false)))
}

/// 上传附件字节（请求体是原始字节），返回 sha；前端再用 sha 调对应的登记命令。
#[tauri::command]
pub async fn remote_upload_blob(
    app: AppHandle,
    runtime: State<'_, RemoteRuntime>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, Value> {
    let client = runtime.client().ok_or_else(not_connected)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(Value::String("上传需要原始字节。".to_string()));
    };
    let bytes = bytes.clone();
    let result = tauri::async_runtime::spawn_blocking(move || client.upload_blob(&bytes))
        .await
        .map_err(|error| Value::String(error.to_string()))?;
    result.map_err(|error| frontend_error(&app, error))
}

/// 单个本机文件的上传上限（与桌面保存图片、服务器单次上传一致）。
const MAX_LOCAL_FILE_BYTES: u64 = 50 * 1024 * 1024;

fn read_local_file(path: &str) -> Result<(String, Vec<u8>), String> {
    let path = std::path::Path::new(path);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "文件名无效。".to_string())?
        .to_string();
    let size = std::fs::metadata(path).map_err(|error| error.to_string())?.len();
    if size > MAX_LOCAL_FILE_BYTES {
        return Err(format!("{name} 超过 50 MB，没有上传。"));
    }
    Ok((name, std::fs::read(path).map_err(|error| error.to_string())?))
}

/// 桌面 `save_image_attachment_from_path` 的远程版：读本机文件 → 按内容哈希上传 → `save_fragment_image`。
/// 返回资料库相对路径，与本地版一致。
#[tauri::command]
pub async fn remote_save_image_from_path(
    app: AppHandle,
    runtime: State<'_, RemoteRuntime>,
    path: String,
) -> Result<Value, Value> {
    let client = runtime.client().ok_or_else(not_connected)?;
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Value, Result<RemoteError, String>> {
        let (_, bytes) = read_local_file(&path).map_err(Err)?;
        let sha = client.upload_blob(&bytes).map_err(Ok)?;
        client.write("save_fragment_image", json!({ "blobSha": sha })).map_err(Ok)
    })
    .await
    .map_err(|error| Value::String(error.to_string()))?;
    result.map_err(|error| match error {
        Ok(remote) => frontend_error(&app, remote),
        Err(message) => Value::String(message),
    })
}

/// 桌面 `import_library_files` 的远程版：逐个读本机文件并上传，再一次 `import_library_blobs`。
/// 读不了或超限的文件记进 `skipped`（与服务器对不是图片的文件同样处理），其余照常导入。
#[tauri::command]
pub async fn remote_import_library_files(
    app: AppHandle,
    runtime: State<'_, RemoteRuntime>,
    paths: Vec<String>,
    directory: Option<String>,
) -> Result<Value, Value> {
    let client = runtime.client().ok_or_else(not_connected)?;
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Value, RemoteError> {
        let mut files = Vec::new();
        let mut skipped = Vec::new();
        for path in &paths {
            match read_local_file(path) {
                Ok((name, bytes)) => {
                    let sha = client.upload_blob(&bytes)?;
                    files.push(json!({ "name": name, "blobSha": sha }));
                }
                Err(reason) => skipped.push(json!({ "path": path, "reason": reason })),
            }
        }
        let mut result = if files.is_empty() {
            // 形状与正常导入一致：前端用 tree 刷新目录。
            json!({ "tree": client.read("list_library_tree", json!({}))?, "imported": [], "skipped": [] })
        } else {
            client.write("import_library_blobs", json!({ "files": files, "directory": directory }))?
        };
        if let Some(list) = result.get_mut("skipped").and_then(Value::as_array_mut) {
            list.extend(skipped);
        }
        Ok(result)
    })
    .await
    .map_err(|error| Value::String(error.to_string()))?;
    result.map_err(|error| frontend_error(&app, error))
}

/// 服务器的 SSE → Tauri 事件：`vault-changed`（与本地文件监听同形）、`lockbox-changed`、`vault-resync`。
/// 断线按 1–60 秒退避加抖动重连，带上最后事件 id 续传；令牌失效时通知前端并停止。
fn spawn_event_bridge(app: AppHandle, client: Client, stop: Arc<AtomicBool>, link: LinkState) {
    thread::spawn(move || {
        let mut last_event_id: Option<String> = None;
        let mut retry = Duration::from_secs(1);
        let emit_state = |state: &'static str| {
            link.set(state);
            let _ = app.emit(REMOTE_CONNECTION_EVENT, json!({ "state": state }));
        };
        emit_state("connecting");
        while !stop.load(Ordering::SeqCst) {
            match client.events(last_event_id.as_deref()) {
                Ok(stream) => {
                    emit_state("connected");
                    retry = Duration::from_secs(1);
                    let mut stream = stream.with_stop_flag(Arc::clone(&stop));
                    for item in stream.by_ref() {
                        match item {
                            Ok(event) => dispatch(&app, &event.event, &event.data),
                            Err(error) if error.is_unauthenticated() => {
                                emit_state("signedOut");
                                let _ = app.emit(REMOTE_AUTH_REQUIRED_EVENT, json!({ "server": client.server() }));
                                return;
                            }
                            Err(_) => break,
                        }
                    }
                    last_event_id = stream.last_event_id().map(str::to_string);
                }
                Err(error) if error.is_unauthenticated() => {
                    emit_state("signedOut");
                    let _ = app.emit(REMOTE_AUTH_REQUIRED_EVENT, json!({ "server": client.server() }));
                    return;
                }
                Err(_) => {}
            }
            if stop.load(Ordering::SeqCst) {
                return;
            }
            emit_state("reconnecting");
            let jitter = rand_jitter(retry);
            thread::sleep(jitter);
            retry = (retry * 2).min(Duration::from_secs(60));
        }
    });
}

/// 等待时间取 [0.5, 1) 倍，避免多台设备同时重连。
fn rand_jitter(base: Duration) -> Duration {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or(0);
    let factor = 0.5 + f64::from(nanos % 1000) / 2000.0;
    base.mul_f64(factor)
}

fn dispatch(app: &AppHandle, event: &str, data: &str) {
    match event {
        "vault-changed" => {
            if let Ok(payload) = serde_json::from_str::<Value>(data) {
                let _ = app.emit(crate::vault_watch::VAULT_CHANGED_EVENT, payload);
            }
        }
        "lockbox-changed" => {
            let _ = app.emit(LOCKBOX_CHANGED_EVENT, lockbox_changed_payload(data));
        }
        "resync" => {
            let _ = app.emit(VAULT_RESYNC_EVENT, json!({}));
        }
        _ => {}
    }
}

/// 服务器的 `lockbox-changed` 数据原样转给前端：`{seq}`（这次提交的密匣 seq，密匣客户端据此认出自己写入的回声）。
/// 解析不了就当没有 seq。
fn lockbox_changed_payload(data: &str) -> Value {
    serde_json::from_str::<Value>(data).ok().filter(Value::is_object).unwrap_or_else(|| json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lockbox_changes_keep_the_server_seq() {
        assert_eq!(lockbox_changed_payload(r#"{"seq":42}"#), json!({ "seq": 42 }));
        assert_eq!(lockbox_changed_payload("{}"), json!({}));
        assert_eq!(lockbox_changed_payload("不是 JSON"), json!({}));
    }

    #[test]
    fn jitter_stays_between_half_and_full() {
        for _ in 0..100 {
            let wait = rand_jitter(Duration::from_secs(10));
            assert!(wait >= Duration::from_secs(5) && wait <= Duration::from_secs(10));
        }
    }

    fn remote_error(status: Option<u16>, code: &str, message: &str, detail: Option<Value>) -> RemoteError {
        RemoteError {
            server: "https://shard.test".to_string(),
            command: "update_fragment".to_string(),
            status,
            code: code.to_string(),
            message: message.to_string(),
            detail: detail.map(Box::new),
        }
    }

    #[test]
    fn failures_match_the_web_transport() {
        // 普通调用：与网页 readError 同形，结构化错误优先，否则是说明文字。
        let stale = remote_error(Some(409), "STALE_BASE", "STALE_BASE: 已在别处修改", None);
        assert_eq!(failure_payload(stale.clone(), false), json!("STALE_BASE: 已在别处修改"));
        let search = remote_error(Some(400), "SEARCH", "搜索失败", Some(json!({ "code": "QUERY_TOO_LONG" })));
        assert_eq!(failure_payload(search, false), json!({ "code": "QUERY_TOO_LONG" }));
        // 密匣客户端的通道：带上状态码与错误码。
        let locked = remote_error(Some(409), "LOCKBOX_UNAVAILABLE", "这是密匣条目", None);
        assert_eq!(
            failure_payload(locked, true),
            json!({ "status": 409, "code": "LOCKBOX_UNAVAILABLE", "detail": "这是密匣条目" })
        );
        // 没拿到响应：与网页一样只给说明文字。
        let offline = remote_error(None, "NETWORK", "连不上 Shard 服务器：连接超时", None);
        assert_eq!(failure_payload(offline, true), json!("连不上 Shard 服务器：连接超时"));
    }

    fn fetched(status: u16, bytes: &[u8]) -> shard_remote::FetchedBytes {
        shard_remote::FetchedBytes {
            status,
            content_type: Some("text/plain; charset=utf-8".to_string()),
            etag: None,
            cache_control: None,
            content_security_policy: None,
            bytes: bytes.to_vec(),
        }
    }

    #[test]
    fn revision_bytes_keep_every_byte_and_report_their_sha() {
        let text = "\u{feff}---\nid: a\n---\n正文\n".as_bytes();
        let payload = revision_bytes_payload("https://shard.test", fetched(200, text)).unwrap();
        use base64::Engine as _;
        let data = base64::engine::general_purpose::STANDARD.decode(payload["data"].as_str().unwrap()).unwrap();
        assert_eq!(data, text);
        assert_eq!(payload["sha"], json!(shard_core::sha256_hex(text)));
        assert_eq!(payload["contentType"], json!("text/plain; charset=utf-8"));

        let missing = revision_bytes_payload("https://shard.test", fetched(404, b"")).unwrap_err();
        assert_eq!((missing.status, missing.code.as_str()), (Some(404), "NOT_FOUND"));
        let revoked = revision_bytes_payload("https://shard.test", fetched(401, b"")).unwrap_err();
        assert!(revoked.is_unauthenticated());
    }

    #[test]
    fn pairing_poll_results_use_camel_case_fields() {
        assert_eq!(
            serde_json::to_value(PairPollResult::Pending { interval_ms: 2000 }).unwrap(),
            json!({ "status": "pending", "intervalMs": 2000 })
        );
        assert_eq!(serde_json::to_value(PairPollResult::Expired).unwrap(), json!({ "status": "expired" }));
    }

    #[test]
    fn link_state_starts_connecting_and_follows_the_bridge() {
        let link = LinkState::new();
        let bridge = link.clone();
        assert_eq!(link.get(), "connecting");
        bridge.set("connected");
        assert_eq!(link.get(), "connected");
    }
}
