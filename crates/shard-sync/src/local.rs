//! 离线时的命令实现：参数结构、校验顺序、报错与返回值逐一照抄服务端的命令层
//! （`crates/shard-server/src/commands/*.rs`、`search.rs`），领域函数是同一份 shard-vault。
//! 只在「副本 ∪ overlay」上跑，不碰网络。

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use shard_core::{contains_lockbox_tag, frontmatter::validate_property_key};
use shard_vault::{
    build_library_tree,
    canvas::{self, split},
    existing_vault_images_in, image_mime_type, image_references_in_vault, is_lockbox_fragment_id, is_protected_type,
    list_csv_files_in_vault, list_mind_maps_in_vault, list_public_fragments, normalize_new_fragment,
    property_input_to_yaml, read_csv_file_in_vault, read_dataset_in_vault, read_graph_fragment_in_vault,
    read_mind_map_in_vault, read_property_registry_in_vault, remove_public_fragment_property_in_vault,
    resolve_vault_asset_path,
    search::{
        build_public_snapshot, parse_search_query, read_public_search_target, snapshot_id, validate_search_request,
        ReadSearchTargetRequest, ReadSearchTargetResponse, SearchContext, SearchError, SearchIndexState, SearchScope,
        SearchVaultRequest, SearchVaultResponse,
    },
    set_public_fragment_pinned_by_id, set_public_fragment_property_in_vault, sort_fragment_list,
    store_image_attachment, update_public_fragment_by_id, update_public_fragment_tags_by_id, Fragment,
    PropertyInputValue, PublicFragmentUpdate, VaultCtx, LOCKBOX_TYPE_ERROR,
};

use crate::policy::offline_message;

/// 本地执行失败：形状与服务器的错误响应一致（状态码、错误码、说明、结构化错误）。
/// `status` 为空表示「需要联网」——与网络失败一样，前端拿到的只是说明文字。
#[derive(Clone, Debug)]
pub(crate) struct LocalError {
    pub status: Option<u16>,
    pub code: String,
    pub message: String,
    pub detail: Option<Value>,
}

impl LocalError {
    pub(crate) fn new(status: u16, code: &str, message: impl Into<String>) -> Self {
        Self { status: Some(status), code: code.to_string(), message: message.into(), detail: None }
    }

    pub(crate) fn invalid_args(error: impl std::fmt::Display) -> Self {
        Self::new(400, "INVALID_ARGS", format!("参数无效：{error}"))
    }

    pub(crate) fn offline(command: &str) -> Self {
        Self { status: None, code: "OFFLINE".to_string(), message: offline_message(command), detail: None }
    }

    fn search(error: SearchError) -> Self {
        let status = match &error {
            SearchError::InvalidRequest { .. } => 400,
            SearchError::NotFound => 404,
            SearchError::Io { .. } | SearchError::Internal { .. } => 500,
            _ => 409,
        };
        let detail = serde_json::to_value(&error).unwrap_or(Value::Null);
        let code = detail.get("code").and_then(Value::as_str).unwrap_or("search").to_string();
        Self { status: Some(status), code: code.clone(), message: code, detail: Some(detail) }
    }
}

/// 领域函数的字符串错误：与服务端 `RpcError::from(String)` 同样按前缀定状态码。
impl From<String> for LocalError {
    fn from(message: String) -> Self {
        if message.starts_with("STALE_BASE") {
            Self::new(409, "STALE_BASE", message)
        } else {
            Self::new(400, "COMMAND_FAILED", message)
        }
    }
}

