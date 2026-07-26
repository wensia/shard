//! 笔记库的 DDL —— 定义在 `shard-core`，客户端与服务端共用。
//!
//! 这里只做转发。表定义本身放在共享 crate 里，是因为两端 schema 漂移不会
//! 编译失败，只会在很久以后表现成「同一条笔记在另一台设备上不太对」。

pub(crate) use shard_core::NOTES_MIGRATIONS as MIGRATIONS;
