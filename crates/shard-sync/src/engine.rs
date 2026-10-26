//! 同步引擎本体：命令分流（在线直发 / 离线本地执行）、本地读写、状态与事件。
//! 拉取见 `pull.rs`，补交见 `push.rs`，outbox 合并见 `queue.rs`。

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex, MutexGuard, RwLock,
    },
};

use chrono::{DateTime, FixedOffset, Utc};
use rusqlite::{Connection, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};
use shard_remote::{utc_offset_minutes, Client, RemoteError};
use shard_store::{path_key::path_key, Store, DEFAULT_VIRTUAL_ROOT};
use shard_vault::{NoHooks, VaultCtx};

use crate::{
    db, ids,
    local::{self, LocalError, ReadContext, WritePlan},
    overlay::{OverlayVfs, Touched},
    policy::{classify, is_read_only, offline_message, CommandClass},
    runner::RunnerMsg,
};

/// 引擎的配置。
#[derive(Clone, Debug)]
pub struct EngineOptions {
    /// 放副本的目录（桌面是 `<App 数据目录>/remote`）：`replica.db`（内容 + 同步表）与 `replica-blobs.db`。
    pub dir: PathBuf,
    /// 恢复备份后找回的条目、断开连接时还没补交的操作，原文另存到这里（不随副本删除）。
    pub recovered_dir: Option<PathBuf>,
    /// 新建内容的 `source`；与服务器给配对桌面记的一致（desktop），离线新建与补交后的字节才一样。
    pub source: String,
    pub device_id: String,
}

impl EngineOptions {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into(), recovered_dir: None, source: "desktop".to_string(), device_id: String::new() }
    }
}

/// 给状态栏的同步状态（Tauri 事件 `sync-status` 的载荷）。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// online | offline | syncing
    pub state: &'static str,
    /// 待上传（还没补交完）的操作数。
    pub pending: i64,
    /// 生成了冲突副本、还没被用户看过的条目数。
    pub conflicts: i64,
    /// 服务器拒绝、标为失败的操作数。
    pub failed: i64,
}

/// 与 `vault-changed` 同形的一条变化。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct VaultChange {
    pub path: String,
    pub exists: bool,
    pub sha: Option<String>,
}

/// 引擎发给宿主（桌面）的事件。
#[derive(Clone, Debug)]
pub enum SyncEvent {
    Status(SyncStatus),
    /// 本机看到的内容变了（拉取、冲突副本、本地层收敛）。
    VaultChanged(Vec<VaultChange>),
    /// 补交时发现服务器上这条已被改过或删除：本地内容另存为冲突副本 `copy_id`。
    Conflict { id: String, copy_id: Option<String>, reason: String },
    /// 服务器拒绝了一条操作（不会重试）。
    Failed { command: String, target: String, message: String },
    /// 从备份恢复后对账：`pushed` 条推回服务器，`saved` 条原文另存在 `dir`。
    Recovered { pushed: usize, saved: usize, dir: Option<PathBuf> },
    /// 设备令牌失效。
    AuthRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Connectivity {
    /// 刚启动，还不知道连不连得上。
    Unknown,
    Online,
    Offline,
}

/// 一轮同步的结果。
#[derive(Clone, Debug, Default)]
pub struct RoundReport {
    /// 拉取后本机内容变了的条目数。
    pub pulled: usize,
    pub acked: usize,
    pub conflicts: usize,
    pub failed: usize,
    pub offline: bool,
    pub auth_required: bool,
    /// 有操作在退避：最早在这个时刻再试。
    pub retry_at: Option<DateTime<Utc>>,
    /// 这一轮做了全量对账（epoch 变化或游标过旧）。
    pub reconciled: bool,
    pub recovered: usize,
    pub error: Option<String>,
}

/// 内部错误。
#[derive(Debug)]
pub(crate) enum SyncError {
    Remote(RemoteError),
    Store(String),
    Db(rusqlite::Error),
    Io(std::io::Error),
    Local(LocalError),
}

impl SyncError {
    pub(crate) fn is_network(&self) -> bool {
        matches!(self, SyncError::Remote(error) if error.is_retryable())
    }
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::Remote(error) => write!(f, "{error}"),
            SyncError::Store(message) => write!(f, "本地副本错误：{message}"),
            SyncError::Db(error) => write!(f, "本地副本错误：{error}"),
            SyncError::Io(error) => write!(f, "{error}"),
            SyncError::Local(error) => write!(f, "{}", error.message),
        }
    }
}

