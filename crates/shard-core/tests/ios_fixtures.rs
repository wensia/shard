//! Cross-language format contract for the iOS app (docs/dev/ios-app-plan.md §2).
//!
//! The cases below are run through the Rust implementation and must equal the
//! committed fixture file, which the Swift `ShardKit` tests replay. Regenerate after
//! an intentional format change with:
//!
//!     SHARD_WRITE_IOS_FIXTURES=1 cargo test -p shard-core --test ios_fixtures

use chrono::{DateTime, FixedOffset};
use serde_json::{json, Value};
use shard_core::{
    extract_tags, normalize_tags, normalize_type_tags, write_fragment_file, FragmentFrontmatter, FsVfs,
    PROTECTED_TYPE_TAGS,
};
use std::{env, fs, path::PathBuf};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/ios/ShardKit/Tests/ShardKitTests/Fixtures/format-fixtures.json")
}

const EXTRACT_CASES: &[&str] = &[
    "骑行回来想到的 #骑行 #复盘",
    "中文#标签紧贴",
    "abc#notag",
    "#a#b",
    "(#括号)",
    "#标签，后面",
    "#tag.",
    "##double",
    "#  ",
    "emoji #🚴骑行 ok",
    "#a\u{3000}b",
    "“#引号”",
    "#Ünïcödé",
    "#e\u{301}",
    "mail@example.com #ok",
    "#100%",
    "#2026 #true #null #007 #1.5 #-x #[x] #a:b #x,",
    "#%a #@b #`c #*d #&e #!f #|g #>h #?i #:j #~ #'k",
    "#it's #a#b",
    "#0x1F #1e3 #.inf #NULL #True #+5 #-7 #- #0 #1_000",
    "#密匣 secret",
    "#outline 想法 #note #document",
    "line one\n#换行 后\t#制表",
    "",
];

const NORMALIZE_CASES: &[(&[&str], bool)] = &[
    (&[" #a ", "b", "a"], true),
    (&["中", "Z", "a"], false),
    (&["  ", "#", ""], true),
    (&["a  b", "#,x,", "##y"], false),
    (&["e\u{301}", "\u{e9}"], false),
];

const TYPE_CASES: &[&[&str]] = &[
    &["note", "document", "a"],
    &["document", "x"],
    &["outline", "flowchart"],
    &["plain"],
];

/// (content, id, created_at). created_at carries the device offset, like desktop Local time.
const CAPTURE_CASES: &[(&str, &str, &str)] = &[
    (
        "骑行回来想到的：坡道上不要急着换挡。#骑行 #复盘\n\n- [ ] 换飞轮",
        "20261013-182233-1a2b3c4d-5e6f70",
        "2026-10-13T18:22:33.683399+08:00",
    ),
    (
        "  只有正文，没有标签  \n\n",
        "20260101-000000-00000000-000000",
        "2026-01-01T00:00:00+08:00",
    ),
    (
        "#2026 #true #null #007 #-x #[x] #it's #a:b 引号测试",
        "20251231-235959-ffffffff-ffffff",
        "2025-12-31T23:59:59.500-05:00",
    ),
    (
        "#🚴骑行 #%a #@b #`c #*d #&e #|g #>h #~ #0x1F #1e3 #NULL #True #+5 #-7 #- #0 #1_000 #1.5 #100% #a#b 符号",
        "20260301-080910-abcdef01-234567",
        "2026-03-01T08:09:10.120+05:30",
    ),
    (
        "#outline #note #document 类型标签",
        "20260615-120000-01234567-89abcd",
        "2026-06-15T12:00:00.000001+00:00",
    ),
];

/// Strings serialized alone by serde_yaml (block context, same rules as map values).
const YAML_SCALAR_CASES: &[&str] = &[
    "plain", "骑行", "with space", " leading", "trailing ", "a #b", "a#b", "a: b", "key:", ":x",
    "-", "-x", "- x", "?", "?x", "---", "---x", "...", "..x", "%a", "@b", "`c", "*d", "&e", "!f",
    "|g", ">h", "#i", "~", "", "''", "it's", "\"q\"", "tab\there", "\u{feff}bom", "x\u{85}y",
    "2026", "007", "-007", "+5", "-7", "0", "0x1F", "-0x1F", "0o17", "0b101", "0x", "1e3", "1.5",
    ".5", "5.", "1_000", ".inf", "-.inf", ".nan", "inf", "NaN", "null", "Null", "NULL", "true",
    "True", "TRUE", "false", "yes", "no", "on", "off", "y", "n", "2026-10-13", "12:30",
    "2026-10-13T18:22:33.683399+08:00", "[x", "x]", "{a}", "a,b", "a?b", "é", "e\u{301}",
    // Line breaks inside single quotes get libyaml's fold indentation; no field iOS writes
    // can contain one (tags stop at whitespace), so they stay out of the contract.
    "🚴骑行", "\u{a0}x", "x\u{7f}", "\u{1b}esc", "back\\slash", "\u{fffd}", "\u{e000}",
];

