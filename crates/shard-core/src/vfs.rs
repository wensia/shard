//! 资料库的文件系统抽象。
//!
//! 接口照着 `std::fs` 的语义设计，参数是绝对路径（`vault.join(...)` 算出来的那种），
//! 这样 lib.rs 里的领域逻辑只需把 `fs::read_to_string(&path)` 换成 `vfs.read_to_string(&path)`，
//! 不用改算法。两种实现：
//! - [`crate::FsVfs`]：直接读写本地目录，切换前的桌面模式用。
//! - [`crate::SqliteVfs`]：服务端内容库里的一个事务，根目录是虚拟的，从不触盘。
//!
//! 两种实现的行为差异只允许出现在文档写明的地方，`tests/vfs_conformance.rs` 用随机操作序列逐项比对。

use std::{
    ffi::OsString,
    io,
    path::{Path, PathBuf},
    time::SystemTime,
};

use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Dir,
    /// 只有 FsVfs 会出现；SqliteVfs 里没有符号链接。
    Symlink,
    Other,
}

impl EntryKind {
    pub fn is_file(self) -> bool {
        self == EntryKind::File
    }

    pub fn is_dir(self) -> bool {
        self == EntryKind::Dir
    }

    pub fn is_symlink(self) -> bool {
        self == EntryKind::Symlink
    }
}

/// 时间字段保留「平台给不出」的情况：FsVfs 下 `modified()` / `created()` 与 `std::fs::Metadata`
/// 同样可能返回 Err（例如部分文件系统没有创建时间），调用方原有的降级分支照常生效。
#[derive(Clone, Debug)]
pub struct VfsMetadata {
    kind: EntryKind,
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
}

fn time_unavailable() -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, "该文件系统不提供这个时间")
}

impl VfsMetadata {
    pub fn new(kind: EntryKind, len: u64, modified: SystemTime, created: SystemTime) -> Self {
        Self { kind, len, modified: Some(modified), created: Some(created) }
    }

    pub fn file_type(&self) -> EntryKind {
        self.kind
    }

    pub fn is_file(&self) -> bool {
        self.kind.is_file()
    }

    pub fn is_dir(&self) -> bool {
        self.kind.is_dir()
    }

    pub fn is_symlink(&self) -> bool {
        self.kind.is_symlink()
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// 与 `std::fs::Metadata::modified` 同签名，方便机械替换。
    pub fn modified(&self) -> io::Result<SystemTime> {
        self.modified.ok_or_else(time_unavailable)
    }

    pub fn created(&self) -> io::Result<SystemTime> {
        self.created.ok_or_else(time_unavailable)
    }

    pub(crate) fn from_std(metadata: &std::fs::Metadata) -> Self {
        let file_type = metadata.file_type();
        let kind = if file_type.is_symlink() {
            EntryKind::Symlink
        } else if file_type.is_dir() {
            EntryKind::Dir
        } else if file_type.is_file() {
            EntryKind::File
        } else {
            EntryKind::Other
        };
        Self {
            kind,
            len: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
        }
    }
}

/// `read_dir` 的一项。SqliteVfs 预先带上元数据；FsVfs 按需 `stat`（跟随符号链接，与 `DirEntry::metadata` 不同，
/// 但与现有代码里 `fs::metadata(entry.path())` 的写法一致）。
#[derive(Clone, Debug)]
pub struct VfsDirEntry {
    path: PathBuf,
    file_name: OsString,
    kind: EntryKind,
    metadata: Option<VfsMetadata>,
}

impl VfsDirEntry {
    pub fn new(path: PathBuf, kind: EntryKind, metadata: Option<VfsMetadata>) -> Self {
        let file_name = path.file_name().map(OsString::from).unwrap_or_default();
        Self { path, file_name, kind, metadata }
    }

    pub fn path(&self) -> PathBuf {
        self.path.clone()
    }

    pub fn file_name(&self) -> OsString {
        self.file_name.clone()
    }

    /// 不跟随符号链接，与 `std::fs::DirEntry::file_type` 一致。
    pub fn file_type(&self) -> io::Result<EntryKind> {
        Ok(self.kind)
    }