impl From<RemoteError> for SyncError {
    fn from(error: RemoteError) -> Self {
        SyncError::Remote(error)
    }
}

impl From<shard_store::StoreError> for SyncError {
    fn from(error: shard_store::StoreError) -> Self {
        SyncError::Store(error.to_string())
    }
}

impl From<rusqlite::Error> for SyncError {
    fn from(error: rusqlite::Error) -> Self {
        SyncError::Db(error)
    }
}

impl From<std::io::Error> for SyncError {
    fn from(error: std::io::Error) -> Self {
        SyncError::Io(error)
    }
}

impl From<LocalError> for SyncError {
    fn from(error: LocalError) -> Self {
        SyncError::Local(error)
    }
}

impl From<String> for SyncError {
    fn from(error: String) -> Self {
        SyncError::Store(error)
    }
}

/// 一条准备好的写操作：参数已是要发给服务器的样子（含客户端 id、createdAt），op_id 与时区已定。
#[derive(Clone, Debug)]
pub(crate) struct PreparedOp {
    pub op_id: String,
    pub command: String,
    pub args: Value,
    pub utc_offset: i32,
    pub created_at: DateTime<FixedOffset>,
}

pub(crate) fn offset_of(minutes: i32) -> FixedOffset {
    FixedOffset::east_opt(minutes * 60).unwrap_or_else(|| FixedOffset::east_opt(0).expect("UTC"))
}

pub(crate) fn in_trash(path: &str) -> bool {
    let key = path_key(path);
    key == ".trash" || key.starts_with(".trash/")
}

pub struct SyncEngine {
    pub(crate) client: Client,
    pub(crate) replica: Store,
    /// 同步表的写连接（与副本内容同一个文件）。
    pub(crate) db: Mutex<Connection>,
    /// 本地读用的连接：读 overlay 时不挡住补交线程。
    reader: Mutex<Connection>,
    /// 本机可见内容（副本 ∪ overlay）的读写锁：本地写、拉取写副本、收敛丢 overlay 取写锁，本地读取读锁。
    pub(crate) local: RwLock<()>,
    /// 单飞：同一时刻只跑一轮同步。
    round: Mutex<()>,
    connectivity: Mutex<Connectivity>,
    syncing: AtomicBool,
    pub(crate) options: EngineOptions,
    listener: Box<dyn Fn(SyncEvent) + Send + Sync>,
    trigger: Mutex<Option<mpsc::Sender<RunnerMsg>>>,
    /// 上次整理副本（清变化日志、回收不再引用的 blob）的时间：每天至多一次。
    maintained_at: Mutex<Option<std::time::Instant>>,
}

/// 副本整理的间隔。
const MAINTENANCE_EVERY: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

const REPLICA_FILES: [&str; 6] =
    ["replica.db", "replica.db-wal", "replica.db-shm", "replica-blobs.db", "replica-blobs.db-wal", "replica-blobs.db-shm"];

