//! 本地目录实现：每个方法都是对应 `std::fs` 调用的直通，不加任何额外检查，
//! 让桌面本地模式在迁移到 Vfs 后行为与迁移前逐字节一致。

use std::{
    fs,
    io,
    path::{Path, PathBuf},
};

use crate::vfs::{EntryKind, Vfs, VfsDirEntry, VfsMetadata};

#[derive(Clone, Debug)]
pub struct FsVfs {
    root: PathBuf,
}

impl FsVfs {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

fn to_io(error: String) -> io::Error {
    io::Error::other(error)
}

impl Vfs for FsVfs {
    fn root(&self) -> &Path {
        &self.root
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        fs::read(path)
    }

    fn read_to_string(&self, path: &Path) -> io::Result<String> {
        fs::read_to_string(path)
    }

    fn metadata(&self, path: &Path) -> io::Result<VfsMetadata> {
        fs::metadata(path).map(|metadata| VfsMetadata::from_std(&metadata))
    }

    fn symlink_metadata(&self, path: &Path) -> io::Result<VfsMetadata> {
        fs::symlink_metadata(path).map(|metadata| VfsMetadata::from_std(&metadata))
    }

    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }

    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }

    fn read_dir(&self, path: &Path) -> io::Result<Vec<VfsDirEntry>> {
        let mut entries = Vec::new();
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let kind = if file_type.is_symlink() {
                EntryKind::Symlink
            } else if file_type.is_dir() {
                EntryKind::Dir
            } else if file_type.is_file() {
                EntryKind::File
            } else {
                EntryKind::Other
            };
            entries.push(VfsDirEntry::new(entry.path(), kind, None));
        }
        Ok(entries)
    }

    fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        fs::write(path, bytes)
    }

    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        shard_core::write_bytes_atomically(path, bytes).map_err(to_io)
    }

    fn create_dir(&self, path: &Path) -> io::Result<()> {
        fs::create_dir(path)
    }

    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        fs::create_dir_all(path)
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }

    fn remove_dir(&self, path: &Path) -> io::Result<()> {
        fs::remove_dir(path)
    }

    fn remove_dir_all(&self, path: &Path) -> io::Result<()> {
        fs::remove_dir_all(path)
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)
    }

    fn copy(&self, from: &Path, to: &Path) -> io::Result<u64> {
        fs::copy(from, to)
    }

    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        fs::canonicalize(path)
    }
}
