//! 在**真实 FTS5** 里验证分词方案，而不只是验证字符串变换。
//!
//! 这些测试把计划里的三条论断变成可执行的证据：
//!
//! 1. 裸 `unicode61` 搜不到中文（连续汉字被当成一个 token）——所以必须预切分；
//! 2. `trigram` 对 2 字中文查询返回空——所以不能选它；
//! 3. CJK 逐字预切 + `unicode61` 能精确命中 1 字与 2 字查询——所以选它。
//!
//! 全部用 `:memory:` 库，无外部依赖、无网络。

use libsql::{params, Builder, Connection};
use shard_core::fts::{build_match_query, to_fts_text, FTS_TOKENIZE};

/// 三条真实的中文笔记内容，覆盖「查询词出现在词中间」这种最容易漏的情况。
const DOCS: [(&str, &str); 3] = [
    ("n1", "今天开会议程安排在下午三点"),
    ("n2", "会议纪要已经整理好了"),
    ("n3", "Rust 项目的日程规划 #2"),
];

async fn conn_with_tokenizer(tokenize: &str, preprocess: bool) -> Connection {
    let db = Builder::new_local(":memory:")
        .build()
        .await
        .expect("建内存库失败");
    let conn = db.connect().expect("连接失败");
    conn.execute_batch(&format!(
        "CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, body, tokenize = \"{tokenize}\");"
    ))
    .await
    .expect("建 FTS5 表失败");

    for (id, body) in DOCS {
        let indexed = if preprocess {
            to_fts_text(body)
        } else {
            body.to_string()
        };
        conn.execute("INSERT INTO docs (id, body) VALUES (?1, ?2)", params![id, indexed])
            .await
            .expect("插入失败");
    }
    conn
}

async fn hits(conn: &Connection, match_expr: &str) -> Vec<String> {
    let mut rows = conn
        .query(
            "SELECT id FROM docs WHERE docs MATCH ?1 ORDER BY rank",
            params![match_expr],
        )
        .await
        .unwrap_or_else(|e| panic!("查询 {match_expr:?} 失败：{e}"));

    let mut out = Vec::new();
    while let Some(row) = rows.next().await.expect("读行失败") {
        out.push(row.get::<String>(0).expect("取 id 失败"));
    }
    out
}

/// 论断 1：不预切分时，`unicode61` 搜不到「会议」——这正是现状必须改的原因。
#[tokio::test]
async fn bare_unicode61_cannot_find_chinese() {
    let conn = conn_with_tokenizer("unicode61", false).await;
    let found = hits(&conn, "\"会议\"").await;
    assert!(
        found.is_empty(),
        "裸 unicode61 竟然命中了 {found:?}——若此断言失败说明 SQLite 行为已变，分词方案需重新评估"
    );
}

/// 论断 2：`trigram` 对 2 字中文查询返回空。这是不选它的决定性理由。
#[tokio::test]
async fn trigram_fails_on_two_character_queries() {
    let conn = conn_with_tokenizer("trigram", false).await;

    // 3 字可以命中……
    let three = hits(&conn, "\"会议纪\"").await;
    assert!(!three.is_empty(), "trigram 连 3 字都搜不到，环境异常");

    // ……但 2 字（用户最常输入的形态）搜不到。
    let two = hits(&conn, "\"会议\"").await;
    assert!(
        two.is_empty(),
        "trigram 竟然命中了 2 字查询 {two:?}——若此断言失败可重新评估 trigram"
    );
}

/// 论断 3：预切分 + `unicode61` 能精确命中 2 字查询，包括出现在词中间的情况。
#[tokio::test]
async fn preprocessed_unicode61_matches_two_character_query() {
    let conn = conn_with_tokenizer(FTS_TOKENIZE, true).await;
    let query = build_match_query("会议").expect("查询不该为 None");

    let found = hits(&conn, &query).await;
    found_contains(&found, "n1", "「今天开会议程」中间的『会议』必须命中");
    found_contains(&found, "n2", "「会议纪要」开头的『会议』必须命中");
    assert!(
        !found.contains(&"n3".to_string()),
        "不含『会议』的 n3 不该命中，实际 {found:?}"
    );
}

/// 单字查询也必须可用——这是 trigram 完全做不到的。
#[tokio::test]
async fn single_character_query_works() {
    let conn = conn_with_tokenizer(FTS_TOKENIZE, true).await;
    let query = build_match_query("会").expect("查询不该为 None");
    let found = hits(&conn, &query).await;
    assert!(
        found.contains(&"n1".to_string()) && found.contains(&"n2".to_string()),
        "单字『会』应命中 n1 与 n2，实际 {found:?}"
    );
}

/// phrase 必须保序：『议会』不能命中只含『会议』的文档。
#[tokio::test]
async fn phrase_order_is_significant() {
    let conn = conn_with_tokenizer(FTS_TOKENIZE, true).await;
    let query = build_match_query("议会").expect("查询不该为 None");
    let found = hits(&conn, &query).await;
    assert!(
        found.is_empty(),
        "『议会』不该命中只含『会议』的文档，实际 {found:?}——说明退化成了词袋匹配"
    );
}

/// 中英混排与 tokenchars：`#2` 和 `Rust` 都要能检索到。
#[tokio::test]
async fn mixed_script_and_tokenchars() {
    let conn = conn_with_tokenizer(FTS_TOKENIZE, true).await;

    for (input, expect) in [("日程", "n3"), ("rust", "n3"), ("#2", "n3")] {
        let query = build_match_query(input).unwrap_or_else(|| panic!("{input} 查询为 None"));
        let found = hits(&conn, &query).await;
        assert!(
            found.contains(&expect.to_string()),
            "查询 {input:?}（表达式 {query:?}）应命中 {expect}，实际 {found:?}"
        );
    }
}

/// 用户输入里的 FTS5 语法元素不能让查询报错（注入防护的运行时验证）。
#[tokio::test]
async fn hostile_input_does_not_break_query() {
    let conn = conn_with_tokenizer(FTS_TOKENIZE, true).await;

    for hostile in ["a OR b", "(x)", "NEAR(会议 日程)", "col:value", "\"quoted\"", "会议*"] {
        if let Some(query) = build_match_query(hostile) {
            // 只要不 panic 就算通过——hits() 内部对查询失败会 panic。
            let _ = hits(&conn, &query).await;
        }
    }
}

fn found_contains(found: &[String], id: &str, msg: &str) {
    assert!(
        found.contains(&id.to_string()),
        "{msg}；实际命中 {found:?}"
    );
}