impl SyncEngine {
    /// 打开（必要时新建）`dir` 下的副本。副本属于另一台服务器时先把没补交的操作另存，再整个换掉。
    pub fn open(
        client: Client,
        options: EngineOptions,
        listener: impl Fn(SyncEvent) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        fs::create_dir_all(&options.dir).map_err(|error| format!("建不了副本目录：{error}"))?;
        let content = options.dir.join("replica.db");
        if content.exists() {
            let conn = db::open(&content).map_err(|error| error.to_string())?;
            let state = db::load_state(&conn).map_err(|error| error.to_string())?;
            let foreign = state.as_ref().is_some_and(|state| state.server_url != client.server());
            drop(conn);
            if foreign {
                Self::discard(&options.dir, options.recovered_dir.as_deref())?;
            }
        }
        let replica = Store::open_files(&content, &options.dir.join("replica-blobs.db"), Path::new(DEFAULT_VIRTUAL_ROOT))
            .map_err(|error| error.to_string())?;
        let conn = db::open(&content).map_err(|error| error.to_string())?;
        db::init_state(&conn, client.server(), &options.device_id).map_err(|error| error.to_string())?;
        db::reset_inflight(&conn).map_err(|error| error.to_string())?;
        let reader = db::open(&content).map_err(|error| error.to_string())?;
        Ok(Self {
            client,
            replica,
            db: Mutex::new(conn),
            reader: Mutex::new(reader),
            local: RwLock::new(()),
            round: Mutex::new(()),
            connectivity: Mutex::new(Connectivity::Unknown),
            syncing: AtomicBool::new(false),
            options,
            listener: Box::new(listener),
            trigger: Mutex::new(None),
            maintained_at: Mutex::new(None),
        })
    }

