//! Shard 的存储层。
//!
//! - [`Vfs`]：资料库文件系统抽象，按 `std::fs` 语义设计，领域逻辑写一次、两种存储都能跑。
//! - [`FsVfs`]：本地目录（切换前的桌面模式）。
//! - [`Store`] / [`SqliteVfs`]：服务端内容库，库里存原文字节，id、标签、链接是同事务派生投影。
//!
//! 设计见 `docs/dev/server-sqlite-plan.md`。

mod fs_vfs;
pub mod path_key;
pub mod projection;
mod store;
mod vfs;

pub use fs_vfs::FsVfs;
pub use store::{
    ChangeRecord, ChangesPage, Committed, SqliteVfs, Store, StoreError, TxnRecord, WriteCtx,
    DEFAULT_VIRTUAL_ROOT, INLINE_MAX,
};
pub use vfs::{sha256_hex, EntryKind, Vfs, VfsDirEntry, VfsMetadata};
