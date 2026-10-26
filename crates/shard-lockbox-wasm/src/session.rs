//! 浏览器里的密匣会话：一个内存资料库（[`MemVfs`]）、服务器确认过的基线、可选的已解锁密钥。
//!
//! 每个命令都在内存资料库上跑 `shard_vault::lockbox` 里与桌面相同的函数（桌面在 src-tauri 只是这些函数外面
//! 一层会话外壳，这里是同样薄的另一层）。写操作跑完后按信封 id 比较前后的文件，换成对服务器的写入：
//! - 信封新增 / 改动 / 换路径（归档、恢复是同 id 换路径）→ `lockbox_apply` 里的一条 put；消失 → delete；
//! - manifest 改动（设置、改口令、重置、旧 manifest 补写入密钥对）→ `lockbox_apply` 的 manifest 写入；
//! - 公开碎片被移入密匣（公开文件消失、同 id 的信封出现）→ `seal_fragment_into_lockbox`。
//!
//! 服务器确认后调用方用 [`Session::call`] 的 `commit` 推进基线；失败用 `rollback` 退回基线；409 时调用方重取
//! 快照走 `replace_snapshot`。主密钥只在这里（wasm 内存）：上锁、快照被撤回、换掉密钥时清零。
//!
//! 不依赖 wasm-bindgen：wasm 外壳（`lib.rs`）只把 JSON 转进转出，这里用原生 `cargo test` 测。

use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime},
};

use chrono::FixedOffset;
use serde::Deserialize;
use serde_json::{json, Value};
use shard_core::{contains_lockbox_tag, MemVfs, Vfs};
use shard_lockbox::{Manifest, ReadKeys};
use shard_vault::{
    content_sha256_hex, find_fragment_path, find_lockbox_fragment_path, is_protected_type,
    lockbox::{self as domain, MigratedLockboxDialectSource},
    normalize_new_fragment, normalize_updated_type_tags, property_input_to_yaml,
    search::{
        invalid_request, is_markdown_target, parse_search_query, resolve_target_file, snapshot_id,
        validate_loaded_identity, validate_search_request, validate_target_identity,
        LoadedSearchDocument, ReadSearchTargetRequest, ReadSearchTargetResponse, SearchContext,
        SearchError, SearchIndexState, SearchScope, SearchSnapshotData, SearchVaultRequest,
        SearchVaultResponse,
    },
    update_public_fragment_by_id, update_public_fragment_tags_by_id, NoHooks, PropertyInputValue,
    PublicFragmentUpdate, VaultCtx, LOCKBOX_TYPE_ERROR,
};
use zeroize::Zeroize;

/// 内存资料库的根。只是个标识，`Fragment.path` 等都是相对它的路径。
pub const ROOT: &str = "/vault";
const MANIFEST_PATH: &str = ".shard/lockbox.json";
/// 网页上新建的内容记的来源（密匣碎片是 `web-lockbox`）。
const SOURCE: &str = "web";
/// 网页端的搜索上下文没有资料库代次（服务器 epoch 变化时整个页面会重新同步），固定为 0。
const VAULT_EPOCH: &str = "0";

/// 「允许在网页解锁密匣」关掉时，网页上所有会解出主密钥的操作都拒绝。
pub const WEB_UNLOCK_DISABLED: &str = "网页解锁已关闭：可在账号设置里打开「允许在网页解锁密匣」，或到桌面应用里使用密匣。";

static NO_HOOKS: NoHooks = NoHooks;

/// 命令的错误：领域错误是界面直接显示的字符串（与桌面一字不差）；搜索命令的错误是结构化对象。
#[derive(Debug, PartialEq)]
pub enum CallError {
    Message(String),
    Search(SearchError),
}

impl From<String> for CallError {
    fn from(message: String) -> Self {
        Self::Message(message)
    }
}

impl From<&str> for CallError {
    fn from(message: &str) -> Self {
        Self::Message(message.to_string())
    }
}

impl From<SearchError> for CallError {
    fn from(error: SearchError) -> Self {
        Self::Search(error)
    }
}

type CallResult = Result<Value, CallError>;

fn parse<T: serde::de::DeserializeOwned>(args: &Value) -> Result<T, CallError> {
    serde_json::from_value(args.clone()).map_err(|error| CallError::Message(format!("参数无效：{error}")))
}

// ---------------------------------------------------------------------------
// 服务器快照与基线
// ---------------------------------------------------------------------------

/// `lockbox_snapshot` 的返回（见 crates/shard-server/src/lockbox.rs）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(default)]
    pub manifest: Option<SnapshotManifest>,
    #[serde(default)]
    pub items: Vec<SnapshotItem>,
    #[serde(default)]
    pub items_withheld: bool,
    #[serde(default = "default_true")]
    pub web_unlock: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