    /// 删掉副本（断开连接、换服务器）。还没补交的操作先另存成 JSON（`recovered_dir`），不静默丢弃。
    /// 返回另存的文件（没有待补交的操作时为空）。
    pub fn discard(dir: &Path, recovered_dir: Option<&Path>) -> Result<Option<PathBuf>, String> {
        let content = dir.join("replica.db");
        let mut saved = None;
        if content.exists() {
            let conn = db::open(&content).map_err(|error| error.to_string())?;
            saved = export_unsent(&conn, recovered_dir).map_err(|error| error.to_string())?;
        }
        for name in REPLICA_FILES {
            let path = dir.join(name);
            if path.exists() {
                fs::remove_file(&path).map_err(|error| format!("删不掉 {}：{error}", path.display()))?;
            }
        }
        Ok(saved)
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub(crate) fn emit(&self, event: SyncEvent) {
        (self.listener)(event);
    }

    pub(crate) fn set_trigger(&self, sender: mpsc::Sender<RunnerMsg>) {
        *lock(&self.trigger) = Some(sender);
    }

    /// 请后台跑一轮同步（单飞，多次请求合并）。没有后台线程（测试）时什么也不做。
    pub fn request_sync(&self) {
        if let Some(sender) = lock(&self.trigger).as_ref() {
            let _ = sender.send(RunnerMsg::Trigger);
        }
    }

    pub fn connectivity(&self) -> Connectivity {
        *lock(&self.connectivity)
    }

    pub(crate) fn set_connectivity(&self, next: Connectivity) {
        let changed = {
            let mut current = lock(&self.connectivity);
            let changed = *current != next;
            *current = next;
            changed
        };
        if changed {
            self.emit_status();
        }
    }

    /// 网络不通：之后的读写直接走本地，后台按退避探测。
    pub(crate) fn went_offline(&self) {
        let was = self.connectivity();
        self.set_connectivity(Connectivity::Offline);
        if was != Connectivity::Offline {
            self.request_sync();
        }
    }

    /// 实时通道（SSE）的连通情况：连上 → 在线并同步一轮；网络断开 → 离线。
    pub fn note_link(&self, up: bool) {
        if up {
            self.retry_now();
            self.set_connectivity(Connectivity::Online);
            self.request_sync();
        } else {
            self.went_offline();
        }
    }

    /// 联网恢复：在退避的操作不再等，下一轮立即重发（同一个 op_id）。
    pub fn retry_now(&self) {
        let _ = lock(&self.db).execute(
            &format!("UPDATE outbox SET next_try_at = NULL WHERE state IN {}", db::UNSETTLED),
            [],
        );
    }

    pub fn is_offline(&self) -> bool {
        self.connectivity() == Connectivity::Offline
    }

    pub(crate) fn state(&self) -> Result<db::SyncState, SyncError> {
        Ok(db::load_state(&lock(&self.db))?.unwrap_or_default())
    }

    /// 副本完整拉取过至少一次：离线读才有意义。
    pub fn replica_ready(&self) -> bool {
        self.state().map(|state| state.last_pull_at.is_some()).unwrap_or(false)
    }

    pub fn unsettled(&self) -> i64 {
        db::unsettled_count(&lock(&self.db)).unwrap_or(0)
    }

    /// 读命令是否走本地：离线、刚启动（先用副本秒开），或还有没补交完的本地写（服务器还看不到它们）。
    pub fn reads_local(&self) -> bool {
        self.replica_ready() && (self.connectivity() != Connectivity::Online || self.unsettled() > 0)
    }

    /// 离线允许的写是否走本地：已知离线，或前面还有没补交完的（保持顺序，基线才对得上）。
    fn writes_local(&self) -> bool {
        self.is_offline() || self.unsettled() > 0
    }

    pub fn status(&self) -> SyncStatus {
        let (pending, conflicts, failed) = db::counts(&lock(&self.db)).unwrap_or((0, 0, 0));
        let state = match self.connectivity() {
            Connectivity::Offline => "offline",
            Connectivity::Unknown => "syncing",
            Connectivity::Online if self.syncing.load(Ordering::SeqCst) => "syncing",
            Connectivity::Online => "online",
        };
        SyncStatus { state, pending, conflicts, failed }
    }

    pub(crate) fn emit_status(&self) {
        self.emit(SyncEvent::Status(self.status()));
    }

    /// 用户看过冲突与失败的提示：计数清零（记录保留到下一轮收敛时删除）。
    pub fn dismiss_notices(&self) {
        let _ = lock(&self.db).execute(
            "UPDATE outbox SET dismissed = 1 WHERE state IN ('conflicted','failed')",
            [],
        );
        self.emit_status();
    }

    fn offline_error(&self, command: &str) -> RemoteError {
        RemoteError {
            server: self.client.server().to_string(),
            command: command.to_string(),
            status: None,
            code: "OFFLINE".to_string(),
            message: offline_message(command),
            detail: None,
        }
    }

    pub(crate) fn remote_error(&self, command: &str, error: LocalError) -> RemoteError {
        RemoteError {
            server: self.client.server().to_string(),
            command: command.to_string(),
            status: error.status,
            code: error.code,
            message: error.message,
            detail: error.detail.map(Box::new),
        }
    }

    fn internal_error(&self, command: &str, error: impl std::fmt::Display) -> RemoteError {
        RemoteError {
            server: self.client.server().to_string(),
            command: command.to_string(),
            status: Some(500),
            code: "LOCAL".to_string(),
            message: format!("本地副本出错：{error}"),
            detail: None,
        }
    }

    // ---- 命令入口 ----

    /// 执行一个命令（与 `POST /api/rpc/{命令}` 同名同参）。失败的形状与服务器错误一致；
    /// 离线时不允许的命令返回 `status: None`、说明文字以「需要联网：」开头。
    pub fn invoke(&self, command: &str, args: Value) -> Result<Value, RemoteError> {
        match classify(command) {
            CommandClass::LocalRead => self.invoke_read(command, args),
            CommandClass::OfflineWrite => self.invoke_offline_write(command, args),
            CommandClass::OnlineOnly => self.invoke_online(command, args),
        }
    }

    fn invoke_read(&self, command: &str, args: Value) -> Result<Value, RemoteError> {
        // 密匣快照不在本机层里：只要连得上就问服务器，真离线才用缓存的密文快照。
        let local_first = if command == "lockbox_snapshot" { self.is_offline() } else { self.reads_local() };
        if local_first {
            return self.local_read(command, args);
        }
        match self.client.read(command, args.clone()) {
            Ok(value) => {
                self.set_connectivity(Connectivity::Online);
                self.observe(command, &value);
                Ok(value)
            }
            Err(error) if error.is_retryable() => {
                self.went_offline();
                // 密匣快照的缓存不依赖副本是否拉全过。
                if self.replica_ready() || command == "lockbox_snapshot" {
                    self.local_read(command, args)
                } else {
                    Err(self.offline_error(command))
                }
            }
            Err(error) => {
                if error.status.is_some() {
                    self.set_connectivity(Connectivity::Online);
                }
                Err(error)
            }
        }
    }

    fn invoke_offline_write(&self, command: &str, args: Value) -> Result<Value, RemoteError> {
        let op = prepare(command, args);
        if self.writes_local() {
            if !self.replica_ready() {
                return Err(self.offline_error(command));
            }
            return self.local_write(&op).map_err(|error| self.remote_error(command, error));
        }
        match self.client.write_with_key_at(command, &op.args, &op.op_id, op.utc_offset) {
            Ok(value) => {
                self.set_connectivity(Connectivity::Online);
                self.request_sync();
                Ok(value)
            }
            Err(error) if error.is_retryable() => {
                // 请求可能已经送达：同一个 op_id、同一个请求体进 outbox，补交时服务器按幂等键回放，不会重复。
                self.went_offline();
                if !self.replica_ready() {
                    return Err(self.offline_error(command));
                }
                self.local_write(&op).map_err(|error| self.remote_error(command, error))
            }
            Err(error) => {
                if error.status.is_some() {
                    self.set_connectivity(Connectivity::Online);
                }
                Err(error)
            }
        }
    }

    fn invoke_online(&self, command: &str, args: Value) -> Result<Value, RemoteError> {
        if self.is_offline() {
            return Err(self.offline_error(command));
        }
        match self.client.write(command, args) {
            Ok(value) => {
                self.set_connectivity(Connectivity::Online);
                if !is_read_only(command) {
                    self.request_sync();
                }
                Ok(value)
            }
            Err(error) if error.is_retryable() => {
                self.went_offline();
                Err(self.offline_error(command))
            }
            Err(error) => {
                if error.status.is_some() {
                    self.set_connectivity(Connectivity::Online);
                }
                Err(error)
            }
        }
    }

    /// 在线读到的、离线时还要用的服务器信息。
    fn observe(&self, command: &str, value: &Value) {
        let conn = lock(&self.db);
        match command {
            "list_fragments" => {
                let identity = value.get("vaultPath").and_then(Value::as_str);
                let configured = value.pointer("/lockbox/configured").and_then(Value::as_bool).unwrap_or(false);
                let _ = conn.execute(
                    "UPDATE sync_state SET vault_identity = COALESCE(?1, vault_identity), lockbox_configured = ?2 WHERE id = 1",
                    rusqlite::params![identity, configured as i64],
                );
            }
            "lockbox_snapshot" => {
                let _ = conn.execute(
                    "UPDATE sync_state SET lockbox_snapshot = ?1 WHERE id = 1",
                    rusqlite::params![value.to_string()],
                );
            }
            _ => {}
        }
    }

    /// 上传附件字节（粘贴图片）。在线时直接上传；网络不通时先存本机，补交 `save_fragment_image` 前再传。
    /// 两种情况都在本机留一份，离线时登记图片要用到它。返回 sha。
    pub fn upload_blob(&self, bytes: &[u8]) -> Result<String, RemoteError> {
        let sha = shard_core::sha256_hex(bytes);
        let now = ids::stamp(Utc::now());
        if !self.is_offline() {
            match self.client.upload_blob(bytes) {
                Ok(_) => {
                    self.set_connectivity(Connectivity::Online);
                    db::put_pending_blob(&lock(&self.db), &sha, bytes, true, &now)
                        .map_err(|error| self.internal_error("upload_blob", error))?;
                    return Ok(sha);
                }
                Err(error) if error.is_retryable() => self.went_offline(),
                Err(error) => return Err(error),
            }
        }
        db::put_pending_blob(&lock(&self.db), &sha, bytes, false, &now)
            .map_err(|error| self.internal_error("upload_blob", error))?;
        Ok(sha)
    }

    pub(crate) fn read_context(&self) -> ReadContext {
        let state = self.state().unwrap_or_default();
        let snapshot = db::lockbox_snapshot(&lock(&self.db)).ok().flatten();
        let identity = state.vault_identity.clone().unwrap_or_else(|| {
            let host = self
                .client
                .server()
                .split("://")
                .nth(1)
                .unwrap_or_default()
                .split(':')
                .next()
                .unwrap_or_default()
                .to_string();
            format!("shard://{host}/{}", state.vault_id)
        });
        ReadContext {
            vault_identity: identity,
            epoch: state.epoch,
            lockbox_configured: state.lockbox_configured,
            lockbox_snapshot: snapshot,
        }
    }

    /// 服务器的 `vaultPath`（离线时发出的 `vault-changed` 载荷带上它，与服务器推的同形）。
    pub fn vault_identity(&self) -> String {
        self.read_context().vault_identity
    }

    /// 在「副本 ∪ overlay」上跑读命令。
    pub fn local_read(&self, command: &str, args: Value) -> Result<Value, RemoteError> {
        let context = self.read_context();
        let _local = self.local.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut reader = lock(&self.reader);
        let tx = reader.transaction().map_err(|error| self.internal_error(command, error))?;
        let source = self.options.source.clone();
        let result = self.replica.read(|base| {
            let vfs = OverlayVfs::new(base, &tx, false);
            let cx = VaultCtx::local(&vfs, &NoHooks).with_clock(offset_of(utc_offset_minutes()), &source);
            local::read(command, args, &cx, &context)
        });
        drop(tx);
        match result {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(self.remote_error(command, error)),
            Err(error) => Err(self.internal_error(command, error)),
        }
    }

    /// 本机可见的一个资料库文件（离线显示图片）：`None` 表示没有。
    pub fn local_file(&self, rel: &str) -> Option<Vec<u8>> {
        let _local = self.local.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut reader = lock(&self.reader);
        let tx = reader.transaction().ok()?;
        let result = self.replica.read(|base| {
            let vfs = OverlayVfs::new(base, &tx, false);
            let path = shard_vault::resolve_vault_asset_path(&vfs, rel).ok()?;
            shard_core::Vfs::read(&vfs, &path).ok()
        });
        drop(tx);
        result.ok().flatten()
    }

    /// 离线允许的写：在 overlay 上执行并记进 outbox。
    fn local_write(&self, op: &PreparedOp) -> Result<Value, LocalError> {
        let (value, touched) = {
            let _local = self.local.write().unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut conn = lock(&self.db);
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| LocalError::new(500, "LOCAL", error.to_string()))?;
            let applied = self.apply_local(&tx, op, true)?;
            tx.commit().map_err(|error| LocalError::new(500, "LOCAL", error.to_string()))?;
            applied
        };
        // 与在线时服务器经 SSE 回推自己的写入一样，发一次同形的 `vault-changed`（界面按 sha 判断要不要刷新）。
        let changes = self.effective(touched.into_values().map(|(path, _)| path));
        if !changes.is_empty() {
            self.emit(SyncEvent::VaultChanged(changes));
        }
        self.emit_status();
        self.request_sync();
        Ok(value)
    }

