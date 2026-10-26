//! Shard 的存储层。
//!
//! - [`Vfs`]：资料库文件系统抽象，按 `std::fs` 语义设计，领域逻辑写一次、两种存储都能跑。
//! - [`FsVfs`]：本地目录（切换前的桌面模式）。
//! - [`Store`] / [`SqliteVfs`]：服务端内容库，库里存原文字节，id、标签、链接是同事务派生投影。
//!
//! 设计见 `docs/dev/server-sqlite-plan.md`。

pub mod path_key;
pub mod projection;
mod store;
pub mod transfer;

pub use store::{
    ChangeRecord, ChangesPage, Committed, DeletedEntry, EraseReport, LockboxItemEntry, LockboxManifestEntry,
    MaintenanceReport, ManifestEntry, RevisionInfo, VerifyReport, SqliteVfs, BLOB_GRACE_DAYS, REVISION_FULL_DAYS,
    Store, StoreError, TxnRecord, WriteCtx, DEFAULT_VIRTUAL_ROOT, INLINE_MAX, LockboxItemRaw, PURGED_HISTORY_DAYS,
};
pub use shard_core::{sha256_hex, EntryKind, FsVfs, Vfs, VfsDirEntry, VfsMetadata};
