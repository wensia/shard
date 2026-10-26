//! 密匣（端到端加密的私密空间）的领域逻辑：manifest、信封载荷、密匣碎片与笔记的读写、公开内容移入密匣、
//! 密匣的方言迁移，以及从解密后的载荷构造搜索文档。
//!
//! 与其他模块一样跑在 [`VaultCtx`] 上（只经 `cx.vfs` 读写、只经 `cx.hooks` 提交，时间取 `cx.now()`），
//! 不依赖 Tauri、不碰 `std::fs`、不读系统时钟，可以编进 wasm 在内存 Vfs 上跑。
//!
//! 这里不持有任何会话状态：解锁会话、租约、过期计时都由调用方管理（桌面在 src-tauri 的 `LockboxRuntime`）。
//! 需要密钥的函数显式接收：
//! - `&ReadKeys`：必须已解锁（更新正文、标签、置顶、归档、属性，列出与读取）。
//! - `Option<&ReadKeys>`：锁着也能写（新建、移入密匣），锁着时用 manifest 里的公钥加密，返回不含正文的投影；
//!   已解锁时读回明文。
//! - 设置、解锁、改口令、重置口令返回主密钥，由调用方放进自己的会话。
//!
//! 搜索运行时的副作用（例如移入密匣前作废公开快照）也由调用方在调用前后处理。
//! 报错文案、JSON 形状、写出的字节与提交信息与迁移前的 src-tauri 实现一字不差。

use crate::prelude::*;
use crate::search::{markdown_document, LoadedSearchDocument, SearchError, SearchScope};
use shard_core::{ensure_vault_layout, frontmatter::raw_from_frontmatter, normalize_tag, MARKDOWN_DIALECT};
use shard_lockbox::{validate_password, Envelope, Manifest, ReadKeys, WriteKey};

/// 一条密匣内容解密后的载荷（`.shard` 信封里的明文 JSON）。字段名即落盘格式，不能改。
#[derive(Debug, Serialize, Deserialize)]
pub struct LockboxFragmentPayload {
    pub frontmatter: FragmentFrontmatter,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frontmatter_raw: Option<String>,
    pub body: String,
    /// 正文的 Markdown 方言版本（见 src-tauri 的 markdown_dialect.rs）。旧载荷没有这个字段，按 v1 读；
    /// 只改元数据的写回原样带着它，只有写入新正文时才标成当前版本。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markdown_dialect: Option<u32>,
}

/// 设置密匣或用恢复密钥重置后的结果：给用户看的恢复密钥，以及调用方放进会话的主密钥。
pub struct LockboxSetup {
    pub recovery_key: String,
    pub master_key: Vec<u8>,
}

// ---------------------------------------------------------------------------
// manifest 与目录
// ---------------------------------------------------------------------------

pub fn lockbox_manifest_path(vault: &Path) -> PathBuf {
    vault.join(".shard").join("lockbox.json")
}

pub fn read_lockbox_manifest(vfs: &dyn Vfs) -> Result<Manifest, String> {
    let path = lockbox_manifest_path(vfs.root());
    if !vfs.exists(&path) {
        return Err("密匣尚未设置。".to_string());
    }
    let text = vfs.read_to_string(&path).map_err(|error| error.to_string())?;
    Manifest::parse(&text)
}

