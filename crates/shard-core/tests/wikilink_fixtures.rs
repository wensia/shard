//! 读取与前端共用的 `tests/fixtures/wikilink-cases.json`，逐条断言 Rust 移植
//! （`shard_core::wikilink`）。TS 那一侧是 `src/lib/wikilink.fixtures.test.ts`。

use serde::Deserialize;
use shard_core::wikilink::{
    apply_wikilink_relation_sync, build_csv_wikilink_candidates,
    build_mind_map_wikilink_candidates, build_wikilink_candidates, derive_note_title,
    derive_wikilink_relations, is_csv_wikilink_target, normalize_wikilink_target, parse_wikilinks,
    plan_wikilink_relation_sync, resolve_wikilink_target, strip_markdown_hard_breaks,
    WikilinkCandidate, WikilinkCandidateKind, WikilinkCsvFile, WikilinkDocument, WikilinkMindMap,
};
use shard_core::FragmentRelation;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    parse: Vec<ParseCase>,
    normalize: Vec<ValueCase<String>>,
    csv_target: Vec<ValueCase<bool>>,
    note_title: Vec<NoteTitleCase>,
    hard_breaks: Vec<HardBreakCase>,
    resolve: Vec<ResolveCase>,
    relations: Vec<RelationCase>,
}

#[derive(Deserialize)]
struct ParseCase {
    name: String,
    content: String,
    links: Vec<ExpectedLink>,
}

#[derive(Debug, PartialEq, Deserialize)]
struct ExpectedLink {
    target: String,
    alias: Option<String>,
    embed: bool,
    text: String,
}

#[derive(Deserialize)]
struct ValueCase<T> {
    input: String,
    expected: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteTitleCase {
    name: String,
    content: String,
    #[serde(default)]
    repeat_prefix: Option<RepeatPrefix>,
    expected: String,
}

#[derive(Deserialize)]
struct RepeatPrefix {
    text: String,
    count: usize,
}

#[derive(Deserialize)]
struct HardBreakCase {
    content: String,
    expected: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveCase {
    name: String,
    fragments: Vec<WikilinkDocument>,
    csv_files: Vec<WikilinkCsvFile>,
    mind_maps: Vec<WikilinkMindMap>,
    candidates: Vec<WikilinkCandidate>,
    lookups: Vec<Lookup>,
}

#[derive(Deserialize)]
struct Lookup {
    target: String,
    expected: Option<ExpectedHit>,
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedHit {
    kind: WikilinkCandidateKind,
    #[serde(default)]
    fragment_id: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelationCase {
    name: String,
    corpus: Vec<WikilinkDocument>,
    source: WikilinkDocument,
    current_relations: Vec<RelationRef>,
    expected_targets: Option<Vec<String>>,
    #[serde(default)]
    expected_removed: Vec<String>,
    #[serde(default)]
    expected_added: Vec<String>,
    #[serde(default)]
    expected_relations: Vec<RelationRef>,
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelationRef {
    target_id: String,
    origin: String,
}

fn fixture() -> Fixture {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/wikilink-cases.json"
    );
    let text = std::fs::read_to_string(path).expect("读取 wikilink fixture");
    serde_json::from_str(&text).expect("解析 wikilink fixture")
}

#[test]
fn parse_cases() {
    for case in fixture().parse {
        let actual = parse_wikilinks(&case.content)
            .into_iter()
            .map(|link| ExpectedLink {
                text: case.content[link.from..link.to].to_string(),
                target: link.target,
                alias: link.alias,
                embed: link.embed,
            })
            .collect::<Vec<_>>();
        assert_eq!(actual, case.links, "parse：{}", case.name);
    }
}

#[test]
fn normalize_cases() {
    for case in fixture().normalize {
        assert_eq!(
            normalize_wikilink_target(&case.input),
            case.expected,
            "normalize：{:?}",
            case.input
        );
    }
}

#[test]
fn csv_target_cases() {
    for case in fixture().csv_target {
        assert_eq!(
            is_csv_wikilink_target(&case.input),
            case.expected,
            "csvTarget：{:?}",
            case.input
        );
    }
}

#[test]
fn note_title_cases() {
    for case in fixture().note_title {
        let content = match &case.repeat_prefix {
            Some(prefix) => prefix.text.repeat(prefix.count) + &case.content,
            None => case.content.clone(),
        };
        assert_eq!(
            derive_note_title(&content),
            case.expected,
            "noteTitle：{}",
            case.name
        );
    }
}

#[test]
fn hard_break_cases() {
    for case in fixture().hard_breaks {
        assert_eq!(
            strip_markdown_hard_breaks(&case.content, 32_000),
            case.expected,
            "hardBreaks：{:?}",
            case.content
        );
    }
}

#[test]
fn resolve_cases() {
    for case in fixture().resolve {
        let mut candidates = build_wikilink_candidates(&case.fragments);
        candidates.extend(build_csv_wikilink_candidates(&case.csv_files));
        candidates.extend(build_mind_map_wikilink_candidates(&case.mind_maps));
        assert_eq!(candidates, case.candidates, "resolve 候选：{}", case.name);

        for lookup in case.lookups {
            let actual =
                resolve_wikilink_target(&lookup.target, &candidates).map(|candidate| ExpectedHit {
                    kind: candidate.kind,
                    fragment_id: candidate.fragment_id.clone(),
                    path: candidate.path.clone(),
                });
            assert_eq!(
                actual, lookup.expected,
                "resolve：{} / {:?}",
                case.name, lookup.target
            );
        }
    }
}

#[test]
fn relation_cases() {
    for case in fixture().relations {
        let targets = derive_wikilink_relations(&case.source, &case.corpus);
        assert_eq!(
            targets, case.expected_targets,
            "relations 目标：{}",
            case.name
        );
        let Some(targets) = targets else {
            continue;
        };

        let current = case
            .current_relations
            .iter()
            .map(|relation| FragmentRelation {
                target_id: relation.target_id.clone(),
                origin: relation.origin.clone(),
                created_at: "2026-01-01T00:00:00+08:00".to_string(),
                note: None,
            })
            .collect::<Vec<_>>();
        let sync = plan_wikilink_relation_sync(&current, &targets);
        assert_eq!(
            sync.removed, case.expected_removed,
            "relations 删除：{}",
            case.name
        );
        assert_eq!(
            sync.added, case.expected_added,
            "relations 新增：{}",
            case.name
        );

        let next = apply_wikilink_relation_sync(&current, &sync, "2026-10-26T00:00:00+08:00")
            .into_iter()
            .map(|relation| RelationRef {
                target_id: relation.target_id,
                origin: relation.origin,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            next, case.expected_relations,
            "relations 结果：{}",
            case.name
        );
    }
}
