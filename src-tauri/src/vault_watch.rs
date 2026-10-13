//! vault 文件监听：终端 `shard`、AI 助手、其他编辑器或同步工具在 App 之外改了文件，
//! 去抖后发 `vault-changed` 事件给前端，正在运行的 App 不用等切回窗口就能看到。
//!
//! 只看公开内容根（`fragments/`、`notes/`、`datasets/`），忽略 `.git`、`.shard`、密匣与
//! 一切以 `.` 开头的文件和目录（原子写的临时文件、冲突副本、last-good 备份）。每条变化带上
//! 文件当前的整文件 sha256：前端拿它和内存里的 `fileSha` 比对，App 自己刚保存的文件 sha
//! 已经一致，不会因此重载。

use crate::search_runtime;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        mpsc::{self, RecvTimeoutError},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

pub(crate) const VAULT_CHANGED_EVENT: &str = "vault-changed";
/// 最后一个事件之后再等这么久才发出，合并同一次写入的多条事件。
const DEBOUNCE: Duration = Duration::from_millis(250);
/// 持续有写入时最多攒这么久就发一次，批量导入也能逐步显示。
const MAX_WAIT: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VaultFileChange {
    /// vault 相对路径，`/` 分隔；`*.csv.schema.json` 归到对应的 `*.csv`。
    pub path: String,
    /// 路径现在是否存在（文件或目录）；与前端已知列表对比即可判断新增或删除。
    pub exists: bool,
    /// 文件当前的整文件 sha256（与 `Fragment.fileSha` 同算法）；目录或已删除时为空。
    pub sha: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultChangedPayload {
    vault: String,
    changes: Vec<VaultFileChange>,
}

struct ActiveWatch {
    vault: PathBuf,
    // 只为持有：drop 时停止监听，事件通道随之断开，去抖线程自行退出。
    _watcher: RecommendedWatcher,
}

static ACTIVE: Mutex<Option<ActiveWatch>> = Mutex::new(None);

/// 开始监听 `vault`；已在监听同一个 vault 时什么都不做，换 vault 时先停掉旧的。
pub(crate) fn watch(app: AppHandle, vault: PathBuf) -> Result<(), String> {
    let mut active = ACTIVE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if active.as_ref().is_some_and(|watch| watch.vault == vault) {
        return Ok(());
    }
    *active = None;

    let event_vault = vault.clone();
    let watcher = spawn_watcher(&vault, move |changes| {
        // 外部写入不经过 App 的写门：补走一次门，让搜索快照失效并在后台对账。
        if let Ok(guard) = search_runtime::acquire_write_guard(&event_vault) {
            drop(guard);
        }
        let _ = app.emit(
            VAULT_CHANGED_EVENT,
            VaultChangedPayload {
                vault: event_vault.display().to_string(),
                changes,
            },
        );
    })?;

    *active = Some(ActiveWatch {
        vault,
        _watcher: watcher,
    });
    Ok(())
}

/// 监听 `vault` 并在去抖线程里把每批变化交给 `on_batch`；返回的 watcher 被 drop 即停止。
fn spawn_watcher(
    vault: &Path,
    mut on_batch: impl FnMut(Vec<VaultFileChange>) + Send + 'static,
) -> Result<RecommendedWatcher, String> {
    let (sender, receiver) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher =
        notify::recommended_watcher(sender).map_err(|error| format!("无法监听资料库：{error}"))?;
    watcher
        .watch(vault, RecursiveMode::Recursive)
        .map_err(|error| format!("无法监听资料库：{error}"))?;
    let roots = vault_roots(vault);
    let vault = vault.to_path_buf();
    thread::Builder::new()
        .name("vault-watch".to_string())
        .spawn(move || {
            debounce_loop(receiver, &roots, |paths| {
                on_batch(describe_changes(&vault, paths))
            })
        })
        .map_err(|error| format!("无法启动资料库监听线程：{error}"))?;
    Ok(watcher)
}

/// FSEvents 报的是规范化路径（如 `/private/var/...`），配置里的 vault 可能经过符号链接；
/// 两种前缀都认。
fn vault_roots(vault: &Path) -> Vec<PathBuf> {
    let mut roots = vec![vault.to_path_buf()];
    if let Ok(canonical) = vault.canonicalize() {
        if canonical != vault {
            roots.push(canonical);
        }
    }
    roots
}

fn debounce_loop(
    receiver: mpsc::Receiver<notify::Result<Event>>,
    roots: &[PathBuf],
    mut flush: impl FnMut(&BTreeSet<String>),
) {
    let mut pending = BTreeSet::new();
    let mut first_at: Option<Instant> = None;
    loop {
        let received = match first_at {
            None => receiver.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(_) => receiver.recv_timeout(DEBOUNCE),
        };
        match received {
            Ok(Ok(event)) => {
                for path in &event.paths {
                    if let Some(relative) = classify(roots, path) {
                        pending.insert(relative);
                        first_at.get_or_insert_with(Instant::now);
                    }
                }
                if first_at.is_none_or(|first| first.elapsed() < MAX_WAIT) {
                    continue;
                }
            }
            // 单个事件出错（如监听队列溢出）不影响后续事件。
            Ok(Err(_)) => continue,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if !pending.is_empty() {
            flush(&pending);
            pending.clear();
        }
        first_at = None;
    }
}

/// 把事件路径换成值得通知的 vault 相对路径；不相关的返回 None。
fn classify(roots: &[PathBuf], path: &Path) -> Option<String> {
    let relative = roots.iter().find_map(|root| path.strip_prefix(root).ok())?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return None;
        };
        let part = part.to_str()?;
        if part.starts_with('.') {
            return None;
        }
        parts.push(part);
    }
    let name = *parts.last()?;
    match parts.first().copied()? {
        "fragments" => name.ends_with(".md").then(|| parts.join("/")),
        "notes" => Some(parts.join("/")),
        "datasets" => {
            if let Some(csv) = name.strip_suffix(".schema.json").filter(|csv| csv.ends_with(".csv")) {
                let mut parts = parts.clone();
                *parts.last_mut()? = csv;
                Some(parts.join("/"))
            } else {
                name.ends_with(".csv").then(|| parts.join("/"))
            }
        }
        _ => None,
    }
}

