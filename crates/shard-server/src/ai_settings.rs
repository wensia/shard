//! 「设置 → AI」的服务端部分：自动标签用哪个模型、开没开、跑得怎么样。
//!
//! 配置来源二选一：
//! - 服务器环境变量 `SHARD_AUTO_TAG_ENABLED=true`（连同其余 `SHARD_AUTO_TAG_*`）：运维托管，App 里只读；
//! - 否则用 App 设置里保存的 `<data_dir>/ai-settings.json`（权限 600，不进内容库、不进导出与同步）。
//!
//! 密钥只进不出：读取只告诉「有没有」。改配置立即生效：worker 订阅 [`AiSettings::subscribe`]，不用重启服务。

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicI64, Ordering},
        Mutex,
    },
};

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shard_store::AutoTaggingCounts;
use tokio::sync::watch;

use crate::{
    rpc::{Access, Registry, RpcEnv, RpcError},
    tagging_model::{ModelClient, PROMPT_VERSION},
};

const FILE_NAME: &str = "ai-settings.json";
pub const DEFAULT_API_BASE: &str = "https://api.openai.com/v1";
const MAX_KEY_LENGTH: usize = 4096;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAutoTagging {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    api_base: String,
    #[serde(default)]
    model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    #[serde(default)]
    auto_tagging: StoredAutoTagging,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    App,
    Env,
}

/// 后台任务现在的状态：关闭 / 运行中 / 因配置错误暂停（改配置后自动恢复）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkerState {
    Off,
    Running,
    Paused,
}

#[derive(Clone, Debug, Default)]
struct Activity {
    last_success_at: Option<i64>,
    last_error: Option<String>,
    last_error_at: Option<i64>,
    paused: bool,
}

/// 设置页提交的自动标签表单。`apiKey` 留空表示保留已保存的密钥，`clearKey` 显式删除。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoTaggingInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub api_base: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub clear_key: bool,
}

pub struct AiSettings {
    path: PathBuf,
    source: Source,
    stored: Mutex<StoredAutoTagging>,
    client: watch::Sender<Option<ModelClient>>,
    activity: Mutex<Activity>,
    /// 上次把候选扫空时的内容 seq（-1 = 还没扫空过）。worker 据此跳过无变化时的扫描。
    scan_settled: AtomicI64,
}

