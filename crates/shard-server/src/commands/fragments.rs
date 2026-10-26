//! 碎片：列表、新建、保存、标签、回收站、置顶、属性、关系、碎片⇄笔记转换。
//! 桌面外壳：`src-tauri/src/lib.rs` 的同名命令。桌面先按 id 分流密匣再调公开实现，这里在同一个
//! 位置把密匣分支换成 [`lockbox_unavailable`]。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use shard_core::{contains_lockbox_tag, frontmatter::validate_property_key};
use shard_vault::{
    convert_fragment_to_note_in_vault, convert_note_to_fragment_in_vault, create_public_fragment,
    is_lockbox_fragment_id, is_protected_type, library_mutation_result, link_fragments_in_vault,
    list_public_fragments, normalize_new_fragment, property_input_to_yaml, read_property_registry_in_vault,
    register_property_type_in_vault, remove_public_fragment_property_in_vault, set_public_fragment_archived_by_id,
    set_public_fragment_pinned_by_id, set_public_fragment_property_in_vault, sort_fragment_list,
    unlink_fragments_in_vault, update_public_fragment_by_id, update_public_fragment_tags_by_id, Fragment, GitInfo,
    PropertyInputValue, PropertyType, PublicFragmentUpdate, VaultCtx, LOCKBOX_TYPE_ERROR,
};

use super::{cli::source_override, lockbox_unavailable, parse, read, read_store, write};
use crate::rpc::{Access, Registry, RpcEnv, RpcError};

pub(super) fn register(registry: &mut Registry) {
    registry
        .register("list_fragments", Access::Read, list_fragments)
        .register("list_markdown_dialect_migration", Access::Read, list_markdown_dialect_migration)
        .register("create_fragment", Access::Write, create_fragment)
        .register("update_fragment", Access::Write, update_fragment)
        .register("update_fragment_tags", Access::Write, update_fragment_tags)
        .register("set_fragment_archived", Access::Write, set_fragment_archived)
        .register("set_fragment_pinned", Access::Write, set_fragment_pinned)
        .register("move_fragment_to_lockbox", Access::Write, move_fragment_to_lockbox)
        .register("read_property_registry", Access::Read, read_property_registry)
        .register("register_property_type", Access::Write, register_property_type)
        .register("set_fragment_property", Access::Write, set_fragment_property)
        .register("remove_fragment_property", Access::Write, remove_fragment_property)
        .register("link_fragments", Access::Write, link_fragments)
        .register("unlink_fragments", Access::Write, unlink_fragments)
        .register("convert_fragment_to_note", Access::Write, convert_fragment_to_note)
        .register("convert_note_to_fragment", Access::Write, convert_note_to_fragment);
}

/// 桌面 `LOCKBOX_TTL`（15 分钟）：前端用它显示自动上锁的倒计时。
const LOCKBOX_TTL_SECONDS: u64 = 15 * 60;

/// 与桌面 `VaultState` 同形。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultState {
    vault_path: String,
    fragments: Vec<Fragment>,
    git: GitInfo,
    lockbox: LockboxState,
}

/// 与桌面 `LockboxState` 同形。服务器上永远是锁着的：密匣只以密文存在。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LockboxState {
    configured: bool,
    unlocked: bool,
    expires_at: Option<String>,
    ttl_seconds: u64,
}

/// 桌面锁着密匣时的 `list_fragments`：只有公开碎片与笔记，按置顶、创建时间排序。
fn list_fragments(env: &RpcEnv<'_>, _args: Value) -> Result<Value, RpcError> {
    read_store(env, |vfs, cx| {
        let mut fragments = list_public_fragments(cx, &cx.hooks.dirty_paths())?;
        sort_fragment_list(&mut fragments);
        let configured = vfs.lockbox_manifest_raw().map_err(|error| error.to_string())?.is_some();
        Ok(VaultState {
            vault_path: env.vault_identity.to_string(),
            fragments,
            git: cx.hooks.git_info(),
            lockbox: LockboxState { configured, unlocked: false, expires_at: None, ttl_seconds: LOCKBOX_TTL_SECONDS },
        })
    })
}

