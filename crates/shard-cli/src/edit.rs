//! 用 `$VISUAL` / `$EDITOR` 编辑一条已有碎片。
//!
//! 保存语义与 App 编辑碎片一致：正文里的 `#标签` 重新收进 frontmatter，type 标签
//! 原样保留，`updated_at` 刷新，frontmatter 其余内容逐字节不动（`write_fragment_update`）。
//! 编辑器开着的时候不持锁；写回前拿资料库进程锁并核对文件哈希，期间被 App 或同步
//! 改过就拒绝覆盖，用户的修改留在临时文件里。

use crate::find::{short_id, FragmentEntry};
use crate::tui::app::{SaveError, SaveReport};
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

pub struct Session {
    pub path: PathBuf,
    pub vault: PathBuf,
    pub id: String,
    pub body: String,
    raw: String,
    sha: String,
}

pub fn open_session(entry: &FragmentEntry) -> Result<Session, String> {
    let raw = fs::read_to_string(&entry.path)
        .map_err(|error| format!("读取 {} 失败：{error}", entry.path.display()))?;
    let parsed = parse_fragment(&raw)?;
    if derive_type(&parsed.frontmatter.tags).is_some_and(|kind| PROTECTED_TYPE_TAGS.contains(&kind))
    {
        return Err("大纲与流程图请在 Shard 中编辑，或使用 --graph-* 命令。".to_string());
    }
    let vault = entry
        .path
        .ancestors()
        .find(|path| path.file_name().is_some_and(|name| name == "fragments"))
        .and_then(Path::parent)
        .ok_or_else(|| {
            format!(
                "碎片路径不在资料库 fragments 目录中：{}",
                entry.path.display()
            )
        })?
        .to_path_buf();
    Ok(Session {
        path: entry.path.clone(),
        vault,
        id: entry.id.clone(),
        body: parsed.body.trim_start_matches('\n').trim_end().to_string(),
        sha: content_sha256_hex(&raw),
        raw,
    })
}

pub fn save_session(
    session: &mut Session,
    body: &str,
    lock_dir: &Path,
    timeout: Duration,
) -> Result<SaveReport, SaveError> {
    let next_body = body.trim_start_matches('\n').trim_end();
    if next_body.trim().is_empty() {
        return Err(SaveError::Invalid(
            "内容为空，未保存。删除碎片请在 Shard 中操作。".into(),
        ));
    }
    let parsed = parse_fragment(&session.raw).map_err(SaveError::Invalid)?;
    let tags = edited_tags(&parsed.frontmatter.tags, next_body);
    if contains_lockbox_tag(&tags) {
        return Err(SaveError::Invalid(
            "终端不支持写入密匣，请在 Shard 中保存。".into(),
        ));
    }
    let _lock =
        VaultProcessLock::acquire(lock_dir, &session.vault, Some(timeout)).map_err(|error| {
            if error == "Shard 正在写入资料库，请稍后重试" {
                SaveError::Locked
            } else {
                SaveError::Invalid(error)
            }
        })?;
    let current = fs::read_to_string(&session.path).ok();
    if current.as_deref().map(content_sha256_hex).as_deref() != Some(session.sha.as_str()) {
        let draft = draft_path(&session.id);
        fs::write(&draft, format!("{next_body}\n"))
            .map_err(|error| SaveError::Invalid(format!("创建临时文件失败：{error}")))?;
        return Err(SaveError::Conflict { draft_path: draft });
    }
    let mut frontmatter = parsed.frontmatter;
    frontmatter.tags = tags;
    frontmatter.updated_at = now_rfc3339();
    write_fragment_update(&session.path, &parsed.raw, &frontmatter, next_body)
        .map_err(|error| SaveError::Invalid(format!("保存失败：{error}")))?;
    session.raw = fs::read_to_string(&session.path)
        .map_err(|error| SaveError::Invalid(format!("读取保存结果失败：{error}")))?;
    session.sha = content_sha256_hex(&session.raw);
    session.body = next_body.to_string();
    Ok(SaveReport)
}

