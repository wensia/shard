//! 本地目录实现：每个方法都是对应 `std::fs` 调用的直通，不加任何额外检查，
//! 让桌面本地模式在迁移到 Vfs 后行为与迁移前逐字节一致。

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use rand::{rngs::OsRng, RngCore};

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

/// 发布写的临时文件：任何返回路径上都删掉，成功发布后删掉的只是多出来的那个链接。
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn publish_nonce() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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

    fn read_head(&self, path: &Path, limit: u64) -> io::Result<Vec<u8>> {
        let mut bytes = Vec::new();
        File::open(path)?.take(limit).read_to_end(&mut bytes)?;
        Ok(bytes)
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
        crate::write_bytes_atomically(path, bytes).map_err(to_io)
    }

    /// 迁移前 `canvas_commands::atomic_write` 的原样搬迁：临时文件名 `.<name>.canvas-tmp-<32 hex>`
    /// 与 App 提交时排除的 pathspec 对应，不能改。
    fn publish(&self, path: &Path, bytes: &[u8], overwrite: bool) -> io::Result<()> {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| io::Error::other("画布文件名无效。"))?;
        let temp = TempFile(path.with_file_name(crate::temporary_filename(
            name,
            &format!(".canvas-tmp-{}", publish_nonce()),
        )));
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp.0)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if overwrite {
            fs::rename(&temp.0, path)?;
        } else {
            // hard_link 发布是原子的，并拒绝任何已存在的目标，包括悬空符号链接。
            fs::hard_link(&temp.0, path)?;
        }
        if let Some(parent) = path.parent() {
            if let Ok(directory) = File::open(parent) {
                let _ = directory.sync_all();
            }
        }
        Ok(())
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
