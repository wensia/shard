//! 纯内存实现：整个资料库是一棵内存里的目录树，不碰磁盘、不读系统时钟。
//!
//! 用途：浏览器（wasm）里把服务器下发的内容（例如密匣信封）按原路径放进来，跑同一套领域函数，
//! 再用 [`MemVfs::files`] 比较操作前后的文件，把增删改换成对服务器的写入；测试里也可以当一个
//! 不落盘的资料库用。
//!
//! 语义对齐 FsVfs（`std::fs` / POSIX），`tests/vfs_conformance.rs` 用随机操作序列逐项比对。
//! 与 FsVfs 的已知差异：
//! - 路径比较不区分大小写与 Unicode 规范化方式（NFC + 小写），保留首次写入时的写法——与 APFS
//!   （macOS 桌面）和服务端 SqliteVfs 一致；Linux 本地目录区分大小写。
//! - 只接受根目录之下的路径；根外路径一律 `PermissionDenied`，`..` 一律 `InvalidInput`（不解析）。
//!   根目录本身不能删除、不能改名。
//! - 没有符号链接；`canonicalize` 只做词法规整，返回存储时的写法。
//! - `read_dir` 按存储的名字排序（本地目录是文件系统给的顺序）。
//! - 错误的 `ErrorKind` 只保证「成功 / 失败」与 NotFound、AlreadyExists 一致。
//! - 时间来自构造时给的时钟（默认固定在 UNIX 纪元，可用 [`MemVfs::set_time`] 调整），从不调用
//!   `SystemTime::now()`。规则照本地文件系统：新建条目的创建与修改时间都是当前时钟；`write` 覆盖已有
//!   文件只更新修改时间；`write_atomic` / `publish` 是「临时文件 + rename」，结果是一个新文件，两个时间都重置；
//!   `copy` 到已有文件只更新修改时间，到新路径两个时间都是当前时钟（macOS 的 clonefile 会保留源文件的
//!   修改时间，这里按 Linux 的行为）；`rename` 不改被移动条目的时间；目录里增删改名条目时更新目录的修改时间。
//! - `copy(a, a)`：本地 macOS 会把文件截断清空，这里内容不变。

use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, io,
    path::{Component, Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::SystemTime,
};

use unicode_normalization::UnicodeNormalization;

use crate::vfs::{EntryKind, Vfs, VfsDirEntry, VfsMetadata};

type Clock = Box<dyn Fn() -> SystemTime + Send + Sync>;

/// 内存资料库。内部用互斥锁保护，`&self` 上的写操作彼此串行。
pub struct MemVfs {
    root: PathBuf,
    inner: Mutex<Inner>,
}

struct Inner {
    tree: Node,
    clock: Clock,
}

struct Node {
    /// 存储时的写法（首次创建时给的名字）；根目录为空串。
    name: String,
    created: SystemTime,
    modified: SystemTime,
    body: Body,
}

enum Body {
    File(Vec<u8>),
    /// 子项按比较键（NFC + 小写）索引。
    Dir(BTreeMap<String, Node>),
}

/// 目录节点的可变视图：修改时间与子项分开借用。
struct DirMut<'a> {
    modified: &'a mut SystemTime,
    children: &'a mut BTreeMap<String, Node>,
}

/// 名字的比较键：NFC 规整后转小写（与 APFS、服务端 `path_key` 相同）。
fn fold(name: &str) -> String {
    name.nfc().collect::<String>().to_lowercase()
}

fn joined(parts: &[String]) -> String {
    parts.join("/")
}

fn not_found(parts: &[String]) -> io::Error {
    io::Error::new(io::ErrorKind::NotFound, format!("不存在：{}", joined(parts)))
}

fn not_a_directory(parts: &[String]) -> io::Error {
    io::Error::new(io::ErrorKind::NotADirectory, format!("不是目录：{}", joined(parts)))
}

fn is_a_directory(parts: &[String]) -> io::Error {
    io::Error::new(io::ErrorKind::IsADirectory, format!("是目录：{}", joined(parts)))
}

