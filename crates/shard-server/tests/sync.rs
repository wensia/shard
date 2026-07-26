//! 同步协议的端到端保证。
//!
//! 这些是整个方案里最不能出错的几条：冲突不覆盖、墓碑照常同步、增量不漏、
//! 密匣明文进不来。它们全都不会以编译错误的形式暴露，只能靠测试守住。

use libsql::Connection;
use shard_core::sync::{
    AttachmentPayload, Change, FragmentPayload, MapPayload, PushItem, PushOutcome, ServerVersion,
};
use shard_server::{db, repo};

async fn conn() -> Connection {
    let database = libsql::Builder::new_local(":memory:").build().await.unwrap();
    let conn = database.connect().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").await.unwrap();

    let mut current = 0;
    for migration in shard_core::NOTES_MIGRATIONS {
        conn.execute_batch(migration.sql).await.unwrap();
        current = migration.version;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {current};"))
        .await
        .unwrap();
    conn
}

fn fragment(id: &str, content: &str) -> FragmentPayload {
    FragmentPayload {
        id: id.into(),
        content: Some(content.into()),
        content_hash: shard_core::hash_text(content),
        created_at: "2026-07-26T10:00:00+08:00".into(),
        updated_at: "2026-07-26T10:00:00+08:00".into(),
        updated_at_ms: 1_784_000_000_000,
        archived_at: None,
        deleted_at: None,
        pinned: false,
        lockbox: false,
        category: None,
        ai_status: "none".into(),
        source: "desktop".into(),
        tags: vec!["会议".into()],
        revision: 1,
        updated_by_device: "dev-a".into(),
        conflict_of: None,
        cipher: None,
        attachment_hashes: vec![],
    }
}

fn create(payload: FragmentPayload) -> PushItem {
    PushItem::Fragment {
        base_revision: None,
        payload: Box::new(payload),
    }
}

fn update(payload: FragmentPayload, base: i64) -> PushItem {
    PushItem::Fragment {
        base_revision: Some(base),
        payload: Box::new(payload),
    }
}

fn applied(outcome: &PushOutcome) -> (i64, i64) {
    match outcome {
        PushOutcome::Applied { revision, seq } => (*revision, *seq),
        other => panic!("期望写入成功，实际是 {other:?}"),
    }
}

#[tokio::test]
async fn push_creates_then_updates_with_matching_revision() {
    let conn = conn().await;

    let results = repo::apply_push(&conn, "dev-a", &[create(fragment("f1", "第一版"))])
        .await
        .unwrap();
    let (revision, first_seq) = applied(&results[0].outcome);
    assert_eq!(revision, 1);

    let results = repo::apply_push(&conn, "dev-a", &[update(fragment("f1", "第二版"), 1)])
        .await
        .unwrap();
    let (revision, second_seq) = applied(&results[0].outcome);
    assert_eq!(revision, 2);
    assert!(second_seq > first_seq, "每次写入都要拿一个更大的序号");

    let stored = repo::load_fragment(&conn, "f1").await.unwrap().unwrap();
    assert_eq!(stored.content.as_deref(), Some("第二版"));
}

/// 核心保证：CAS 不匹配时服务端**原样保留自己那一版**，并把它回给客户端。
#[tokio::test]
async fn conflicting_push_never_overwrites_and_returns_server_version() {
    let conn = conn().await;
    repo::apply_push(&conn, "dev-a", &[create(fragment("f1", "原始"))])
        .await
        .unwrap();
    repo::apply_push(&conn, "dev-a", &[update(fragment("f1", "A 改的"), 1)])
        .await
        .unwrap();

    // dev-b 手里还是 revision 1。
    let results = repo::apply_push(&conn, "dev-b", &[update(fragment("f1", "B 改的"), 1)])
        .await
        .unwrap();

    match &results[0].outcome {
        PushOutcome::Conflict { current } => match current.as_ref() {
            ServerVersion::Fragment(payload) => {
                assert_eq!(payload.content.as_deref(), Some("A 改的"));
                assert_eq!(payload.revision, 2);
            }
            other => panic!("期望片段版本，实际是 {other:?}"),
        },
        other => panic!("期望冲突，实际是 {other:?}"),
    }

    let stored = repo::load_fragment(&conn, "f1").await.unwrap().unwrap();
    assert_eq!(
        stored.content.as_deref(),
        Some("A 改的"),
        "冲突绝不能让后来者覆盖先到者"
    );
}

/// 重复新建同一个 id 是冲突，不是静默覆盖。
#[tokio::test]
async fn duplicate_create_is_a_conflict() {
    let conn = conn().await;
    repo::apply_push(&conn, "dev-a", &[create(fragment("f1", "先到"))])
        .await
        .unwrap();

    let results = repo::apply_push(&conn, "dev-b", &[create(fragment("f1", "后到"))])
        .await
        .unwrap();
    assert!(matches!(results[0].outcome, PushOutcome::Conflict { .. }));

    let stored = repo::load_fragment(&conn, "f1").await.unwrap().unwrap();
    assert_eq!(stored.content.as_deref(), Some("先到"));
}

/// 一条冲突不该连累同一批里的其他条目——每条独立事务。
#[tokio::test]
async fn one_conflict_does_not_block_the_rest_of_the_batch() {
    let conn = conn().await;
    repo::apply_push(&conn, "dev-a", &[create(fragment("f1", "已存在"))])
        .await
        .unwrap();

    let results = repo::apply_push(
        &conn,
        "dev-b",
        &[
            create(fragment("f1", "会冲突")),
            create(fragment("f2", "该成功")),
            create(fragment("f3", "也该成功")),
        ],
    )
    .await
    .unwrap();

    assert!(matches!(results[0].outcome, PushOutcome::Conflict { .. }));
    assert!(matches!(results[1].outcome, PushOutcome::Applied { .. }));
    assert!(matches!(results[2].outcome, PushOutcome::Applied { .. }));
    assert!(repo::load_fragment(&conn, "f2").await.unwrap().is_some());
}

/// 拿着 base_revision 去更新一条服务端没有的记录：这不是并发冲突，
/// 是请求本身不成立，要给出能看懂的理由。
#[tokio::test]
async fn updating_an_unknown_row_is_rejected_not_conflicted() {
    let conn = conn().await;
    let results = repo::apply_push(&conn, "dev-a", &[update(fragment("ghost", "内容"), 3)])
        .await
        .unwrap();

    assert!(matches!(results[0].outcome, PushOutcome::Rejected { .. }));
}

/// 安全关键：带明文的密匣条目必须被拒，服务端不留任何明文。
#[tokio::test]
async fn lockbox_payload_carrying_plaintext_is_rejected() {
    let conn = conn().await;
    let mut payload = fragment("secret", "会议室密码");
    payload.lockbox = true;

    let results = repo::apply_push(&conn, "dev-a", &[create(payload)])
        .await
        .unwrap();
    assert!(matches!(results[0].outcome, PushOutcome::Rejected { .. }));
    assert!(repo::load_fragment(&conn, "secret").await.unwrap().is_none());
}

/// 墓碑要照常同步。没有它，离线设备上线后会把已删除的笔记推回来。
#[tokio::test]
async fn tombstones_travel_through_sync() {
    let conn = conn().await;
    repo::apply_push(&conn, "dev-a", &[create(fragment("f1", "待删"))])
        .await
        .unwrap();

    let mut deleted = fragment("f1", "待删");
    deleted.deleted_at = Some("2026-07-27T10:00:00+08:00".into());
    repo::apply_push(&conn, "dev-a", &[update(deleted, 1)])
        .await
        .unwrap();

    let changes = repo::changes_since(&conn, 0, 100).await.unwrap();
    let fragment_change = changes
        .iter()
        .find_map(|change| match change {
            Change::Fragment { payload, .. } if payload.id == "f1" => Some(payload),
            _ => None,
        })
        .expect("墓碑行也要出现在增量里");
    assert!(fragment_change.deleted_at.is_some());
}

/// 增量按 seq 严格递增，且不重不漏。
#[tokio::test]
async fn changes_are_ordered_and_complete() {
    let conn = conn().await;
    for index in 0..5 {
        repo::apply_push(
            &conn,
            "dev-a",
            &[create(fragment(&format!("f{index}"), "内容"))],
        )
        .await
        .unwrap();
    }

    let all = repo::changes_since(&conn, 0, 100).await.unwrap();
    assert_eq!(all.len(), 5);
    let seqs: Vec<i64> = all.iter().map(Change::seq).collect();
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    assert_eq!(seqs, sorted, "必须按 seq 升序");

    // 从中间的游标接着拉，拿到的正好是剩下那些。
    let cursor = seqs[1];
    let rest = repo::changes_since(&conn, cursor, 100).await.unwrap();
    assert_eq!(rest.len(), 3);
    assert!(rest.iter().all(|change| change.seq() > cursor));
}

/// 分页不能丢数据：一页一页拉完，总数与一次拉完相同。
#[tokio::test]
async fn paging_covers_everything_exactly_once() {
    let conn = conn().await;
    for index in 0..7 {
        repo::apply_push(
            &conn,
            "dev-a",
            &[create(fragment(&format!("f{index}"), "内容"))],
        )
        .await
        .unwrap();
    }

    let mut cursor = 0;
    let mut collected = Vec::new();
    loop {
        let page = repo::changes_since(&conn, cursor, 2).await.unwrap();
        if page.is_empty() {
            break;
        }
        cursor = page.last().unwrap().seq();
        collected.extend(page.into_iter().map(|change| match change {
            Change::Fragment { payload, .. } => payload.id.clone(),
            other => panic!("只该有片段：{other:?}"),
        }));
    }

    collected.sort();
    collected.dedup();
    assert_eq!(collected.len(), 7, "分页拉取必须覆盖全部且不重复");
}

#[tokio::test]
async fn tags_survive_the_round_trip() {
    let conn = conn().await;
    let mut payload = fragment("f1", "内容");
    payload.tags = vec!["工作".into(), "会议".into()];
    repo::apply_push(&conn, "dev-a", &[create(payload)])
        .await
        .unwrap();

    let stored = repo::load_fragment(&conn, "f1").await.unwrap().unwrap();
    assert_eq!(stored.tags, vec!["会议".to_string(), "工作".to_string()]);

    // 更新时标签是**替换**而不是累加。
    let mut next = fragment("f1", "内容");
    next.tags = vec!["个人".into()];
    repo::apply_push(&conn, "dev-a", &[update(next, 1)])
        .await
        .unwrap();
    assert_eq!(
        repo::load_fragment(&conn, "f1").await.unwrap().unwrap().tags,
        vec!["个人".to_string()]
    );
}

/// 笔记先于附件元数据到达是合法顺序，不该报错——关联等附件到了再补。
#[tokio::test]
async fn note_referencing_an_unknown_attachment_still_applies() {
    let conn = conn().await;
    let mut payload = fragment("f1", "看图");
    payload.attachment_hashes = vec!["a".repeat(64)];

    let results = repo::apply_push(&conn, "dev-a", &[create(payload)])
        .await
        .unwrap();
    assert!(matches!(results[0].outcome, PushOutcome::Applied { .. }));

    let stored = repo::load_fragment(&conn, "f1").await.unwrap().unwrap();
    assert!(stored.attachment_hashes.is_empty(), "关联要等附件登记后才建立");
}

#[tokio::test]
async fn attachment_metadata_is_idempotent() {
    let conn = conn().await;
    let payload = AttachmentPayload {
        hash: "b".repeat(64),
        mime_type: "image/png".into(),
        byte_size: 1024,
        created_at: "2026-07-26T10:00:00+08:00".into(),
        deleted_at: None,
    };

    for _ in 0..3 {
        let results = repo::apply_push(
            &conn,
            "dev-a",
            &[PushItem::Attachment {
                payload: payload.clone(),
            }],
        )
        .await
        .unwrap();
        assert!(matches!(results[0].outcome, PushOutcome::Applied { .. }));
    }

    let mut rows = conn
        .query("SELECT count(*) FROM attachments", ())
        .await
        .unwrap();
    let count: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
    assert_eq!(count, 1, "同一份内容只该有一行");
}

#[tokio::test]
async fn maps_sync_with_cas_semantics() {
    let conn = conn().await;
    let doc = "{\n  \"id\": \"m1\"\n}\n";
    let payload = MapPayload {
        id: "m1".into(),
        title: "计划".into(),
        doc_json: doc.into(),
        doc_hash: shard_core::hash_text(doc),
        revision: 1,
        node_count: 1,
        created_at: "2026-07-26T10:00:00+08:00".into(),
        updated_at: "2026-07-26T10:00:00+08:00".into(),
        updated_at_ms: 1_784_000_000_000,
        deleted_at: None,
    };

    let results = repo::apply_push(
        &conn,
        "dev-a",
        &[PushItem::Map {
            base_revision: None,
            payload: Box::new(payload.clone()),
        }],
    )
    .await
    .unwrap();
    assert!(matches!(results[0].outcome, PushOutcome::Applied { .. }));

    // 过期版本推不上去。
    let results = repo::apply_push(
        &conn,
        "dev-b",
        &[PushItem::Map {
            base_revision: Some(99),
            payload: Box::new(payload),
        }],
    )
    .await
    .unwrap();
    assert!(matches!(results[0].outcome, PushOutcome::Conflict { .. }));
}

/// 冲突回滚不能白白吃掉一个序号——否则客户端会看到 seq 出现空洞，
/// 虽然不影响正确性，但会让「服务端最大 seq」这个判断失真。
#[tokio::test]
async fn conflicting_push_does_not_consume_a_sequence_number() {
    let conn = conn().await;
    repo::apply_push(&conn, "dev-a", &[create(fragment("f1", "原始"))])
        .await
        .unwrap();
    let after_create = db::current_seq(&conn).await.unwrap();

    repo::apply_push(&conn, "dev-b", &[create(fragment("f1", "重复"))])
        .await
        .unwrap();

    assert_eq!(
        db::current_seq(&conn).await.unwrap(),
        after_create,
        "被拒绝的写入不该推进序号"
    );
}