/// 桌面 `list_markdown_dialect_migration` 同形：`{ dialect, sources }`。内容库只收方言 v2
/// （导入前置检查保证），没有要改写的原文。网页端读碎片列表前会先问一次，不注册的话每次都 404。
fn list_markdown_dialect_migration(env: &RpcEnv<'_>, _args: Value) -> Result<Value, RpcError> {
    let dialect = env
        .store
        .meta("markdown_dialect")?
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(2);
    Ok(serde_json::json!({ "dialect": dialect, "sources": [] }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateFragmentArgs {
    content: String,
    #[serde(default)]
    tags: Option<Vec<String>>,
    /// 覆盖按调用方记的来源（web / desktop / cli），例如命令行的 `--source claude-code`。桌面没有这个参数。
    #[serde(default)]
    source: Option<String>,
    /// 客户端生成的 id（桌面离线新建后补交：id 在离线时就已显示、被引用，补交后不能变）。须与 `createdAt` 一起给。
    #[serde(default)]
    id: Option<String>,
    /// 客户端的创建时间（RFC 3339，带时区）：决定 `fragments/YYYY/MM` 与 frontmatter 时间。
    #[serde(default)]
    created_at: Option<String>,
    /// 冲突副本：原条目的 id（离线编辑补交时服务器上已被改过或删除，本地内容另存为副本）。
    #[serde(default)]
    conflict_of: Option<String>,
}

fn create_fragment(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: CreateFragmentArgs = parse(args)?;
    let source = source_override(args.source.as_deref())?;
    let (content, tags) = normalize_new_fragment(&args.content, args.tags)?;
    if contains_lockbox_tag(&tags) {
        if is_protected_type(&tags) {
            return Err(LOCKBOX_TYPE_ERROR.to_string().into());
        }
        return Err(lockbox_unavailable());
    }
    let explicit = match (&args.id, &args.created_at) {
        (Some(id), Some(created_at)) => {
            let created_at = chrono::DateTime::parse_from_rfc3339(created_at)
                .map_err(|error| RpcError::invalid_args(format!("createdAt 无效：{error}")))?;
            if !shard_core::is_valid_fragment_id(id) {
                return Err(RpcError::invalid_args(format!("片段 id 无效：{id}")));
            }
            Some((id.clone(), created_at))
        }
        (None, None) => None,
        _ => return Err(RpcError::invalid_args("id 与 createdAt 要一起给。")),
    };
    if let Some(conflict_of) = &args.conflict_of {
        if !shard_core::is_valid_fragment_id(conflict_of) {
            return Err(RpcError::invalid_args(format!("conflictOf 无效：{conflict_of}")));
        }
    }
    write(env, |cx| {
        let cx = match source.as_deref() {
            Some(source) => cx.with_clock(cx.offset, source),
            None => *cx,
        };
        match &explicit {
            Some((id, created_at)) => {
                if shard_vault::find_fragment_path(cx.vfs, id)?.is_some() || is_lockbox_fragment_id(cx.vfs, id)? {
                    return Err(RpcError::new(
                        axum::http::StatusCode::CONFLICT,
                        "FRAGMENT_EXISTS",
                        format!("片段 {id} 已存在。"),
                    ));
                }
                Ok(shard_vault::create_public_fragment_as(&cx, &content, tags, id, created_at, args.conflict_of.as_deref())?)
            }
            None if args.conflict_of.is_some() => {
                let id = shard_core::new_fragment_id(&cx.now());
                Ok(shard_vault::create_public_fragment_as(&cx, &content, tags, &id, &cx.now(), args.conflict_of.as_deref())?)
            }
            None => Ok(create_public_fragment(&cx, &content, tags)?),
        }
    })
}

/// 目标 id 是密匣条目时桌面走密匣实现；服务器直接拒绝。
fn reject_lockbox_target(cx: &VaultCtx<'_>, id: &str) -> Result<(), RpcError> {
    if is_lockbox_fragment_id(cx.vfs, id)? {
        return Err(lockbox_unavailable());
    }
    Ok(())
}

fn saved(update: PublicFragmentUpdate) -> Result<Fragment, RpcError> {
    match update {
        PublicFragmentUpdate::Saved(fragment) => Ok(*fragment),
        // 新标签里带密匣标签：桌面会把公开文件整体移进密匣。领域函数在这之前没有改任何文件。
        PublicFragmentUpdate::MoveToLockbox { .. } => Err(lockbox_unavailable()),
    }
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

fn update_fragment(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: UpdateFragmentArgs = parse(args)?;
    if args.content.trim().is_empty() {
        return Err("片段内容不能为空".to_string().into());
    }
    write(env, |cx| {
        reject_lockbox_target(cx, &args.id)?;
        saved(update_public_fragment_by_id(
            cx,
            &args.id,
            &args.content,
            args.tags.unwrap_or_default(),
            args.expected_file_sha.as_deref(),
        )?)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateFragmentTagsArgs {
    id: String,
    tags: Vec<String>,
}

fn update_fragment_tags(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: UpdateFragmentTagsArgs = parse(args)?;
    write(env, |cx| {
        reject_lockbox_target(cx, &args.id)?;
        saved(update_public_fragment_tags_by_id(cx, &args.id, args.tags)?)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetArchivedArgs {
    id: String,
    archived: bool,
}

fn set_fragment_archived(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: SetArchivedArgs = parse(args)?;
    write(env, |cx| {
        reject_lockbox_target(cx, &args.id)?;
        Ok(set_public_fragment_archived_by_id(cx, &args.id, args.archived)?)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPinnedArgs {
    id: String,
    pinned: bool,
}

fn set_fragment_pinned(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: SetPinnedArgs = parse(args)?;
    write(env, |cx| {
        reject_lockbox_target(cx, &args.id)?;
        Ok(set_public_fragment_pinned_by_id(cx, &args.id, args.pinned)?)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArgs {
    id: String,
}

/// 桌面把明文碎片加密后移进密匣；服务器拿不到密钥，端到端加密前一律拒绝。
fn move_fragment_to_lockbox(_env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let _: IdArgs = parse(args)?;
    Err(lockbox_unavailable())
}

fn read_property_registry(env: &RpcEnv<'_>, _args: Value) -> Result<Value, RpcError> {
    read(env, |cx| Ok(read_property_registry_in_vault(cx)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterPropertyTypeArgs {
    key: String,
    property_type: PropertyType,
    expected_sha: String,
}

fn register_property_type(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: RegisterPropertyTypeArgs = parse(args)?;
    write(env, |cx| Ok(register_property_type_in_vault(cx, &args.key, args.property_type, &args.expected_sha)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPropertyArgs {
    id: String,
    key: String,
    value: PropertyInputValue,
}

fn set_fragment_property(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: SetPropertyArgs = parse(args)?;
    // 顺序与桌面一致：先换算属性值，再校验键名，再分流密匣。
    let value = property_input_to_yaml(args.value)?;
    write(env, |cx| {
        validate_property_key(&args.key)?;
        reject_lockbox_target(cx, &args.id)?;
        Ok(set_public_fragment_property_in_vault(cx, &args.id, &args.key, &value)?)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemovePropertyArgs {
    id: String,
    key: String,
}

fn remove_fragment_property(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: RemovePropertyArgs = parse(args)?;
    write(env, |cx| {
        validate_property_key(&args.key)?;
        reject_lockbox_target(cx, &args.id)?;
        Ok(remove_public_fragment_property_in_vault(cx, &args.id, &args.key)?)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkArgs {
    source_id: String,
    target_id: String,
    origin: String,
    #[serde(default)]
    note: Option<String>,
}

/// 密匣 id 由领域代码（`ensure_public_fragment_id`）拒绝，与桌面同一条报错。
fn link_fragments(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: LinkArgs = parse(args)?;
    write(env, |cx| Ok(link_fragments_in_vault(cx, &args.source_id, &args.target_id, &args.origin, args.note)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnlinkArgs {
    source_id: String,
    target_id: String,
}

fn unlink_fragments(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: UnlinkArgs = parse(args)?;
    write(env, |cx| Ok(unlink_fragments_in_vault(cx, &args.source_id, &args.target_id)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConvertToNoteArgs {
    id: String,
    #[serde(default)]
    destination_directory: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

fn convert_fragment_to_note(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: ConvertToNoteArgs = parse(args)?;
    write(env, |cx| {
        let (fragment, updated_links) = convert_fragment_to_note_in_vault(
            cx,
            &args.id,
            args.destination_directory.as_deref(),
            args.title.as_deref(),
        )?;
        Ok(library_mutation_result(cx, Some(fragment), updated_links)?)
    })
}

fn convert_note_to_fragment(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: IdArgs = parse(args)?;
    write(env, |cx| {
        let (fragment, updated_links) = convert_note_to_fragment_in_vault(cx, &args.id)?;
        Ok(library_mutation_result(cx, Some(fragment), updated_links)?)
    })
}
