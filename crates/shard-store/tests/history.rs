//! 版本历史：列出与读取修订、彻底删除后找回、立即抹除（库文件与 WAL 里不留原文）、到期清理。

use std::path::{Path, PathBuf};

use chrono::{Duration, TimeZone, Utc};
use shard_store::{sha256_hex, Store, StoreError, Vfs, WriteCtx, INLINE_MAX};

fn open() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_with_root(dir.path(), Path::new("/vault")).unwrap();
    (dir, store)
}

fn p(rel: &str) -> PathBuf {
    Path::new("/vault").join(rel)
}

fn ctx(device: &str, minute: i64) -> WriteCtx {
    let base = Utc.with_ymd_and_hms(2026, 10, 26, 9, 0, 0).unwrap();
    WriteCtx::new("test", "test").with_device(device).with_now(base + Duration::minutes(minute))
}

fn write(store: &Store, ctx: &WriteCtx, f: impl FnOnce(&shard_store::SqliteVfs<'_>) -> std::io::Result<()>) {
    store.write(ctx, |vfs| f(vfs).map_err(StoreError::from)).expect("写入成功");
}

fn reasons(store: &Store, path: &str) -> Vec<String> {
    store.list_revisions(path).unwrap().unwrap().1.into_iter().map(|rev| rev.reason).collect()
}

#[test]
fn revisions_are_listed_newest_first_and_read_back_byte_for_byte() {
    let (_dir, store) = open();
    let big: Vec<u8> = (0..INLINE_MAX + 10).map(|i| (i % 253) as u8).collect();
    write(&store, &ctx("mac", 0), |vfs| {
        vfs.create_dir_all(&p("notes"))?;
        vfs.write(&p("notes/a.md"), b"v1")?;
        vfs.write(&p("big.bin"), &big)
    });
    // 换设备才不合并。
    write(&store, &ctx("phone", 1), |vfs| vfs.write(&p("notes/a.md"), b"v2 longer"));
    write(&store, &ctx("phone", 2), |vfs| vfs.rename(&p("notes/a.md"), &p("notes/b.md")));

    assert!(store.list_revisions("notes/a.md").unwrap().is_none(), "旧路径已经没有条目");
    let (node_id, revisions) = store.list_revisions("NOTES/B.md").unwrap().unwrap();
    assert_eq!(revisions.iter().map(|rev| rev.reason.as_str()).collect::<Vec<_>>(), ["rename", "edit", "create"]);
    assert!(revisions.iter().all(|rev| rev.node_id == node_id));
    let edit = &revisions[1];
    assert_eq!(edit.path, "notes/a.md");
    assert_eq!(edit.size, Some(9));
    assert_eq!(edit.device.as_deref(), Some("phone"));
    let (info, bytes) = store.read_revision(edit.rev_id).unwrap().unwrap();
    assert_eq!(&info, edit);
    assert_eq!(bytes, b"v2 longer");
    assert_eq!(info.sha.as_deref(), Some(sha256_hex(b"v2 longer").as_str()));

    let (_, big_revisions) = store.list_revisions("big.bin").unwrap().unwrap();
    assert_eq!(big_revisions[0].size, Some(big.len() as i64));
    assert_eq!(store.read_revision(big_revisions[0].rev_id).unwrap().unwrap().1, big);
    assert!(store.read_revision(999_999).unwrap().is_none());
}

#[test]
fn purged_files_can_be_revived_with_their_history() {
    let (_dir, store) = open();
    write(&store, &ctx("mac", 0), |vfs| {
        vfs.create_dir_all(&p("notes"))?;
        vfs.write(&p("notes/a.md"), b"first")
    });
    write(&store, &ctx("phone", 1), |vfs| vfs.write(&p("notes/a.md"), b"second"));
    write(&store, &ctx("mac", 2), |vfs| {
        vfs.create_dir_all(&p(".trash/notes"))?;
        vfs.rename(&p("notes/a.md"), &p(".trash/notes/a.md"))
    });
    write(&store, &ctx("mac", 3), |vfs| vfs.remove_file(&p(".trash/notes/a.md")));

    let deleted = store.list_deleted().unwrap();
    assert_eq!(deleted.len(), 1);
    let entry = &deleted[0];
    assert_eq!(entry.path, ".trash/notes/a.md");
    assert_eq!(entry.sha.as_deref(), Some(sha256_hex(b"second").as_str()));
    assert_eq!(entry.revisions, 4);
    assert_eq!(store.read_revision(entry.rev_id).unwrap().unwrap().1, b"second");
    assert_eq!(entry.purged_at, "2026-10-26T09:03:00.000000Z");
    assert_eq!(entry.expires_at, "2026-11-25T09:03:00.000000Z");
    let history = store.list_node_revisions(entry.node_id).unwrap();
    assert_eq!(history.iter().map(|rev| rev.reason.as_str()).collect::<Vec<_>>(), ["purge", "trash", "edit", "create"]);
    assert_eq!(history[0].sha, None);
    let first = history[3].rev_id;

    // 恢复最早的版本到原位置：沿用原节点。
    let mut revert = ctx("mac", 4);
    revert.revision_reason = Some("revert");
    write(&store, &revert, |vfs| {
        let (_, bytes) = vfs.revision(first)?.unwrap();
        assert_eq!(vfs.node_path(entry.node_id)?, None);
        vfs.revive(entry.node_id, &p("notes/a.md"), &bytes)
    });
    assert_eq!(store.read(|vfs| vfs.read(&p("notes/a.md")).unwrap()).unwrap(), b"first");
    let (node_id, _) = store.list_revisions("notes/a.md").unwrap().unwrap();
    assert_eq!(node_id, entry.node_id);
    assert_eq!(reasons(&store, "notes/a.md"), ["revert", "purge", "trash", "edit", "create"]);
    assert!(store.list_deleted().unwrap().is_empty());

    // 目标被占、条目不是墓碑：都拒绝。
    let occupied = store.write(&ctx("mac", 5), |vfs| {
        vfs.revive(entry.node_id, &p("notes/a.md"), b"x").map_err(StoreError::from)
    });
    assert!(occupied.is_err());
}

fn file_bytes(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap_or_default()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

#[test]
fn erasing_purged_history_leaves_no_plaintext_in_the_databases() {
    let (dir, store) = open();
    const CANARY: &str = "CANARY-7f3a-抹除测试";
    let big = format!("{CANARY}\n{}", "x".repeat(INLINE_MAX + 100)).into_bytes();
    let note = format!("# {CANARY}\n\n正文 {CANARY}\n");
    write(&store, &ctx("mac", 0), |vfs| {
        vfs.create_dir_all(&p("notes"))?;
        vfs.write(&p("notes/keep.md"), b"unrelated")?;
        vfs.write(&p("notes/secret.md"), note.as_bytes())?;
        vfs.write(&p("notes/secret.bin"), &big)
    });
    // 成功响应带着正文：幂等记录里也有一份。
    store
        .write_recorded(
            &ctx("phone", 1).with_op_id("op-canary"),
            |vfs| {
                vfs.write(&p("notes/secret.md"), format!("{note}再改一次 {CANARY}\n").as_bytes())?;
                Ok::<_, StoreError>(CANARY.to_string())
            },
            |value| value.as_bytes().to_vec(),
        )
        .unwrap();
    write(&store, &ctx("mac", 2), |vfs| {
        vfs.remove_file(&p("notes/secret.md"))?;
        vfs.remove_file(&p("notes/secret.bin"))
    });
    let deleted = store.list_deleted().unwrap();
    assert_eq!(deleted.len(), 2);

    let present = ["shard.db", "shard.db-wal", "blobs.db", "blobs.db-wal"]
        .iter()
        .filter(|name| contains(&file_bytes(&dir.path().join(name)), CANARY.as_bytes()))
        .count();
    assert!(present >= 2, "抹除前内容库与 blob 库里都应该有原文");

    // 在用的条目不能抹。
    let (live, _) = store.list_revisions("notes/keep.md").unwrap().unwrap();
    assert!(store.erase_purged(&[live]).is_err());

    let report = store.erase_purged(&deleted.iter().map(|entry| entry.node_id).collect::<Vec<_>>()).unwrap();
    assert_eq!(report.nodes, 2);
    assert_eq!(report.revisions, 5);
    assert_eq!(report.blobs, 1);
    assert!(report.wal_truncated);
    assert!(store.list_deleted().unwrap().is_empty());
    assert!(store.list_node_revisions(deleted[0].node_id).unwrap().is_empty());
    assert!(!store.has_blob(&sha256_hex(&big)).unwrap());
    assert_eq!(store.find_txn("op-canary").unwrap().unwrap().response, None);
    assert!(store.verify().unwrap().missing_blobs.is_empty());

    for name in ["shard.db", "shard.db-wal", "blobs.db", "blobs.db-wal"] {
        let bytes = file_bytes(&dir.path().join(name));
        assert!(!contains(&bytes, CANARY.as_bytes()), "{name} 里还有原文");
    }
    // 变化日志里的路径（常含标题）也抹掉，保留下限推进：游标更早的客户端改走全量对账。
    for name in ["shard.db", "shard.db-wal"] {
        assert!(!contains(&file_bytes(&dir.path().join(name)), b"notes/secret"), "{name} 里还有路径");
    }
    let page = store.changes_since(0, 10).unwrap();
    assert!(page.floor_seq >= page.head_seq && page.head_seq > 0);
    // 不相干的条目不受影响。
    assert_eq!(store.read(|vfs| vfs.read(&p("notes/keep.md")).unwrap()).unwrap(), b"unrelated");
}

#[test]
fn purged_history_expires_after_thirty_days() {
    let (_dir, store) = open();
    write(&store, &ctx("mac", 0), |vfs| vfs.write(&p("a.md"), b"a"));
    write(&store, &ctx("mac", 1), |vfs| vfs.remove_file(&p("a.md")));
    let purged_at = Utc.with_ymd_and_hms(2026, 10, 26, 9, 1, 0).unwrap();

    let early = store.expire_purged_history(purged_at + Duration::days(29)).unwrap();
    assert_eq!(early.nodes, 0);
    assert_eq!(store.list_deleted().unwrap().len(), 1);

    let due = store.expire_purged_history(purged_at + Duration::days(30) + Duration::seconds(1)).unwrap();
    assert_eq!(due.nodes, 1);
    assert!(store.list_deleted().unwrap().is_empty());
}
