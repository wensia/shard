//! 旧 vault 目录 ⇄ 内容库。
//!
//! - 导入：只读地走一遍 vault，每个文件按**原始字节**入库，保留创建与修改时间；密匣信封原样进
//!   `lockbox_items`、`.shard/lockbox.json` 原样进 `lockbox_manifest`，服务器不解密任何东西。
//!   整个导入是一个事务：要么全部进库，要么什么都不留。
//! - 导出：把库里的每一行原样写回目录，恢复修改时间。导出结果与原 vault 逐字节一致（只差排除清单），
//!   旧版 App 能直接打开——这既是回滚通道，也是逃生通道。
//!
//! 排除清单只有真正的垃圾：`.git/`、`.DS_Store`、上一轮方案残留的 `.shard/notes.sqlite3*`、原子写的临时文件。
//! 不认识的东西（符号链接、`lockbox/` 下不是 `.shard` 的文件）一律报错，不静默丢弃。

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

use serde_json::Value;
use shard_core::{derive_type, frontmatter::parse_fragment, Vfs};

use crate::{LockboxItemRaw, Store, StoreError, WriteCtx};

#[derive(Clone, Debug, Default)]
pub struct ImportReport {
    pub files: usize,
    pub dirs: usize,
    pub bytes: u64,
    pub lockbox_items: usize,
    pub lockbox_manifest: bool,
    /// (相对路径, 原因)
    pub skipped: Vec<(String, String)>,
}

#[derive(Clone, Debug, Default)]
pub struct ExportReport {
    pub files: usize,
    pub dirs: usize,
    pub lockbox_items: usize,
}

/// 导入前置检查：一次性迁移必须先在旧版 App 里跑完（迁移逻辑在前端，服务器执行不了）。
/// 返回问题清单，空表示可以导入。
pub fn precheck(source: &Path) -> Result<Vec<String>, String> {
    let mut problems = Vec::new();
    match fs::read_to_string(source.join(".shard/format.json")) {
        Ok(text) => {
            let dialect = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|value| value.get("markdownDialect").and_then(Value::as_u64));
            if dialect != Some(2) {
                problems.push(format!(
                    "Markdown 方言不是 v2（format.json 里是 {dialect:?}）：先用旧版 App 打开一次这个资料库完成迁移。"
                ));
            }
        }
        Err(_) => problems.push("缺少 .shard/format.json：先用旧版 App 打开一次这个资料库。".to_string()),
    }
    if source.join("archive").is_dir() {
        problems.push("还有旧的 archive/ 目录：先用旧版 App 打开一次，把它迁进回收站。".to_string());
    }
    let mut stack = vec![source.join("fragments")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
                let Ok(text) = fs::read_to_string(&path) else { continue };
                if let Ok(parsed) = parse_fragment(&text) {
                    if derive_type(&parsed.frontmatter.tags) == Some("note") {
                        problems.push(format!(
                            "fragments/ 里有笔记 {}：先用旧版 App 打开一次，把旧笔记迁进资料库。",
                            relative(source, &path)
                        ));
                    }
                }
            }
        }
    }
    Ok(problems)
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

/// 排除的原因；`None` 表示要导入。
fn exclusion(rel: &str, name: &str) -> Option<&'static str> {
    let key = rel.to_lowercase();
    if key == ".git" || key.starts_with(".git/") {
        return Some("Git 仓库数据");
    }
    if name == ".DS_Store" {
        return Some("访达元数据");
    }
    if key.starts_with(".shard/notes.sqlite3") {
        return Some("上一轮 SQLite 方案的残留");
    }
    if name.contains(".tmp-") || name.contains(".canvas-tmp-") {
        return Some("原子写的临时文件");
    }
    None
}

fn system_time(metadata: &fs::Metadata) -> (SystemTime, SystemTime) {
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    (metadata.created().unwrap_or(modified), modified)
}

fn to_rfc3339(time: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
}

fn io(error: std::io::Error) -> StoreError {
    StoreError::Io(error)
}

enum Planned {
    Dir { rel: String, times: (SystemTime, SystemTime) },
    File { rel: String, bytes: Vec<u8>, times: (SystemTime, SystemTime) },
    Lockbox(LockboxItemRaw),
    Manifest { body: String, modified: SystemTime },
}