    pub fn metadata(&self) -> io::Result<VfsMetadata> {
        match &self.metadata {
            Some(metadata) => Ok(metadata.clone()),
            None => std::fs::metadata(&self.path).map(|metadata| VfsMetadata::from_std(&metadata)),
        }
    }
}

/// 资料库文件系统。所有路径都是绝对路径，必须落在 [`Vfs::root`] 之下（SqliteVfs 会拒绝根外路径；
/// FsVfs 不检查，与现在直接用 `std::fs` 的行为一致）。
pub trait Vfs {
    /// 资料库根目录。FsVfs 是真实目录；SqliteVfs 是虚拟路径，只用来拼接与剥离前缀。
    fn root(&self) -> &Path;

    fn read(&self, path: &Path) -> io::Result<Vec<u8>>;

    fn read_to_string(&self, path: &Path) -> io::Result<String> {
        let bytes = self.read(path)?;
        String::from_utf8(bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    /// 只读文件开头至多 `limit` 字节：读文件头、限长读取时不把大文件整个读进内存。
    /// 默认实现读全文再截断；FsVfs 用 `take` 只读前缀，与迁移前的 `File::open(..).take(..)` 一致。
    fn read_head(&self, path: &Path, limit: u64) -> io::Result<Vec<u8>> {
        let mut bytes = self.read(path)?;
        bytes.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        Ok(bytes)
    }

    /// 跟随符号链接（SqliteVfs 没有符号链接，与 `symlink_metadata` 相同）。
    fn metadata(&self, path: &Path) -> io::Result<VfsMetadata>;

    fn symlink_metadata(&self, path: &Path) -> io::Result<VfsMetadata> {
        self.metadata(path)
    }

    fn exists(&self, path: &Path) -> bool {
        self.metadata(path).is_ok()
    }

    fn is_file(&self, path: &Path) -> bool {
        self.metadata(path).map(|metadata| metadata.is_file()).unwrap_or(false)
    }

    fn is_dir(&self, path: &Path) -> bool {
        self.metadata(path).map(|metadata| metadata.is_dir()).unwrap_or(false)
    }

    fn read_dir(&self, path: &Path) -> io::Result<Vec<VfsDirEntry>>;

    /// `std::fs::write` 语义：父目录必须已存在，已有文件整体替换。SqliteVfs 里天然原子。
    fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()>;

    /// `shard_core::write_bytes_atomically` 语义：自动建父目录，原子替换。
    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> io::Result<()>;

    /// 图形文档（画布、流程图及其恢复记录）的发布写：父目录必须已存在。
    /// `overwrite` 为真时原子替换目标；为假时只发布新文件，目标已存在（含悬空符号链接）即返回
    /// `AlreadyExists`，绝不覆盖。默认实现在 `write`（SqliteVfs 里天然原子）之上做存在检查；
    /// FsVfs 沿用迁移前画布的写法（独立临时文件 + fsync，再 rename 或 hard_link）。
    fn publish(&self, path: &Path, bytes: &[u8], overwrite: bool) -> io::Result<()> {
        if !overwrite && self.symlink_metadata(path).is_ok() {
            return Err(io::Error::from(io::ErrorKind::AlreadyExists));
        }
        self.write(path, bytes)
    }

    fn create_dir(&self, path: &Path) -> io::Result<()>;

    fn create_dir_all(&self, path: &Path) -> io::Result<()>;

    fn remove_file(&self, path: &Path) -> io::Result<()>;

    /// 只删空目录。
    fn remove_dir(&self, path: &Path) -> io::Result<()>;

    fn remove_dir_all(&self, path: &Path) -> io::Result<()>;

    /// POSIX `rename` 语义：文件覆盖文件、目录覆盖空目录；目标父目录必须存在；不能把目录挪进自己里面。
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;

    /// 只复制文件，返回字节数；目标父目录必须存在。
    fn copy(&self, from: &Path, to: &Path) -> io::Result<u64>;

    /// FsVfs 解析符号链接；SqliteVfs 只做词法规整并要求路径存在。
    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf>;

    /// 原始字节的 sha256（十六进制），即现在的 `fileSha`。SqliteVfs 直接读列，不读内容。
    fn content_sha(&self, path: &Path) -> io::Result<String> {
        Ok(sha256_hex(&self.read(path)?))
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
