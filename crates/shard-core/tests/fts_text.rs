//! 分词逻辑的一致性测试。
//!
//! 用例来自 `tests/fixtures/fts_text_cases.json`——这份 fixture 是 Rust 侧与
//! 未来 Web 侧实现的共同基准。改动分词逻辑必须先改 fixture，并且记得全量
//! `rebuild_search_index()`，否则旧索引配新查询会静默搜不到东西。

use serde_json::Value;
use shard_core::fts::{build_match_query, to_fts_text};

fn load_cases() -> Vec<Value> {
    let raw = include_str!("fixtures/fts_text_cases.json");
    let parsed: Value = serde_json::from_str(raw).expect("fixture 不是合法 JSON");
    parsed["cases"]
        .as_array()
        .expect("fixture 缺少 cases 数组")
        .clone()
}

#[test]
fn fixture_cases_match_implementation() {
    let mut failures = Vec::new();

    for case in load_cases() {
        let name = case["name"].as_str().unwrap_or("<未命名>");
        let input = case["input"].as_str().expect("用例缺少 input");

        let expected_text = case["ftsText"].as_str().expect("用例缺少 ftsText");
        let actual_text = to_fts_text(input);
        if actual_text != expected_text {
            failures.push(format!(
                "[{name}] to_fts_text({input:?})\n  期望: {expected_text:?}\n  实际: {actual_text:?}"
            ));
        }

        let expected_query = case["matchQuery"].as_str();
        let actual_query = build_match_query(input);
        if actual_query.as_deref() != expected_query {
            failures.push(format!(
                "[{name}] build_match_query({input:?})\n  期望: {expected_query:?}\n  实际: {:?}",
                actual_query.as_deref()
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} 条 fixture 用例不匹配：\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

/// 索引侧与查询侧必须对同一段中文产生可互相匹配的结果：查询生成的 phrase
/// 去掉引号后，必须是索引文本的子串。这条不变量一旦破坏，搜索就静默失效。
#[test]
fn cjk_phrase_is_substring_of_indexed_text() {
    for input in ["会议", "今天开会议程", "日程安排", "ミーティング"] {
        let indexed = to_fts_text(input);
        let query = build_match_query(input).expect("中文查询不该为 None");
        let phrase = query.trim_matches('"');
        assert!(
            indexed.contains(phrase),
            "查询 phrase {phrase:?} 不是索引文本 {indexed:?} 的子串（输入 {input:?}）"
        );
    }
}

/// 用户输入里的 FTS5 语法元素必须被中性化，不能改变表达式结构。
#[test]
fn fts5_syntax_in_user_input_is_neutralized() {
    for hostile in ["a OR b", "(x)", "NEAR(a b)", "col:value", "a*b", "\"quoted\""] {
        let Some(query) = build_match_query(hostile) else {
            continue;
        };
        // 每个生成项都必须是 "..."  或 "..."* 的形式，即引号包裹。
        for term in query.split(" AND ") {
            assert!(
                term.starts_with('"') && (term.ends_with('"') || term.ends_with("\"*")),
                "输入 {hostile:?} 生成了未被引号包裹的项 {term:?}（完整查询 {query:?}）"
            );
        }
    }
}

/// 空白差异不应改变索引结果之外的语义：多余空白会被归一化。
#[test]
fn whitespace_is_normalized() {
    assert_eq!(to_fts_text("  会议  "), "会 议");
    assert_eq!(build_match_query("  会议  ").as_deref(), Some("\"会 议\""));
}