fn plan(source: &Path, report: &mut ImportReport) -> Result<Vec<Planned>, StoreError> {
    let mut planned = Vec::new();
    let mut stack = vec![source.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut entries: Vec<_> = fs::read_dir(&dir).map_err(io)?.collect::<Result<_, _>>().map_err(io)?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = relative(source, &path);
            if let Some(reason) = exclusion(&rel, &name) {
                report.skipped.push((rel, reason.to_string()));
                continue;
            }
            let metadata = fs::symlink_metadata(&path).map_err(io)?;
            if metadata.file_type().is_symlink() {
                return Err(StoreError::Invalid(format!("不支持符号链接：{rel}（请先换成真实文件）。")));
            }
            let key = rel.to_lowercase();
            let in_lockbox = key == "lockbox" || key.starts_with("lockbox/");
            if metadata.is_dir() {
                if !in_lockbox {
                    planned.push(Planned::Dir { rel, times: system_time(&metadata) });
                } else if fs::read_dir(&path).map_err(io)?.next().is_none() {
                    // 密匣只以信封存在 lockbox_items 里，没有目录的概念；空目录 App 用到时会自己重建。
                    report.skipped.push((rel, "空的密匣目录".to_string()));
                }
                stack.push(path);
                continue;
            }
            let bytes = fs::read(&path).map_err(io)?;
            if in_lockbox {
                if !name.ends_with(".shard") {
                    return Err(StoreError::Invalid(format!("密匣目录里有不认识的文件：{rel}")));
                }
                let text = String::from_utf8(bytes)
                    .map_err(|_| StoreError::Invalid(format!("密匣信封不是 UTF-8：{rel}")))?;
                let id = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|value| value.get("id").and_then(Value::as_str).map(str::to_string))
                    .ok_or_else(|| StoreError::Invalid(format!("密匣信封缺少 id：{rel}")))?;
                let (created, modified) = system_time(&metadata);
                planned.push(Planned::Lockbox(LockboxItemRaw {
                    item_id: id,
                    envelope: text,
                    legacy_path: Some(rel),
                    created_at: to_rfc3339(created),
                    updated_at: to_rfc3339(modified),
                }));
                continue;
            }
            if key == ".shard/lockbox.json" {
                let text = String::from_utf8(bytes)
                    .map_err(|_| StoreError::Invalid("密匣 manifest 不是 UTF-8。".to_string()))?;
                planned.push(Planned::Manifest { body: text, modified: system_time(&metadata).1 });
                continue;
            }
            planned.push(Planned::File { rel, bytes, times: system_time(&metadata) });
        }
    }
    Ok(planned)
}

/// 把旧 vault 整个导入内容库（一个事务）。重复导入幂等：内容相同的文件不产生变化。
pub fn import_vault(store: &Store, source: &Path) -> Result<ImportReport, StoreError> {
    let problems = precheck(source).map_err(StoreError::Invalid)?;
    if !problems.is_empty() {
        return Err(StoreError::Invalid(format!("导入前置检查没有通过：\n- {}", problems.join("\n- "))));
    }
    let mut report = ImportReport::default();
    let planned = plan(source, &mut report)?;
    let mut ctx = WriteCtx::new("import_vault", "import");
    ctx.revision_reason = Some("import");
    let mut ids = BTreeMap::new();
    store.write(&ctx, |vfs| {
        let root = vfs.root().to_path_buf();
        for item in &planned {
            match item {
                Planned::Dir { rel, times } => {
                    let path = root.join(rel);
                    let fresh = !vfs.exists(&path);
                    vfs.create_dir_all(&path).map_err(io)?;
                    if fresh {
                        vfs.set_times(&path, times.0, times.1).map_err(io)?;
                    }
                    report.dirs += 1;
                }
                Planned::File { rel, bytes, times } => {
                    let path = root.join(rel);
                    let fresh = !vfs.exists(&path);
                    vfs.write_atomic(&path, bytes).map_err(io)?;
                    if fresh {
                        vfs.set_times(&path, times.0, times.1).map_err(io)?;
                    }
                    report.files += 1;
                    report.bytes += bytes.len() as u64;
                }
                Planned::Lockbox(item) => {
                    if let Some(previous) = ids.insert(item.item_id.clone(), item.legacy_path.clone()) {
                        return Err(StoreError::Invalid(format!(
                            "两个密匣信封用了同一个 id {}：{:?} 与 {:?}",
                            item.item_id, previous, item.legacy_path
                        )));
                    }
                    vfs.put_lockbox_item_raw(item).map_err(io)?;
                    report.lockbox_items += 1;
                }
                Planned::Manifest { body, modified } => {
                    vfs.put_lockbox_manifest_raw(body, Some(&to_rfc3339(*modified))).map_err(io)?;
                    report.lockbox_manifest = true;
                }
            }
        }
        Ok::<_, StoreError>(())
    })?;
    Ok(report)
}

