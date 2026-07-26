//! 笔记库：客户端本地的结构化存储。
//!
//! # 定位
//!
//! 这个库是**客户端本地的读写缓冲与索引**，不是直连云端的副本。最终架构里
//! 客户端只调自建后端的 HTTP API，同步由应用层的 outbox 协议完成，因此
//! [`NotesSpec::remote`] 恒为 `None`——本地库永远以 `new_local` 打开。
//!
//! 这不是权宜之计。libSQL 的帧同步是物理 WAL 复制，没有行级合并语义，
//! 冲突是不可恢复的硬错误（见 `libsql-0.9.30/src/sync.rs` 的 `sync_offline`），
//! 拿它做多端合并会在双端离线写之后永久分叉。同步必须自己在应用层做。
//!
//! # 真相源
//!
//! 这个库**就是**本地的真相源。Markdown / `.shard` / `.shardmap.json` 已经
//! 降级为手动导出的产物：写命令只写库、不碰文件，文件只在用户点导出时生成。

pub(crate) mod attachments;
pub(crate) mod bridge;
pub(crate) mod commands;
pub(crate) mod export;
pub(crate) mod import;
pub(crate) mod maps;
pub(crate) mod model;
pub(crate) mod repo;
pub(crate) mod schema;
pub(crate) mod search;
pub(crate) mod sync;

use crate::db::{migrate::Migration, DbHandle, DbSpec};
use crate::AppConfig;

/// 笔记库的静态描述。
pub(crate) struct NotesSpec;

impl DbSpec for NotesSpec {
    const SUBDIR: &'static str = ".shard";
    const FILE_NAME: &'static str = "notes.sqlite3";
    // 本地缓存，可从 Markdown 或服务端完全重建，绝不该进版本库。
    const IGNORE_MAIN_DB: bool = true;

    fn migrations() -> &'static [Migration] {
        schema::MIGRATIONS
    }

    /// 恒为 `None`：本地库不直连任何远端。
    ///
    /// 尤其**不能**回退到记账模块的 `turso_url`——两个库共用同一个远端会让
    /// 两套 `PRAGMA user_version` 互相踩踏，可能直接损坏远端数据。
    fn remote(_cfg: &AppConfig) -> Option<(String, String)> {
        None
    }
}

/// 注册进 `tauri::Builder::manage`，跨命令共享的笔记库缓存。
pub(crate) type NotesDb = DbHandle<NotesSpec>;

#[cfg(test)]
mod tests {
    use super::model::{CipherEnvelope, NoteWrite};
    use super::*;
    use libsql::Connection;

    async fn open_test_conn() -> Connection {
        let db = libsql::Builder::new_local(":memory:")
            .build()
            .await
            .unwrap();
        let conn = crate::db::connect_with_pragmas(&db).await.unwrap();
        crate::db::migrate::apply(&conn, NotesSpec::migrations())
            .await
            .unwrap();
        conn
    }