/// (epoch microseconds, offset seconds) for chrono `to_rfc3339` formatting.
const RFC3339_CASES: &[(i64, i32)] = &[
    (1_791_886_953_683_399, 8 * 3600),
    (1_767_196_800_000_000, 8 * 3600),
    (1_767_196_800_500_000, -5 * 3600),
    (1_767_196_800_000_001, 0),
    (1_767_196_800_120_000, 5 * 3600 + 30 * 60),
];

fn capture_tags(content: &str) -> Vec<String> {
    let extracted = extract_tags(content)
        .into_iter()
        .filter(|tag| !PROTECTED_TYPE_TAGS.contains(&tag.as_str()))
        .collect();
    normalize_type_tags(normalize_tags(extracted, true))
}

fn fragment_text(id: &str, created_at: &str, tags: Vec<String>, body: &str) -> String {
    let frontmatter = FragmentFrontmatter {
        id: id.to_string(),
        created_at: created_at.to_string(),
        updated_at: created_at.to_string(),
        tags,
        category: None,
        ai_status: Some("none".to_string()),
        pinned: false,
        source: "ios".to_string(),
        conflict_of: None,
        related: Vec::new(),
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fragment.md");
    write_fragment_file(&FsVfs::new(dir.path()), &path, &frontmatter, body).unwrap();
    fs::read_to_string(path).unwrap()
}

fn build_fixtures() -> Value {
    let extract: Vec<Value> = EXTRACT_CASES
        .iter()
        .map(|input| json!({ "input": input, "expected": extract_tags(input) }))
        .collect();

    let normalize: Vec<Value> = NORMALIZE_CASES
        .iter()
        .map(|(input, include_inbox)| {
            let tags = input.iter().map(|tag| tag.to_string()).collect();
            json!({
                "input": input,
                "includeInbox": include_inbox,
                "expected": normalize_tags(tags, *include_inbox),
            })
        })
        .collect();

    let types: Vec<Value> = TYPE_CASES
        .iter()
        .map(|input| {
            let tags = input.iter().map(|tag| tag.to_string()).collect();
            json!({ "input": input, "expected": normalize_type_tags(tags) })
        })
        .collect();

    let captures: Vec<Value> = CAPTURE_CASES
        .iter()
        .map(|(content, id, created_at)| {
            let time = DateTime::parse_from_rfc3339(created_at).unwrap();
            // Swift derives created_at from the instant, so cases must be in chrono's own form.
            assert_eq!(time.to_rfc3339(), *created_at, "non-canonical created_at in case {id}");
            // create_public_fragment_with_id_in_vault: trim, then write_fragment_file trims the end again.
            let body = content.trim();
            let tags = capture_tags(content);
            json!({
                "content": content,
                "id": id,
                "createdAt": created_at,
                "epochMicros": time.timestamp_micros(),
                "offsetSeconds": time.offset().local_minus_utc(),
                "expectedTags": tags.clone(),
                "expectedPath": format!("fragments/{}/{}.md", time.format("%Y/%m"), id),
                "expectedText": fragment_text(id, created_at, tags, body),
            })
        })
        .collect();

    let rfc3339: Vec<Value> = RFC3339_CASES
        .iter()
        .map(|(micros, offset)| {
            let offset_tz = FixedOffset::east_opt(*offset).unwrap();
            let time = DateTime::from_timestamp_micros(*micros).unwrap().with_timezone(&offset_tz);
            json!({ "epochMicros": micros, "offsetSeconds": offset, "expected": time.to_rfc3339() })
        })
        .collect();

    let yaml_scalars: Vec<Value> = YAML_SCALAR_CASES
        .iter()
        .map(|input| {
            let emitted = serde_yaml::to_string(input).unwrap();
            json!({ "input": input, "expected": emitted.strip_suffix('\n').unwrap_or(&emitted) })
        })
        .collect();

    json!({
        "comment": "Generated by crates/shard-core/tests/ios_fixtures.rs — do not edit by hand.",
        "extractTags": extract,
        "normalizeTags": normalize,
        "normalizeTypeTags": types,
        "captures": captures,
        "rfc3339": rfc3339,
        "yamlScalars": yaml_scalars,
    })
}

#[test]
fn ios_format_fixtures_match_rust_implementation() {
    let fixtures = build_fixtures();
    let path = fixture_path();
    if env::var_os("SHARD_WRITE_IOS_FIXTURES").is_some() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, serde_json::to_string_pretty(&fixtures).unwrap() + "\n").unwrap();
        return;
    }
    let committed: Value = serde_json::from_str(
        &fs::read_to_string(&path).expect("fixture missing; run with SHARD_WRITE_IOS_FIXTURES=1"),
    )
    .unwrap();
    assert_eq!(
        committed, fixtures,
        "iOS fixtures are stale; regenerate with SHARD_WRITE_IOS_FIXTURES=1 and update ShardKit"
    );
}