fn set_file_times(path: &Path, created: SystemTime, modified: SystemTime) -> std::io::Result<()> {
    let times = fs::FileTimes::new().set_modified(modified).set_accessed(modified);
    #[cfg(target_os = "macos")]
    let times = {
        use std::os::macos::fs::FileTimesExt;
        times.set_created(created)
    };
    #[cfg(not(target_os = "macos"))]
    let _ = created;
    fs::File::open(path)?.set_times(times)
}

/// 把内容库导出成 vault 目录。`target` 必须不存在或为空。
pub fn export_vault(store: &Store, target: &Path) -> Result<ExportReport, StoreError> {
    if target.exists() && fs::read_dir(target).map_err(io)?.next().is_some() {
        return Err(StoreError::Invalid(format!("导出目录不是空的：{}", target.display())));
    }
    fs::create_dir_all(target).map_err(io)?;
    let mut report = ExportReport::default();
    // 目录时间最后设：往目录里写文件会改它的修改时间。
    let mut dir_times: Vec<(PathBuf, SystemTime, SystemTime)> = Vec::new();
    store.read(|vfs| -> Result<(), StoreError> {
        let root = vfs.root().to_path_buf();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in vfs.read_dir(&dir).map_err(io)? {
                let path = entry.path();
                let rel = relative(&root, &path);
                let out = target.join(&rel);
                let metadata = entry.metadata().map_err(io)?;
                let created = metadata.created().unwrap_or(SystemTime::UNIX_EPOCH);
                let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                if metadata.is_dir() {
                    fs::create_dir_all(&out).map_err(io)?;
                    dir_times.push((out, created, modified));
                    stack.push(path);
                    report.dirs += 1;
                } else {
                    if let Some(parent) = out.parent() {
                        fs::create_dir_all(parent).map_err(io)?;
                    }
                    fs::write(&out, vfs.read(&path).map_err(io)?).map_err(io)?;
                    set_file_times(&out, created, modified).map_err(io)?;
                    report.files += 1;
                }
            }
        }
        for item in vfs.lockbox_items_raw().map_err(io)? {
            let rel = item
                .legacy_path
                .clone()
                .unwrap_or_else(|| format!("lockbox/exported/{}.shard", item.item_id));
            let out = target.join(&rel);
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(io)?;
            }
            fs::write(&out, item.envelope.as_bytes()).map_err(io)?;
            let parse = |text: &str| {
                chrono::DateTime::parse_from_rfc3339(text).map(SystemTime::from).unwrap_or(SystemTime::UNIX_EPOCH)
            };
            set_file_times(&out, parse(&item.created_at), parse(&item.updated_at)).map_err(io)?;
            report.lockbox_items += 1;
        }
        if let Some((body, updated_at)) = vfs.lockbox_manifest_raw().map_err(io)? {
            let out = target.join(".shard/lockbox.json");
            fs::create_dir_all(out.parent().expect("有父目录")).map_err(io)?;
            fs::write(&out, body.as_bytes()).map_err(io)?;
            let modified = chrono::DateTime::parse_from_rfc3339(&updated_at)
                .map(SystemTime::from)
                .unwrap_or(SystemTime::UNIX_EPOCH);
            set_file_times(&out, modified, modified).map_err(io)?;
            report.files += 1;
        }
        Ok(())
    })??;
    dir_times.sort_by(|a, b| b.0.components().count().cmp(&a.0.components().count()));
    for (dir, created, modified) in dir_times {
        set_file_times(&dir, created, modified).map_err(io)?;
    }
    Ok(report)
}
