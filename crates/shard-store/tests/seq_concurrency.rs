//! seq 必须在写事务内分配：多个写者并发提交时，一个按游标增量拉取的读者
//! 不能漏掉任何一条变化（如果某条较小的 seq 晚于较大的 seq 才提交，读者推进游标后就会永久错过它）。

use std::{
    collections::BTreeSet,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
};

use shard_store::{Store, StoreError, Vfs, WriteCtx};

#[test]
fn concurrent_writers_never_hide_a_seq_from_an_incremental_reader() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_with_root(dir.path(), Path::new("/vault")).unwrap());
    store
        .write(&WriteCtx::new("setup", "test"), |vfs| {
            vfs.create_dir_all(Path::new("/vault/fragments")).map_err(StoreError::from)
        })
        .unwrap();

    let done = Arc::new(AtomicBool::new(false));
    let reader = {
        let store = Arc::clone(&store);
        let done = Arc::clone(&done);
        thread::spawn(move || {
            let mut cursor = 0;
            let mut seen = BTreeSet::new();
            loop {
                let finished = done.load(Ordering::SeqCst);
                let page = store.changes_since(cursor, 50).unwrap();
                for change in &page.changes {
                    assert!(change.seq > cursor, "页内 seq 必须递增");
                    cursor = change.seq;
                    seen.insert(change.seq);
                }
                if finished && !page.more {
                    break seen;
                }
            }
        })
    };

    let writers: Vec<_> = (0..6)
        .map(|writer| {
            let store = Arc::clone(&store);
            thread::spawn(move || {
                for index in 0..60 {
                    let path = format!("/vault/fragments/w{writer}-{index}.md");
                    store
                        .write(&WriteCtx::new("create", "test"), |vfs| {
                            vfs.write(Path::new(&path), format!("{writer}-{index}").as_bytes())
                                .map_err(StoreError::from)
                        })
                        .unwrap();
                }
            })
        })
        .collect();
    for writer in writers {
        writer.join().unwrap();
    }
    done.store(true, Ordering::SeqCst);
    let seen = reader.join().unwrap();

    let all: BTreeSet<i64> = store
        .changes_since(0, 10_000)
        .unwrap()
        .changes
        .iter()
        .map(|change| change.seq)
        .collect();
    assert_eq!(all.len(), 1 + 6 * 60, "setup 建目录一条 + 每个写者 60 条");
    assert_eq!(seen, all, "增量读者看到的必须是全部变化");
}