fn already_exists(parts: &[String]) -> io::Error {
    io::Error::new(io::ErrorKind::AlreadyExists, format!("已存在：{}", joined(parts)))
}

fn root_untouchable() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "不能删除或改名资料库根目录。")
}

impl Node {
    fn file(name: &str, bytes: Vec<u8>, now: SystemTime) -> Self {
        Self { name: name.to_string(), created: now, modified: now, body: Body::File(bytes) }
    }

    fn dir(name: &str, now: SystemTime) -> Self {
        Self { name: name.to_string(), created: now, modified: now, body: Body::Dir(BTreeMap::new()) }
    }

    fn is_dir(&self) -> bool {
        matches!(self.body, Body::Dir(_))
    }

    fn kind(&self) -> EntryKind {
        if self.is_dir() {
            EntryKind::Dir
        } else {
            EntryKind::File
        }
    }

    fn metadata(&self) -> VfsMetadata {
        let len = match &self.body {
            Body::File(bytes) => bytes.len() as u64,
            Body::Dir(_) => 0,
        };
        VfsMetadata::new(self.kind(), len, self.modified, self.created)
    }

    fn as_dir_mut(&mut self) -> Option<DirMut<'_>> {
        match &mut self.body {
            Body::Dir(children) => Some(DirMut { modified: &mut self.modified, children }),
            Body::File(_) => None,
        }
    }
}

/// 按路径找条目，同时给出存储时的写法（相对根）。中间某一级是文件时报 NotADirectory。
fn find<'a>(root: &'a Node, parts: &[String]) -> io::Result<(&'a Node, Vec<&'a str>)> {
    let mut node = root;
    let mut stored = Vec::with_capacity(parts.len());
    for (index, part) in parts.iter().enumerate() {
        let Body::Dir(children) = &node.body else {
            return Err(not_a_directory(&parts[..index]));
        };
        node = children.get(&fold(part)).ok_or_else(|| not_found(&parts[..=index]))?;
        stored.push(node.name.as_str());
    }
    Ok((node, stored))
}

/// 父目录必须存在且是目录（`std::fs` 的写入、建目录、rename 目标都要求这一点）。
fn dir_mut<'a>(root: &'a mut Node, parts: &[String]) -> io::Result<DirMut<'a>> {
    let mut node = root;
    for (index, part) in parts.iter().enumerate() {
        let Body::Dir(children) = &mut node.body else {
            return Err(not_a_directory(&parts[..index]));
        };
        node = children.get_mut(&fold(part)).ok_or_else(|| not_found(&parts[..=index]))?;
    }
    node.as_dir_mut().ok_or_else(|| not_a_directory(parts))
}

/// `std::fs::create_dir_all`：已是目录就跳过，缺的逐级建；路上有同名文件则失败（已建的上级目录保留）。
fn create_dir_all_in(root: &mut Node, parts: &[String], now: SystemTime) -> io::Result<()> {
    let mut node = root;
    for (index, part) in parts.iter().enumerate() {
        let key = fold(part);
        let Some(dir) = node.as_dir_mut() else {
            return Err(already_exists(&parts[..index]));
        };
        if !dir.children.contains_key(&key) {
            dir.children.insert(key.clone(), Node::dir(part, now));
            *dir.modified = now;
        }
        let child = dir.children.get_mut(&key).ok_or_else(|| not_found(&parts[..=index]))?;
        if !child.is_dir() {
            return Err(already_exists(&parts[..=index]));
        }
        node = child;
    }
    Ok(())
}

fn collect(node: &Node, prefix: &str, files: &mut BTreeMap<String, Vec<u8>>, dirs: &mut BTreeSet<String>) {
    let Body::Dir(children) = &node.body else {
        return;
    };
    for child in children.values() {
        let path = if prefix.is_empty() { child.name.clone() } else { format!("{prefix}/{}", child.name) };
        match &child.body {
            Body::File(bytes) => {
                files.insert(path, bytes.clone());
            }
            Body::Dir(_) => {
                collect(child, &path, files, dirs);
                dirs.insert(path);
            }
        }
    }
}