fn describe_changes(vault: &Path, paths: &BTreeSet<String>) -> Vec<VaultFileChange> {
    paths
        .iter()
        .map(|path| {
            let full = vault.join(path);
            VaultFileChange {
                path: path.clone(),
                exists: fs::symlink_metadata(&full).is_ok(),
                sha: file_sha(&full),
            }
        })
        .collect()
}

fn file_sha(path: &Path) -> Option<String> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let digest = Sha256::digest(&bytes);
    Some(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classify_in(path: &str) -> Option<String> {
        classify(&[PathBuf::from("/vault")], Path::new(path))
    }

    #[test]
    fn only_public_content_is_reported() {
        assert_eq!(
            classify_in("/vault/fragments/2026/10/a.md").as_deref(),
            Some("fragments/2026/10/a.md")
        );
        assert_eq!(classify_in("/vault/fragments/2026/10"), None);
        assert_eq!(classify_in("/vault/fragments/2026/10/.a.md.tmp-1234"), None);
        assert_eq!(
            classify_in("/vault/notes/项目/周报.md").as_deref(),
            Some("notes/项目/周报.md")
        );
        assert_eq!(classify_in("/vault/notes/项目").as_deref(), Some("notes/项目"));
        assert_eq!(
            classify_in("/vault/notes/图.shardmap.json").as_deref(),
            Some("notes/图.shardmap.json")
        );
        assert_eq!(
            classify_in("/vault/datasets/阅读.csv").as_deref(),
            Some("datasets/阅读.csv")
        );
        assert_eq!(
            classify_in("/vault/datasets/阅读.csv.schema.json").as_deref(),
            Some("datasets/阅读.csv")
        );
        assert_eq!(classify_in("/vault/datasets/.gitattributes"), None);
        for ignored in [
            "/vault/.git/index",
            "/vault/.shard/state.json",
            "/vault/lockbox/x.md",
            "/vault/maps/.conflicts/a.json",
            "/vault/assets/a.png",
            "/vault",
            "/elsewhere/fragments/a.md",
        ] {
            assert_eq!(classify_in(ignored), None, "{ignored}");
        }
    }

    #[test]
    fn sha_matches_fragment_file_sha() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("a.md");
        fs::write(&path, "---\nid: a\n---\n\n正文\n").unwrap();
        assert_eq!(
            file_sha(&path),
            Some(shard_core::graph_model::content_sha256_hex(
                "---\nid: a\n---\n\n正文\n"
            ))
        );
        assert_eq!(file_sha(directory.path()), None);
        assert_eq!(file_sha(&directory.path().join("missing.md")), None);
    }

    #[test]
    fn real_watcher_reports_external_writes_with_sha() {
        // tempdir 在 /var 下，FSEvents 报 /private/var：顺带验证规范化前缀。
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path().to_path_buf();
        fs::create_dir_all(vault.join("fragments/2026/10")).unwrap();
        fs::create_dir_all(vault.join(".git")).unwrap();
        let (sender, receiver) = mpsc::channel();
        let watcher = spawn_watcher(&vault, move |changes| {
            let _ = sender.send(changes);
        })
        .unwrap();
        thread::sleep(Duration::from_millis(200));
        fs::write(vault.join(".git/index"), "x").unwrap();
        fs::write(vault.join("fragments/2026/10/a.md"), "正文").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = Vec::new();
        while Instant::now() < deadline && seen.is_empty() {
            if let Ok(batch) = receiver.recv_timeout(Duration::from_millis(200)) {
                seen.extend(batch);
            }
        }
        drop(watcher);
        assert_eq!(
            seen,
            vec![VaultFileChange {
                path: "fragments/2026/10/a.md".to_string(),
                exists: true,
                sha: Some(shard_core::graph_model::content_sha256_hex("正文")),
            }]
        );
    }

    #[test]
    fn debounce_merges_bursts_and_stops_when_disconnected() {
        let (sender, receiver) = mpsc::channel::<notify::Result<Event>>();
        let roots = vec![PathBuf::from("/vault")];
        let event = |path: &str| Ok(Event::default().add_path(PathBuf::from(path)));
        sender.send(event("/vault/fragments/a.md")).unwrap();
        sender.send(event("/vault/.git/index")).unwrap();
        sender.send(event("/vault/fragments/a.md")).unwrap();
        sender.send(event("/vault/notes/b.md")).unwrap();
        let handle = thread::spawn(move || {
            let mut batches = Vec::new();
            debounce_loop(receiver, &roots, |paths| {
                batches.push(paths.iter().cloned().collect::<Vec<_>>())
            });
            batches
        });
        thread::sleep(DEBOUNCE * 3);
        sender.send(event("/vault/datasets/c.csv")).unwrap();
        thread::sleep(DEBOUNCE * 3);
        drop(sender);
        assert_eq!(
            handle.join().unwrap(),
            vec![
                vec!["fragments/a.md".to_string(), "notes/b.md".to_string()],
                vec!["datasets/c.csv".to_string()],
            ]
        );
    }
}
