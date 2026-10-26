//! 例行维护：修订保留策略（90 天后每天留一条）与 blob 回收（未引用满 35 天才删）。

use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, TimeZone, Utc};
use shard_store::{sha256_hex, Store, StoreError, Vfs, WriteCtx, INLINE_MAX};

fn open() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_with_root(dir.path(), Path::new("/vault")).unwrap();
    (dir, store)
}

fn p(rel: &str) -> PathBuf {
    Path::new("/vault").join(rel)
}

fn base() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 1, 10, 8, 0, 0).unwrap()
}

/// 同一设备、间隔超过 5 分钟的编辑各算一条修订。
fn edit(store: &Store, at: DateTime<Utc>, bytes: &[u8]) {
    let ctx = WriteCtx::new("test", "test").with_device("mac").with_now(at);
    store.write(&ctx, |vfs| vfs.write(&p("a.md"), bytes).map_err(StoreError::from)).unwrap();
}

fn revision_times(store: &Store) -> Vec<String> {
    let (_, revisions) = store.list_revisions("a.md").unwrap().unwrap();
    revisions.into_iter().map(|rev| rev.created_at).collect()
}

#[test]
fn old_revisions_keep_one_per_day_and_recent_ones_are_untouched() {
    let (_dir, store) = open();
    // 第 1 天三条、第 2 天两条（都在 90 天前），最近两条。
    let day1 = base();
    let day2 = base() + Duration::days(1);
    let now = base() + Duration::days(120);
    for (index, at) in [day1, day1 + Duration::hours(1), day1 + Duration::hours(2), day2, day2 + Duration::hours(3)]
        .into_iter()
        .enumerate()
    {
        edit(&store, at, format!("old {index}").as_bytes());
    }
    let recent = now - Duration::days(1);
    edit(&store, recent, b"recent 1");
    edit(&store, recent + Duration::hours(1), b"recent 2");
    assert_eq!(revision_times(&store).len(), 7);

    let report = store.compact_revisions(now).unwrap();
    assert_eq!(report.revisions_dropped, 3);
    let kept = revision_times(&store);
    assert_eq!(kept.len(), 4);
    // 每天留最后一条；最近的全留。
    assert!(kept.contains(&"2026-01-10T10:00:00.000000Z".to_string()));
    assert!(kept.contains(&"2026-01-11T11:00:00.000000Z".to_string()));
    assert_eq!(kept.iter().filter(|time| time.starts_with("2026-05-09")).count(), 2);
    // 再跑一次什么也不变。
    assert_eq!(store.compact_revisions(now).unwrap().revisions_dropped, 0);
}

#[test]
fn the_latest_revision_survives_even_when_old() {
    let (_dir, store) = open();
    edit(&store, base(), b"only");
    store.compact_revisions(base() + Duration::days(400)).unwrap();
    assert_eq!(revision_times(&store).len(), 1);
}

#[test]
fn unreferenced_blobs_are_deleted_only_after_the_grace_period() {
    let (_dir, store) = open();
    let orphan = vec![1u8; INLINE_MAX + 1];
    let orphan_sha = sha256_hex(&orphan);
    store.put_blob(&orphan_sha, &orphan).unwrap();
    let used = vec![2u8; INLINE_MAX + 1];
    edit(&store, base(), &used);

    let first = store.collect_blobs(base()).unwrap();
    assert_eq!((first.blobs_marked, first.blobs_deleted), (1, 0));
    assert_eq!(store.collect_blobs(base() + Duration::days(34)).unwrap().blobs_deleted, 0);
    assert!(store.has_blob(&orphan_sha).unwrap());
    let due = store.collect_blobs(base() + Duration::days(36)).unwrap();
    assert_eq!(due.blobs_deleted, 1);
    assert!(!store.has_blob(&orphan_sha).unwrap());
    assert!(store.has_blob(&sha256_hex(&used)).unwrap(), "被引用的 blob 不动");
    assert!(store.verify().unwrap().missing_blobs.is_empty());
}

#[test]
fn a_blob_referenced_again_loses_its_mark() {
    let (_dir, store) = open();
    let bytes = vec![3u8; INLINE_MAX + 1];
    let sha = sha256_hex(&bytes);
    store.put_blob(&sha, &bytes).unwrap();
    assert_eq!(store.collect_blobs(base()).unwrap().blobs_marked, 1);
    // 之后有条目引用了它（同样的字节写进库）。
    edit(&store, base() + Duration::days(1), &bytes);
    store.collect_blobs(base() + Duration::days(2)).unwrap();
    assert_eq!(store.collect_blobs(base() + Duration::days(100)).unwrap().blobs_deleted, 0);
    assert!(store.has_blob(&sha).unwrap());
}