impl MemVfs {
    /// 空资料库（只有根目录），时钟固定在 UNIX 纪元；需要真实时间时用 [`MemVfs::with_clock`] 或 [`MemVfs::set_time`]。
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self::with_clock(root, || SystemTime::UNIX_EPOCH)
    }

    /// 空资料库，创建 / 修改时间一律取 `clock()`（例如 wasm 里包一层 `Date.now()`）。
    pub fn with_clock(root: impl Into<PathBuf>, clock: impl Fn() -> SystemTime + Send + Sync + 'static) -> Self {
        let now = clock();
        Self {
            root: root.into(),
            inner: Mutex::new(Inner { tree: Node::dir("", now), clock: Box::new(clock) }),
        }
    }

    /// 换成固定时钟：之后的写入都记为 `time`。
    pub fn set_time(&self, time: SystemTime) {
        self.lock().clock = Box::new(move || time);
    }

    /// 直接设定某个条目的创建与修改时间（例如按服务器记录的时间还原）。
    pub fn set_times(&self, path: &Path, created: SystemTime, modified: SystemTime) -> io::Result<()> {
        let parts = self.parts(path)?;
        let mut inner = self.lock();
        let node = if let Some((name, parent)) = parts.split_last() {
            let DirMut { children, .. } = dir_mut(&mut inner.tree, parent)?;
            children.get_mut(&fold(name)).ok_or_else(|| not_found(&parts))?
        } else {
            &mut inner.tree
        };
        node.created = created;
        node.modified = modified;
        Ok(())
    }

    /// 全部文件：相对根的路径（`/` 分隔、存储时的写法）→ 字节，按路径排序。
    /// 操作前后各取一次即可算出增删改。
    pub fn files(&self) -> BTreeMap<String, Vec<u8>> {
        let mut files = BTreeMap::new();
        collect(&self.lock().tree, "", &mut files, &mut BTreeSet::new());
        files
    }

    /// 全部目录（不含根）：相对根的路径，按路径排序。
    pub fn dirs(&self) -> BTreeSet<String> {
        let mut dirs = BTreeSet::new();
        collect(&self.lock().tree, "", &mut BTreeMap::new(), &mut dirs);
        dirs
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 绝对路径 → 相对根的各级名字。根外路径、`..`、非 UTF-8 名字一律拒绝。
    fn parts(&self, path: &Path) -> io::Result<Vec<String>> {
        let rest = path.strip_prefix(&self.root).map_err(|_| {
            io::Error::new(io::ErrorKind::PermissionDenied, format!("路径不在资料库内：{}", path.display()))
        })?;
        let mut parts = Vec::new();
        for component in rest.components() {
            match component {
                Component::Normal(part) => {
                    let part = part
                        .to_str()
                        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "路径不是有效的 UTF-8。"))?;
                    parts.push(part.to_string());
                }
                Component::CurDir => {}
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("路径不能含 `..`：{}", path.display()),
                    ))
                }
            }
        }
        Ok(parts)
    }

    fn abs(&self, stored: &[&str]) -> PathBuf {
        let mut path = self.root.clone();
        for name in stored {
            path.push(name);
        }
        path
    }
}

impl Inner {
    fn now(&self) -> SystemTime {
        (self.clock)()
    }
}

impl fmt::Debug for MemVfs {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("MemVfs").field("root", &self.root).finish_non_exhaustive()
    }
}

impl Vfs for MemVfs {
    fn root(&self) -> &Path {
        &self.root
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        let parts = self.parts(path)?;
        let inner = self.lock();
        match &find(&inner.tree, &parts)?.0.body {
            Body::File(bytes) => Ok(bytes.clone()),
            Body::Dir(_) => Err(is_a_directory(&parts)),
        }
    }

    fn read_head(&self, path: &Path, limit: u64) -> io::Result<Vec<u8>> {
        let parts = self.parts(path)?;
        let inner = self.lock();
        match &find(&inner.tree, &parts)?.0.body {
            Body::File(bytes) => {
                let end = usize::try_from(limit).unwrap_or(usize::MAX).min(bytes.len());
                Ok(bytes[..end].to_vec())
            }
            Body::Dir(_) => Err(is_a_directory(&parts)),
        }
    }

