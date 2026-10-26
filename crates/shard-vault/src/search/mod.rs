//! 搜索：线上契约、公开内容的来源枚举与投影、与运行时无关的扫描组装。桌面与服务端共用。
//!
//! - [`contract`]：`search_vault` / `read_search_target` 的请求、响应与错误类型（JSON 契约已冻结）。
//! - [`documents`]：经 `Vfs` 枚举公开来源、把文件投影成可搜索文档；服务端入口
//!   [`build_public_snapshot`] 与 [`read_public_search_target`]。
//! - [`scan`]：请求校验、查询解析、在快照上扫描并组装命中（含 `map_hit`）。
//!
//! 只处理公开内容。密匣的解密与投影、桌面的增量同步、SQLite 派生索引、运行时快照与代次留在 src-tauri。

pub mod contract;
pub mod documents;
pub mod scan;

pub use contract::*;
pub use documents::*;
pub use scan::*;

#[cfg(test)]
mod tests;