    fn note(id: &str, content: &str, tags: &[&str]) -> NoteWrite {
        NoteWrite {
            id: id.into(),
            content: Some(content.into()),
            created_at: "2026-07-26T10:00:00+08:00".into(),
            updated_at: "2026-07-26T10:00:00+08:00".into(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            category: None,
            ai_status: "none".into(),
            source: "desktop".into(),
            archived: false,
            pinned: false,
            cipher: None,
            export_path: Some(format!("fragments/2026/07/{id}.md")),
        }
    }

    fn lockbox_note(id: &str, ciphertext: &str) -> NoteWrite {
        NoteWrite {
            content: None,
            cipher: Some(CipherEnvelope {
                version: 1,
                nonce: "nonce".into(),
                text: ciphertext.into(),
                key_alg: Some("rsa-oaep-sha256".into()),
                key_text: Some("wrapped".into()),
                key_id: None,
            }),
            ..note(id, "", &[])
        }
    }

    /// 建库后 user_version 应停在最新迁移上。跟随 MIGRATIONS 取值而非写死数字，
    /// 这样追加迁移时不必再回来改这条断言。
    #[tokio::test]
    async fn creates_schema_and_sets_latest_user_version() {
        let conn = open_test_conn().await;
        let version = crate::db::migrate::user_version(&conn).await.unwrap();
        let latest = NotesSpec::migrations()
            .iter()
            .map(|m| m.version)
            .max()
            .unwrap();
        assert_eq!(version, latest);

        // v2 的三张新表都应存在。
        for table in ["shard_maps", "attachments", "fragment_attachments", "lockbox_manifest", "lockbox_keys"] {
            let mut rows = conn
                .query(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    libsql::params![table],
                )
                .await
                .unwrap();
            let found: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
            assert_eq!(found, 1, "缺少表 {table}");
        }
    }

    #[tokio::test]
    async fn upsert_round_trips_content_and_tags() {
        let conn = open_test_conn().await;
        repo::upsert(&conn, &note("f1", "今天开会议程安排", &["工作", "会议"]))
            .await
            .unwrap();

        let row = repo::get(&conn, "f1").await.unwrap().expect("应能读回");
        assert_eq!(row.content.as_deref(), Some("今天开会议程安排"));
        assert_eq!(row.tags, vec!["会议".to_string(), "工作".to_string()]);
        assert_eq!(row.revision, 1);
        assert!(!row.lockbox);
    }

    /// 重复写入同一 id 必须是更新而不是报错——导入要能安全重跑。
    #[tokio::test]
    async fn upsert_is_idempotent_and_bumps_revision() {
        let conn = open_test_conn().await;
        repo::upsert(&conn, &note("f1", "第一版", &["a"])).await.unwrap();
        repo::upsert(&conn, &note("f1", "第二版", &["b"])).await.unwrap();

        let row = repo::get(&conn, "f1").await.unwrap().unwrap();
        assert_eq!(row.content.as_deref(), Some("第二版"));
        assert_eq!(row.tags, vec!["b".to_string()], "旧标签必须被替换而非累积");
        assert_eq!(row.revision, 2);
        assert_eq!(repo::count(&conn, true).await.unwrap(), 1, "不该产生重复行");
    }

    /// 端到端验证中文搜索：查询词夹在词中间也要命中。
    /// 这是整个搜索方案的核心收益，也是 trigram 方案会失败的地方。
    #[tokio::test]
    async fn search_finds_two_character_chinese_mid_word() {
        let conn = open_test_conn().await;
        repo::upsert(&conn, &note("f1", "今天开会议程安排在下午", &[]))
            .await
            .unwrap();
        repo::upsert(&conn, &note("f2", "随便写点别的内容", &[]))
            .await
            .unwrap();

        let hits = search::search(&conn, "会议", false, 20).await.unwrap();
        let ids: Vec<_> = hits.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, vec!["f1"], "『会议』应只命中 f1");
        assert!(hits[0].snippet.contains("<<"), "应返回带高亮标记的片段");
    }

    /// 标签也要可检索。
    #[tokio::test]
    async fn search_covers_tags() {
        let conn = open_test_conn().await;
        repo::upsert(&conn, &note("f1", "正文里没有那个词", &["日程"]))
            .await
            .unwrap();

        let hits = search::search(&conn, "日程", false, 20).await.unwrap();
        assert_eq!(hits.len(), 1, "标签应进入索引");
    }

    /// 安全关键：密匣密文绝不能进全文索引，也不能被搜到。
    #[tokio::test]
    async fn lockbox_never_enters_search_index() {
        let conn = open_test_conn().await;
        repo::upsert(&conn, &lockbox_note("secret", "会议密文内容"))
            .await
            .unwrap();

        let row = repo::get(&conn, "secret").await.unwrap().unwrap();
        assert!(row.lockbox);
        assert!(row.content.is_none(), "密匣条目的明文列必须为空");
        assert_eq!(row.cipher.unwrap().text, "会议密文内容");

        // 用密文里出现过的词去搜，必须搜不到。
        let hits = search::search(&conn, "会议", false, 20).await.unwrap();
        assert!(hits.is_empty(), "密匣内容不该出现在搜索结果里");

        let mut rows = conn
            .query("SELECT count(*) FROM fragments_fts", ())
            .await
            .unwrap();
        let indexed: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
        assert_eq!(indexed, 0, "密匣条目不该在 FTS 表里留下任何行");
    }

    /// 安全关键：schema 层必须拒绝「既是密匣又带明文」的行，
    /// 不依赖调用方自觉。
    #[tokio::test]
    async fn schema_rejects_lockbox_row_carrying_plaintext() {
        let conn = open_test_conn().await;
        let result = conn
            .execute(
                "INSERT INTO fragments
                 (id, content, content_hash, created_at, updated_at, updated_at_ms,
                  lockbox, cipher_text)
                 VALUES ('bad', '明文', 'h', 't', 't', 0, 1, 'cipher')",
                (),
            )
            .await;
        assert!(result.is_err(), "CHECK 约束应拒绝密匣行携带明文");
    }

    /// 从明文转成密匣后，旧明文必须同时从索引里消失。
    #[tokio::test]
    async fn converting_to_lockbox_purges_old_plaintext_from_index() {
        let conn = open_test_conn().await;
        repo::upsert(&conn, &note("f1", "会议记录明文", &[])).await.unwrap();
        assert_eq!(search::search(&conn, "会议", false, 20).await.unwrap().len(), 1);

        repo::upsert(&conn, &lockbox_note("f1", "已加密")).await.unwrap();
        let hits = search::search(&conn, "会议", false, 20).await.unwrap();
        assert!(hits.is_empty(), "转入密匣后旧明文必须从索引中清除");
    }