    /// 在 overlay 上执行一条写并记进 outbox（调用方持本地写锁，`tx` 是写事务）。
    /// `merge` 为假时不与前一条合并（冲突副本、恢复补交）。返回 (结果, 写过的条目)。
    pub(crate) fn apply_local(
        &self,
        tx: &Connection,
        op: &PreparedOp,
        merge: bool,
    ) -> Result<(Value, Touched), LocalError> {
        let source = self.options.source.clone();
        let outcome = self
            .replica
            .read(|base| {
                let vfs = OverlayVfs::new(base, tx, true);
                let cx = VaultCtx::local(&vfs, &NoHooks).with_clock(offset_of(op.utc_offset), &source);
                let blob = |sha: &str| db::pending_blob(tx, sha).ok().flatten().map(|(bytes, _)| bytes);
                let (value, plan) = local::write(&op.command, &op.args, &cx, &blob)?;
                Ok::<(Value, WritePlan, Touched), LocalError>((value, plan, vfs.touched()))
            })
            .map_err(|error| LocalError::new(500, "LOCAL", error.to_string()))??;
        let (value, plan, touched) = outcome;
        crate::queue::enqueue(tx, op, &value, &plan, &touched, merge)
            .map_err(|error| LocalError::new(500, "LOCAL", error.to_string()))?;
        Ok((value, touched))
    }