impl AiSettings {
    /// 启动时读取：环境变量开启了就以它为准（配置错误直接让服务起不来，与之前一致）；
    /// 否则读 App 保存的文件。文件坏了不阻止服务启动，只记日志、当作关闭。
    pub fn load(data_dir: &Path) -> Result<Self, String> {
        let path = data_dir.join(FILE_NAME);
        if let Some(client) = ModelClient::from_env()? {
            return Ok(Self::with(path, Source::Env, StoredAutoTagging::default(), Some(client)));
        }
        let stored = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<StoredSettings>(&bytes) {
                Ok(settings) => settings.auto_tagging,
                Err(_) => {
                    tracing::error!("AI 设置文件无法解析，自动标签保持关闭");
                    StoredAutoTagging::default()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => StoredAutoTagging::default(),
            Err(_) => {
                tracing::error!("AI 设置文件读取失败，自动标签保持关闭");
                StoredAutoTagging::default()
            }
        };
        let client = match build_client(&stored) {
            Ok(client) => client,
            Err(_) => {
                tracing::error!("已保存的自动标签配置无效，保持关闭");
                None
            }
        };
        Ok(Self::with(path, Source::App, stored, client))
    }

    fn with(path: PathBuf, source: Source, stored: StoredAutoTagging, client: Option<ModelClient>) -> Self {
        Self {
            path,
            source,
            stored: Mutex::new(stored),
            client: watch::Sender::new(client),
            activity: Mutex::new(Activity::default()),
            scan_settled: AtomicI64::new(-1),
        }
    }

    pub fn scan_settled_at(&self) -> Option<i64> {
        Some(self.scan_settled.load(Ordering::Relaxed)).filter(|seq| *seq >= 0)
    }

    pub fn settle_scan(&self, seq: i64) {
        self.scan_settled.store(seq, Ordering::Relaxed);
    }

    /// 测试用：直接换模型客户端（App 保存只接受公网 HTTPS，测试要连本机假服务）。
    #[cfg(any(test, feature = "test-auth"))]
    pub fn replace_client_for_tests(&self, client: Option<ModelClient>) {
        *self.activity.lock().expect("AI 状态锁中毒") = Activity::default();
        self.client.send_replace(client);
    }

    pub fn source(&self) -> Source {
        self.source
    }

    /// worker 订阅当前生效的模型；`None` 表示关闭。
    pub fn subscribe(&self) -> watch::Receiver<Option<ModelClient>> {
        self.client.subscribe()
    }

    pub fn current_client(&self) -> Option<ModelClient> {
        self.client.borrow().clone()
    }

    /// 保存 App 配置并立即生效。环境变量托管时拒绝（界面也会禁用表单）。
    pub fn save(&self, input: AutoTaggingInput) -> Result<(), String> {
        if self.source == Source::Env {
            return Err(ENV_MANAGED_MESSAGE.into());
        }
        let mut stored = self.stored.lock().expect("AI 设置锁中毒");
        let next = merge(&stored, input)?;
        let client = build_client(&next)?;
        write_private(&self.path, &StoredSettings { auto_tagging: next.clone() })?;
        *stored = next;
        drop(stored);
        *self.activity.lock().expect("AI 状态锁中毒") = Activity::default();
        self.client.send_replace(client);
        Ok(())
    }

    /// 「测试连接」用的客户端：表单里的值；密钥留空时用已保存的。环境变量托管时直接用当前配置。
    pub fn client_for_test(&self, input: AutoTaggingInput) -> Result<ModelClient, String> {
        if self.source == Source::Env {
            return self.current_client().ok_or_else(|| ENV_MANAGED_MESSAGE.to_string());
        }
        let stored = self.stored.lock().expect("AI 设置锁中毒");
        let mut next = merge(&stored, AutoTaggingInput { enabled: true, ..input })?;
        next.enabled = true;
        build_client(&next)?.ok_or_else(|| "请先填写模型名称与 API Key".to_string())
    }

    pub fn record_success(&self, at: i64) {
        let mut activity = self.activity.lock().expect("AI 状态锁中毒");
        activity.last_success_at = Some(at);
        activity.paused = false;
    }

    /// 只记已经脱敏的说明（`ModelError::message`），不记模型原文、正文或密钥。
    pub fn record_error(&self, message: &str, at: i64) {
        let mut activity = self.activity.lock().expect("AI 状态锁中毒");
        activity.last_error = Some(message.chars().take(200).collect());
        activity.last_error_at = Some(at);
    }

    pub fn set_paused(&self, paused: bool) {
        self.activity.lock().expect("AI 状态锁中毒").paused = paused;
    }

    /// 设置页看到的全部：来源、表单值（无密钥）、后台状态与进度。
    pub fn view(&self, counts: Option<AutoTaggingCounts>) -> Value {
        let client = self.current_client();
        let activity = self.activity.lock().expect("AI 状态锁中毒").clone();
        let state = match (&client, activity.paused) {
            (None, _) => WorkerState::Off,
            (Some(_), true) => WorkerState::Paused,
            (Some(_), false) => WorkerState::Running,
        };
        let (enabled, api_base, model, has_key) = match self.source {
            Source::Env => {
                let client = client.as_ref();
                (
                    client.is_some(),
                    client.map(|client| client.api_base().to_string()).unwrap_or_default(),
                    client.map(|client| client.model().to_string()).unwrap_or_default(),
                    client.is_some(),
                )
            }
            Source::App => {
                let stored = self.stored.lock().expect("AI 设置锁中毒");
                (
                    stored.enabled,
                    if stored.api_base.is_empty() { DEFAULT_API_BASE.to_string() } else { stored.api_base.clone() },
                    stored.model.clone(),
                    stored.api_key.is_some(),
                )
            }
        };
        json!({
            "autoTagging": {
                "source": self.source,
                "enabled": enabled,
                "apiBase": api_base,
                "model": model,
                "hasKey": has_key,
                "state": state,
                "lastSuccessAt": activity.last_success_at,
                "lastError": activity.last_error,
                "lastErrorAt": activity.last_error_at,
                "counts": counts,
            }
        })
    }
}

const ENV_MANAGED_MESSAGE: &str = "自动标签由服务器环境变量 SHARD_AUTO_TAG_* 托管，请在服务器上修改";

fn merge(current: &StoredAutoTagging, input: AutoTaggingInput) -> Result<StoredAutoTagging, String> {
    let api_base = input.api_base.trim().trim_end_matches('/').to_string();
    let model = input.model.trim().to_string();
    if model.chars().count() > 256 || model.chars().any(char::is_control) {
        return Err("自动标签模型名称无效".into());
    }
    let api_key = if input.clear_key {
        None
    } else {
        match input.api_key.as_deref().map(str::trim).filter(|key| !key.is_empty()) {
            Some(key) if key.len() > MAX_KEY_LENGTH || key.chars().any(char::is_control) => {
                return Err("自动标签 API 密钥格式无效".into())
            }
            Some(key) => Some(key.to_string()),
            None => current.api_key.clone(),
        }
    };
    Ok(StoredAutoTagging { enabled: input.enabled, api_base, model, api_key })
}

/// 开启时必须能建出客户端；关闭时也校验已填的地址，让用户当场看到错误。
fn build_client(settings: &StoredAutoTagging) -> Result<Option<ModelClient>, String> {
    let api_base = if settings.api_base.is_empty() { DEFAULT_API_BASE } else { &settings.api_base };
    if !settings.enabled {
        if !settings.api_base.is_empty() {
            ModelClient::new_public(api_base, "placeholder", "placeholder")?;
        }
        return Ok(None);
    }
    if settings.model.is_empty() {
        return Err("开启自动标签需要填写模型名称".into());
    }
    let Some(key) = settings.api_key.as_deref() else {
        return Err("开启自动标签需要填写 API Key".into());
    };
    ModelClient::new_public(api_base, &settings.model, key).map(Some)
}

/// 原子写入且只有服务进程能读：先写同目录临时文件（600），fsync 后改名。
fn write_private(path: &Path, settings: &StoredSettings) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(settings).map_err(|_| "AI 设置无法编码")?;
    let temporary = path.with_extension(format!("json.tmp-{}", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        tracing::error!("AI 设置写入失败");
        return Err("AI 设置保存失败，请检查服务器数据目录权限".into());
    }
    Ok(())
}

pub fn register(registry: &mut Registry) {
    registry.register("ai_settings_get", Access::Read, get);
    registry.register("ai_settings_save", Access::Write, save);
    registry.register("ai_settings_test", Access::Read, test);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveArgs {
    auto_tagging: AutoTaggingInput,
}

fn counts(env: &RpcEnv<'_>) -> Option<AutoTaggingCounts> {
    env.store.auto_tagging_counts(PROMPT_VERSION).ok()
}

fn get(env: &RpcEnv<'_>, _args: Value) -> Result<Value, RpcError> {
    Ok(env.ai.view(counts(env)))
}

fn save(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: SaveArgs = serde_json::from_value(args).map_err(RpcError::invalid_args)?;
    env.ai
        .save(args.auto_tagging)
        .map_err(|message| RpcError::new(StatusCode::BAD_REQUEST, "AI_SETTINGS_INVALID", message))?;
    Ok(env.ai.view(counts(env)))
}

/// RPC 处理函数跑在 `spawn_blocking` 线程上，可以就地等这一次网络请求（有超时上限）。
fn test(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: SaveArgs = serde_json::from_value(args).map_err(RpcError::invalid_args)?;
    let client = env
        .ai
        .client_for_test(args.auto_tagging)
        .map_err(|message| RpcError::new(StatusCode::BAD_REQUEST, "AI_SETTINGS_INVALID", message))?;
    let handle = tokio::runtime::Handle::try_current()
        .map_err(|_| RpcError::new(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", "服务器出错了，请稍后再试。"))?;
    match handle.block_on(client.test()) {
        Ok(tags) => Ok(json!({ "ok": true, "tags": tags })),
        Err(error) => Ok(json!({ "ok": false, "message": error.message })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(enabled: bool, base: &str, model: &str, key: Option<&str>) -> AutoTaggingInput {
        AutoTaggingInput {
            enabled,
            api_base: base.into(),
            model: model.into(),
            api_key: key.map(str::to_string),
            clear_key: false,
        }
    }

    #[test]
    fn saves_privately_keeps_key_when_blank_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let settings = AiSettings::load(dir.path()).unwrap();
        assert_eq!(settings.source(), Source::App);
        assert!(settings.current_client().is_none());
        let mut receiver = settings.subscribe();

        settings.save(input(true, "https://api.example.com/v1/", "model-a", Some("secret-key"))).unwrap();
        assert!(receiver.has_changed().unwrap());
        assert_eq!(receiver.borrow_and_update().as_ref().unwrap().model(), "model-a");
        let path = dir.path().join(FILE_NAME);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }

        // 密钥留空保留；读取永远不回显密钥。
        settings.save(input(true, "https://api.example.com/v1", "model-b", Some("  "))).unwrap();
        let view = settings.view(None).to_string();
        assert!(!view.contains("secret-key"));
        assert!(view.contains("\"hasKey\":true"));
        assert!(view.contains("model-b"));

        let reloaded = AiSettings::load(dir.path()).unwrap();
        assert_eq!(reloaded.current_client().unwrap().model(), "model-b");
        assert_eq!(reloaded.current_client().unwrap().api_base(), "https://api.example.com/v1");
    }

    #[test]
    fn disabling_stops_worker_and_clear_key_removes_secret() {
        let dir = tempfile::tempdir().unwrap();
        let settings = AiSettings::load(dir.path()).unwrap();
        settings.save(input(true, "", "model", Some("secret-key"))).unwrap();
        assert!(settings.current_client().is_some());
        settings.save(input(false, "", "model", None)).unwrap();
        assert!(settings.current_client().is_none());
        assert!(fs::read_to_string(dir.path().join(FILE_NAME)).unwrap().contains("secret-key"));
        settings
            .save(AutoTaggingInput { clear_key: true, ..input(false, "", "model", None) })
            .unwrap();
        assert!(!fs::read_to_string(dir.path().join(FILE_NAME)).unwrap().contains("secret-key"));
    }

    #[test]
    fn rejects_incomplete_or_private_configuration_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let settings = AiSettings::load(dir.path()).unwrap();
        assert!(settings.save(input(true, "", "", Some("key"))).unwrap_err().contains("模型名称"));
        assert!(settings.save(input(true, "", "model", None)).unwrap_err().contains("API Key"));
        assert!(settings.save(input(true, "https://127.0.0.1/v1", "model", Some("key"))).is_err());
        assert!(settings.save(input(false, "http://api.example.com/v1", "", None)).is_err());
        assert!(!dir.path().join(FILE_NAME).exists());
        assert!(settings.current_client().is_none());
    }

    #[test]
    fn test_client_uses_form_values_and_saved_key_without_saving() {
        let dir = tempfile::tempdir().unwrap();
        let settings = AiSettings::load(dir.path()).unwrap();
        assert!(settings.client_for_test(input(false, "", "model", None)).is_err());
        settings.save(input(false, "", "model", Some("saved-key"))).unwrap();
        let client = settings.client_for_test(input(false, "https://other.example.com/v1", "other", None)).unwrap();
        assert_eq!(client.model(), "other");
        assert!(settings.current_client().is_none());
    }

    #[test]
    fn corrupt_file_does_not_block_startup() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), b"{not json").unwrap();
        let settings = AiSettings::load(dir.path()).unwrap();
        assert!(settings.current_client().is_none());
    }

    #[test]
    fn view_reports_paused_and_recovers_after_save() {
        let dir = tempfile::tempdir().unwrap();
        let settings = AiSettings::load(dir.path()).unwrap();
        settings.save(input(true, "", "model", Some("key"))).unwrap();
        settings.record_error("自动标签模型返回 HTTP 401", 10);
        settings.set_paused(true);
        let view = settings.view(Some(AutoTaggingCounts { pending: 2, done: 3, failed: 1 }));
        assert_eq!(view["autoTagging"]["state"], "paused");
        assert_eq!(view["autoTagging"]["lastError"], "自动标签模型返回 HTTP 401");
        assert_eq!(view["autoTagging"]["counts"]["done"], 3);
        settings.save(input(true, "", "model", None)).unwrap();
        let view = settings.view(None);
        assert_eq!(view["autoTagging"]["state"], "running");
        assert!(view["autoTagging"]["lastError"].is_null());
    }
}
