//! Shard 客户端（Tauri）与服务端共享的核心逻辑。
//!
//! 放进这个 crate 的东西只有一个标准：**两端都要用，且两端必须一致**。
//! 典型是全文检索分词——索引在一端写、查询在另一端发，逻辑一旦漂移，
//! 搜索就会静默失效。数据模型与 schema 定义后续也归这里。

pub mod fts;

pub use fts::{build_match_query, is_cjk, to_fts_text, FTS_TOKENIZE};