fn parse<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, LocalError> {
    serde_json::from_value(args).map_err(LocalError::invalid_args)
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<Value, LocalError> {
    serde_json::to_value(value).map_err(|error| LocalError::new(500, "INTERNAL", error.to_string()))
}

/// 本地读需要的、副本里没有的服务器信息。
pub(crate) struct ReadContext {
    /// 服务器的 `vaultPath`。
    pub vault_identity: String,
    /// 服务器的 epoch（搜索上下文用）。
    pub epoch: String,
    pub lockbox_configured: bool,
    /// 最近一次在线取到的密匣快照（JSON 原文）。
    pub lockbox_snapshot: Option<String>,
}

/// 与桌面 `LOCKBOX_TTL` 一致（服务端同名常量）。
const LOCKBOX_TTL_SECONDS: u64 = 15 * 60;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArgs {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArgs {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanvasReadArgs {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathsArgs {
    paths: Vec<String>,
}

#[derive(Deserialize)]
struct SearchArgs {
    request: SearchVaultRequest,
}

#[derive(Deserialize)]
struct ReadTargetArgs {
    request: ReadSearchTargetRequest,
}

/// 读命令。
pub(crate) fn read(command: &str, args: Value, cx: &VaultCtx<'_>, context: &ReadContext) -> Result<Value, LocalError> {
    match command {
        "list_fragments" => {
            let mut fragments = list_public_fragments(cx, &cx.hooks.dirty_paths())?;
            sort_fragment_list(&mut fragments);
            Ok(json!({
                "vaultPath": context.vault_identity,
                "fragments": to_json(&fragments)?,
                "git": to_json(&cx.hooks.git_info())?,
                "lockbox": {
                    "configured": context.lockbox_configured,
                    "unlocked": false,
                    "expiresAt": null,
                    "ttlSeconds": LOCKBOX_TTL_SECONDS,
                },
            }))
        }
        "list_markdown_dialect_migration" => Ok(json!({ "dialect": 2, "sources": [] })),
        "read_property_registry" => to_json(&read_property_registry_in_vault(cx)?),
        "list_library_tree" => to_json(&build_library_tree(cx)?),
        "list_mind_maps" => to_json(&list_mind_maps_in_vault(cx)?),
        "list_csv_files" => to_json(&list_csv_files_in_vault(cx)?),
        "list_diagram_documents" => to_json(&split::list_in_vault(cx)?),
        "read_mind_map" => {
            let args: IdArgs = parse(args)?;
            to_json(&read_mind_map_in_vault(cx, &args.id)?)
        }
        "read_canvas" => {
            let args: CanvasReadArgs = parse(args)?;
            to_json(&canvas::read_in_vault(cx, &args.path)?)
        }
        "read_dataset" => {
            let args: PathArgs = parse(args)?;
            to_json(&read_dataset_in_vault(cx, &args.path)?)
        }
        "read_csv_file" => {
            let args: PathArgs = parse(args)?;
            to_json(&read_csv_file_in_vault(cx, &args.path)?)
        }
        "read_graph_fragment" => {
            let args: IdArgs = parse(args)?;
            to_json(&read_graph_fragment_in_vault(cx, &args.id)?)
        }
        "image_references" => {
            let args: PathArgs = parse(args)?;
            to_json(&image_references_in_vault(cx, &args.path)?)
        }
        "existing_vault_images" => {
            let args: PathsArgs = parse(args)?;
            to_json(&existing_vault_images_in(cx.vfs, args.paths))
        }
        "read_fragment_image" => {
            let args: PathArgs = parse(args)?;
            let image_path = resolve_vault_asset_path(cx.vfs, &args.path)?;
            let bytes = cx.vfs.read(&image_path).map_err(|error| error.to_string())?;
            let mime_type = image_mime_type(&image_path, &bytes)?;
            Ok(Value::String(format!("data:{mime_type};base64,{}", STANDARD.encode(bytes))))
        }
        "search_vault" => search_vault(args, cx, context),
        "read_search_target" => read_search_target(args, cx, context),
        "lockbox_snapshot" => match &context.lockbox_snapshot {
            Some(text) => serde_json::from_str(text).map_err(|error| LocalError::new(500, "INTERNAL", error.to_string())),
            None => Err(LocalError::offline(command)),
        },
        _ => Err(LocalError::offline(command)),
    }
}

fn search_context(context: &ReadContext) -> SearchContext {
    SearchContext {
        vault_path: context.vault_identity.clone(),
        vault_epoch: context.epoch.clone(),
        privacy_epoch: "0".to_string(),
    }
}

/// 同服务端 `check_context`。
fn check_context(current: &SearchContext, expected: &str, requested: Option<&SearchContext>) -> Result<(), LocalError> {
    if expected != current.vault_path {
        return Err(LocalError::search(SearchError::VaultChanged));
    }
    if let Some(requested) = requested {
        if requested.vault_path != current.vault_path {
            return Err(LocalError::search(SearchError::VaultChanged));
        }
        if requested.vault_epoch != current.vault_epoch {
            return Err(LocalError::search(SearchError::ContextExpired));
        }
    }
    Ok(())
}

fn search_vault(args: Value, cx: &VaultCtx<'_>, context: &ReadContext) -> Result<Value, LocalError> {
    let SearchArgs { request } = serde_json::from_value(args).map_err(LocalError::invalid_args)?;
    validate_search_request(&request).map_err(LocalError::search)?;
    let current = search_context(context);
    check_context(&current, &request.expected_vault_path, request.context.as_ref())?;
    if matches!(request.scope, SearchScope::Lockbox) {
        return Err(LocalError::search(SearchError::Locked));
    }
    let query = parse_search_query(&request.query).map_err(LocalError::search)?;
    let snapshot = build_public_snapshot(cx.vfs, &current.vault_path).map_err(LocalError::search)?;
    let scanned = snapshot
        .search(&query, request.limit as usize, request.include_trash)
        .map_err(LocalError::search)?;
    let response = SearchVaultResponse {
        client_request_id: request.client_request_id,
        snapshot_id: Some(snapshot_id(&current, &request.scope, &snapshot.source_stamp)),
        context: current,
        index_state: SearchIndexState::Ready,
        expires_at: None,
        hits: scanned.hits,
        total: Some(scanned.total),
        skipped_files: snapshot.skipped_files,
        warning: None,
    };
    to_json(&response)
}

fn read_search_target(args: Value, cx: &VaultCtx<'_>, context: &ReadContext) -> Result<Value, LocalError> {
    let ReadTargetArgs { request } = serde_json::from_value(args).map_err(LocalError::invalid_args)?;
    if request.client_request_id.trim().is_empty() {
        return Err(LocalError::search(SearchError::InvalidRequest { reason: "missingClientRequestId".to_string() }));
    }
    let current = search_context(context);
    check_context(&current, &request.expected_vault_path, request.context.as_ref())?;
    if request.target.vault_path != current.vault_path {
        return Err(LocalError::search(SearchError::VaultChanged));
    }
    if matches!(request.target.scope, SearchScope::Lockbox) {
        return Err(LocalError::search(SearchError::Locked));
    }
    let loaded = read_public_search_target(cx.vfs, &current.vault_path, &request.target).map_err(LocalError::search)?;
    let fragment = loaded.fragment.ok_or_else(|| LocalError::search(SearchError::UnsupportedTarget))?;
    let response = ReadSearchTargetResponse {
        client_request_id: request.client_request_id,
        context: current,
        expires_at: None,
        target: loaded.metadata.target,
        revision: loaded.metadata.revision,
        read_only: loaded.metadata.read_only,
        fragment,
    };
    to_json(&response)
}

/// 一次本地写在 outbox 里要记的东西（除了命令与参数本身）。
#[derive(Clone, Debug)]
pub(crate) struct WritePlan {
    /// `fragment:<id>` | `asset:<sha>`
    pub target: String,
    /// 目标文件写完后的 vault 相对路径。
    pub target_path: Option<String>,
    pub blob_dep: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateFragmentArgs {
    content: String,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    conflict_of: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateFragmentArgs {
    id: String,
    content: String,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    expected_file_sha: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTagsArgs {
    id: String,
    tags: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPinnedArgs {
    id: String,
    pinned: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPropertyArgs {
    id: String,
    key: String,
    value: PropertyInputValue,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemovePropertyArgs {
    id: String,
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveImageArgs {
    blob_sha: String,
}

fn fragment_plan(fragment: &Fragment) -> WritePlan {
    WritePlan { target: format!("fragment:{}", fragment.id), target_path: Some(fragment.path.clone()), blob_dep: None }
}

fn saved(update: PublicFragmentUpdate) -> Result<Fragment, LocalError> {
    match update {
        PublicFragmentUpdate::Saved(fragment) => Ok(*fragment),
        PublicFragmentUpdate::MoveToLockbox { .. } => Err(LocalError::offline("move_fragment_to_lockbox")),
    }
}

/// 目标是密匣条目：服务器会拒绝（`LOCKBOX_UNAVAILABLE`），离线时直接说需要联网。
fn reject_lockbox_target(cx: &VaultCtx<'_>, id: &str) -> Result<(), LocalError> {
    if is_lockbox_fragment_id(cx.vfs, id)? {
        return Err(LocalError::offline("lockbox_apply"));
    }
    Ok(())
}

fn valid_blob_sha(sha: &str) -> bool {
    sha.len() == 64 && sha.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// 离线允许的写命令。`blob` 按 sha 取本机暂存的附件字节。
pub(crate) fn write(
    command: &str,
    args: &Value,
    cx: &VaultCtx<'_>,
    blob: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> Result<(Value, WritePlan), LocalError> {
    let args = args.clone();
    match command {
        "create_fragment" => {
            let args: CreateFragmentArgs = parse(args)?;
            let source = match args.source.as_deref().map(str::trim).filter(|source| !source.is_empty()) {
                Some(source) if !shard_vault::cli::valid_source(source) => {
                    return Err(LocalError::invalid_args("source 必须是不超过 40 个字符的单行名称"))
                }
                source => source.map(str::to_string),
            };
            let (content, tags) = normalize_new_fragment(&args.content, args.tags)?;
            if contains_lockbox_tag(&tags) {
                if is_protected_type(&tags) {
                    return Err(LOCKBOX_TYPE_ERROR.to_string().into());
                }
                return Err(LocalError::offline("lockbox_apply"));
            }
            // 引擎补交前一律带上客户端 id 与创建时间（离线显示的 id 补交后不变）。
            let (Some(id), Some(created_at)) = (&args.id, &args.created_at) else {
                return Err(LocalError::invalid_args("离线新建需要客户端 id 与 createdAt。"));
            };
            let created_at = chrono::DateTime::parse_from_rfc3339(created_at)
                .map_err(|error| LocalError::invalid_args(format!("createdAt 无效：{error}")))?;
            if !shard_core::is_valid_fragment_id(id) {
                return Err(LocalError::invalid_args(format!("片段 id 无效：{id}")));
            }
            if let Some(conflict_of) = &args.conflict_of {
                if !shard_core::is_valid_fragment_id(conflict_of) {
                    return Err(LocalError::invalid_args(format!("conflictOf 无效：{conflict_of}")));
                }
            }
            let cx = match source.as_deref() {
                Some(source) => cx.with_clock(cx.offset, source),
                None => *cx,
            };
            if shard_vault::find_fragment_path(cx.vfs, id)?.is_some() || is_lockbox_fragment_id(cx.vfs, id)? {
                return Err(LocalError::new(409, "FRAGMENT_EXISTS", format!("片段 {id} 已存在。")));
            }
            let fragment =
                shard_vault::create_public_fragment_as(&cx, &content, tags, id, &created_at, args.conflict_of.as_deref())?;
            Ok((to_json(&fragment)?, fragment_plan(&fragment)))
        }
        "update_fragment" => {
            let args: UpdateFragmentArgs = parse(args)?;
            if args.content.trim().is_empty() {
                return Err("片段内容不能为空".to_string().into());
            }
            reject_lockbox_target(cx, &args.id)?;
            let fragment = saved(update_public_fragment_by_id(
                cx,
                &args.id,
                &args.content,
                args.tags.unwrap_or_default(),
                args.expected_file_sha.as_deref(),
            )?)?;
            Ok((to_json(&fragment)?, fragment_plan(&fragment)))
        }
        "update_fragment_tags" => {
            let args: UpdateTagsArgs = parse(args)?;
            reject_lockbox_target(cx, &args.id)?;
            let fragment = saved(update_public_fragment_tags_by_id(cx, &args.id, args.tags)?)?;
            Ok((to_json(&fragment)?, fragment_plan(&fragment)))
        }
        "set_fragment_pinned" => {
            let args: SetPinnedArgs = parse(args)?;
            reject_lockbox_target(cx, &args.id)?;
            let fragment = set_public_fragment_pinned_by_id(cx, &args.id, args.pinned)?;
            Ok((to_json(&fragment)?, fragment_plan(&fragment)))
        }
        "set_fragment_property" => {
            let args: SetPropertyArgs = parse(args)?;
            let value = property_input_to_yaml(args.value)?;
            validate_property_key(&args.key)?;
            reject_lockbox_target(cx, &args.id)?;
            let fragment = set_public_fragment_property_in_vault(cx, &args.id, &args.key, &value)?;
            Ok((to_json(&fragment)?, fragment_plan(&fragment)))
        }
        "remove_fragment_property" => {
            let args: RemovePropertyArgs = parse(args)?;
            validate_property_key(&args.key)?;
            reject_lockbox_target(cx, &args.id)?;
            let fragment = remove_public_fragment_property_in_vault(cx, &args.id, &args.key)?;
            Ok((to_json(&fragment)?, fragment_plan(&fragment)))
        }
        "save_fragment_image" => {
            let args: SaveImageArgs = parse(args)?;
            if !valid_blob_sha(&args.blob_sha) {
                return Err(LocalError::invalid_args("blobSha 必须是 64 位小写十六进制。"));
            }
            let bytes = blob(&args.blob_sha)
                .ok_or_else(|| LocalError::new(400, "BLOB_MISSING", "找不到已上传的文件内容，请重新上传。"))?;
            let path = store_image_attachment(cx, &bytes)?;
            let plan = WritePlan {
                target: format!("asset:{}", args.blob_sha),
                target_path: Some(path.clone()),
                blob_dep: Some(args.blob_sha),
            };
            Ok((Value::String(path), plan))
        }
        _ => Err(LocalError::offline(command)),
    }
}
