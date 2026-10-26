//! 资料库操作的上下文与版本控制钩子。

use crate::prelude::*;

/// 资料库操作的上下文：文件系统 + 版本控制钩子。
///
/// 领域函数只经 `vfs` 读写资料库内部路径、只经 `hooks` 触发版本控制与索引副作用，
/// 不直接碰 `std::fs` 与 git。桌面：`FsVfs` + src-tauri 的 `GitHooks`；服务端：`SqliteVfs` + [`NoHooks`]。
#[derive(Clone, Copy)]
pub struct VaultCtx<'a> {
    pub vfs: &'a dyn Vfs,
    pub hooks: &'a dyn VaultHooks,
}

impl VaultCtx<'_> {
    pub fn root(&self) -> &Path {
        self.vfs.root()
    }
}

/// 版本控制与桌面索引的副作用；服务端模式用 [`NoHooks`]（全部空操作，`has_vcs` 为假）。
/// 必需方法各对应迁移前领域代码里直接调用的一个 git 函数，语义保持不变；带默认实现的方法
/// 是迁移前直接调桌面搜索索引的地方，默认实现就是索引不可用时原来的退路。
pub trait VaultHooks {
    /// 原来的 `vault.join(".git").exists()`。
    fn has_vcs(&self) -> bool;
    /// 原来的 `dirty_paths(vault)`。
    fn dirty_paths(&self) -> HashSet<String>;
    /// 原来的 `checkpoint_before_structural_locked(vault)`；必须已持写门。
    fn checkpoint_before_structural(&self);
    /// 原来的 `checkpoint_vault_locked(vault, trigger)`；必须已持写门。
    fn checkpoint(&self, trigger: Option<&str>) -> Result<CheckpointResult, String>;
    /// 原来的 `commit_paths_best_effort(vault, paths, message)`。
    fn commit_paths_best_effort(&self, paths: &[String], message: &str);
    /// 原来的 `commit_paths_if_git(vault, paths, message)`：没有版本控制时 `Ok(None)`。
    fn commit_paths_if_git(&self, paths: &[String], message: &str) -> Result<Option<()>, String>;
    /// 原来的 `commit_path_if_git(vault, path, message)`：没有版本控制时 `Ok(None)`。
    fn commit_path_if_git(&self, path: &str, message: &str) -> Result<Option<()>, String>;
    /// 原来的 `ensure_no_unfinished_git_operation(vault)`：外部 Git 操作进行中时拒绝写图形文档。
    fn ensure_no_unfinished_operation(&self) -> Result<(), String>;
    /// 原来的 `git_info(vault)`。
    fn git_info(&self) -> GitInfo;
    /// 资料库图片宫格用的「公开资料库内容引用到的附件」集合（原来的 `library_asset_references`）。
    /// 默认全量扫描 `notes/` 与 `datasets/`；桌面 `GitHooks` 先走搜索索引的增量同步，失败再退回全量扫描。
    fn library_asset_references(&self, vfs: &dyn Vfs) -> HashSet<String> {
        library_asset_references_full_scan(vfs)
    }
}

/// 没有版本控制：与本地资料库未初始化 Git 时各 git 函数的返回值一致。
pub struct NoHooks;

impl VaultHooks for NoHooks {
    fn has_vcs(&self) -> bool {
        false
    }

    fn dirty_paths(&self) -> HashSet<String> {
        HashSet::new()
    }

    fn checkpoint_before_structural(&self) {}

    fn checkpoint(&self, _trigger: Option<&str>) -> Result<CheckpointResult, String> {
        Ok(CheckpointResult {
            status: "not_git".to_string(),
            changes: 0,
            reason: None,
            skipped_large: Vec::new(),
            git: no_git_info(),
        })
    }

    fn commit_paths_best_effort(&self, _paths: &[String], _message: &str) {}

    fn commit_paths_if_git(&self, _paths: &[String], _message: &str) -> Result<Option<()>, String> {
        Ok(None)
    }

    fn commit_path_if_git(&self, _path: &str, _message: &str) -> Result<Option<()>, String> {
        Ok(None)
    }

    fn ensure_no_unfinished_operation(&self) -> Result<(), String> {
        Ok(())
    }

    fn git_info(&self) -> GitInfo {
        no_git_info()
    }
}

/// 资料库没有版本控制时的 Git 状态（本地未初始化 Git，或服务端模式）。
pub fn no_git_info() -> GitInfo {
    GitInfo {
        branch: "main".to_string(),
        short_commit: "no git".to_string(),
        has_remote: false,
        status: "no_git".to_string(),
        error: None,
        ahead: 0,
        behind: 0,
    }
}
