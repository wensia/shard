//! 共用的小工具：哈希、相对路径、保存基线校验、类型标签规则。

use crate::prelude::*;

/// 保存基线过期（磁盘内容已被同步或外部编辑改写）的错误标记；
/// 前端识别该前缀进入冲突流程（覆盖 / 载入磁盘版）。
pub const STALE_BASE_ERROR: &str =
    "STALE_BASE:磁盘上的笔记内容已变化（可能来自同步或外部编辑），保存已中止";

pub const LOCKBOX_TYPE_ERROR: &str = "大纲与流程图不能放入密匣。";

pub fn content_sha256_hex(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// expected_file_sha 为调用方上次读到/存下的完整文件哈希；不带则跳过校验。
pub fn ensure_expected_file_sha(current_file: &str, expected_file_sha: Option<&str>) -> Result<(), String> {
    let Some(expected) = expected_file_sha else {
        return Ok(());
    };
    if content_sha256_hex(current_file) != expected {
        return Err(STALE_BASE_ERROR.to_string());
    }
    Ok(())
}

pub fn is_protected_type(tags: &[String]) -> bool {
    derive_type(tags).is_some_and(|kind| PROTECTED_TYPE_TAGS.contains(&kind))
}

pub fn normalize_updated_type_tags(current_tags: &[String], tags: Vec<String>) -> Vec<String> {
    let mut next = normalize_type_tags(normalize_tags(tags, false));
    if let Some(current) = derive_type(current_tags).filter(|kind| PROTECTED_TYPE_TAGS.contains(kind)) {
        next.retain(|tag| !TYPE_TAGS.contains(&tag.as_str()));
        next.push(current.to_string());
        next.sort();
        next.dedup();
    } else {
        next.retain(|tag| !PROTECTED_TYPE_TAGS.contains(&tag.as_str()));
    }
    next
}

pub fn hash_text(text: &str) -> String {
    hash_bytes(text.as_bytes())
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn system_time_to_rfc3339(value: SystemTime) -> String {
    let datetime: chrono::DateTime<chrono::Utc> = value.into();
    datetime.to_rfc3339()
}

pub fn relative_path(vault: &Path, path: &Path) -> Result<String, String> {
    let rel = path
        .strip_prefix(vault)
        .map_err(|error| error.to_string())?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

/// Markdown 方言迁移的提交信息：公开内容（src-tauri 的 markdown_dialect.rs）与密匣（[`crate::lockbox`]）共用。
pub const MARKDOWN_DIALECT_MIGRATION_COMMIT_MESSAGE: &str =
    "格式迁移：Markdown 方言 v2（源码一行显示一行，空一行显示一行空白）";

/// 方言迁移写回的目标：只收由普通名字组成的相对路径（不含 `.`、`..`、根），公开与密匣迁移共用。
pub fn dialect_migration_path(vault: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(rel_path);
    if path.components().any(|component| !matches!(component, Component::Normal(_))) {
        return Err(format!("不允许迁移这个路径：{rel_path}"));
    }
    Ok(vault.join(path))
}