    // ---- 一轮同步 ----

    /// 跑一轮：拉 → 推 → 再拉 → 收敛本地层。单飞：已有一轮在跑时等它结束再跑。
    pub fn sync_round(&self) -> RoundReport {
        let _round = lock(&self.round);
        let mut report = RoundReport::default();
        self.syncing.store(true, Ordering::SeqCst);
        if self.connectivity() != Connectivity::Offline {
            self.emit_status();
        }
        let mut changes: Vec<VaultChange> = Vec::new();
        let mut pulled_last = false;
        let was_offline = self.is_offline();
        match self.pull() {
            Ok(outcome) => {
                // 刚从离线恢复：在退避的操作马上重发。
                if was_offline {
                    self.retry_now();
                }
                self.set_connectivity(Connectivity::Online);
                report.reconciled = outcome.reconciled;
                report.recovered = outcome.recovered;
                changes.extend(outcome.changes);
                pulled_last = true;
            }
            Err(error) => self.round_error(&mut report, error),
        }
        if pulled_last {
            let push = self.push();
            report.acked = push.acked;
            report.conflicts = push.conflicts;
            report.failed = push.failed;
            report.retry_at = push.retry_at;
            changes.extend(push.changes);
            if let Some(error) = push.error {
                pulled_last = false;
                self.round_error(&mut report, error);
            }
            if pulled_last && (push.acked > 0 || push.conflicts > 0) {
                match self.pull() {
                    Ok(outcome) => changes.extend(outcome.changes),
                    Err(error) => {
                        pulled_last = false;
                        self.round_error(&mut report, error);
                    }
                }
            }
        }
        if pulled_last {
            match self.settle() {
                Ok(dropped) => changes.extend(dropped),
                Err(error) => report.error = Some(error.to_string()),
            }
            let _ = lock(&self.db).execute(
                "UPDATE sync_state SET last_push_at = ?1 WHERE id = 1",
                rusqlite::params![ids::stamp(Utc::now())],
            );
            self.maintain();
        }
        report.pulled = changes.len();
        let changes = dedupe_changes(changes);
        if !changes.is_empty() {
            self.emit(SyncEvent::VaultChanged(changes));
        }
        self.syncing.store(false, Ordering::SeqCst);
        self.emit_status();
        report
    }

