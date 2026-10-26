//! shard-vault 的测试。
//!
//! - `legacy_*`：随领域代码从 src-tauri/src/lib.rs 搬来的测试，跑在本地目录（FsVfs）+ NoHooks 上，
//!   准备数据照旧直接写文件；需要 Git 或密匣的测试留在 src-tauri。
//! - `dual`：同一组领域场景在 FsVfs 与 SqliteVfs（服务端内容库）上各跑一遍，比对返回值与最终目录树。
//! - `dto_snapshot`：DTO 的 JSON 形状与搬迁前逐字节一致。

pub(crate) use crate::prelude::*;
pub(crate) use shard_core::{
    ensure_vault_layout, frontmatter::raw_from_frontmatter, write_text_atomically, FsVfs,
};
pub(crate) use std::fs;

mod dto_snapshot;
mod dual;
mod legacy_datasets;
mod legacy_fragments;
mod legacy_images;
mod legacy_library;
mod legacy_maps_graph;
mod legacy_refs_trash;

/// 测试用的本地资料库：真实目录 + [`NoHooks`]。迁移前这些测试用的是桌面的 `LocalVault`
/// （FsVfs + GitHooks），测试资料库都没有初始化 Git，GitHooks 的每个钩子与 NoHooks 返回相同。
pub(crate) struct LocalVault {
    vfs: FsVfs,
    hooks: NoHooks,
}

impl LocalVault {
    pub(crate) fn new(vault: &Path) -> Self {
        Self {
            vfs: FsVfs::new(vault),
            hooks: NoHooks,
        }
    }

    pub(crate) fn cx(&self) -> VaultCtx<'_> {
        VaultCtx {
            vfs: &self.vfs,
            hooks: &self.hooks,
        }
    }
}

/// 迁移前这些测试调的是桌面的 `dirty_paths(vault)`（`git status`）；测试资料库没有 Git，结果恒为空集。
pub(crate) fn dirty_paths(_vault: &Path) -> HashSet<String> {
    HashSet::new()
}

pub(crate) const TEST_PNG: &[u8] = b"\x89PNG\r\n\x1a\npng";

pub(crate) fn write_public_test_fragment(vault: &Path, body: &str) -> String {
    let now = Local::now();
    let id = format!("test-{}", unique_suffix());
    let dir = vault.join("fragments").join("tests");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{}.md", id));
    let frontmatter = FragmentFrontmatter {
        id: id.clone(),
        created_at: now.to_rfc3339(),
        updated_at: now.to_rfc3339(),
        tags: vec!["inbox".to_string()],
        category: None,
        ai_status: Some("none".to_string()),
        pinned: false,
        source: "test".to_string(),
        conflict_of: None,
        related: Vec::new(),
    };
    write_fragment_file(&FsVfs::new(vault), &path, &frontmatter, body).unwrap();
    id
}

pub(crate) fn write_t6_fragment(path: &Path, id: &str, tags: Vec<&str>, body: &str) {
    let now = Local::now().to_rfc3339();
    let frontmatter = FragmentFrontmatter {
        id: id.to_string(),
        created_at: now.clone(),
        updated_at: now,
        tags: tags.into_iter().map(str::to_string).collect(),
        category: None,
        ai_status: Some("none".to_string()),
        pinned: false,
        source: "test".to_string(),
        conflict_of: None,
        related: Vec::new(),
    };
    write_fragment_file(&FsVfs::new(path.parent().unwrap()), path, &frontmatter, body).unwrap();
}
