//! 影子写：把刚落盘的改动同步进本地库。
//!
//! # 为什么失败只记日志
//!
//! Phase 2/3 里 Markdown 文件仍是真相源，这个库是旁路。DESIGN.md 要求
//! 「保存动作不可失败、不可阻塞后续输入」，所以索引层的任何问题都**不能**
//! 向上传播——用户刚写的东西已经安全落盘了，不该因为一个旁路索引出错而看到
//! 保存失败。库真出了问题，重跑一次 `import_vault_markdown` 即可完全重建。
//!
//! # 为什么走「重读文件」而不是复用内存里的 Fragment
//!
//! `Fragment` 是面向 UI 的视图：没有 `source` 字段，而且密匣条目在解锁态下
//! `content` 装的是**解密后的明文**——直接拿它写库会把明文写进去。
//! 统一走 `import::sync_one` 的解析路径，既杜绝字段漂移，也让明文永远不会
//! 从这条路进入存储层。

use super::{import, repo, NotesDb};

/// 同步一条刚写盘的笔记。`rel_path` 是 vault 相对路径（`Fragment.path`）。
pub(crate) async fn sync_file(app: &tauri::AppHandle, notes: &NotesDb, rel_path: &str) {
    if let Err(error) = try_sync_file(app, notes, rel_path).await {
        eprintln!("[shard] 影子写失败，Markdown 仍是真相源（{rel_path}）：{error}");
    }
}

async fn try_sync_file(
    app: &tauri::AppHandle,
    notes: &NotesDb,
    rel_path: &str,
) -> Result<(), String> {
    let vault = crate::ensure_vault_dirs(app)?;
    let conn = notes.conn(app, false).await?;
    import::sync_one(&conn, &vault, rel_path).await
}

/// 一条笔记被移入密匣后调用。
///
/// 明文文件此时已被删除，但库里还留着那一行。必须**立刻**清掉——留着就是
/// 明文泄漏，哪怕只是在本地库里。清完再增量扫一次密匣目录，把新的密文条目
/// 收进来（只扫密匣，不重读整个 vault）。
pub(crate) async fn sync_lockbox_transfer(app: &tauri::AppHandle, notes: &NotesDb, id: &str) {
    if let Err(error) = try_sync_lockbox_transfer(app, notes, id).await {
        eprintln!("[shard] 密匣转移的影子写失败（{id}）：{error}");
    }
}

async fn try_sync_lockbox_transfer(
    app: &tauri::AppHandle,
    notes: &NotesDb,
    id: &str,
) -> Result<(), String> {
    let vault = crate::ensure_vault_dirs(app)?;
    let conn = notes.conn(app, false).await?;

    repo::purge(&conn, id).await?;
    import::run(
        &conn,
        &vault,
        &import::ImportOptions {
            include_plaintext: false,
            ..Default::default()
        },
    )
    .await
    .map(|_| ())
}

/// 从磁盘重新对账一遍。
///
/// 用在那些**不经过本机写命令**的文件变更之后。影子写只能捕捉本机写操作，
/// 外部编辑器直接改 vault 里的文件就属于这类，必须靠重扫补上。
/// 目前由 `import_vault_markdown` 命令手动触发；接入服务端同步后会成为
/// 拉取流程的一部分。
///
/// 按内容 hash 幂等，没有新东西时只是空跑一遍扫描。
#[allow(dead_code)]
pub(crate) async fn resync_from_disk(app: &tauri::AppHandle, notes: &NotesDb) {
    let result = async {
        let vault = crate::ensure_vault_dirs(app)?;
        let conn = notes.conn(app, false).await?;
        import::run(&conn, &vault, &import::ImportOptions::default()).await
    }
    .await;

    match result {
        Ok(report) if report.imported > 0 => {
            eprintln!("[shard] 从磁盘同步了 {} 条笔记到本地库", report.imported);
        }
        Ok(_) => {}
        Err(error) => eprintln!("[shard] 从磁盘重新对账失败：{error}"),
    }
}

/// 一条笔记被删除或移出库后调用，把它从本地库彻底移除。
#[allow(dead_code)]
pub(crate) async fn purge(app: &tauri::AppHandle, notes: &NotesDb, id: &str) {
    let result = async {
        let conn = notes.conn(app, false).await?;
        repo::purge(&conn, id).await
    }
    .await;

    if let Err(error) = result {
        eprintln!("[shard] 影子清理失败（{id}）：{error}");
    }
}