pub fn write_lockbox_manifest(vfs: &dyn Vfs, manifest: &Manifest) -> Result<(), String> {
    let path = lockbox_manifest_path(vfs.root());
    if let Some(parent) = path.parent() {
        vfs.create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = manifest.to_text()?;
    vfs.write_atomic(&path, text.as_bytes())
        .map_err(|error| error.to_string())
}

pub fn ensure_lockbox_layout(vfs: &dyn Vfs) -> Result<(), String> {
    let vault = vfs.root();
    vfs.create_dir_all(&vault.join("lockbox").join("fragments"))
        .map_err(|error| error.to_string())?;
    vfs.create_dir_all(&vault.join("lockbox").join("archive"))
        .map_err(|error| error.to_string())
}

/// 写入用的密钥（纯函数）：manifest 已有免密写入密钥对就用公钥；旧 manifest 没有时，必须给出已解锁的
/// 主密钥，就地补上密钥对。返回 `(写入密钥, manifest 是否改动、需要回写)`。
pub fn lockbox_write_key(manifest: &mut Manifest, master_key: Option<&[u8]>) -> Result<(WriteKey, bool), String> {
    if manifest.has_write_key() {
        let public_key = manifest
            .write_public_key()?
            .ok_or_else(|| "密匣写入密钥缺失。".to_string())?;
        return Ok((WriteKey::Public(public_key), false));
    }

    let master_key = master_key.ok_or_else(|| "密匣需要先解锁一次以启用免密码写入。".to_string())?;
    manifest.ensure_write_key(master_key)?;
    let write_key = manifest
        .write_public_key()?
        .map(WriteKey::Public)
        .ok_or_else(|| "密匣写入密钥生成失败。".to_string())?;
    Ok((write_key, true))
}

/// 读 manifest 取写入密钥；manifest 补了密钥对就回写并提交。返回写入密钥与写入后用来读回的密钥：
/// 补了密钥对时，传入的读取密钥还没有新的写入私钥，按新 manifest 重新派生（与迁移前「写完再向会话取一次
/// 读取密钥」的结果相同）。
fn prepare_write_key(
    cx: &VaultCtx<'_>,
    read_keys: Option<&ReadKeys>,
) -> Result<(WriteKey, Option<ReadKeys>), String> {
    let mut manifest = read_lockbox_manifest(cx.vfs)?;
    let (write_key, upgraded) =
        lockbox_write_key(&mut manifest, read_keys.map(|keys| keys.master_key.as_slice()))?;
    if !upgraded {
        return Ok((write_key, read_keys.cloned()));
    }
    write_lockbox_manifest(cx.vfs, &manifest)?;
    cx.hooks
        .commit_path_if_git(".shard/lockbox.json", "upgrade lockbox write key")
        .ok();
    let read_keys = read_keys.and_then(|keys| manifest.read_keys(&keys.master_key).ok());
    Ok((write_key, read_keys))
}

// ---------------------------------------------------------------------------
// 设置、解锁、改口令、重置
// ---------------------------------------------------------------------------

/// 第一次设置密匣：建目录、生成主密钥与恢复密钥、写 manifest 并提交。主密钥交给调用方放进会话。
pub fn setup_lockbox(cx: &VaultCtx<'_>, password: &str) -> Result<LockboxSetup, String> {
    validate_password(password)?;
    ensure_vault_layout(cx.vfs)?;
    ensure_lockbox_layout(cx.vfs)?;
    let manifest_path = lockbox_manifest_path(cx.root());
    if cx.vfs.exists(&manifest_path) {
        return Err("密匣已经设置。".to_string());
    }

    let master_key = shard_lockbox::random_bytes(shard_lockbox::MASTER_KEY_BYTES);
    let recovery_key = shard_lockbox::generate_recovery_key();
    let manifest = Manifest::build(password, &recovery_key, &master_key)?;
    write_lockbox_manifest(cx.vfs, &manifest)?;

    cx.hooks
        .commit_path_if_git(".shard/lockbox.json", "setup lockbox")
        .ok();

    Ok(LockboxSetup { recovery_key, master_key })
}

/// 用口令解出主密钥；旧 manifest 没有免密写入密钥对时顺带补上并提交。
pub fn unlock_lockbox(cx: &VaultCtx<'_>, password: &str) -> Result<Vec<u8>, String> {
    let mut manifest = read_lockbox_manifest(cx.vfs)?;
    let master_key = manifest.unwrap_with_password(password)?;
    if manifest.ensure_write_key(&master_key)? {
        write_lockbox_manifest(cx.vfs, &manifest)?;
        cx.hooks
            .commit_path_if_git(".shard/lockbox.json", "upgrade lockbox write key")
            .ok();
    }
    Ok(master_key)
}

/// 换口令：只重包口令那一份，返回主密钥（换完即视为已解锁）。
pub fn change_lockbox_password(
    cx: &VaultCtx<'_>,
    current_password: &str,
    new_password: &str,
) -> Result<Vec<u8>, String> {
    validate_password(new_password)?;
    let mut manifest = read_lockbox_manifest(cx.vfs)?;
    let master_key = manifest.unwrap_with_password(current_password)?;
    manifest.rewrap_password(new_password, &master_key)?;
    write_lockbox_manifest(cx.vfs, &manifest)?;
    cx.hooks
        .commit_path_if_git(".shard/lockbox.json", "change lockbox password")
        .ok();
    Ok(master_key)
}

/// 用恢复密钥重置口令：口令与恢复密钥两份都换，返回新的恢复密钥与主密钥。
pub fn reset_lockbox_password(
    cx: &VaultCtx<'_>,
    recovery_key: &str,
    new_password: &str,
) -> Result<LockboxSetup, String> {
    validate_password(new_password)?;
    let mut manifest = read_lockbox_manifest(cx.vfs)?;
    let master_key = manifest.unwrap_with_recovery(recovery_key)?;
    let next_recovery_key = manifest.reset(new_password, &master_key)?;
    write_lockbox_manifest(cx.vfs, &manifest)?;
    cx.hooks
        .commit_path_if_git(".shard/lockbox.json", "reset lockbox password")
        .ok();

    Ok(LockboxSetup { recovery_key: next_recovery_key, master_key })
}

// ---------------------------------------------------------------------------
// 密匣碎片
// ---------------------------------------------------------------------------

/// 新建一条密匣碎片：`lockbox/fragments/YYYY/MM/{id}.shard`，总用 manifest 的公钥加密（锁着也能写）。
/// `read_keys` 为 `None`（锁着）时返回不含正文的投影。
pub fn create_lockbox_fragment(
    cx: &VaultCtx<'_>,
    read_keys: Option<&ReadKeys>,
    content: &str,
    tags: Vec<String>,
) -> Result<Fragment, String> {
    reject_lockbox_images(content)?;
    let tags = normalize_type_tags(normalize_lockbox_tags(tags));
    if is_protected_type(&tags) {
        return Err(LOCKBOX_TYPE_ERROR.to_string());
    }
    let (write_key, read_keys) = prepare_write_key(cx, read_keys)?;
    let now = cx.now();
    let id = new_fragment_id(&now);
    let created_at = now.to_rfc3339();
    let dir = cx
        .root()
        .join("lockbox")
        .join("fragments")
        .join(now.format("%Y").to_string())
        .join(now.format("%m").to_string());
    cx.vfs.create_dir_all(&dir).map_err(|error| error.to_string())?;

    let path = dir.join(format!("{id}.shard"));
    let frontmatter = FragmentFrontmatter {
        id,
        created_at: created_at.clone(),
        updated_at: created_at,
        tags,
        category: None,
        ai_status: Some("none".to_string()),
        pinned: false,
        source: format!("{}-lockbox", cx.source),
        conflict_of: None,
        related: Vec::new(),
    };

    write_lockbox_fragment_file(cx.vfs, &path, &write_key, &frontmatter, None, content)?;

    let dirty = cx.hooks.dirty_paths();
    // 内容保存只落盘，提交由聚合检查点接管（docs/design/commit-coalescing-plan.md §7 A2）
    let override_status = None;

    if let Some(read_keys) = read_keys {
        read_lockbox_fragment(cx, &path, &dirty, &read_keys, override_status)
    } else {
        let encrypted_text = cx.vfs.read_to_string(&path).map_err(|error| error.to_string())?;
        lockbox_fragment_from_parts(
            cx,
            &path,
            &dirty,
            &encrypted_text,
            frontmatter,
            None,
            String::new(),
            override_status,
        )
    }
}

pub fn update_lockbox_fragment_in_vault(
    cx: &VaultCtx<'_>,
    path: &Path,
    read_keys: &ReadKeys,
    content: &str,
    tags: Vec<String>,
    expected_file_sha: Option<&str>,
) -> Result<Fragment, String> {
    reject_lockbox_images(content)?;
    let encrypted_text = cx.vfs.read_to_string(path).map_err(|error| error.to_string())?;
    ensure_expected_file_sha(&encrypted_text, expected_file_sha)?;
    let mut payload = read_lockbox_payload(cx.vfs, path, read_keys)?;
    let raw = payload
        .frontmatter_raw
        .clone()
        .map(Ok)
        .unwrap_or_else(|| raw_from_frontmatter(&payload.frontmatter))?;
    payload.frontmatter.tags = normalize_lockbox_tags(normalize_updated_type_tags(
        &payload.frontmatter.tags,
        tags,
    ));
    payload.frontmatter.updated_at = cx.now().to_rfc3339();
    payload.frontmatter_raw = Some(apply_frontmatter(&raw, &payload.frontmatter)?);
    payload.body = content.to_string();
    payload.markdown_dialect = Some(MARKDOWN_DIALECT);
    let write_key = WriteKey::Master(read_keys.master_key.clone());
    write_lockbox_payload(cx.vfs, path, &write_key, &payload)?;

    let dirty = cx.hooks.dirty_paths();
    // 内容保存只落盘，提交由聚合检查点接管（docs/design/commit-coalescing-plan.md §7 A2）
    let override_status = None;

    read_lockbox_fragment(cx, path, &dirty, read_keys, override_status)
}

pub fn update_lockbox_fragment_tags_in_vault(
    cx: &VaultCtx<'_>,
    path: &Path,
    read_keys: &ReadKeys,
    tags: Vec<String>,
) -> Result<Fragment, String> {
    let mut payload = read_lockbox_payload(cx.vfs, path, read_keys)?;
    let raw = payload
        .frontmatter_raw
        .clone()
        .map(Ok)
        .unwrap_or_else(|| raw_from_frontmatter(&payload.frontmatter))?;
    payload.frontmatter.tags = normalize_lockbox_tags(normalize_updated_type_tags(
        &payload.frontmatter.tags,
        tags,
    ));
    payload.frontmatter.updated_at = cx.now().to_rfc3339();
    payload.frontmatter_raw = Some(apply_frontmatter(&raw, &payload.frontmatter)?);
    let write_key = WriteKey::Master(read_keys.master_key.clone());
    write_lockbox_payload(cx.vfs, path, &write_key, &payload)?;

    let dirty = cx.hooks.dirty_paths();
    // 内容保存只落盘，提交由聚合检查点接管（docs/design/commit-coalescing-plan.md §7 A2）
    let override_status = None;

    read_lockbox_fragment(cx, path, &dirty, read_keys, override_status)
}

pub fn set_lockbox_fragment_pinned_in_vault(
    cx: &VaultCtx<'_>,
    path: &Path,
    read_keys: &ReadKeys,
    pinned: bool,
) -> Result<Fragment, String> {
    let rel_path = relative_path(cx.root(), path)?;
    if rel_path.starts_with("lockbox/archive/") && pinned {
        return Err("密匣中已删除的片段不能置顶。".to_string());
    }

    let mut payload = read_lockbox_payload(cx.vfs, path, read_keys)?;
    let raw = payload
        .frontmatter_raw
        .clone()
        .map(Ok)
        .unwrap_or_else(|| raw_from_frontmatter(&payload.frontmatter))?;
    payload.frontmatter.pinned = pinned;
    payload.frontmatter.updated_at = cx.now().to_rfc3339();
    payload.frontmatter_raw = Some(apply_frontmatter(&raw, &payload.frontmatter)?);
    let write_key = WriteKey::Master(read_keys.master_key.clone());
    write_lockbox_payload(cx.vfs, path, &write_key, &payload)?;

    let dirty = cx.hooks.dirty_paths();
    // 内容保存只落盘，提交由聚合检查点接管（docs/design/commit-coalescing-plan.md §7 A2）
    let override_status = None;

    read_lockbox_fragment(cx, path, &dirty, read_keys, override_status)
}

/// 密匣内的删除 / 恢复：在 `lockbox/fragments/` 与 `lockbox/archive/` 之间移动，始终保持加密。
pub fn set_lockbox_fragment_archived_in_vault(
    cx: &VaultCtx<'_>,
    path: &Path,
    read_keys: &ReadKeys,
    archived: bool,
) -> Result<Fragment, String> {
    let vault = cx.root();
    let rel_path = relative_path(vault, path)?;
    let is_archived = rel_path.starts_with("lockbox/archive/");
    if is_archived == archived {
        let dirty = cx.hooks.dirty_paths();
        return read_lockbox_fragment(cx, path, &dirty, read_keys, None);
    }

    let source_root = if is_archived {
        vault.join("lockbox").join("archive")
    } else {
        vault.join("lockbox").join("fragments")
    };
    let target_root = if archived {
        vault.join("lockbox").join("archive")
    } else {
        vault.join("lockbox").join("fragments")
    };
    let source_rel = path
        .strip_prefix(&source_root)
        .map_err(|error| error.to_string())?;
    let target_path = target_root.join(source_rel);

    if let Some(parent) = target_path.parent() {
        cx.vfs.create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    cx.vfs
        .rename(path, &target_path)
        .or_else(|_| {
            cx.vfs
                .copy(path, &target_path)
                .map(|_| ())
                .and_then(|_| cx.vfs.remove_file(path))
        })
        .map_err(|error| error.to_string())?;

    let dirty = cx.hooks.dirty_paths();
    // 内容保存只落盘，提交由聚合检查点接管（docs/design/commit-coalescing-plan.md §7 A2）
    let override_status = None;

    read_lockbox_fragment(cx, &target_path, &dirty, read_keys, override_status)
}

/// 设置（`Some`）或删除（`None`）一条密匣碎片的自定义属性；调用方已校验属性键。
pub fn mutate_lockbox_fragment_property_in_vault(
    cx: &VaultCtx<'_>,
    path: &Path,
    read_keys: &ReadKeys,
    key: &str,
    value: Option<&serde_yaml::Value>,
) -> Result<Fragment, String> {
    if relative_path(cx.root(), path)?.starts_with("lockbox/archive/") {
        return Err("密匣中已删除的片段不能修改属性。".to_string());
    }
    let mut payload = read_lockbox_payload(cx.vfs, path, read_keys)?;
    let raw = payload.frontmatter_raw.as_deref().map(str::to_string).map(Ok)
        .unwrap_or_else(|| raw_from_frontmatter(&payload.frontmatter))?;
    let raw = match value {
        Some(value) => set_custom_property(&raw, key, value)?,
        None => remove_custom_property(&raw, key)?,
    };
    payload.frontmatter.updated_at = cx.now().to_rfc3339();
    payload.frontmatter_raw = Some(apply_frontmatter(&raw, &payload.frontmatter)?);
    write_lockbox_payload(
        cx.vfs,
        path,
        &WriteKey::Master(read_keys.master_key.clone()),
        &payload,
    )?;
    read_lockbox_fragment(cx, path, &cx.hooks.dirty_paths(), read_keys, None)
}

// ---------------------------------------------------------------------------
// 公开内容移入密匣（`fragments/` → `lockbox/fragments/`，`notes/` → `lockbox/notes/`）
// ---------------------------------------------------------------------------

/// 把一篇公开碎片或笔记原样移入密匣（`move_fragment_to_lockbox` 命令）。
pub fn move_public_fragment_to_lockbox(
    cx: &VaultCtx<'_>,
    read_keys: Option<&ReadKeys>,
    path: &Path,
) -> Result<Fragment, String> {
    let text = cx.vfs.read_to_string(path).map_err(|error| error.to_string())?;
    let parsed = parse_fragment(&text)?;
    if is_protected_type(&parsed.frontmatter.tags) {
        return Err(LOCKBOX_TYPE_ERROR.to_string());
    }
    move_public_fragment_payload_to_lockbox(
        cx,
        read_keys,
        path,
        parsed.body.trim_start_matches('\n'),
        parsed.frontmatter.tags.clone(),
        Some(parsed.frontmatter),
        Some(parsed.raw),
    )
}

/// 保存公开碎片时新标签带上了密匣标签：用新正文与新标签移入密匣（[`PublicFragmentUpdate::MoveToLockbox`]）。
pub fn move_public_fragment_content_to_lockbox(
    cx: &VaultCtx<'_>,
    read_keys: Option<&ReadKeys>,
    path: &Path,
    content: &str,
    tags: Vec<String>,
) -> Result<Fragment, String> {
    let text = cx.vfs.read_to_string(path).map_err(|error| error.to_string())?;
    let parsed = parse_fragment(&text)?;
    if is_protected_type(&parsed.frontmatter.tags) {
        return Err(LOCKBOX_TYPE_ERROR.to_string());
    }
    move_public_fragment_payload_to_lockbox(
        cx,
        read_keys,
        path,
        content,
        tags,
        Some(parsed.frontmatter),
        Some(parsed.raw),
    )
}

fn move_public_fragment_payload_to_lockbox(
    cx: &VaultCtx<'_>,
    read_keys: Option<&ReadKeys>,
    public_path: &Path,
    content: &str,
    tags: Vec<String>,
    existing_frontmatter: Option<FragmentFrontmatter>,
    existing_frontmatter_raw: Option<String>,
) -> Result<Fragment, String> {
    reject_lockbox_images(content)?;
    if existing_frontmatter
        .as_ref()
        .is_some_and(|frontmatter| is_protected_type(&frontmatter.tags))
    {
        return Err(LOCKBOX_TYPE_ERROR.to_string());
    }
    let vault = cx.root();
    let (write_key, read_keys) = prepare_write_key(cx, read_keys)?;
    let mut frontmatter = existing_frontmatter.ok_or_else(|| "片段缺少 frontmatter".to_string())?;
    frontmatter.tags = normalize_lockbox_tags(tags);
    frontmatter.updated_at = cx.now().to_rfc3339();
    frontmatter.source = format!("{}-lockbox", cx.source);
    frontmatter.related.clear();

    let public_path_mapping = [
        ("notes", vault.join("lockbox").join("notes")),
        ("fragments", vault.join("lockbox").join("fragments")),
    ]
    .into_iter()
    .find_map(|(source, target_root)| {
        public_path
            .strip_prefix(vault.join(source))
            .ok()
            .map(|public_rel| (public_rel, target_root))
    })
    .ok_or_else(|| "只有 fragments/、notes/ 中的文档可以移入密匣。".to_string())?;
    let (public_rel, target_root) = public_path_mapping;
    let mut lockbox_path = target_root.join(public_rel);
    lockbox_path.set_extension("shard");

    if let Some(parent) = lockbox_path.parent() {
        cx.vfs.create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    write_lockbox_fragment_file(
        cx.vfs,
        &lockbox_path,
        &write_key,
        &frontmatter,
        existing_frontmatter_raw.as_deref(),
        content,
    )?;
    cx.vfs.remove_file(public_path).map_err(|error| error.to_string())?;

    let commit_result = cx.hooks.commit_paths_if_git(
        &[
            relative_path(vault, public_path)?,
            relative_path(vault, &lockbox_path)?,
        ],
        &format!("move fragment {} to lockbox", frontmatter.id),
    );
    let dirty = cx.hooks.dirty_paths();
    let override_status = commit_override_status(commit_result);

    if let Some(read_keys) = read_keys {
        read_lockbox_fragment(cx, &lockbox_path, &dirty, &read_keys, override_status)
    } else {
        let encrypted_text = cx
            .vfs
            .read_to_string(&lockbox_path)
            .map_err(|error| error.to_string())?;
        lockbox_fragment_from_parts(
            cx,
            &lockbox_path,
            &dirty,
            &encrypted_text,
            frontmatter,
            None,
            String::new(),
            override_status,
        )
    }
}

fn commit_override_status(
    commit_result: Result<Option<()>, String>,
) -> Option<(String, Option<String>)> {
    match commit_result {
        Ok(Some(_)) => Some(("committed".to_string(), None)),
        Ok(None) => Some(("saved".to_string(), None)),
        Err(error) => Some(("commit_failed".to_string(), Some(error))),
    }
}

// ---------------------------------------------------------------------------
// 读取与投影
// ---------------------------------------------------------------------------

/// 已解锁时列出密匣里的全部碎片与笔记（`lockbox/fragments`、`lockbox/archive`、`lockbox/notes`），
/// 解不开的跳过，未排序。
pub fn list_lockbox_fragments(
    cx: &VaultCtx<'_>,
    dirty_paths: &HashSet<String>,
    read_keys: &ReadKeys,
) -> Result<Vec<Fragment>, String> {
    let vault = cx.root();
    let mut lockbox_files = Vec::new();
    collect_lockbox_files(
        cx.vfs,
        &vault.join("lockbox").join("fragments"),
        &mut lockbox_files,
    )?;
    collect_lockbox_files(cx.vfs, &vault.join("lockbox").join("archive"), &mut lockbox_files)?;
    collect_lockbox_files(cx.vfs, &vault.join("lockbox").join("notes"), &mut lockbox_files)?;

    Ok(lockbox_files
        .iter()
        .filter_map(|path| read_lockbox_fragment(cx, path, dirty_paths, read_keys, None).ok())
        .collect())
}

pub fn read_lockbox_fragment(
    cx: &VaultCtx<'_>,
    path: &Path,
    dirty_paths: &HashSet<String>,
    read_keys: &ReadKeys,
    override_status: Option<(String, Option<String>)>,
) -> Result<Fragment, String> {
    let encrypted_text = cx.vfs.read_to_string(path).map_err(|error| error.to_string())?;
    let payload = read_lockbox_payload_from_text(&encrypted_text, read_keys)?;
    lockbox_fragment_from_parts(
        cx,
        path,
        dirty_paths,
        &encrypted_text,
        payload.frontmatter,
        payload.frontmatter_raw,
        payload.body,
        override_status,
    )
}

/// 密匣碎片的 DTO。`file_sha` 是信封原文（密文）的哈希，与正文出自同一份快照。
#[allow(clippy::too_many_arguments)]
pub fn lockbox_fragment_from_parts(
    cx: &VaultCtx<'_>,
    path: &Path,
    dirty_paths: &HashSet<String>,
    encrypted_text: &str,
    frontmatter: FragmentFrontmatter,
    frontmatter_raw: Option<String>,
    body: String,
    override_status: Option<(String, Option<String>)>,
) -> Result<Fragment, String> {
    let rel_path = relative_path(cx.root(), path)?;
    let (git_status, error) = override_status.unwrap_or_else(|| {
        if !cx.hooks.has_vcs() {
            ("saved".to_string(), None)
        } else if dirty_paths.contains(&rel_path) {
            ("sync_pending".to_string(), None)
        } else {
            ("committed".to_string(), None)
        }
    });
    let archived = rel_path.starts_with("lockbox/archive/");
    let properties = frontmatter_raw
        .as_deref()
        .map(fragment_properties)
        .unwrap_or_default();

    Ok(Fragment {
        id: frontmatter.id,
        content: body.trim_start_matches('\n').to_string(),
        file_sha: content_sha256_hex(encrypted_text),
        created_at: frontmatter.created_at,
        updated_at: frontmatter.updated_at,
        tags: frontmatter.tags,
        category: frontmatter.category,
        path: rel_path,
        git_status,
        error,
        ai_status: frontmatter.ai_status.unwrap_or_else(|| "none".to_string()),
        archived,
        lockbox: true,
        pinned: frontmatter.pinned,
        related: frontmatter.related,
        properties,
        conflict_of: frontmatter.conflict_of,
    })
}

// ---------------------------------------------------------------------------
// 载荷读写
// ---------------------------------------------------------------------------

pub fn write_lockbox_fragment_file(
    vfs: &dyn Vfs,
    path: &Path,
    write_key: &WriteKey,
    frontmatter: &FragmentFrontmatter,
    frontmatter_raw: Option<&str>,
    body: &str,
) -> Result<(), String> {
    let mut next = frontmatter.clone();
    next.related.clear();
    let raw = match frontmatter_raw {
        Some(raw) => apply_frontmatter(raw, &next)?,
        None => raw_from_frontmatter(&next)?,
    };
    let payload = LockboxFragmentPayload {
        frontmatter: next,
        frontmatter_raw: Some(raw),
        body: body.trim_end().to_string(),
        markdown_dialect: Some(MARKDOWN_DIALECT),
    };
    write_lockbox_payload(vfs, path, write_key, &payload)
}

pub fn write_lockbox_payload(
    vfs: &dyn Vfs,
    path: &Path,
    write_key: &WriteKey,
    payload: &LockboxFragmentPayload,
) -> Result<(), String> {
    let plaintext = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
    let text = Envelope::seal(write_key, &payload.frontmatter.id, &plaintext)?.to_text()?;
    vfs.write_atomic(path, text.as_bytes())
        .map_err(|error| error.to_string())
}

pub fn read_lockbox_payload(
    vfs: &dyn Vfs,
    path: &Path,
    read_keys: &ReadKeys,
) -> Result<LockboxFragmentPayload, String> {
    let text = vfs.read_to_string(path).map_err(|error| error.to_string())?;
    read_lockbox_payload_from_text(&text, read_keys)
}

/// 解密 `.shard` 原文。有 `frontmatter_raw` 时以它为准重建结构化 frontmatter。
pub fn read_lockbox_payload_from_text(
    text: &str,
    read_keys: &ReadKeys,
) -> Result<LockboxFragmentPayload, String> {
    let plaintext = shard_lockbox::open_text(text, read_keys)?;
    let mut payload =
        serde_json::from_slice::<LockboxFragmentPayload>(&plaintext).map_err(|error| error.to_string())?;
    if let Some(raw) = payload.frontmatter_raw.as_deref() {
        payload.frontmatter =
            serde_yaml::from_str(raw).map_err(|error| format!("密匣 frontmatter 无效：{error}"))?;
    }
    Ok(payload)
}

/// 密匣碎片的标签：规范化后去掉密匣标签与 `inbox`，排序去重。
pub fn normalize_lockbox_tags(tags: Vec<String>) -> Vec<String> {
    let mut next_tags = tags
        .into_iter()
        .filter_map(|tag| normalize_tag(&tag))
        .filter(|tag| tag != LOCKBOX_TAG && tag != "inbox")
        .collect::<Vec<_>>();
    next_tags.sort();
    next_tags.dedup();
    next_tags
}

pub fn reject_lockbox_images(content: &str) -> Result<(), String> {
    if content.lines().any(is_markdown_image_line) {
        return Err("密匣暂不支持图片附件。请先移除图片，再保存到密匣。".to_string());
    }
    Ok(())
}

pub fn is_markdown_image_line(line: &str) -> bool {
    let line = line.trim();
    line.starts_with("![") && line.contains("](") && line.ends_with(')')
}

// ---------------------------------------------------------------------------
// 搜索：解密后的载荷 → 可搜索文档
// ---------------------------------------------------------------------------

/// 一份密匣信封原文 → 可搜索文档（复用公开 Markdown 的投影）。`vault_path` 是搜索上下文里的资料库标识，
/// `relative` 是信封相对资料库的路径。解不开报不可重试的 IO 错误；会话校验由调用方前后各做一次。
pub fn lockbox_search_document(
    vault_path: &str,
    relative: String,
    encrypted_text: &str,
    read_keys: &ReadKeys,
) -> Result<LoadedSearchDocument, SearchError> {
    let file_sha = content_sha256_hex(encrypted_text);
    let payload = read_lockbox_payload_from_text(encrypted_text, read_keys)
        .map_err(|_| SearchError::Io { retryable: false })?;
    let revision = serde_json::to_vec(&payload)
        .map(|bytes| hash_bytes(&bytes))
        .map_err(|_| SearchError::Internal { retryable: false })?;
    let LockboxFragmentPayload {
        frontmatter,
        frontmatter_raw,
        body,
        ..
    } = payload;
    let archived = relative.starts_with("lockbox/archive/");
    Ok(markdown_document(
        vault_path,
        SearchScope::Lockbox,
        relative,
        archived,
        frontmatter,
        frontmatter_raw.as_deref(),
        &body,
        revision,
        file_sha,
    ))
}

// ---------------------------------------------------------------------------
// Markdown 方言迁移（密匣部分；公开部分在 src-tauri 的 markdown_dialect.rs）
// ---------------------------------------------------------------------------

/// 还是方言 v1 的一条密匣正文（交给前端改写）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockboxDialectSource {
    pub path: String,
    pub body: String,
    pub sha: String,
}

/// 前端改写好的密匣正文，`expected_sha` 是列出时信封原文的哈希。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigratedLockboxDialectSource {
    pub path: String,
    pub expected_sha: String,
    pub body: String,
}

/// 解锁后列出还是方言 v1 的密匣正文（整个 `lockbox/` 下的信封，按路径排序）。
/// 读不出或解不开的跳过，不挡住整批迁移。
pub fn list_lockbox_dialect_sources(
    cx: &VaultCtx<'_>,
    read_keys: &ReadKeys,
) -> Result<Vec<LockboxDialectSource>, String> {
    let vault = cx.root();
    let mut files = Vec::new();
    collect_lockbox_files(cx.vfs, &vault.join("lockbox"), &mut files)?;
    files.sort();

    let mut sources = Vec::new();
    for path in files {
        let Ok(text) = cx.vfs.read_to_string(&path) else {
            eprintln!("[shard] 方言迁移跳过无法读取的密匣文件：{}", path.display());
            continue;
        };
        let Ok(payload) = read_lockbox_payload_from_text(&text, read_keys) else {
            eprintln!("[shard] 方言迁移跳过无法解密的密匣文件：{}", path.display());
            continue;
        };
        if payload.markdown_dialect.is_some() {
            continue;
        }
        sources.push(LockboxDialectSource {
            path: relative_path(vault, &path)?,
            sha: content_sha256_hex(&text),
            body: payload.body,
        });
    }
    Ok(sources)
}

/// 调用方持有写门。只改 v1 载荷的正文并标上 v2；核对 sha 全部通过才写。
pub fn apply_lockbox_dialect_migration(
    cx: &VaultCtx<'_>,
    read_keys: &ReadKeys,
    files: Vec<MigratedLockboxDialectSource>,
) -> Result<usize, String> {
    let vault = cx.root();
    let mut writes = Vec::new();
    for file in files {
        let target = lockbox_dialect_target(vault, &file.path)?;
        let text = cx.vfs.read_to_string(&target).map_err(|error| error.to_string())?;
        if content_sha256_hex(&text) != file.expected_sha {
            return Err(format!("{} 在迁移期间被改动，已中止，请重新解锁再试。", file.path));
        }
        let mut payload = read_lockbox_payload_from_text(&text, read_keys)?;
        if payload.markdown_dialect.is_some() {
            return Err(format!("{} 已经是新格式，不能重复迁移。", file.path));
        }
        payload.body = file.body;
        payload.markdown_dialect = Some(MARKDOWN_DIALECT);
        writes.push((target, file.path, payload));
    }
    if writes.is_empty() {
        return Ok(0);
    }

    cx.hooks.checkpoint_before_structural();
    let write_key = WriteKey::Master(read_keys.master_key.clone());
    for (target, _, payload) in &writes {
        write_lockbox_payload(cx.vfs, target, &write_key, payload)?;
    }
    let paths: Vec<String> = writes.iter().map(|(_, path, _)| path.clone()).collect();
    if let Err(error) = cx.hooks.commit_paths_if_git(&paths, MARKDOWN_DIALECT_MIGRATION_COMMIT_MESSAGE) {
        eprintln!("[shard] 密匣方言迁移提交失败（文件已写入）：{error}");
    }
    Ok(writes.len())
}

/// 方言迁移允许写回的密匣路径：`lockbox/` 下的 `.shard`，不含 `.` / `..`。
pub fn lockbox_dialect_target(vault: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let target = dialect_migration_path(vault, rel_path)?;
    if !rel_path.starts_with("lockbox/") || !rel_path.ends_with(".shard") {
        return Err(format!("不允许迁移这个路径：{rel_path}"));
    }
    Ok(target)
}
