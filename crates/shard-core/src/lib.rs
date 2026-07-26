//! Shard 客户端（Tauri）与服务端共享的核心逻辑。
//!
//! 放进这个 crate 的东西只有一个标准：**两端都要用，且两端必须一致**。
//!
//! - [`fts`]：全文检索分词。索引在一端写、查询在另一端发，逻辑一旦漂移，
//!   搜索就会静默失效。
//! - [`schema`]：笔记库的表定义。两端跑同一套 DDL。
//! - [`hash`]：内容指纹。同一份内容在两端必须算出同一个值。
//! - [`sync`]：同步协议的报文格式。
//!
//! 这几样的共同点是：出问题时**不会编译失败，只会数据不对**。这正是把它们
//! 集中到一处、而不是两边各写一份的理由。

pub mod fts;
pub mod hash;
pub mod schema;
pub mod sync;

pub use fts::{build_match_query, is_cjk, to_fts_text, FTS_TOKENIZE};
pub use hash::{hash_bytes, hash_text};
pub use schema::{Migration, NOTES_MIGRATIONS};