    /// 每天至多一次：副本自己的变化日志没人读，清掉；不再被引用的 blob 过了宽限期删掉。失败不影响同步。
    fn maintain(&self) {
        let mut maintained_at = lock(&self.maintained_at);
        if maintained_at.is_some_and(|at| at.elapsed() < MAINTENANCE_EVERY) {
            return;
        }
        *maintained_at = Some(std::time::Instant::now());
        drop(maintained_at);
        let _local = self.local.write().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Err(error) = self.replica.prune_replica_log() {
            eprintln!("整理本机副本失败：{error}");
        }
        if let Err(error) = self.replica.collect_blobs(Utc::now()) {
            eprintln!("回收本机副本的附件失败：{error}");
        }
    }

    fn round_error(&self, report: &mut RoundReport, error: SyncError) {
        if error.is_network() {
            report.offline = true;
            self.went_offline();
        } else if let SyncError::Remote(remote) = &error {
            if remote.is_unauthenticated() {
                report.auth_required = true;
                self.emit(SyncEvent::AuthRequired);
            }
        }
        report.error = Some(error.to_string());
    }

    /// 本机可见的状态（overlay 优先），给 `vault-changed` 用。
    pub(crate) fn effective(&self, paths: impl IntoIterator<Item = String>) -> Vec<VaultChange> {
        let paths: Vec<String> = paths.into_iter().collect();
        if paths.is_empty() {
            return Vec::new();
        }
        let _local = self.local.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut reader = lock(&self.reader);
        let Ok(tx) = reader.transaction() else {
            return Vec::new();
        };
        let result = self.replica.read(|base| {
            let vfs = OverlayVfs::new(base, &tx, false);
            paths
                .iter()
                .map(|path| {
                    let abs = shard_core::Vfs::root(&vfs).join(path);
                    match shard_core::Vfs::metadata(&vfs, &abs) {
                        Ok(metadata) if metadata.is_dir() => VaultChange { path: path.clone(), exists: true, sha: None },
                        Ok(_) => VaultChange {
                            path: path.clone(),
                            exists: true,
                            sha: shard_core::Vfs::content_sha(&vfs, &abs).ok(),
                        },
                        Err(_) => VaultChange { path: path.clone(), exists: false, sha: None },
                    }
                })
                .collect::<Vec<_>>()
        });
        drop(tx);
        result.unwrap_or_default()
    }
}