    #[tokio::test]
    async fn soft_delete_hides_row_and_purges_index() {
        let conn = open_test_conn().await;
        repo::upsert(&conn, &note("f1", "会议纪要", &[])).await.unwrap();

        repo::soft_delete(&conn, "f1", "2026-07-26T11:00:00+08:00", "dev-a")
            .await
            .unwrap();

        assert!(repo::get(&conn, "f1").await.unwrap().is_none());
        assert!(search::search(&conn, "会议", false, 20).await.unwrap().is_empty());
        assert_eq!(repo::count(&conn, true).await.unwrap(), 0);

        // 但物理行仍在——墓碑不能被真删，否则离线设备会把它推回来。
        let mut rows = conn
            .query("SELECT count(*) FROM fragments WHERE deleted_at IS NOT NULL", ())
            .await
            .unwrap();
        let tombstones: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
        assert_eq!(tombstones, 1, "软删除必须留下墓碑");
    }

    #[tokio::test]
    async fn count_and_search_respect_archived_flag() {
        let conn = open_test_conn().await;
        let mut archived = note("f1", "归档的会议记录", &[]);
        archived.archived = true;
        repo::upsert(&conn, &archived).await.unwrap();

        assert_eq!(repo::count(&conn, false).await.unwrap(), 0);
        assert_eq!(repo::count(&conn, true).await.unwrap(), 1);
        assert!(search::search(&conn, "会议", false, 20).await.unwrap().is_empty());
        assert_eq!(search::search(&conn, "会议", true, 20).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn rebuild_reconstructs_index_from_scratch() {
        let conn = open_test_conn().await;
        repo::upsert(&conn, &note("f1", "会议一", &["x"])).await.unwrap();
        repo::upsert(&conn, &note("f2", "会议二", &[])).await.unwrap();
        repo::upsert(&conn, &lockbox_note("f3", "密文")).await.unwrap();

        let count = search::rebuild(&conn).await.unwrap();
        assert_eq!(count, 2, "只应重建明文条目");

        let hits = search::search(&conn, "会议", false, 20).await.unwrap();
        assert_eq!(hits.len(), 2);
    }

    /// 新建走 `expected_revision = None`，起始 revision 为 1。
    #[tokio::test]
    async fn write_creates_at_revision_one() {
        let conn = open_test_conn().await;
        let revision = repo::write(&conn, &note("f1", "新建", &["a"]), None, "dev-a")
            .await
            .unwrap();

        assert_eq!(revision, 1);
        assert_eq!(repo::get(&conn, "f1").await.unwrap().unwrap().revision, 1);
    }

    /// 新建撞上已存在的 id 必须是冲突，**不能**静默覆盖——多端并发下
    /// 静默覆盖就是丢数据。
    #[tokio::test]
    async fn write_rejects_duplicate_create() {
        let conn = open_test_conn().await;
        repo::write(&conn, &note("f1", "先来的", &[]), None, "dev-a")
            .await
            .unwrap();

        let result = repo::write(&conn, &note("f1", "后到的", &[]), None, "dev-b").await;
        assert!(matches!(result, Err(repo::WriteError::Conflict)));
        assert_eq!(
            repo::get(&conn, "f1").await.unwrap().unwrap().content.as_deref(),
            Some("先来的"),
            "先写的那一版必须原封不动"
        );
    }

    #[tokio::test]
    async fn write_advances_revision_with_matching_cas() {
        let conn = open_test_conn().await;
        repo::write(&conn, &note("f1", "第一版", &[]), None, "dev-a")
            .await
            .unwrap();

        let revision = repo::write(&conn, &note("f1", "第二版", &[]), Some(1), "dev-a")
            .await
            .unwrap();
        assert_eq!(revision, 2);

        let row = repo::get(&conn, "f1").await.unwrap().unwrap();
        assert_eq!(row.content.as_deref(), Some("第二版"));
    }

    /// 拿着过期的 revision 去写必须失败，且不留下任何痕迹。
    #[tokio::test]
    async fn write_rejects_stale_revision() {
        let conn = open_test_conn().await;
        repo::write(&conn, &note("f1", "第一版", &[]), None, "dev-a")
            .await
            .unwrap();
        repo::write(&conn, &note("f1", "第二版", &[]), Some(1), "dev-a")
            .await
            .unwrap();

        // dev-b 手里还是 revision 1。
        let result = repo::write(&conn, &note("f1", "基于旧版", &[]), Some(1), "dev-b").await;
        assert!(matches!(result, Err(repo::WriteError::Conflict)));

        let row = repo::get(&conn, "f1").await.unwrap().unwrap();
        assert_eq!(row.content.as_deref(), Some("第二版"));
        assert_eq!(row.revision, 2, "冲突不该推进 revision");
    }

    /// 软删除的行不该还能被 CAS 写活。
    #[tokio::test]
    async fn write_cannot_resurrect_a_tombstone() {
        let conn = open_test_conn().await;
        repo::write(&conn, &note("f1", "内容", &[]), None, "dev-a")
            .await
            .unwrap();
        repo::soft_delete(&conn, "f1", "2026-07-26T11:00:00+08:00", "dev-a")
            .await
            .unwrap();

        let result = repo::write(&conn, &note("f1", "复活", &[]), Some(2), "dev-a").await;
        assert!(matches!(result, Err(repo::WriteError::Conflict)));
    }

    /// 归档时间只记第一次。此后改标签、改正文都不该把它刷成"刚刚"。
    #[tokio::test]
    async fn archived_at_records_first_archive_only() {
        let conn = open_test_conn().await;
        repo::write(&conn, &note("f1", "内容", &[]), None, "dev-a")
            .await
            .unwrap();

        let mut archived = note("f1", "内容", &[]);
        archived.archived = true;
        archived.updated_at = "2026-07-26T12:00:00+08:00".into();
        repo::write(&conn, &archived, Some(1), "dev-a").await.unwrap();
        let first = archived_at(&conn, "f1").await;

        let mut edited = archived.clone();
        edited.updated_at = "2026-07-27T09:00:00+08:00".into();
        repo::write(&conn, &edited, Some(2), "dev-a").await.unwrap();
        assert_eq!(archived_at(&conn, "f1").await, first, "归档时间不该被后续编辑刷新");

        // 取消归档要清空，再次归档才重新记时间。
        let mut restored = edited.clone();
        restored.archived = false;
        repo::write(&conn, &restored, Some(3), "dev-a").await.unwrap();
        assert!(archived_at(&conn, "f1").await.is_none());
    }

    async fn archived_at(conn: &Connection, id: &str) -> Option<String> {
        let mut rows = conn
            .query(
                "SELECT archived_at FROM fragments WHERE id = ?1",
                libsql::params![id],
            )
            .await
            .unwrap();
        rows.next().await.unwrap().unwrap().get(0).unwrap()
    }

    /// 安全关键：一条笔记转入密匣后，库里绝不能残留明文。
    ///
    /// 文件时代这是「删明文文件 + 写密匣文件」两步，中间明文同时存在于两处；
    /// 现在是同一行的一次 CAS UPDATE，明文列与索引在同一个事务里被清空。
    #[tokio::test]
    async fn converting_to_lockbox_leaves_no_plaintext_behind() {
        let conn = open_test_conn().await;
        repo::write(&conn, &note("f1", "会议室密码是 1234", &["x"]), None, "dev-a")
            .await
            .unwrap();
        assert_eq!(
            search::search(&conn, "会议", false, 20).await.unwrap().len(),
            1,
            "前置条件：明文此时应可搜到"
        );

        repo::write(&conn, &lockbox_note("f1", "ENCRYPTED"), Some(1), "dev-a")
            .await
            .unwrap();

        let row = repo::get(&conn, "f1").await.unwrap().unwrap();
        assert!(row.lockbox);
        assert!(row.content.is_none(), "明文列必须为空");
        assert_eq!(row.cipher.unwrap().text, "ENCRYPTED");
        assert!(row.tags.is_empty(), "密匣的标签留在密文里，不该落在明文标签表");

        assert!(
            search::search(&conn, "会议", false, 20).await.unwrap().is_empty(),
            "旧明文必须已从索引中消失"
        );
        let mut rows = conn
            .query("SELECT count(*) FROM fragments_fts", ())
            .await
            .unwrap();
        let indexed: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
        assert_eq!(indexed, 0, "FTS 表里不该留下任何行");
    }

    /// 设备标识生成一次之后必须固定：它会写进每一行的 updated_by_device，
    /// 每次启动都变的话冲突诊断就没有线索了。
    #[tokio::test]
    async fn device_id_is_stable_once_generated() {
        let conn = open_test_conn().await;
        let first = repo::device_id(&conn).await.unwrap();
        let second = repo::device_id(&conn).await.unwrap();

        assert_eq!(first, second);
        assert_eq!(first.len(), 16, "16 位十六进制，64 bit 熵");
    }

    #[tokio::test]
    async fn meta_round_trips() {
        let conn = open_test_conn().await;
        assert!(repo::get_meta(&conn, "owner").await.unwrap().is_none());
        repo::set_meta(&conn, "owner", "notes").await.unwrap();
        repo::set_meta(&conn, "owner", "notes-v2").await.unwrap();
        assert_eq!(
            repo::get_meta(&conn, "owner").await.unwrap().as_deref(),
            Some("notes-v2")
        );
    }
}
