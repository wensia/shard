//! 用 `$VISUAL` / `$EDITOR` 编辑一条已有碎片。
//!
//! 保存语义与 App 编辑碎片一致：正文里的 `#标签` 重新收进 frontmatter，type 标签
//! 原样保留，`updated_at` 刷新，frontmatter 其余内容逐字节不动（`write_fragment_update`）。
//! 编辑器开着的时候不持锁；写回前拿资料库进程锁并核对文件哈希，期间被 App 或同步
//! 改过就拒绝覆盖，用户的修改留在临时文件里。

use crate::find::{short_id, FragmentEntry};
use crate::tui::app::{SaveError, SaveReport, Store};
use shard_core::{
    derive_type,
    frontmatter::parse_fragment,
    graph_model::{content_sha256_hex, now_rfc3339},
    unique_suffix,
    vault_lock::VaultProcessLock,
    FsVfs, PROTECTED_TYPE_TAGS,
};
use shard_vault::cli::{normalize_body, rewrite_document};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

pub use shard_vault::cli::PROTECTED_MESSAGE;

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

pub fn open_session(vault: &Path, entry: &FragmentEntry) -> Result<Session, String> {
    let path = vault.join(&entry.path);
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    let parsed = parse_fragment(&raw)?;
    if derive_type(&parsed.frontmatter.tags).is_some_and(|kind| PROTECTED_TYPE_TAGS.contains(&kind))
    {
        return Err(PROTECTED_MESSAGE.to_string());
    }
    Ok(Session {
        path,
        vault: vault.to_path_buf(),
        id: entry.id.clone(),
        body: normalize_body(&parsed.body).to_string(),
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
    let next_body = normalize_body(body).to_string();
    let written = rewrite_body(
        &session.vault,
        &session.path,
        Some(&session.sha),
        |_| next_body.clone(),
        lock_dir,
        timeout,
    );
    match written {
        Ok(written) => {
            session.raw = written.raw;
            session.sha = written.sha;
            session.body = next_body;
            Ok(SaveReport)
        }
        Err(RewriteError::Stale) => Err(conflict_draft(&session.id, &next_body)),
        Err(RewriteError::Locked) => Err(SaveError::Locked),
        Err(RewriteError::Invalid(message)) => Err(SaveError::Invalid(message)),
    }
}

/// 保存时发现期间被改过：把这次的修改写进临时文件，交给调用方提示用户，绝不覆盖。
pub fn conflict_draft(id: &str, body: &str) -> SaveError {
    let draft = draft_path(id);
    match fs::write(&draft, format!("{body}\n")) {
        Ok(()) => SaveError::Conflict { draft_path: draft },
        Err(error) => SaveError::Invalid(format!("创建临时文件失败：{error}")),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum RewriteError {
    /// 文件哈希与调用方的基线不一致：期间被 App、同步或其他进程改过。
    Stale,
    Locked,
    Invalid(String),
}

pub use shard_vault::cli::Rewritten;

/// 持资料库进程锁改写一篇碎片或笔记的正文，语义与 App 编辑保存一致：正文里的 `#标签`
/// 重新收进 frontmatter，type 标签原样保留，`updated_at` 刷新，frontmatter 其余内容逐字节不动。
/// 规则在 `shard_vault::cli::rewrite_document`，服务端的 `append_document` 用同一份。
///
/// `expected_sha` 是调用方读到的整文件哈希；给了就在锁内核对，不一致返回 `Stale` 且不写。
/// `next` 拿到当前正文、返回新正文，追加之类的读改写因此也在同一把锁里完成。
pub fn rewrite_body(
    vault: &Path,
    path: &Path,
    expected_sha: Option<&str>,
    next: impl FnOnce(&str) -> String,
    lock_dir: &Path,
    timeout: Duration,
) -> Result<Rewritten, RewriteError> {
    let _lock = VaultProcessLock::acquire(lock_dir, vault, Some(timeout)).map_err(|error| {
        if error == "Shard 正在写入资料库，请稍后重试" {
            RewriteError::Locked
        } else {
            RewriteError::Invalid(error)
        }
    })?;
    rewrite_document(&FsVfs::new(vault), path, expected_sha, next, now_rfc3339()).map_err(|error| match error {
        shard_vault::cli::RewriteError::Stale => RewriteError::Stale,
        shard_vault::cli::RewriteError::Invalid(message) => RewriteError::Invalid(message),
    })
}

/// 用外部编辑器编辑一条碎片：经 [`Store`] 读与写，本地模式持锁核对哈希写回，远程模式带 sha 写回服务器。
pub fn edit_fragment(store: &mut dyn Store, entry: &FragmentEntry) -> Result<EditOutcome, EditFailure> {
    let original_body = store.open(entry).map_err(EditFailure::from)?;

    let draft = draft_path(&entry.id);
    fs::write(&draft, format!("{original_body}\n"))
        .map_err(|error| format!("创建临时文件失败：{error}"))?;

    if let Err(message) = open_in_editor(&draft) {
        let _ = fs::remove_file(&draft);
        return Err(message.into());
    }
    let edited = fs::read_to_string(&draft)
        .map_err(|error| format!("读取编辑结果失败：{error}（临时文件：{}）", draft.display()))?;
    let next_body = normalize_body(&edited);

    if next_body == original_body {
        let _ = fs::remove_file(&draft);
        return Ok(EditOutcome::Unchanged);
    }
    match store.save(&entry.id, next_body) {
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

    fn session_fixture() -> (TempDir, FragmentEntry, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vault/fragments/2026/09/one.md");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "---\nid: one\ncreated_at: 2026-09-29T00:00:00Z\nupdated_at: 2026-09-29T00:00:00Z\ntags: [inbox]\ncategory: null\nai_status: none\nsource: test\n---\n\n原文\n").unwrap();
        let entry = FragmentEntry {
            id: "one".into(),
            path: "fragments/2026/09/one.md".into(),
            title: "原文".into(),
            created_at: "2026-09-29T00:00:00Z".into(),
            updated_at: "2026-09-29T00:00:00Z".into(),
            kind: None,
            tags: vec!["inbox".into()],
            modified_at: 0,
            body: "原文".into(),
        };
        (directory, entry, path)
    }

    #[test]
    fn session_saves_twice_with_updated_baseline() {
        let (directory, entry, file) = session_fixture();
        let mut session = open_session(&directory.path().join("vault"), &entry).unwrap();
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
        let parsed = parse_fragment(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(parsed.body.trim(), "第二次 #标签");
        assert_eq!(parsed.frontmatter.tags, vec!["inbox", "标签"]);
    }

    #[test]
    fn session_conflict_writes_draft_without_overwrite() {
        let (directory, entry, file) = session_fixture();
        let mut session = open_session(&directory.path().join("vault"), &entry).unwrap();
        fs::write(&file, "其他进程修改").unwrap();
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
        assert_eq!(fs::read_to_string(&file).unwrap(), "其他进程修改");
        fs::remove_file(draft_path).unwrap();
    }

    #[test]
    fn session_lock_timeout_keeps_original() {
        let (directory, entry, file) = session_fixture();
        let mut session = open_session(&directory.path().join("vault"), &entry).unwrap();
        let before = fs::read(&file).unwrap();
        let locks = directory.path().join("locks");
        let held = VaultProcessLock::acquire(&locks, &session.vault, None).unwrap();
        assert_eq!(
            save_session(&mut session, "我的修改", &locks, Duration::from_millis(10)),
            Err(SaveError::Locked)
        );
        assert_eq!(fs::read(&file).unwrap(), before);
        drop(held);
    }
}
