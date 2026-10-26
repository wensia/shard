//! 时区与来源：服务器一般跑 UTC，碎片 id、`fragments/YYYY/MM` 与 frontmatter 时间必须按客户端时区算。

use chrono::{Duration, FixedOffset, Utc};
use shard_core::FsVfs;

use crate::{create_public_fragment, create_library_note_in_vault, NoHooks, VaultCtx};

#[test]
fn new_content_follows_the_callers_offset_and_source() {
    let dir = tempfile::tempdir().unwrap();
    let vfs = FsVfs::new(dir.path());
    shard_core::ensure_vault_layout(&vfs).unwrap();
    // +14:00 与 UTC 的日期几乎总是不同，能区分「按服务器时区」与「按客户端时区」。
    let offset = FixedOffset::east_opt(14 * 3600).unwrap();
    let cx = VaultCtx::local(&vfs, &NoHooks).with_clock(offset, "web");

    let before = Utc::now().with_timezone(&offset) - Duration::seconds(1);
    let fragment = create_public_fragment(&cx, "手机上记的一条", vec![]).unwrap();
    let after = Utc::now().with_timezone(&offset) + Duration::seconds(1);

    let id_time = chrono::NaiveDateTime::parse_from_str(&fragment.id[..15], "%Y%m%d-%H%M%S").unwrap();
    assert!(id_time >= before.naive_local() && id_time <= after.naive_local(), "id 时间 {id_time} 应按 +14:00 计算");
    assert_eq!(fragment.path, format!("fragments/{}/{}.md", id_time.format("%Y/%m"), fragment.id));
    assert!(fragment.created_at.ends_with("+14:00"), "{}", fragment.created_at);

    let note = create_library_note_in_vault(&cx, "笔记", None).unwrap();
    assert!(note.created_at.ends_with("+14:00"), "{}", note.created_at);
    let text = std::fs::read_to_string(dir.path().join(&note.path)).unwrap();
    assert!(text.contains("\nsource: web\n"), "来源应记为 web：{text}");
}
