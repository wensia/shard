//! Shard 服务端：内容库的唯一写者。提供 RPC、SSE、文件与同步端点，通行密钥登录，并托管网页。
//! 设计见 `docs/dev/server-sqlite-plan.md` §3、§7。

pub mod app;
pub mod auth;
pub mod commands;
pub mod config;
pub mod error;
pub mod events;
pub mod files;
pub mod history;
pub mod rpc;
pub mod search;
pub mod state;