/// 同一路径只留最后一条。
fn dedupe_changes(changes: Vec<VaultChange>) -> Vec<VaultChange> {
    let mut seen = BTreeMap::new();
    for (index, change) in changes.into_iter().enumerate() {
        seen.insert(change.path.clone(), (index, change));
    }
    let mut out: Vec<(usize, VaultChange)> = seen.into_values().collect();
    out.sort_by_key(|(index, _)| *index);
    out.into_iter().map(|(_, change)| change).collect()
}

/// 准备一条写：定 op_id（UUIDv7）与时区；`create_fragment` 没给 id 时补上客户端 id 与创建时间——
/// 在线直发也带上，这样网络失败转进 outbox 时请求体不变，离线显示的 id 补交后也不变。
pub(crate) fn prepare(command: &str, args: Value) -> PreparedOp {
    let utc_offset = utc_offset_minutes();
    let created_at = ids::now_at(utc_offset);
    let mut args = if args.is_object() { args } else { json!({}) };
    if command == "create_fragment" && args.get("id").is_none_or(Value::is_null) {
        args["id"] = json!(shard_core::new_fragment_id(&created_at));
        args["createdAt"] = json!(created_at.to_rfc3339());
    }
    PreparedOp { op_id: ids::uuid_v7(), command: command.to_string(), args, utc_offset, created_at }
}

/// 还没补交的操作另存成 JSON：换服务器、断开连接时用，原文不丢。
fn export_unsent(conn: &Connection, recovered_dir: Option<&Path>) -> rusqlite::Result<Option<PathBuf>> {
    let mut statement = conn.prepare(&format!(
        "SELECT op_id, command, args_json, created_at FROM outbox WHERE state IN {} ORDER BY op_seq",
        db::UNSETTLED
    ))?;
    let ops = statement
        .query_map([], |row| {
            let args: String = row.get(2)?;
            Ok(json!({
                "opId": row.get::<_, String>(0)?,
                "command": row.get::<_, String>(1)?,
                "args": serde_json::from_str::<Value>(&args).unwrap_or(Value::Null),
                "createdAt": row.get::<_, String>(3)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if ops.is_empty() {
        return Ok(None);
    }
    let Some(dir) = recovered_dir else {
        return Ok(None);
    };
    let path = dir.join(format!("unsent-{}.json", Utc::now().format("%Y%m%d-%H%M%S")));
    let written = fs::create_dir_all(dir)
        .and_then(|_| fs::write(&path, serde_json::to_vec_pretty(&json!({ "operations": ops })).unwrap_or_default()));
    Ok(written.ok().map(|_| path))
}
