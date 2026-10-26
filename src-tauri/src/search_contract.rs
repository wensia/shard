//! 搜索契约类型已搬到 `shard_vault::search::contract`（桌面与服务端共用，JSON 形状不变，契约测试随类型搬走）。
//! 这里保留原引用路径 `crate::search_contract::*`。
pub use shard_vault::search::contract::*;
