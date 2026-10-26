//! 资料库领域逻辑：碎片、资料库树、回收站、图片、导图、流程图/画布、数据集、属性、引用改写。
//!
//! 全部跑在 [`VaultCtx`]（`shard_core::Vfs` + [`VaultHooks`]）上，不依赖 Tauri、不碰 `std::fs`
//! 里的资料库路径、不调 git：桌面用 `FsVfs` + 本地 Git 钩子，服务端用 `SqliteVfs` + [`NoHooks`]。
//!
//! 只处理公开内容。密匣（加解密、会话、`lockbox/` 下的读写）留在桌面端：命令层先判断目标是不是
//! 密匣，是就走桌面的密匣实现，不是才调这里。少数公开校验需要知道「哪些 id 属于密匣」，
//! 经 [`Vfs::lockbox_item_ids`](shard_core::Vfs::lockbox_item_ids) 询问，桌面退回扫描 `lockbox/`。
//!
//! 写门（同一资料库的写操作串行化）由调用方在最外层持有，这里的函数一律不取门。
//!
//! 模块划分：
//! - [`hooks`]：[`VaultCtx`]、[`VaultHooks`]、[`NoHooks`]。
//! - [`types`]：命令返回的 DTO（serde 属性即前端 JSON 合同）。
//! - [`fragments`]：碎片读写、属性、关系、碎片⇄笔记转换。
//! - [`library`]：资料库树、新建笔记 / 目录 / 数据集说明笔记。
//! - [`refs`]：改名、移动与引用改写（wikilink、Markdown 图片、CSV 单元格图片）。
//! - [`trash`]：回收站。
//! - [`images`]：图片附件、命名图片导入、引用查询、资料库图片宫格。
//! - [`maps`]：思维导图。
//! - [`graph`]：碎片里的大纲 / 流程图受管区域。
//! - [`canvas`]：独立流程图与旧混合画布（含拆分）。
//! - [`datasets`]：CSV 数据集。
//! - [`xlsx`]：XLSX 导入解析（字节 → 第一个工作表的字符串矩阵），纯函数。

mod prelude;

pub mod canvas;
pub mod datasets;
pub mod fragments;
pub mod graph;
pub mod hooks;
pub mod images;
pub mod library;
pub mod maps;
pub mod refs;
pub mod trash;
pub mod types;
pub mod util;
pub mod xlsx;

pub use datasets::*;
pub use fragments::*;
pub use graph::*;
pub use hooks::*;
pub use images::*;
pub use library::*;
pub use maps::*;
pub use refs::*;
pub use trash::*;
pub use types::*;
pub use util::*;

#[cfg(test)]
mod tests;