pub struct SnapshotManifest {
    pub body: String,
    pub sha: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SnapshotItem {
    pub id: String,
    pub envelope: String,
    pub sha: String,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct BaseItem {
    envelope: String,
    sha: String,
    /// 服务器记的导出路径；没有时按 id 推出（见 [`effective_path`]）。
    path: Option<String>,
}

/// 服务器确认过的状态。内存资料库在没有待确认写入时与它一致。
#[derive(Debug, Clone, Default)]
struct Base {
    manifest: Option<(String, String)>,
    items: BTreeMap<String, BaseItem>,
}

/// 与服务器 `valid_path` 相同的规则：`lockbox/…/x.shard`，不许跳出。
fn valid_item_path(path: &str) -> bool {
    path.starts_with("lockbox/")
        && path.ends_with(".shard")
        && !path.contains('\\')
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('.')
        && !id.chars().any(|char| char == '/' || char == '\\' || char.is_control())
}

/// 信封在内存资料库里的路径：服务器记了就用它；没有就按 id 推出 `lockbox/fragments/YYYY/MM/<id>.shard`
/// （碎片 id 以 `YYYYMMDD-` 开头；不是这种形状的放在 `lockbox/fragments/` 下）。
pub fn effective_path(id: &str, path: Option<&str>) -> Option<String> {
    if let Some(path) = path.filter(|path| valid_item_path(path)) {
        return Some(path.to_string());
    }
    if !valid_id(id) {
        return None;
    }
    let bytes = id.as_bytes();
    if bytes.len() > 8 && bytes[..8].iter().all(u8::is_ascii_digit) && bytes[8] == b'-' {
        return Some(format!("lockbox/fragments/{}/{}/{id}.shard", &id[..4], &id[4..6]));
    }
    Some(format!("lockbox/fragments/{id}.shard"))
}

// ---------------------------------------------------------------------------
// 前后比较
// ---------------------------------------------------------------------------

/// 一次操作前后内存资料库里与服务器有关的文件。
#[derive(Debug, Default)]
struct Files {
    manifest: Option<String>,
    /// 信封 id → (相对路径, 原文)。
    items: BTreeMap<String, (String, String)>,
    /// 公开碎片与笔记（只在「移入密匣」时临时放进来）：相对路径 → 原文。
    public: BTreeMap<String, String>,
}

#[derive(serde::Deserialize)]
struct EnvelopeId {
    id: String,
}

fn is_public_markdown(path: &str) -> bool {
    path.ends_with(".md")
        && (path.starts_with("fragments/") || path.starts_with("notes/") || path.starts_with(".trash/"))
}

#[derive(Debug, Clone)]
struct PendingPut {
    id: String,
    envelope: String,
    /// 发给服务器的路径：新条目或换了路径才带。
    path: Option<String>,
    expected_sha: Option<String>,
}

#[derive(Debug, Clone)]
struct PendingSeal {
    fragment_id: String,
    expected_file_sha: String,
    envelope: String,
    path: String,
}

/// 一次写操作算出的、等服务器确认的改动。
#[derive(Debug, Clone, Default)]
struct Pending {
    manifest: Option<String>,
    manifest_expected_sha: Option<String>,
    puts: Vec<PendingPut>,
    deletes: Vec<(String, String)>,
    seal: Option<PendingSeal>,
}

impl Pending {
    fn is_empty(&self) -> bool {
        self.manifest.is_none() && self.puts.is_empty() && self.deletes.is_empty() && self.seal.is_none()
    }

    /// 给调用方的写入载荷：`apply` 原样作为 `lockbox_apply` 的参数，`seal` 作为 `seal_fragment_into_lockbox` 的参数。
    /// 两者都有时先发 `apply`（只可能是旧 manifest 补写入密钥对）。
    fn payload(&self) -> Value {
        let mut items = Vec::new();
        for put in &self.puts {
            let mut item = json!({ "op": "put", "id": put.id, "envelope": put.envelope, "expectedSha": put.expected_sha });
            if let Some(path) = &put.path {
                item["path"] = json!(path);
            }
            items.push(item);
        }
        for (id, expected_sha) in &self.deletes {
            items.push(json!({ "op": "delete", "id": id, "expectedSha": expected_sha }));
        }
        let apply = if self.manifest.is_some() || !items.is_empty() {
            let mut apply = json!({ "items": items });
            if let Some(body) = &self.manifest {
                apply["manifest"] = json!({ "body": body, "expectedSha": self.manifest_expected_sha });
            }
            apply
        } else {
            Value::Null
        };
        let seal = self.seal.as_ref().map_or(Value::Null, |seal| {
            json!({
                "fragmentId": seal.fragment_id,
                "expectedFileSha": seal.expected_file_sha,
                "item": { "id": seal.fragment_id, "envelope": seal.envelope, "path": seal.path },
            })
        });
        json!({ "apply": apply, "seal": seal })
    }
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

pub struct Session {
    vfs: MemVfs,
    base: Base,
    pending: Option<Pending>,
    keys: Option<ReadKeys>,
    /// 解锁、上锁、密钥被撤回时递增：搜索上下文的隐私代次。
    privacy_epoch: u64,
    web_unlock: bool,
    items_withheld: bool,
    loaded: bool,
    offset: FixedOffset,
    /// 调用方最近一次给的当前时间：内存资料库的文件时间（重建时沿用）。
    now: SystemTime,
    /// 内存资料库每变一次递增：密匣搜索快照的缓存键。
    generation: u64,
    search_cache: Option<(u64, u64, String, Arc<SearchSnapshotData>)>,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    pub fn new() -> Self {
        Self {
            vfs: MemVfs::new(ROOT),
            base: Base::default(),
            pending: None,
            keys: None,
            privacy_epoch: 1,
            web_unlock: true,
            items_withheld: false,
            loaded: false,
            offset: FixedOffset::east_opt(0).expect("UTC"),
            now: SystemTime::UNIX_EPOCH,
            generation: 0,
            search_cache: None,
        }
    }

    /// 命令入口。`args` 可带 `clock: { nowMs, utcOffsetMinutes }`：时区决定碎片 id、`lockbox/fragments/YYYY/MM`
    /// 与 frontmatter 时间（与服务端按 `X-Shard-UTC-Offset` 算一致），时间用作内存资料库的文件时间。
    pub fn call(&mut self, method: &str, args: Value) -> CallResult {
        self.apply_clock(&args);
        match method {
            "load" => self.load(&args),
            "state" => Ok(self.state()),
            "commit" => self.commit(&args),
            "rollback" => {
                self.rollback();
                Ok(self.state())
            }
            "setup" => self.setup(&args),
            "unlock" => self.unlock(&args),
            "lock" => {
                self.lock();
                Ok(self.state())
            }
            "change_password" => self.change_password(&args),
            "reset_password" => self.reset_password(&args),
            "list" => self.list(),
            "create" => self.create(&args),
            "update" => self.update(&args),
            "update_tags" => self.update_tags(&args),
            "set_pinned" => self.set_pinned(&args),
            "set_archived" => self.set_archived(&args),
            "set_property" => self.set_property(&args),
            "remove_property" => self.remove_property(&args),
            "move_public" => self.move_public(&args),
            "update_public" => self.update_public(&args),
            "dialect_list" => self.dialect_list(),
            "dialect_apply" => self.dialect_apply(&args),
            "search" => self.search(&args),
            "read_search_target" => self.read_search_target(&args),
            _ => Err(CallError::Message(format!("未知的密匣命令：{method}"))),
        }
    }

    fn apply_clock(&mut self, args: &Value) {
        let Some(clock) = args.get("clock") else {
            return;
        };
        if let Some(minutes) = clock.get("utcOffsetMinutes").and_then(Value::as_i64) {
            if let Some(offset) = i32::try_from(minutes * 60).ok().and_then(FixedOffset::east_opt) {
                self.offset = offset;
            }
        }
        if let Some(now_ms) = clock.get("nowMs").and_then(Value::as_f64) {
            if now_ms.is_finite() && now_ms >= 0.0 {
                self.now = SystemTime::UNIX_EPOCH + Duration::from_millis(now_ms as u64);
                self.vfs.set_time(self.now);
            }
        }
    }

    fn cx(&self) -> VaultCtx<'_> {
        VaultCtx { vfs: &self.vfs, hooks: &NO_HOOKS, offset: self.offset, source: SOURCE }
    }

    fn configured(&self) -> bool {
        self.base.manifest.is_some()
    }

    /// 给调用方的会话状态：传输层据此决定命令走不走密匣分支、网页解锁开关、列表合并。
    pub fn state(&self) -> Value {
        json!({
            "loaded": self.loaded,
            "configured": self.configured(),
            "unlocked": self.keys.is_some(),
            "webUnlock": self.web_unlock,
            "itemsWithheld": self.items_withheld,
            "itemIds": self.base.items.keys().collect::<Vec<_>>(),
            "privacyEpoch": self.privacy_epoch.to_string(),
            "pending": self.pending.is_some(),
        })
    }

    // ---- 快照与基线 ----

    /// 载入（或替换成）服务器快照。返回状态与相对上一份基线的变化（`vault-changed` 同形，供界面刷新）。
    fn load(&mut self, args: &Value) -> CallResult {
        let snapshot: Snapshot = parse(&args["snapshot"])?;
        let previous = std::mem::take(&mut self.base);
        let mut base = Base {
            manifest: snapshot.manifest.map(|manifest| (manifest.body, manifest.sha)),
            items: BTreeMap::new(),
        };
        for item in snapshot.items {
            base.items.insert(item.id, BaseItem { envelope: item.envelope, sha: item.sha, path: item.path });
        }
        let changes = base_changes(&previous, &base);
        self.base = base;
        self.web_unlock = snapshot.web_unlock;
        self.items_withheld = snapshot.items_withheld;
        self.loaded = true;
        self.pending = None;
        self.reset_to_base();
        self.revalidate_keys();
        Ok(json!({ "state": self.state(), "changes": changes }))
    }

    /// 新快照下密钥还能不能用：服务器扣下了信封（浏览器会话且网页解锁被关掉）、密匣没了、主密钥解不开
    /// 新 manifest 的写入私钥时上锁；否则按新 manifest 重新派生（例如别处补上了写入密钥对）。
    fn revalidate_keys(&mut self) {
        let Some(keys) = &self.keys else {
            return;
        };
        let refreshed = if self.items_withheld {
            None
        } else {
            self.base
                .manifest
                .as_ref()
                .and_then(|(body, _)| Manifest::parse(body).ok())
                .and_then(|manifest| manifest.read_keys(&keys.master_key).ok())
        };
        match refreshed {
            Some(keys) => self.set_keys(keys),
            None => self.lock(),
        }
    }

    fn reset_to_base(&mut self) {
        let vfs = MemVfs::new(ROOT);
        vfs.set_time(self.now);
        let root = PathBuf::from(ROOT);
        if let Some((body, _)) = &self.base.manifest {
            let _ = vfs.write_atomic(&root.join(MANIFEST_PATH), body.as_bytes());
        }
        for (id, item) in &self.base.items {
            let Some(path) = effective_path(id, item.path.as_deref()) else {
                continue;
            };
            let absolute = root.join(&path);
            // 两条信封落到同一个路径（不该发生）：后一条按 id 另放，免得互相覆盖。
            let absolute = if vfs.exists(&absolute) {
                match effective_path(id, None) {
                    Some(fallback) if !vfs.exists(&root.join(&fallback)) => root.join(fallback),
                    _ => continue,
                }
            } else {
                absolute
            };
            let _ = vfs.write_atomic(&absolute, item.envelope.as_bytes());
        }
        self.vfs = vfs;
        self.generation += 1;
    }

    fn files(&self) -> Files {
        let mut files = Files::default();
        for (path, bytes) in self.vfs.files() {
            let Ok(text) = String::from_utf8(bytes) else {
                continue;
            };
            if path == MANIFEST_PATH {
                files.manifest = Some(text);
            } else if path.starts_with("lockbox/") && path.ends_with(".shard") {
                if let Ok(envelope) = serde_json::from_str::<EnvelopeId>(&text) {
                    files.items.insert(envelope.id, (path, text));
                }
            } else if is_public_markdown(&path) {
                files.public.insert(path, text);
            }
        }
        files
    }

    fn diff(&self, before: &Files, after: &Files) -> Result<Pending, String> {
        let mut pending = Pending::default();
        if after.manifest != before.manifest {
            let body = after.manifest.clone().ok_or_else(|| "密匣设置不能删除。".to_string())?;
            pending.manifest = Some(body);
            pending.manifest_expected_sha = self.base.manifest.as_ref().map(|(_, sha)| sha.clone());
        }
        let mut created = Vec::new();
        for (id, (path, text)) in &after.items {
            let expected_sha = self.base.items.get(id).map(|item| item.sha.clone());
            match before.items.get(id) {
                Some((old_path, old_text)) if old_path == path && old_text == text => {}
                Some((old_path, _)) => pending.puts.push(PendingPut {
                    id: id.clone(),
                    envelope: text.clone(),
                    path: (old_path != path).then(|| path.clone()),
                    expected_sha,
                }),
                None => {
                    created.push(id.clone());
                    pending.puts.push(PendingPut {
                        id: id.clone(),
                        envelope: text.clone(),
                        path: Some(path.clone()),
                        expected_sha,
                    });
                }
            }
        }
        for id in before.items.keys() {
            if !after.items.contains_key(id) {
                let sha = self
                    .base
                    .items
                    .get(id)
                    .map(|item| item.sha.clone())
                    .ok_or_else(|| format!("密匣条目 {id} 不在服务器上，不能删除。"))?;
                pending.deletes.push((id.clone(), sha));
            }
        }

        let removed: Vec<&String> = before.public.keys().filter(|path| !after.public.contains_key(*path)).collect();
        let changed_public = after
            .public
            .iter()
            .any(|(path, text)| before.public.get(path) != Some(text));
        if changed_public {
            return Err("密匣操作不应改动公开内容。".to_string());
        }
        match removed.as_slice() {
            [] => {}
            [public_path] => {
                // 公开碎片移入密匣：同 id 的新信封连同删除公开文件交给服务器在一个事务里完成。
                let [id] = created.as_slice() else {
                    return Err("移入密匣应当正好生成一条密匣条目。".to_string());
                };
                let index = pending.puts.iter().position(|put| &put.id == id).expect("刚加入");
                let put = pending.puts.remove(index);
                pending.seal = Some(PendingSeal {
                    fragment_id: put.id,
                    expected_file_sha: content_sha256_hex(&before.public[*public_path]),
                    envelope: put.envelope,
                    path: put.path.expect("新条目带路径"),
                });
            }
            _ => return Err("一次只能移入一篇公开内容。".to_string()),
        }
        Ok(pending)
    }

    /// 跑一个写操作并算出待确认的改动。失败时内存资料库退回基线。
    fn write_op<T>(
        &mut self,
        op: impl FnOnce(&VaultCtx<'_>, Option<&ReadKeys>) -> Result<T, String>,
    ) -> Result<(T, Value), CallError> {
        if self.pending.is_some() {
            return Err("上一次密匣写入还没有完成，请稍后再试。".into());
        }
        let before = self.files();
        let result = {
            let cx = self.cx();
            op(&cx, self.keys.as_ref())
        };
        let value = match result {
            Ok(value) => value,
            Err(error) => {
                self.reset_to_base();
                return Err(error.into());
            }
        };
        let after = self.files();
        self.generation += 1;
        let pending = match self.diff(&before, &after) {
            Ok(pending) => pending,
            Err(error) => {
                self.reset_to_base();
                return Err(error.into());
            }
        };
        if pending.is_empty() {
            return Ok((value, Value::Null));
        }
        let payload = pending.payload();
        self.pending = Some(pending);
        Ok((value, payload))
    }

    fn op_result(result: impl serde::Serialize, write: Value) -> CallResult {
        Ok(json!({ "result": result, "write": write }))
    }

    fn forward() -> CallResult {
        Ok(json!({ "forward": true }))
    }

    /// 服务器确认了上一次写入：推进基线。`apply` / `seal` 是两个接口的原样返回。
    fn commit(&mut self, args: &Value) -> CallResult {
        let pending = self.pending.take().ok_or_else(|| "没有等待确认的密匣写入。".to_string())?;
        let apply = &args["apply"];
        let confirmed = |id: &str| -> Option<&Value> {
            apply["items"].as_array()?.iter().find(|item| item["id"].as_str() == Some(id))
        };
        if let Some(body) = pending.manifest {
            let sha = apply["manifest"]["sha"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| content_sha256_hex(&body));
            self.base.manifest = Some((body, sha));
        }
        for put in pending.puts {
            let server = confirmed(&put.id);
            let sha = server
                .and_then(|item| item["sha"].as_str())
                .map(str::to_string)
                .unwrap_or_else(|| content_sha256_hex(&put.envelope));
            let previous = self.base.items.get(&put.id).and_then(|item| item.path.clone());
            let path = server
                .and_then(|item| item["path"].as_str())
                .map(str::to_string)
                .or(put.path)
                .or(previous);
            self.base.items.insert(put.id, BaseItem { envelope: put.envelope, sha, path });
        }
        for (id, _) in pending.deletes {
            self.base.items.remove(&id);
        }
        if let Some(seal) = pending.seal {
            let item = &args["seal"]["item"];
            let sha = item["sha"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| content_sha256_hex(&seal.envelope));
            let path = item["path"].as_str().map(str::to_string).or(Some(seal.path));
            self.base.items.insert(seal.fragment_id, BaseItem { envelope: seal.envelope, sha, path });
        }
        // 内存资料库已经是写入后的样子；按基线重建一次，确保两者完全一致（例如移入密匣时临时放进来的公开文件）。
        self.reset_to_base();
        Ok(self.state())
    }

    fn rollback(&mut self) {
        self.pending = None;
        self.reset_to_base();
    }

    // ---- 密钥 ----

    fn set_keys(&mut self, keys: ReadKeys) {
        if let Some(mut previous) = self.keys.replace(keys) {
            previous.master_key.zeroize();
        }
    }

    /// 解锁（含设置、改口令、重置后视为已解锁）：按当前内存里的 manifest 派生读取密钥。
    fn unlock_with(&mut self, mut master_key: Vec<u8>) -> Result<(), CallError> {
        let keys = domain::read_lockbox_manifest(&self.vfs).and_then(|manifest| manifest.read_keys(&master_key));
        master_key.zeroize();
        self.set_keys(keys?);
        self.privacy_epoch += 1;
        self.search_cache = None;
        Ok(())
    }

    pub fn lock(&mut self) {
        if let Some(mut keys) = self.keys.take() {
            keys.master_key.zeroize();
            self.privacy_epoch += 1;
        }
        self.search_cache = None;
    }

    /// 桌面 `require_unlocked_lockbox_read_keys` 的同一套报错。
    fn require_keys(&self) -> Result<ReadKeys, CallError> {
        if !self.vfs.exists(&PathBuf::from(ROOT).join(MANIFEST_PATH)) {
            return Err("lockbox_not_configured".into());
        }
        self.keys.clone().ok_or_else(|| "lockbox_locked".into())
    }

    /// 服务器扣下了信封（只对浏览器会话、且「允许在网页解锁密匣」关掉时）：会解出主密钥的操作一律拒绝。
    /// 看 `itemsWithheld` 而不是 `webUnlock`：桌面连服务器时开关关着也照常下发，照常能解锁。
    fn ensure_web_unlock(&self) -> Result<(), CallError> {
        if self.items_withheld {
            Err(WEB_UNLOCK_DISABLED.into())
        } else {
            Ok(())
        }
    }

    // ---- 设置、解锁、改口令、重置 ----

    fn setup(&mut self, args: &Value) -> CallResult {
        let password = args["password"].as_str().unwrap_or_default().to_string();
        self.ensure_web_unlock()?;
        let (setup, write) = self.write_op(|cx, _| domain::setup_lockbox(cx, &password))?;
        let shard_vault::lockbox::LockboxSetup { recovery_key, master_key } = setup;
        self.unlock_with(master_key)?;
        Self::op_result(json!({ "recoveryKey": recovery_key }), write)
    }

    fn unlock(&mut self, args: &Value) -> CallResult {
        let password = args["password"].as_str().unwrap_or_default().to_string();
        self.ensure_web_unlock()?;
        let (master_key, write) = self.write_op(|cx, _| domain::unlock_lockbox(cx, &password))?;
        self.unlock_with(master_key)?;
        Self::op_result(Value::Null, write)
    }

    fn change_password(&mut self, args: &Value) -> CallResult {
        let current = args["currentPassword"].as_str().unwrap_or_default().to_string();
        let next = args["newPassword"].as_str().unwrap_or_default().to_string();
        self.ensure_web_unlock()?;
        let (master_key, write) = self.write_op(|cx, _| domain::change_lockbox_password(cx, &current, &next))?;
        self.unlock_with(master_key)?;
        Self::op_result(Value::Null, write)
    }

    fn reset_password(&mut self, args: &Value) -> CallResult {
        let recovery_key = args["recoveryKey"].as_str().unwrap_or_default().to_string();
        let next = args["newPassword"].as_str().unwrap_or_default().to_string();
        self.ensure_web_unlock()?;
        let (reset, write) = self.write_op(|cx, _| domain::reset_lockbox_password(cx, &recovery_key, &next))?;
        let shard_vault::lockbox::LockboxSetup { recovery_key, master_key } = reset;
        self.unlock_with(master_key)?;
        Self::op_result(json!({ "recoveryKey": recovery_key }), write)
    }

    // ---- 碎片 ----

    /// 已解锁时的全部密匣碎片与笔记（未排序，调用方与公开列表合并后按桌面规则排序）；锁着时为空。
    fn list(&self) -> CallResult {
        let Some(keys) = &self.keys else {
            return Ok(json!([]));
        };
        let fragments = domain::list_lockbox_fragments(&self.cx(), &HashSet::new(), keys)?;
        Ok(json!(fragments))
    }

    fn lockbox_path(&self, id: &str) -> Result<Option<PathBuf>, CallError> {
        Ok(find_lockbox_fragment_path(&self.vfs, id)?)
    }

    /// `create_fragment`：与桌面同序——规整输入，带密匣标签才走密匣（否则交回服务器），大纲 / 流程图拒绝。
    fn create(&mut self, args: &Value) -> CallResult {
        let content = args["content"].as_str().unwrap_or_default();
        let tags: Option<Vec<String>> = parse(&args["tags"])?;
        let (content, tags) = normalize_new_fragment(content, tags)?;
        if !contains_lockbox_tag(&tags) {
            return Self::forward();
        }
        if is_protected_type(&tags) {
            return Err(LOCKBOX_TYPE_ERROR.into());
        }
        let (fragment, write) =
            self.write_op(|cx, keys| domain::create_lockbox_fragment(cx, keys, &content, tags))?;
        Self::op_result(fragment, write)
    }

    fn update(&mut self, args: &Value) -> CallResult {
        let id = args["id"].as_str().unwrap_or_default();
        let content = args["content"].as_str().unwrap_or_default().to_string();
        if content.trim().is_empty() {
            return Err("片段内容不能为空".into());
        }
        let Some(path) = self.lockbox_path(id)? else {
            return Self::forward();
        };
        let keys = self.require_keys()?;
        let tags: Option<Vec<String>> = parse(&args["tags"])?;
        let expected = args["expectedFileSha"].as_str().map(str::to_string);
        let (fragment, write) = self.write_op(|cx, _| {
            domain::update_lockbox_fragment_in_vault(
                cx,
                &path,
                &keys,
                content.trim(),
                tags.unwrap_or_default(),
                expected.as_deref(),
            )
        })?;
        Self::op_result(fragment, write)
    }

    fn update_tags(&mut self, args: &Value) -> CallResult {
        let id = args["id"].as_str().unwrap_or_default();
        let Some(path) = self.lockbox_path(id)? else {
            return Self::forward();
        };
        let keys = self.require_keys()?;
        let tags: Vec<String> = parse(&args["tags"])?;
        let (fragment, write) =
            self.write_op(|cx, _| domain::update_lockbox_fragment_tags_in_vault(cx, &path, &keys, tags))?;
        Self::op_result(fragment, write)
    }

    fn set_pinned(&mut self, args: &Value) -> CallResult {
        let id = args["id"].as_str().unwrap_or_default();
        let Some(path) = self.lockbox_path(id)? else {
            return Self::forward();
        };
        let keys = self.require_keys()?;
        let pinned = args["pinned"].as_bool().unwrap_or_default();
        let (fragment, write) =
            self.write_op(|cx, _| domain::set_lockbox_fragment_pinned_in_vault(cx, &path, &keys, pinned))?;
        Self::op_result(fragment, write)
    }

    fn set_archived(&mut self, args: &Value) -> CallResult {
        let id = args["id"].as_str().unwrap_or_default();
        let Some(path) = self.lockbox_path(id)? else {
            return Self::forward();
        };
        let keys = self.require_keys()?;
        let archived = args["archived"].as_bool().unwrap_or_default();
        let (fragment, write) =
            self.write_op(|cx, _| domain::set_lockbox_fragment_archived_in_vault(cx, &path, &keys, archived))?;
        Self::op_result(fragment, write)
    }

    /// 桌面顺序：先换算属性值、再校验键名、再分流密匣。不是密匣条目时交回服务器（服务器同序校验）。
    fn set_property(&mut self, args: &Value) -> CallResult {
        let id = args["id"].as_str().unwrap_or_default();
        let Some(path) = self.lockbox_path(id)? else {
            return Self::forward();
        };
        let value: PropertyInputValue = parse(&args["value"])?;
        let value = property_input_to_yaml(value)?;
        let key = args["key"].as_str().unwrap_or_default().to_string();
        shard_core::frontmatter::validate_property_key(&key)?;
        let keys = self.require_keys()?;
        let (fragment, write) = self.write_op(|cx, _| {
            domain::mutate_lockbox_fragment_property_in_vault(cx, &path, &keys, &key, Some(&value))
        })?;
        Self::op_result(fragment, write)
    }

    fn remove_property(&mut self, args: &Value) -> CallResult {
        let id = args["id"].as_str().unwrap_or_default();
        let Some(path) = self.lockbox_path(id)? else {
            return Self::forward();
        };
        let key = args["key"].as_str().unwrap_or_default().to_string();
        shard_core::frontmatter::validate_property_key(&key)?;
        let keys = self.require_keys()?;
        let (fragment, write) =
            self.write_op(|cx, _| domain::mutate_lockbox_fragment_property_in_vault(cx, &path, &keys, &key, None))?;
        Self::op_result(fragment, write)
    }

    /// 把一篇公开原文临时放进内存资料库（只在移入密匣时用，写入服务器后由基线重建清掉）。
    fn place_public(&mut self, path: &str, text: &str) -> Result<PathBuf, CallError> {
        if !is_public_markdown(path) || path.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
            return Err(CallError::Message(format!("公开文档路径无效：{path}")));
        }
        if self.pending.is_some() {
            return Err("上一次密匣写入还没有完成，请稍后再试。".into());
        }
        let absolute = PathBuf::from(ROOT).join(path);
        self.vfs
            .write_atomic(&absolute, text.as_bytes())
            .map_err(|error| CallError::Message(error.to_string()))?;
        Ok(absolute)
    }

    /// `move_fragment_to_lockbox`：调用方给出公开碎片的原文（与服务器上的 sha 一致），这里按桌面同序检查后加密，
    /// 写入载荷是 `seal_fragment_into_lockbox`。
    fn move_public(&mut self, args: &Value) -> CallResult {
        let id = args["id"].as_str().unwrap_or_default().to_string();
        self.place_public(args["path"].as_str().unwrap_or_default(), args["text"].as_str().unwrap_or_default())?;
        let found = find_fragment_path(&self.vfs, &id);
        let path = match found {
            Ok(Some(path)) => path,
            Ok(None) => {
                self.reset_to_base();
                return Err(CallError::Message(format!("找不到片段 {id}")));
            }
            Err(error) => {
                self.reset_to_base();
                return Err(error.into());
            }
        };
        let (fragment, write) = self.write_op(|cx, keys| {
            let text = cx.vfs.read_to_string(&path).map_err(|error| error.to_string())?;
            let parsed = shard_core::frontmatter::parse_fragment(&text)?;
            if is_protected_type(&parsed.frontmatter.tags) {
                return Err(LOCKBOX_TYPE_ERROR.to_string());
            }
            domain::move_public_fragment_to_lockbox(cx, keys, &path)
        })?;
        Self::op_result(fragment, write)
    }

    /// `update_fragment` / `update_fragment_tags` 改公开碎片、新标签带上密匣标签：桌面把它整篇移入密匣。
    /// 调用方给出公开原文；不是这种情况就交回服务器。
    fn update_public(&mut self, args: &Value) -> CallResult {
        let id = args["id"].as_str().unwrap_or_default().to_string();
        let tags_only = args["tagsOnly"].as_bool().unwrap_or_default();
        let content = args["content"].as_str().unwrap_or_default().to_string();
        let tags: Vec<String> = if tags_only {
            parse(&args["tags"])?
        } else {
            parse::<Option<Vec<String>>>(&args["tags"])?.unwrap_or_default()
        };
        let expected = args["expectedFileSha"].as_str().map(str::to_string);
        self.place_public(args["path"].as_str().unwrap_or_default(), args["text"].as_str().unwrap_or_default())?;

        // 只判断「会不会移入密匣」，判断规则与 update_public_fragment_*_by_id 相同；其余情况整条交回服务器。
        let moves = find_fragment_path(&self.vfs, &id)
            .ok()
            .flatten()
            .and_then(|path| self.vfs.read_to_string(&path).ok())
            .and_then(|text| shard_core::frontmatter::parse_fragment(&text).ok())
            .is_some_and(|parsed| {
                contains_lockbox_tag(&normalize_updated_type_tags(&parsed.frontmatter.tags, tags.clone()))
            });
        if !moves || (!tags_only && content.trim().is_empty()) {
            self.reset_to_base();
            return Self::forward();
        }

        let (fragment, write) = self.write_op(|cx, keys| {
            let update = if tags_only {
                update_public_fragment_tags_by_id(cx, &id, tags)?
            } else {
                update_public_fragment_by_id(cx, &id, &content, tags, expected.as_deref())?
            };
            match update {
                PublicFragmentUpdate::MoveToLockbox { path, content, tags } => {
                    domain::move_public_fragment_content_to_lockbox(cx, keys, &path, &content, tags)
                }
                PublicFragmentUpdate::Saved(_) => Err("内部错误：应当移入密匣。".to_string()),
            }
        })?;
        Self::op_result(fragment, write)
    }

    // ---- Markdown 方言迁移 ----

    fn dialect_list(&mut self) -> CallResult {
        let keys = self.require_keys()?;
        let sources = domain::list_lockbox_dialect_sources(&self.cx(), &keys)?;
        Ok(json!(sources))
    }

    fn dialect_apply(&mut self, args: &Value) -> CallResult {
        let files: Vec<MigratedLockboxDialectSource> = parse(&args["files"])?;
        let keys = self.require_keys()?;
        let (count, write) = self.write_op(|cx, _| domain::apply_lockbox_dialect_migration(cx, &keys, files))?;
        Self::op_result(count, write)
    }

    // ---- 搜索（密匣范围只在这里，服务器的密匣范围一律 locked） ----

    fn search_context(&self, vault_path: &str) -> SearchContext {
        SearchContext {
            vault_path: vault_path.to_string(),
            vault_epoch: VAULT_EPOCH.to_string(),
            privacy_epoch: self.privacy_epoch.to_string(),
        }
    }

    /// 桌面 `resolve_context` + 租约校验：请求的上下文必须是当前资料库、当前隐私代次。
    fn check_context(
        &self,
        vault_path: &str,
        expected_vault_path: &str,
        requested: Option<&SearchContext>,
    ) -> Result<SearchContext, SearchError> {
        if expected_vault_path.is_empty() || expected_vault_path != vault_path {
            return Err(SearchError::VaultChanged);
        }
        let current = self.search_context(vault_path);
        if let Some(requested) = requested {
            if requested.vault_path != vault_path {
                return Err(SearchError::VaultChanged);
            }
            if requested.vault_epoch != current.vault_epoch || requested.privacy_epoch != current.privacy_epoch {
                return Err(SearchError::ContextExpired);
            }
        }
        Ok(current)
    }

    fn search_snapshot(&mut self, vault_path: &str, keys: &ReadKeys) -> Arc<SearchSnapshotData> {
        if let Some((generation, epoch, path, snapshot)) = &self.search_cache {
            if *generation == self.generation && *epoch == self.privacy_epoch && path == vault_path {
                return Arc::clone(snapshot);
            }
        }
        let mut loaded: Vec<LoadedSearchDocument> = Vec::new();
        let mut skipped = 0u32;
        for (path, bytes) in self.vfs.files() {
            let in_scope = ["lockbox/fragments/", "lockbox/archive/", "lockbox/notes/"]
                .iter()
                .any(|root| path.starts_with(root));
            if !in_scope || !path.ends_with(".shard") {
                continue;
            }
            let document = String::from_utf8(bytes)
                .map_err(|_| SearchError::Io { retryable: false })
                .and_then(|text| domain::lockbox_search_document(vault_path, path.clone(), &text, keys));
            match document {
                Ok(document) => loaded.push(document),
                Err(_) => skipped = skipped.saturating_add(1),
            }
        }
        let snapshot = Arc::new(SearchSnapshotData::assemble(loaded, skipped));
        self.search_cache = Some((self.generation, self.privacy_epoch, vault_path.to_string(), Arc::clone(&snapshot)));
        snapshot
    }

    /// `search_vault` 的密匣范围。`vaultPath` 是当前 `VaultState.vaultPath`；`expiresAt` 由调用方（租约在 JS）填。
    fn search(&mut self, args: &Value) -> CallResult {
        let vault_path = args["vaultPath"].as_str().unwrap_or_default().to_string();
        let request: SearchVaultRequest = serde_json::from_value(args["request"].clone())
            .map_err(|_| SearchError::InvalidRequest { reason: "invalidRequest".to_string() })?;
        validate_search_request(&request)?;
        let context = self.check_context(&vault_path, &request.expected_vault_path, request.context.as_ref())?;
        if request.scope != SearchScope::Lockbox {
            return Err(SearchError::Internal { retryable: false }.into());
        }
        let keys = self.keys.clone().ok_or(SearchError::Locked)?;
        let query = parse_search_query(&request.query)?;
        let snapshot = self.search_snapshot(&vault_path, &keys);
        let scanned = snapshot.search(&query, request.limit as usize, request.include_trash)?;
        let response = SearchVaultResponse {
            client_request_id: request.client_request_id,
            snapshot_id: Some(snapshot_id(&context, &SearchScope::Lockbox, &snapshot.source_stamp)),
            context,
            index_state: SearchIndexState::Ready,
            expires_at: None,
            hits: scanned.hits,
            total: Some(scanned.total),
            skipped_files: snapshot.skipped_files,
            warning: None,
        };
        Ok(json!(response))
    }

    /// `read_search_target` 的密匣范围：与桌面 `read_search_document` 同序校验后解密读取。
    fn read_search_target(&mut self, args: &Value) -> CallResult {
        let vault_path = args["vaultPath"].as_str().unwrap_or_default().to_string();
        let request: ReadSearchTargetRequest = serde_json::from_value(args["request"].clone())
            .map_err(|_| SearchError::InvalidRequest { reason: "invalidRequest".to_string() })?;
        if request.client_request_id.trim().is_empty() {
            return Err(invalid_request("missingClientRequestId").into());
        }
        let context = self.check_context(&vault_path, &request.expected_vault_path, request.context.as_ref())?;
        if request.target.vault_path != context.vault_path {
            return Err(SearchError::VaultChanged.into());
        }
        if request.target.scope != SearchScope::Lockbox {
            return Err(SearchError::Internal { retryable: false }.into());
        }
        let keys = self.keys.clone().ok_or(SearchError::Locked)?;
        validate_target_identity(&context.vault_path, &request.target)?;
        if !is_markdown_target(&request.target) {
            return Err(SearchError::UnsupportedTarget.into());
        }
        let path = resolve_target_file(&self.vfs, &request.target.path, &SearchScope::Lockbox)?;
        let relative = path
            .strip_prefix(ROOT)
            .map(|relative| relative.to_string_lossy().replace('\\', "/"))
            .map_err(|_| SearchError::Io { retryable: false })?;
        let text = self.vfs.read_to_string(&path).map_err(|_| SearchError::NotFound)?;
        let document = domain::lockbox_search_document(&context.vault_path, relative, &text, &keys)?;
        validate_loaded_identity(&request.target, &document.metadata.target)?;
        let fragment = document.fragment.ok_or(SearchError::UnsupportedTarget)?;
        let response = ReadSearchTargetResponse {
            client_request_id: request.client_request_id,
            context,
            expires_at: None,
            target: document.metadata.target,
            revision: document.metadata.revision,
            read_only: document.metadata.read_only,
            fragment,
        };
        Ok(json!(response))
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.lock();
    }
}

/// 两份基线之间的变化，`vault-changed` 同形：`{ path, exists, sha }`。
fn base_changes(previous: &Base, next: &Base) -> Vec<Value> {
    let mut changes = Vec::new();
    for (id, item) in &next.items {
        let path = effective_path(id, item.path.as_deref());
        let old = previous.items.get(id);
        let old_path = old.and_then(|old| effective_path(id, old.path.as_deref()));
        if old.is_some_and(|old| old.sha == item.sha) && old_path == path {
            continue;
        }
        if let (Some(old_path), true) = (&old_path, old_path != path) {
            changes.push(json!({ "path": old_path, "exists": false, "sha": Value::Null }));
        }
        if let Some(path) = path {
            changes.push(json!({ "path": path, "exists": true, "sha": item.sha }));
        }
    }
    for (id, item) in &previous.items {
        if !next.items.contains_key(id) {
            if let Some(path) = effective_path(id, item.path.as_deref()) {
                changes.push(json!({ "path": path, "exists": false, "sha": Value::Null }));
            }
        }
    }
    changes
}
