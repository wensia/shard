//! 提交流水线：变化记录、修订合并、派生投影、幂等键、大文件与只读快照。

use std::path::{Path, PathBuf};

use chrono::{Duration, TimeZone, Utc};
use rusqlite::Connection;
use shard_store::{sha256_hex, Store, StoreError, Vfs, WriteCtx, INLINE_MAX};

fn open() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_with_root(dir.path(), Path::new("/vault")).unwrap();
    (dir, store)
}

fn p(rel: &str) -> PathBuf {
    Path::new("/vault").join(rel)
}

fn ctx() -> WriteCtx {
    WriteCtx::new("test", "test").with_device("mac")
}

fn write(store: &Store, ctx: &WriteCtx, f: impl FnOnce(&shard_store::SqliteVfs<'_>) -> std::io::Result<()>) -> shard_store::Committed {
    let (_, committed) = store
        .write(ctx, |vfs| f(vfs).map_err(StoreError::from))
        .expect("写入成功");
    committed
}

fn db(dir: &tempfile::TempDir) -> Connection {
    Connection::open(dir.path().join("shard.db")).unwrap()
}

fn note(id: &str, tags: &[&str], body: &str) -> String {
    let tags = tags.iter().map(|tag| format!("- {tag}\n")).collect::<String>();
    format!(
        "---\nid: {id}\ncreated_at: 2026-10-26T10:00:00+08:00\nupdated_at: 2026-10-26T10:00:00+08:00\ntags:\n{tags}category: null\nai_status: none\nsource: desktop\n---\n\n{body}"
    )
}

#[test]
fn changes_describe_creates_edits_renames_and_deletes() {
    let (_dir, store) = open();
    let created = write(&store, &ctx(), |vfs| {
        vfs.create_dir_all(&p("notes/读书"))?;
        vfs.write(&p("notes/读书/a.md"), b"one")
    });
    let paths: Vec<_> = created.changes.iter().map(|c| (c.path.as_str(), c.exists, c.kind.as_str())).collect();
    assert_eq!(
        paths,
        vec![("notes", true, "dir"), ("notes/读书", true, "dir"), ("notes/读书/a.md", true, "file")]
    );
    assert_eq!(created.changes[2].sha.as_deref(), Some(sha256_hex(b"one").as_str()));

    // 写入相同字节：没有变化。
    let same = write(&store, &ctx(), |vfs| vfs.write(&p("notes/读书/a.md"), b"one"));
    assert!(same.changes.is_empty());

    // 目录改名：目录与后代都写「旧路径消失、新路径出现」。
    let renamed = write(&store, &ctx(), |vfs| vfs.rename(&p("notes/读书"), &p("notes/书单")));
    let paths: Vec<_> = renamed.changes.iter().map(|c| (c.path.as_str(), c.exists)).collect();
    assert_eq!(
        paths,
        vec![
            ("notes/读书", false),
            ("notes/书单", true),
            ("notes/读书/a.md", false),
            ("notes/书单/a.md", true)
        ]
    );

    let removed = write(&store, &ctx(), |vfs| vfs.remove_file(&p("notes/书单/a.md")));
    assert_eq!(removed.changes.len(), 1);
    assert!(!removed.changes[0].exists);

    // seq 跨事务严格递增，增量拉取能分页取全。
    let page = store.changes_since(0, 3).unwrap();
    assert_eq!(page.changes.len(), 3);
    assert!(page.more);
    let rest = store.changes_since(page.changes.last().unwrap().seq, 100).unwrap();
    assert!(!rest.more);
    let all: Vec<i64> = page.changes.iter().chain(rest.changes.iter()).map(|c| c.seq).collect();
    assert!(all.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(*all.last().unwrap(), store.head_seq().unwrap());
}

#[test]
fn failed_commands_leave_no_trace() {
    let (dir, store) = open();
    let result: Result<((), _), StoreError> = store.write(&ctx(), |vfs| {
        vfs.create_dir_all(&p("notes"))?;
        vfs.write(&p("notes/a.md"), b"x")?;
        Err(StoreError::Invalid("领域校验失败".to_string()))
    });
    assert!(result.is_err());
    assert!(!store.read(|vfs| vfs.exists(&p("notes"))).unwrap());
    let conn = db(&dir);
    let txns: i64 = conn.query_row("SELECT COUNT(*) FROM txns", [], |r| r.get(0)).unwrap();
    let changes: i64 = conn.query_row("SELECT COUNT(*) FROM changes", [], |r| r.get(0)).unwrap();
    assert_eq!((txns, changes), (0, 0));
}

#[test]
fn edits_from_one_device_merge_within_five_minutes() {
    let (dir, store) = open();
    let t0 = Utc.with_ymd_and_hms(2026, 10, 26, 2, 0, 0).unwrap();
    write(&store, &ctx().with_now(t0), |vfs| {
        vfs.create_dir_all(&p("notes"))?;
        vfs.write(&p("notes/a.md"), b"v1")
    });
    for (minutes, body) in [(1, "v2"), (2, "v3"), (4, "v4")] {
        write(&store, &ctx().with_now(t0 + Duration::minutes(minutes)), |vfs| {
            vfs.write(&p("notes/a.md"), body.as_bytes())
        });
    }
    // 另一台设备的编辑不合并。
    write(&store, &WriteCtx::new("test", "test").with_device("phone").with_now(t0 + Duration::minutes(4)), |vfs| {
        vfs.write(&p("notes/a.md"), b"v5")
    });
    // 超出窗口另起一条。
    write(&store, &ctx().with_now(t0 + Duration::minutes(20)), |vfs| vfs.write(&p("notes/a.md"), b"v6"));
    write(&store, &ctx().with_now(t0 + Duration::minutes(21)), |vfs| {
        vfs.rename(&p("notes/a.md"), &p("notes/b.md"))
    });

    let conn = db(&dir);
    let mut statement = conn
        .prepare("SELECT reason, inline, sealed FROM revisions ORDER BY rev_id")
        .unwrap();
    let rows: Vec<(String, Vec<u8>, i64)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let summary: Vec<(&str, &str, i64)> = rows
        .iter()
        .map(|(reason, inline, sealed)| (reason.as_str(), std::str::from_utf8(inline).unwrap(), *sealed))
        .collect();
    assert_eq!(
        summary,
        vec![
            ("create", "v1", 1),
            ("edit", "v4", 1), // v2..v4 合并成一条
            ("edit", "v5", 1),
            ("edit", "v6", 1),
            ("rename", "v6", 1),
        ]
    );
}

#[test]
fn projections_follow_the_content_and_disappear_on_delete() {
    let (dir, store) = open();
    let text = note("20261026-100000-aaaa0000-000001", &["inbox", "note", "读书"], "# 晚上\n\n![](assets/ab/x.png)\n");
    write(&store, &ctx(), |vfs| {
        vfs.create_dir_all(&p("notes"))?;
        vfs.write(&p("notes/晚上.md"), text.as_bytes())
    });
    let conn = db(&dir);
    let (doc_id, title, type_tag, scope): (String, String, String, i64) = conn
        .query_row(
            "SELECT doc_id, title, type_tag, lookup_scope FROM doc_index",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        (doc_id.as_str(), title.as_str(), type_tag.as_str(), scope),
        ("20261026-100000-aaaa0000-000001", "晚上", "note", 1)
    );
    let tags: i64 = conn.query_row("SELECT COUNT(*) FROM doc_tags", [], |r| r.get(0)).unwrap();
    assert_eq!(tags, 3);
    let image: String = conn
        .query_row("SELECT target FROM doc_links WHERE link_kind = 'image'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(image, "assets/ab/x.png");

    // 进回收站后不再落在 notes 的查找范围里；彻底删除后投影消失。
    write(&store, &ctx(), |vfs| {
        vfs.create_dir_all(&p(".trash/notes"))?;
        vfs.rename(&p("notes/晚上.md"), &p(".trash/notes/晚上.md"))
    });
    let scope: i64 = conn.query_row("SELECT lookup_scope FROM doc_index", [], |r| r.get(0)).unwrap();
    assert_eq!(scope, 0);
    write(&store, &ctx(), |vfs| vfs.remove_file(&p(".trash/notes/晚上.md")));
    let docs: i64 = conn.query_row("SELECT COUNT(*) FROM doc_index", [], |r| r.get(0)).unwrap();
    assert_eq!(docs, 0);
    // 墓碑保留，供同步与修订使用。
    let tombstones: i64 = conn
        .query_row("SELECT COUNT(*) FROM nodes WHERE purged_at IS NOT NULL", [], |r| r.get(0))
        .unwrap();
    assert_eq!(tombstones, 1);
}

#[test]
fn an_op_id_commits_once_and_keeps_its_response() {
    let (_dir, store) = open();
    let ctx = ctx().with_op_id("op-1");
    let (value, _) = store
        .write_recorded(
            &ctx,
            |vfs| {
                vfs.write(&p("a.md"), b"x").map_err(StoreError::from)?;
                Ok::<_, StoreError>(42)
            },
            |value| value.to_string().into_bytes(),
        )
        .unwrap();
    assert_eq!(value, 42);
    let again: Result<((), _), StoreError> = store.write(&ctx, |vfs| vfs.write(&p("b.md"), b"y").map_err(StoreError::from));
    assert!(matches!(again, Err(StoreError::DuplicateOp(_))));
    assert!(!store.read(|vfs| vfs.exists(&p("b.md"))).unwrap(), "重复的操作整体回滚");
    let record = store.find_txn("op-1").unwrap().unwrap();
    assert_eq!(record.response.as_deref(), Some(b"42".as_slice()));
}

#[test]
fn large_files_go_to_the_blob_store() {
    let (dir, store) = open();
    let big = vec![7u8; INLINE_MAX + 1];
    write(&store, &ctx(), |vfs| vfs.write(&p("big.png"), &big));
    let back = store.read(|vfs| vfs.read(&p("big.png")).unwrap()).unwrap();
    assert_eq!(back, big);
    assert_eq!(store.read(|vfs| vfs.content_sha(&p("big.png")).unwrap()).unwrap(), sha256_hex(&big));
    let inline: Option<Vec<u8>> = db(&dir)
        .query_row("SELECT inline FROM nodes WHERE path = 'big.png'", [], |r| r.get(0))
        .unwrap();
    assert!(inline.is_none());
    assert!(store.has_blob(&sha256_hex(&big)).unwrap());
    assert!(store.put_blob("0000", b"x").is_err(), "哈希不符的上传被拒");
}

#[test]
fn read_head_returns_prefixes_of_inline_and_blob_contents() {
    let (_dir, store) = open();
    let big: Vec<u8> = (0..INLINE_MAX + 4096).map(|i| (i % 251) as u8).collect();
    write(&store, &ctx(), |vfs| {
        vfs.create_dir_all(&p("notes"))?;
        vfs.write(&p("notes/a.md"), "开头一段正文".as_bytes())?;
        vfs.write(&p("notes/empty.md"), b"")?;
        vfs.write(&p("big.png"), &big)?;
        // 写事务里读得到本事务刚写的内容。
        assert_eq!(vfs.read_head(&p("notes/a.md"), 6)?, "开头".as_bytes());
        Ok(())
    });
    store
        .read(|vfs| {
            let small = "开头一段正文".as_bytes();
            for limit in [0, 1, 6, small.len() as u64, 1 << 40, u64::MAX] {
                let expected = &small[..small.len().min(limit as usize)];
                assert_eq!(vfs.read_head(&p("notes/a.md"), limit).unwrap(), expected, "inline limit={limit}");
            }
            for limit in [0, 8, 64 * 1024, big.len() as u64, u64::MAX] {
                let expected = &big[..big.len().min(limit as usize)];
                assert_eq!(vfs.read_head(&p("big.png"), limit).unwrap(), expected, "blob limit={limit}");
            }
            assert!(vfs.read_head(&p("notes/empty.md"), 16).unwrap().is_empty());
            let dir = vfs.read_head(&p("notes"), 16).unwrap_err();
            assert_eq!(dir.kind(), std::io::ErrorKind::IsADirectory);
            let missing = vfs.read_head(&p("notes/none.md"), 16).unwrap_err();
            assert_eq!(missing.kind(), std::io::ErrorKind::NotFound);
        })
        .unwrap();
}

#[test]
fn paths_are_case_and_normalization_insensitive_like_apfs() {
    let (_dir, store) = open();
    write(&store, &ctx(), |vfs| {
        vfs.create_dir_all(&p("notes"))?;
        vfs.write(&p("notes/Cafe\u{301}.md"), b"one")
    });
    store
        .read(|vfs| {
            assert!(vfs.exists(&p("NOTES/café.md")));
            assert_eq!(vfs.read(&p("notes/CAFÉ.MD")).unwrap(), b"one");
        })
        .unwrap();
    // 换大小写写入：更新同一个条目，名字不变。
    write(&store, &ctx(), |vfs| vfs.write(&p("Notes/CAFÉ.md"), b"two"));
    let names = store
        .read(|vfs| {
            vfs.read_dir(&p("notes"))
                .unwrap()
                .iter()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        })
        .unwrap();
    assert_eq!(names, vec!["Cafe\u{301}.md"]);
    // 只改大小写的改名可以成功。
    write(&store, &ctx(), |vfs| vfs.rename(&p("notes/Cafe\u{301}.md"), &p("notes/CAFE\u{301}.md")));
    let names = store
        .read(|vfs| vfs.read_dir(&p("notes")).unwrap()[0].file_name().to_string_lossy().into_owned())
        .unwrap();
    assert_eq!(names, "CAFE\u{301}.md");
}

#[test]
fn read_snapshots_refuse_writes() {
    let (_dir, store) = open();
    let refused = store.read(|vfs| vfs.write(&p("a.md"), b"x").is_err()).unwrap();
    assert!(refused);
}

#[test]
fn partial_writes_are_kept_when_the_command_reports_a_conflict() {
    let (_dir, store) = open();
    let (result, committed) = store
        .write_keeping_partial(
            &ctx().with_op_id("conflict-1"),
            |vfs| {
                vfs.create_dir_all(&p("maps/.conflicts")).map_err(|error| error.to_string())?;
                vfs.write(&p("maps/.conflicts/a.json"), b"{}").map_err(|error| error.to_string())?;
                Err::<(), String>("导图已被外部修改，已另存冲突副本".to_string())
            },
            |result| format!("{result:?}").into_bytes(),
        )
        .unwrap();
    assert!(result.is_err());
    assert!(!committed.changes.is_empty(), "冲突副本必须留下");
    assert!(store.read(|vfs| vfs.exists(&p("maps/.conflicts/a.json"))).unwrap());
    let record = store.find_txn("conflict-1").unwrap().unwrap();
    assert!(String::from_utf8(record.response.unwrap()).unwrap().starts_with("Err("));
}