    fn metadata(&self, path: &Path) -> io::Result<VfsMetadata> {
        let parts = self.parts(path)?;
        let inner = self.lock();
        Ok(find(&inner.tree, &parts)?.0.metadata())
    }

    fn read_dir(&self, path: &Path) -> io::Result<Vec<VfsDirEntry>> {
        let parts = self.parts(path)?;
        let inner = self.lock();
        let (node, stored) = find(&inner.tree, &parts)?;
        let Body::Dir(children) = &node.body else {
            return Err(not_a_directory(&parts));
        };
        let base = self.abs(&stored);
        let mut children = children.values().collect::<Vec<_>>();
        children.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(children
            .into_iter()
            .map(|child| VfsDirEntry::new(base.join(&child.name), child.kind(), Some(child.metadata())))
            .collect())
    }

    fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        let parts = self.parts(path)?;
        let Some((name, parent_parts)) = parts.split_last() else {
            return Err(is_a_directory(&parts));
        };
        let mut inner = self.lock();
        let now = inner.now();
        let parent = dir_mut(&mut inner.tree, parent_parts)?;
        match parent.children.get_mut(&fold(name)) {
            Some(existing) => {
                let Body::File(content) = &mut existing.body else {
                    return Err(is_a_directory(&parts));
                };
                *content = bytes.to_vec();
                existing.modified = now;
            }
            None => {
                parent.children.insert(fold(name), Node::file(name, bytes.to_vec(), now));
                *parent.modified = now;
            }
        }
        Ok(())
    }

    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        let parts = self.parts(path)?;
        let Some((name, parent_parts)) = parts.split_last() else {
            return Err(is_a_directory(&parts));
        };
        let mut inner = self.lock();
        let now = inner.now();
        create_dir_all_in(&mut inner.tree, parent_parts, now)?;
        replace_with_new_file(&mut inner.tree, &parts, name, parent_parts, bytes, now)
    }

    fn publish(&self, path: &Path, bytes: &[u8], overwrite: bool) -> io::Result<()> {
        let parts = self.parts(path)?;
        let Some((name, parent_parts)) = parts.split_last() else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "画布文件名无效。"));
        };
        let mut inner = self.lock();
        let now = inner.now();
        if !overwrite {
            let parent = dir_mut(&mut inner.tree, parent_parts)?;
            if parent.children.contains_key(&fold(name)) {
                return Err(io::Error::from(io::ErrorKind::AlreadyExists));
            }
        }
        replace_with_new_file(&mut inner.tree, &parts, name, parent_parts, bytes, now)
    }

    fn create_dir(&self, path: &Path) -> io::Result<()> {
        let parts = self.parts(path)?;
        let Some((name, parent_parts)) = parts.split_last() else {
            return Err(already_exists(&parts));
        };
        let mut inner = self.lock();
        let now = inner.now();
        let parent = dir_mut(&mut inner.tree, parent_parts)?;
        let key = fold(name);
        if parent.children.contains_key(&key) {
            return Err(already_exists(&parts));
        }
        parent.children.insert(key, Node::dir(name, now));
        *parent.modified = now;
        Ok(())
    }

    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        let parts = self.parts(path)?;
        let mut inner = self.lock();
        let now = inner.now();
        create_dir_all_in(&mut inner.tree, &parts, now)
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        let parts = self.parts(path)?;
        let Some((name, parent_parts)) = parts.split_last() else {
            return Err(is_a_directory(&parts));
        };
        let mut inner = self.lock();
        let now = inner.now();
        let parent = dir_mut(&mut inner.tree, parent_parts)?;
        let key = fold(name);
        match parent.children.get(&key) {
            None => Err(not_found(&parts)),
            Some(node) if node.is_dir() => Err(is_a_directory(&parts)),
            Some(_) => {
                parent.children.remove(&key);
                *parent.modified = now;
                Ok(())
            }
        }
    }

    fn remove_dir(&self, path: &Path) -> io::Result<()> {
        self.remove_directory(path, false)
    }

    fn remove_dir_all(&self, path: &Path) -> io::Result<()> {
        self.remove_directory(path, true)
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        let from_parts = self.parts(from)?;
        let to_parts = self.parts(to)?;
        let (Some((from_name, from_parent)), Some((to_name, to_parent))) =
            (from_parts.split_last(), to_parts.split_last())
        else {
            return Err(root_untouchable());
        };
        let mut inner = self.lock();
        let now = inner.now();
        let source_is_dir = find(&inner.tree, &from_parts)?.0.is_dir();
        let from_keys = from_parts.iter().map(|part| fold(part)).collect::<Vec<_>>();
        let to_keys = to_parts.iter().map(|part| fold(part)).collect::<Vec<_>>();
        let from_key = fold(from_name);
        let to_key = fold(to_name);

        if from_keys == to_keys {
            // 同一个条目换个写法（只改大小写或规范化方式）：改存储的名字，POSIX 同名 rename 则什么也不做。
            let parent = dir_mut(&mut inner.tree, from_parent)?;
            if let Some(node) = parent.children.get_mut(&from_key) {
                if node.name != *to_name {
                    node.name = to_name.clone();
                    *parent.modified = now;
                }
            }
            return Ok(());
        }
        if source_is_dir && to_keys.starts_with(&from_keys) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "不能把目录挪进它自己里面。"));
        }
        {
            let target_parent = dir_mut(&mut inner.tree, to_parent)?;
            if let Some(target) = target_parent.children.get(&to_key) {
                match (source_is_dir, &target.body) {
                    (false, Body::File(_)) => {}
                    (true, Body::Dir(children)) => {
                        if !children.is_empty() {
                            return Err(io::Error::new(
                                io::ErrorKind::DirectoryNotEmpty,
                                format!("目标目录不为空：{}", joined(&to_parts)),
                            ));
                        }
                    }
                    (false, Body::Dir(_)) => return Err(is_a_directory(&to_parts)),
                    (true, Body::File(_)) => return Err(not_a_directory(&to_parts)),
                }
            }
        }

        let source_parent = dir_mut(&mut inner.tree, from_parent)?;
        let mut node = source_parent.children.remove(&from_key).ok_or_else(|| not_found(&from_parts))?;
        *source_parent.modified = now;
        node.name = to_name.clone();
        // 目标父目录已核对过，且不在被移动的子树里（目录挪进自己已拒绝，文件下面没有子项）；
        // 万一取不到就把源放回原处，不丢条目。
        if let Err(error) = dir_mut(&mut inner.tree, to_parent).map(|_| ()) {
            node.name = from_name.clone();
            if let Ok(source_parent) = dir_mut(&mut inner.tree, from_parent) {
                source_parent.children.insert(from_key, node);
            }
            return Err(error);
        }
        let target_parent = dir_mut(&mut inner.tree, to_parent)?;
        target_parent.children.insert(to_key, node);
        *target_parent.modified = now;
        Ok(())
    }

    fn copy(&self, from: &Path, to: &Path) -> io::Result<u64> {
        let from_parts = self.parts(from)?;
        let to_parts = self.parts(to)?;
        let mut inner = self.lock();
        let now = inner.now();
        let bytes = match &find(&inner.tree, &from_parts)?.0.body {
            Body::File(bytes) => bytes.clone(),
            Body::Dir(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("源不是普通文件：{}", joined(&from_parts)),
                ))
            }
        };
        let len = bytes.len() as u64;
        let Some((name, parent_parts)) = to_parts.split_last() else {
            return Err(is_a_directory(&to_parts));
        };
        let parent = dir_mut(&mut inner.tree, parent_parts)?;
        match parent.children.get_mut(&fold(name)) {
            Some(existing) => {
                let Body::File(content) = &mut existing.body else {
                    return Err(is_a_directory(&to_parts));
                };
                *content = bytes;
                existing.modified = now;
            }
            None => {
                parent.children.insert(fold(name), Node::file(name, bytes, now));
                *parent.modified = now;
            }
        }
        Ok(len)
    }

    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        let parts = self.parts(path)?;
        let inner = self.lock();
        let (_, stored) = find(&inner.tree, &parts)?;
        Ok(self.abs(&stored))
    }
}

