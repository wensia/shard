//! 桌面连接服务器后的同步引擎（S8b）：离线能读、离线能写一部分，联网后收敛。设计见
//! `docs/dev/server-sqlite-plan.md` §5。
//!
//! - **副本（已确认层）**：`replica.db` 用与服务器同一套 shard-store schema，只在拉取时写入；
//!   同一个文件里另有同步表（`sync_state`、`confirmed`、`outbox`、`overlay`、`pending_blobs`，见 `db.rs`）。
//! - **读**：在线且没有待补交的本地写时直发服务器；否则在「副本 ∪ overlay」上跑与服务器同一套
//!   shard-vault 读函数，返回同形结果（`local.rs`）。
//! - **写**：在线直发（写成功后后台拉一轮让副本跟上）；网络失败或已知离线时，离线允许的命令在 overlay
//!   上跑同一套领域函数，同时把 RPC 原样（含客户端 id、createdAt、时区、基线 sha）记进 outbox（`queue.rs`
//!   负责合并）；其余命令返回「需要联网：…」。
//! - **一轮同步**（`SyncEngine::sync_round`，单飞）：拉（`pull.rs`，epoch 变化或 410 时全量对账、恢复备份后
//!   找回数据）→ 按 op_seq 补交（`push.rs`，冲突另存副本、绝不复活）→ 再拉 → 收敛 overlay。
//! - **后台**（`SyncRunner`）：触发合并、离线退避、唤醒检测。
//!
//! 不依赖 Tauri：桌面在 `src-tauri/src/remote_client.rs` 里接上事件与命令；测试在进程内起真服务器。
//! 密匣：本版只缓存密文快照供离线只读，密匣写入一律需要联网。

mod db;
mod engine;
mod ids;
mod local;
mod overlay;
mod policy;
mod pull;
mod push;
mod queue;
mod runner;

pub use engine::{Connectivity, EngineOptions, RoundReport, SyncEngine, SyncEvent, SyncStatus, VaultChange};
pub use policy::{classify, offline_label, offline_message, CommandClass, LOCAL_READS, OFFLINE_WRITES};
pub use runner::SyncRunner;
