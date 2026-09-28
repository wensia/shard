//! 用 `$VISUAL` / `$EDITOR` 编辑一条已有碎片。
//!
//! 保存语义与 App 编辑碎片一致：正文里的 `#标签` 重新收进 frontmatter，type 标签
//! 原样保留，`updated_at` 刷新，frontmatter 其余内容逐字节不动（`write_fragment_update`）。
//! 编辑器开着的时候不持锁；写回前拿资料库进程锁并核对文件哈希，期间被 App 或同步
//! 改过就拒绝覆盖，用户的修改留在临时文件里。

use crate::find::{short_id, FragmentEntry};
use shard_core::{
    contains_lockbox_tag, derive_type, extract_tags,
    frontmatter::{parse_fragment, write_fragment_update},
    graph_model::{content_sha256_hex, now_rfc3339},
    normalize_tags, normalize_type_tags, unique_suffix,
    vault_lock::VaultProcessLock,
    INBOX_TAG, PROTECTED_TYPE_TAGS, TYPE_TAGS,
};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

pub enum EditOutcome {
    Saved,
    Unchanged,
}

pub struct EditFailure {
    /// 2 = 编辑期间文件被改动（冲突），其余 1。
    pub code: u8,
    pub message: String,
}

impl From<String> for EditFailure {
    fn from(message: String) -> Self {
        Self { code: 1, message }
    }
}

pub fn edit_fragment(
    vault: &Path,
    entry: &FragmentEntry,
    lock_dir: &Path,
    lock_timeout: Duration,
) -> Result<EditOutcome, EditFailure> {
    let original_text = fs::read_to_string(&entry.path)
        .map_err(|error| format!("读取 {} 失败：{error}", entry.relative_path(vault)))?;
    let original_sha = content_sha256_hex(&original_text);
    let parsed = parse_fragment(&original_text)?;
    if derive_type(&parsed.frontmatter.tags).is_some_and(|kind| PROTECTED_TYPE_TAGS.contains(&kind))
    {
        return Err("大纲与流程图请在 Shard 中编辑，或使用 --graph-* 命令。"
            .to_string()
            .into());
    }
    let original_body = parsed.body.trim_start_matches('\n').trim_end();

    let draft = draft_path(&entry.id);
    fs::write(&draft, format!("{original_body}\n"))
        .map_err(|error| format!("创建临时文件失败：{error}"))?;

    if let Err(message) = open_in_editor(&draft) {
        let _ = fs::remove_file(&draft);
        return Err(message.into());
    }
    let edited = fs::read_to_string(&draft)
        .map_err(|error| format!("读取编辑结果失败：{error}（临时文件：{}）", draft.display()))?;
    let next_body = edited.trim_start_matches('\n').trim_end();

    if next_body == original_body {
        let _ = fs::remove_file(&draft);
        return Ok(EditOutcome::Unchanged);
    }
    if next_body.trim().is_empty() {
        let _ = fs::remove_file(&draft);
        return Err("内容为空，未保存。删除碎片请在 Shard 中操作。"
            .to_string()
            .into());
    }
    let kept = |message: String| format!("{message}\n你的修改保存在：{}", draft.display());

    let tags = edited_tags(&parsed.frontmatter.tags, next_body);
    if contains_lockbox_tag(&tags) {
        return Err(kept("终端不支持写入密匣，请在 Shard 中保存。".to_string()).into());
    }

    let _lock = VaultProcessLock::acquire(lock_dir, vault, Some(lock_timeout))
        .map_err(|error| kept(error.to_string()))?;
    let current = fs::read_to_string(&entry.path).ok();
    if current.as_deref().map(content_sha256_hex).as_deref() != Some(original_sha.as_str()) {
        return Err(EditFailure {
            code: 2,
            message: kept(
                "编辑期间这条碎片已被修改（可能来自 Shard 或同步），没有覆盖。".to_string(),
            ),
        });
    }

    let mut frontmatter = parsed.frontmatter;
    frontmatter.tags = tags;
    frontmatter.updated_at = now_rfc3339();
    write_fragment_update(&entry.path, &parsed.raw, &frontmatter, next_body)
        .map_err(|error| kept(format!("保存失败：{error}")))?;
    let _ = fs::remove_file(&draft);
    Ok(EditOutcome::Saved)
}

/// 标签规则 = 碎片编辑器提交（`fragment-editor.tsx`：`inbox` + 正文标签，非碎片类型
/// 换回原 type）再过一遍后端 `normalize_updated_type_tags`（受保护类型不可增删）。
fn edited_tags(current: &[String], body: &str) -> Vec<String> {
    let mut tags = vec![INBOX_TAG.to_string()];
    tags.extend(extract_tags(body));
    let mut tags = normalize_tags(tags, false);
    let current_kind = derive_type(current);
    if let Some(kind) = current_kind {
        tags.retain(|tag| !TYPE_TAGS.contains(&tag.as_str()));
        tags.push(kind.to_string());
    }

    let mut next = normalize_type_tags(normalize_tags(tags, false));
    match current_kind.filter(|kind| PROTECTED_TYPE_TAGS.contains(kind)) {
        Some(kind) => {
            next.retain(|tag| !TYPE_TAGS.contains(&tag.as_str()));
            next.push(kind.to_string());
            next.sort();
            next.dedup();
        }
        None => next.retain(|tag| !PROTECTED_TYPE_TAGS.contains(&tag.as_str())),
    }
    if next.is_empty() {
        vec![INBOX_TAG.to_string()]
    } else {
        next
    }
}

/// 临时文件放系统临时目录，扩展名 `.md` 让编辑器按 Markdown 高亮。
fn draft_path(id: &str) -> PathBuf {
    env::temp_dir().join(format!("shard-{}-{}.md", short_id(id), unique_suffix()))
}

/// 与 git 相同的约定：`$VISUAL` → `$EDITOR` → `vi`，交给 shell 执行以支持
/// `code -w` 这类带参数的写法。
fn open_in_editor(path: &Path) -> Result<(), String> {
    let editor = ["VISUAL", "EDITOR"]
        .iter()
        .filter_map(|name| env::var(name).ok())
        .find(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "vi".to_string());
    let status = if cfg!(windows) {
        Command::new("cmd")
            .args(["/C", &format!("{editor} \"{}\"", path.display())])
            .status()
    } else {
        Command::new("sh")
            .arg("-c")
            .arg(format!("{editor} \"$@\""))
            .arg(&editor)
            .arg(path)
            .status()
    }
    .map_err(|error| format!("无法启动编辑器 {editor}：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("编辑器 {editor} 异常退出，没有保存"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn fragment_tags_follow_body() {
        assert_eq!(
            edited_tags(&tags(&["inbox", "旧标签"]), "买咖啡 #生活"),
            tags(&["inbox", "生活"])
        );
    }

    #[test]
    fn document_keeps_its_type() {
        assert_eq!(
            edited_tags(&tags(&["document", "inbox"]), "# 标题\n\n正文 #读书"),
            tags(&["document", "inbox", "读书"])
        );
    }

    #[test]
    fn body_cannot_switch_or_add_protected_type() {
        assert_eq!(
            edited_tags(&tags(&["inbox"]), "随手记 #outline"),
            tags(&["inbox"])
        );
        assert_eq!(
            edited_tags(&tags(&["document", "inbox"]), "改成笔记 #note"),
            tags(&["document", "inbox"])
        );
    }
}