pub fn edit_fragment(
    _vault: &Path,
    entry: &FragmentEntry,
    lock_dir: &Path,
    lock_timeout: Duration,
) -> Result<EditOutcome, EditFailure> {
    let mut session = open_session(entry).map_err(EditFailure::from)?;
    let original_body = session.body.clone();

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
    match save_session(&mut session, next_body, lock_dir, lock_timeout) {
        Ok(_) => {
            let _ = fs::remove_file(&draft);
            Ok(EditOutcome::Saved)
        }
        Err(SaveError::Conflict { draft_path }) => {
            let _ = fs::remove_file(&draft);
            Err(EditFailure { code: 2, message: format!(
                "编辑期间这条碎片已被修改（可能来自 Shard 或同步），没有覆盖。\n你的修改保存在：{}", draft_path.display()
            ) })
        }
        Err(error) => {
            let message = match error {
                SaveError::Locked => "Shard 正在写入资料库，请稍后重试".to_string(),
                SaveError::Invalid(message) => message,
                SaveError::Conflict { .. } => unreachable!(),
            };
            if next_body.trim().is_empty() {
                let _ = fs::remove_file(&draft);
                Err(message.into())
            } else {
                Err(format!("{message}\n你的修改保存在：{}", draft.display()).into())
            }
        }
    }
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

    use tempfile::TempDir;

    fn session_fixture() -> (TempDir, FragmentEntry) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vault/fragments/2026/09/one.md");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "---\nid: one\ncreated_at: 2026-09-29T00:00:00Z\nupdated_at: 2026-09-29T00:00:00Z\ntags: [inbox]\ncategory: null\nai_status: none\nsource: test\n---\n\n原文\n").unwrap();
        let entry = FragmentEntry {
            id: "one".into(),
            path,
            title: "原文".into(),
            created_at: "2026-09-29T00:00:00Z".into(),
            kind: None,
            tags: vec!["inbox".into()],
            modified_at: 0,
            body: "原文".into(),
        };
        (directory, entry)
    }

    #[test]
    fn session_saves_twice_with_updated_baseline() {
        let (directory, entry) = session_fixture();
        let mut session = open_session(&entry).unwrap();
        let locks = directory.path().join("locks");
        save_session(
            &mut session,
            "第一次 #标签",
            &locks,
            Duration::from_millis(100),
        )
        .unwrap();
        save_session(
            &mut session,
            "第二次 #标签",
            &locks,
            Duration::from_millis(100),
        )
        .unwrap();
        let parsed = parse_fragment(&fs::read_to_string(entry.path).unwrap()).unwrap();
        assert_eq!(parsed.body.trim(), "第二次 #标签");
        assert_eq!(parsed.frontmatter.tags, vec!["inbox", "标签"]);
    }

    #[test]
    fn session_conflict_writes_draft_without_overwrite() {
        let (directory, entry) = session_fixture();
        let mut session = open_session(&entry).unwrap();
        fs::write(&entry.path, "其他进程修改").unwrap();
        let error = save_session(
            &mut session,
            "我的修改",
            &directory.path().join("locks"),
            Duration::from_millis(100),
        )
        .unwrap_err();
        let SaveError::Conflict { draft_path } = error else {
            panic!("应返回冲突")
        };
        assert_eq!(fs::read_to_string(&draft_path).unwrap(), "我的修改\n");
        assert_eq!(fs::read_to_string(&entry.path).unwrap(), "其他进程修改");
        fs::remove_file(draft_path).unwrap();
    }

    #[test]
    fn session_lock_timeout_keeps_original() {
        let (directory, entry) = session_fixture();
        let mut session = open_session(&entry).unwrap();
        let before = fs::read(&entry.path).unwrap();
        let locks = directory.path().join("locks");
        let held = VaultProcessLock::acquire(&locks, &session.vault, None).unwrap();
        assert_eq!(
            save_session(&mut session, "我的修改", &locks, Duration::from_millis(10)),
            Err(SaveError::Locked)
        );
        assert_eq!(fs::read(entry.path).unwrap(), before);
        drop(held);
    }

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