/// `write_atomic` / `publish` 的落点：「临时文件 + rename」——父目录必须存在，目标是目录则失败，
/// 已有文件被一个新文件替换（创建与修改时间都重置，名字沿用已有的写法）。
fn replace_with_new_file(
    tree: &mut Node,
    parts: &[String],
    name: &str,
    parent_parts: &[String],
    bytes: &[u8],
    now: SystemTime,
) -> io::Result<()> {
    let parent = dir_mut(tree, parent_parts)?;
    let key = fold(name);
    let stored_name = match parent.children.get(&key) {
        Some(existing) if existing.is_dir() => return Err(is_a_directory(parts)),
        Some(existing) => existing.name.clone(),
        None => name.to_string(),
    };
    parent.children.insert(key, Node::file(&stored_name, bytes.to_vec(), now));
    *parent.modified = now;
    Ok(())
}

impl MemVfs {
    fn remove_directory(&self, path: &Path, recursive: bool) -> io::Result<()> {
        let parts = self.parts(path)?;
        let Some((name, parent_parts)) = parts.split_last() else {
            return Err(root_untouchable());
        };
        let mut inner = self.lock();
        let now = inner.now();
        let parent = dir_mut(&mut inner.tree, parent_parts)?;
        let key = fold(name);
        match parent.children.get(&key).map(|node| &node.body) {
            None => return Err(not_found(&parts)),
            Some(Body::File(_)) => return Err(not_a_directory(&parts)),
            Some(Body::Dir(children)) if !recursive && !children.is_empty() => {
                return Err(io::Error::new(
                    io::ErrorKind::DirectoryNotEmpty,
                    format!("目录不为空：{}", joined(&parts)),
                ))
            }
            Some(Body::Dir(_)) => {}
        }
        parent.children.remove(&key);
        *parent.modified = now;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc,
        },
        time::Duration,
    };

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn times_follow_the_clock_and_local_file_system_rules() {
        let ticks = Arc::new(AtomicU64::new(100));
        let clock = ticks.clone();
        let vfs = MemVfs::with_clock("/vault", move || at(clock.load(Ordering::SeqCst)));
        let root = vfs.root().to_path_buf();
        assert_eq!(vfs.metadata(&root).unwrap().created().unwrap(), at(100));

        ticks.store(200, Ordering::SeqCst);
        vfs.write_atomic(&root.join("notes/a.md"), b"one").unwrap();
        let first = vfs.metadata(&root.join("notes/a.md")).unwrap();
        assert_eq!((first.created().unwrap(), first.modified().unwrap()), (at(200), at(200)));
        assert_eq!(vfs.metadata(&root.join("notes")).unwrap().modified().unwrap(), at(200));

        // `write` 覆盖：只改修改时间，目录不变。
        ticks.store(300, Ordering::SeqCst);
        vfs.write(&root.join("notes/a.md"), b"two").unwrap();
        let second = vfs.metadata(&root.join("notes/a.md")).unwrap();
        assert_eq!((second.created().unwrap(), second.modified().unwrap()), (at(200), at(300)));
        assert_eq!(vfs.metadata(&root.join("notes")).unwrap().modified().unwrap(), at(200));

        // `write_atomic` 替换成新文件：两个时间都重置。
        ticks.store(400, Ordering::SeqCst);
        vfs.write_atomic(&root.join("notes/a.md"), b"three").unwrap();
        let third = vfs.metadata(&root.join("notes/a.md")).unwrap();
        assert_eq!((third.created().unwrap(), third.modified().unwrap()), (at(400), at(400)));

        // rename 保留被移动条目的时间，两边目录的修改时间更新。
        vfs.create_dir(&root.join("archive")).unwrap();
        ticks.store(500, Ordering::SeqCst);
        vfs.rename(&root.join("notes/a.md"), &root.join("archive/a.md")).unwrap();
        let moved = vfs.metadata(&root.join("archive/a.md")).unwrap();
        assert_eq!((moved.created().unwrap(), moved.modified().unwrap()), (at(400), at(400)));
        assert_eq!(vfs.metadata(&root.join("notes")).unwrap().modified().unwrap(), at(500));
        assert_eq!(vfs.metadata(&root.join("archive")).unwrap().modified().unwrap(), at(500));

        vfs.set_time(at(42));
        vfs.write(&root.join("b.txt"), b"x").unwrap();
        assert_eq!(vfs.metadata(&root.join("b.txt")).unwrap().created().unwrap(), at(42));
        vfs.set_times(&root.join("b.txt"), at(1), at(2)).unwrap();
        let restored = vfs.metadata(&root.join("b.txt")).unwrap();
        assert_eq!((restored.created().unwrap(), restored.modified().unwrap()), (at(1), at(2)));
    }

    #[test]
    fn paths_fold_case_and_normalization_like_apfs() {
        let vfs = MemVfs::new("/vault");
        let root = vfs.root().to_path_buf();
        vfs.write_atomic(&root.join("Notes/Cafe\u{0301}.md"), b"x").unwrap();
        assert_eq!(vfs.read(&root.join("notes/café.md")).unwrap(), b"x");
        // 已有目录换大小写写入，子项挂在原目录名下；已有文件保留原写法。
        vfs.write_atomic(&root.join("NOTES/CAFÉ.md"), b"y").unwrap();
        vfs.write(&root.join("notes/new.md"), b"z").unwrap();
        assert_eq!(
            vfs.files().into_keys().collect::<Vec<_>>(),
            vec!["Notes/Cafe\u{0301}.md".to_string(), "Notes/new.md".to_string()]
        );
        assert_eq!(vfs.canonicalize(&root.join("notes/NEW.md")).unwrap(), root.join("Notes/new.md"));
        // 只改大小写的 rename 改的是存储写法。
        vfs.rename(&root.join("notes/new.md"), &root.join("notes/New.md")).unwrap();
        assert!(vfs.files().contains_key("Notes/New.md"));
        assert_eq!(vfs.dirs().into_iter().collect::<Vec<_>>(), vec!["Notes".to_string()]);
    }

    #[test]
    fn rejects_paths_outside_the_root_and_protects_the_root() {
        let vfs = MemVfs::new("/vault");
        let root = vfs.root().to_path_buf();
        assert_eq!(vfs.write(Path::new("/elsewhere/x.md"), b"x").unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(vfs.write(&root.join("../etc/passwd"), b"x").unwrap_err().kind(), io::ErrorKind::InvalidInput);
        assert!(vfs.remove_dir_all(&root).is_err());
        assert!(vfs.rename(&root, &root.join("x")).is_err());
        assert!(vfs.create_dir_all(&root).is_ok());
        assert!(vfs.is_dir(&root));
        // 密匣路径照常可用（浏览器把信封放在原路径上）。
        vfs.write_atomic(&root.join("lockbox/fragments/2026/10/a.shard"), b"{}").unwrap();
        assert_eq!(vfs.lockbox_item_ids().unwrap(), None);
        assert_eq!(vfs.read_head(&root.join("lockbox/fragments/2026/10/a.shard"), 1).unwrap(), b"{");
    }

    #[test]
    fn read_dir_is_sorted_and_carries_metadata() {
        let vfs = MemVfs::new("/vault");
        let root = vfs.root().to_path_buf();
        for name in ["b.md", "A.md", "c"] {
            vfs.write(&root.join(name), name.as_bytes()).unwrap();
        }
        let entries = vfs.read_dir(&root).unwrap();
        let names = entries.iter().map(|entry| entry.file_name().into_string().unwrap()).collect::<Vec<_>>();
        assert_eq!(names, vec!["A.md", "b.md", "c"]);
        assert_eq!(entries[0].path(), root.join("A.md"));
        assert_eq!(entries[0].metadata().unwrap().len(), 4);
    }
}
