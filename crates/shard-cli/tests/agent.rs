//! 给 AI 助手的非交互命令：--json 输出、按 id 读写、追加、资料库笔记、数据集、错误码。

use serde_json::Value;
use shard_core::{frontmatter::parse_fragment, vault_lock::VaultProcessLock};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Output, Stdio},
};

const FRAGMENT: &str = "20260926-061830-81b8ea9d-a2237f";
const OTHER: &str = "20260926-071830-81b8ffff-b3348e";

struct Fixture {
    _directory: tempfile::TempDir,
    vault: PathBuf,
    locks: PathBuf,
    state: PathBuf,
    home: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let fixture = Self {
            vault: root.join("vault"),
            locks: root.join("locks"),
            state: root.join("state"),
            home: root.join("home"),
            _directory: directory,
        };
        for path in [&fixture.vault, &fixture.locks, &fixture.state, &fixture.home] {
            fs::create_dir_all(path).unwrap();
        }
        fs::create_dir_all(fixture.vault.join("notes")).unwrap();
        fixture
    }

    fn fragment(&self, id: &str, tags: &str, body: &str) -> PathBuf {
        let path = self.vault.join(format!("fragments/2026/09/{id}.md"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("---\nid: {id}\ncreated_at: 2026-09-26T06:18:30Z\nupdated_at: 2026-09-26T06:18:30Z\ntags: {tags}\ncategory: null\nai_status: none\nsource: test\n---\n\n{body}\n")).unwrap();
        path
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_shard-cli"));
        command
            .args(args)
            .env("SHARD_VAULT", &self.vault)
            .env("SHARD_LOCK_DIR", &self.locks)
            .env("SHARD_CLI_STATE_DIR", &self.state)
            .env("HOME", &self.home)
            .env_remove("SHARD_SOURCE")
            .env_remove("EDITOR")
            .env_remove("VISUAL")
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("CODEX_HOME");
        command
    }

    /// 标准输入是管道（与 AI 助手调用时一致）；`input` 为 None 时给空输入。
    fn run(&self, args: &[&str], input: Option<&str>) -> Output {
        let mut child = self
            .command(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.unwrap_or("").as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }

    fn json(&self, args: &[&str], input: Option<&str>) -> Value {
        let output = self.run(args, input);
        assert!(
            output.status.success(),
            "{args:?} 失败：{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
}

fn error_code(output: &Output) -> String {
    let value: Value = serde_json::from_slice(&output.stderr)
        .unwrap_or_else(|_| panic!("stderr 不是 JSON：{}", String::from_utf8_lossy(&output.stderr)));
    value["error"]["code"].as_str().unwrap().to_string()
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).unwrap()
}

#[test]
fn create_returns_json_and_records_source() {
    let f = Fixture::new();
    let created = f.json(&["--json", "--source", "claude-code", "#读书 读完了"], None);
    let path = f.vault.join(created["path"].as_str().unwrap());
    let raw = fs::read_to_string(&path).unwrap();
    let parsed = parse_fragment(&raw).unwrap();
    assert_eq!(created["id"], parsed.frontmatter.id);
    assert_eq!(parsed.frontmatter.source, "claude-code");
    assert_eq!(parsed.frontmatter.tags, vec!["inbox", "读书"]);
    assert_eq!(created["sha"].as_str().unwrap().len(), 64);

    let piped = f.json(&["--json"], Some("#摘录 第一行\n\n第二行\n"));
    let raw = fs::read_to_string(f.vault.join(piped["path"].as_str().unwrap())).unwrap();
    assert!(raw.ends_with("#摘录 第一行\n\n第二行\n"));
    assert_eq!(parse_fragment(&raw).unwrap().frontmatter.source, "cli");
}

#[test]
fn read_resolves_id_short_id_and_path() {
    let f = Fixture::new();
    f.fragment(FRAGMENT, "[inbox, 项目]", "第一条 #项目");
    let by_id = f.json(&["--read", FRAGMENT, "--json"], None);
    assert_eq!(by_id["body"], "第一条 #项目");
    assert_eq!(by_id["kind"], "fragment");
    assert_eq!(by_id["path"], format!("fragments/2026/09/{FRAGMENT}.md"));
    let by_path = f.json(&["--read", by_id["path"].as_str().unwrap(), "--json"], None);
    assert_eq!(by_path["sha"], by_id["sha"]);
    let short = f.run(&["--read", "81b8ea9d"], None);
    assert_eq!(stdout(&short), "第一条 #项目\n");

    f.fragment(OTHER, "[inbox]", "第二条");
    let ambiguous = f.run(&["--read", "81b8", "--json"], None);
    assert_eq!(ambiguous.status.code(), Some(1));
    assert_eq!(error_code(&ambiguous), "AMBIGUOUS");
    let missing = f.run(&["--read", "不存在的", "--json"], None);
    assert_eq!(error_code(&missing), "NOT_FOUND");
}

#[test]
fn update_requires_matching_sha_and_never_overwrites() {
    let f = Fixture::new();
    let path = f.fragment(FRAGMENT, "[inbox, 旧]", "原文 #旧");
    let read = f.json(&["--read", FRAGMENT, "--json"], None);
    let sha = read["sha"].as_str().unwrap();

    let missing_expect = f.run(&["--update", FRAGMENT], Some("新正文"));
    assert_eq!(missing_expect.status.code(), Some(1));

    let updated = f.json(
        &["--update", FRAGMENT, "--expect", sha, "--json"],
        Some("新正文 #新\n"),
    );
    assert_eq!(updated["changed"], true);
    assert_eq!(updated["tags"], serde_json::json!(["inbox", "新"]));
    let raw = fs::read_to_string(&path).unwrap();
    assert_eq!(updated["sha"], shard_core::graph_model::content_sha256_hex(&raw));
    assert!(raw.contains("source: test"), "其余 frontmatter 不动");

    let before = fs::read(&path).unwrap();
    let stale = f.run(&["--update", FRAGMENT, "--expect", sha, "--json"], Some("覆盖"));
    assert_eq!(stale.status.code(), Some(2));
    assert_eq!(error_code(&stale), "CONFLICT");
    assert_eq!(fs::read(&path).unwrap(), before);

    let same = f.json(
        &["--update", FRAGMENT, "--expect", updated["sha"].as_str().unwrap(), "--json"],
        Some("新正文 #新"),
    );
    assert_eq!(same["changed"], false);
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn append_continues_lists_without_sha() {
    let f = Fixture::new();
    let path = f.fragment(FRAGMENT, "[inbox]", "#待办\n\n- [ ] 买咖啡");
    f.json(&["--append", FRAGMENT, "--json", "/复选框", "买牛奶"], None);
    f.json(&["--append", FRAGMENT, "--json"], Some("补充说明 #生活"));
    let parsed = parse_fragment(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        parsed.body.trim(),
        "#待办\n\n- [ ] 买咖啡\n- [ ] 买牛奶\n\n补充说明 #生活"
    );
    assert_eq!(parsed.frontmatter.tags, vec!["inbox", "待办", "生活"]);

    let stale = f.run(&["--append", FRAGMENT, "--expect", "stale", "--json", "不该写入"], None);
    assert_eq!(error_code(&stale), "CONFLICT");
}

#[test]
fn notes_are_created_in_folders_and_searchable() {
    let f = Fixture::new();
    let note = f.json(
        &["--note", "周会纪要", "--folder", "项目/周会", "--json", "--source", "codex"],
        Some("## 结论\n\n- 下周发布 #发布\n"),
    );
    assert_eq!(note["path"], "notes/项目/周会/周会纪要.md");
    let raw = fs::read_to_string(f.vault.join("notes/项目/周会/周会纪要.md")).unwrap();
    let parsed = parse_fragment(&raw).unwrap();
    assert_eq!(parsed.frontmatter.tags, vec!["inbox", "note", "发布"]);
    assert_eq!(parsed.frontmatter.source, "codex");
    assert!(parsed.body.trim_start().starts_with("# 周会纪要\n\n## 结论"));

    let again = f.json(&["--note", "周会纪要", "--folder", "notes/项目/周会", "--json"], None);
    assert_eq!(again["path"], "notes/项目/周会/周会纪要-2.md");

    let hits = f.json(&["-s", "下周发布", "--json"], None);
    assert_eq!(hits[0]["kind"], "note");
    assert_eq!(hits[0]["title"], "周会纪要");
    assert!(hits[0]["updatedAt"].as_str().unwrap().starts_with("20"));

    let read = f.json(&["--read", "notes/项目/周会/周会纪要.md", "--json"], None);
    let updated = f.json(
        &["--update", read["id"].as_str().unwrap(), "--expect", read["sha"].as_str().unwrap(), "--json"],
        Some("# 周会纪要\n\n改了 #发布"),
    );
    assert_eq!(updated["tags"], serde_json::json!(["inbox", "note", "发布"]));
}

#[test]
fn tags_and_listing_cover_library() {
    let f = Fixture::new();
    f.fragment(FRAGMENT, "[inbox, 读书]", "#读书 一");
    f.fragment(OTHER, "[inbox, 读书, 摘录]", "#读书 #摘录 二");
    f.json(&["--note", "计划", "--folder", "项目", "--json"], Some("#读书 三"));
    let tags = f.json(&["--tags", "--json"], None);
    assert_eq!(
        tags,
        serde_json::json!([{ "tag": "读书", "count": 3 }, { "tag": "摘录", "count": 1 }])
    );

    f.json(
        &["--create-dataset", "阅读记录", "--folder", "项目", "--json"],
        Some(r#"{"header":["id","书名"],"rows":[["1","置身事内"]],"primaryKey":"id"}"#),
    );
    let listing = f.json(&["--ls", "--json"], None);
    let paths = listing
        .as_array()
        .unwrap()
        .iter()
        .map(|item| format!("{}:{}", item["kind"].as_str().unwrap(), item["path"].as_str().unwrap()))
        .collect::<Vec<_>>();
    assert_eq!(
        paths,
        vec![
            "folder:notes/项目",
            "note:notes/项目/计划.md",
            "note:notes/项目/阅读记录.md",
            "dataset:datasets/阅读记录.csv",
        ]
    );
    let sub = f.run(&["--ls", "项目"], None);
    assert_eq!(stdout(&sub), "notes/项目/计划.md\nnotes/项目/阅读记录.md\n");
}

#[test]
fn datasets_round_trip_through_cli() {
    let f = Fixture::new();
    let created = f.json(
        &["--create-dataset", "阅读记录", "--json"],
        Some(r#"{"header":["id","书名"],"rows":[["1","置身事内"]],"primaryKey":"id"}"#),
    );
    assert_eq!(created["path"], "datasets/阅读记录.csv");
    assert_eq!(created["notePath"], "notes/阅读记录.md");
    let note = fs::read_to_string(f.vault.join("notes/阅读记录.md")).unwrap();
    assert!(note.contains("```datatable\n{\n  \"title\": \"阅读记录\",\n  \"src\": \"datasets/阅读记录.csv\"\n}\n```"));

    let appended = f.json(
        &["--append-dataset", "datasets/阅读记录.csv"],
        Some(r#"{"expectedHeader":["id","书名"],"records":[{"id":"2","书名":"人类简史"}]}"#),
    );
    assert_eq!(appended["appended"], 1);
    let read = f.json(&["--read-dataset", "datasets/阅读记录.csv", "--json"], None);
    assert_eq!(read["rows"], serde_json::json!([["1", "置身事内"], ["2", "人类简史"]]));
    assert_eq!(read["primaryKey"], "id");
    let csv = f.run(&["--read-dataset", "datasets/阅读记录.csv"], None);
    assert!(stdout(&csv).contains("2,人类简史"));
}

#[test]
fn json_errors_carry_codes() {
    let f = Fixture::new();
    let frontmatter = f.run(&["--json"], Some("---\ntitle: x\n---\n正文"));
    assert_eq!(frontmatter.status.code(), Some(1));
    assert_eq!(error_code(&frontmatter), "ERROR");
    assert!(fs::read_dir(&f.vault).unwrap().flatten().all(|entry| entry.file_name() != "fragments"));

    let path = f.fragment(FRAGMENT, "[inbox]", "原文");
    let held = VaultProcessLock::acquire(&f.locks, &f.vault, None).unwrap();
    let locked = f
        .command(&["--append", FRAGMENT, "--json", "追加"])
        .env("SHARD_LOCK_TIMEOUT_MS", "50")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(error_code(&locked), "LOCKED");
    drop(held);
    assert!(fs::read_to_string(&path).unwrap().ends_with("原文\n"));

    let outline = f.fragment(OTHER, "[inbox, outline]", "大纲");
    let protected = f.run(&["--read", OTHER, "--json"], None);
    assert_eq!(error_code(&protected), "NOT_FOUND");
    assert!(String::from_utf8_lossy(&protected.stderr).contains("--graph-read"));
    assert!(outline.exists());

    let edit = f.run(&["-e", FRAGMENT], None);
    assert_eq!(edit.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&edit.stderr).contains("--update"));
}

#[test]
fn guide_and_skill_install() {
    let f = Fixture::new();
    let guide = f.run(&["--agent-guide"], None);
    assert!(stdout(&guide).starts_with("# Shard CLI 使用说明"));

    fs::create_dir_all(f.home.join(".claude")).unwrap();
    let installed = f.run(&["--install-skill"], None);
    assert!(installed.status.success(), "{}", String::from_utf8_lossy(&installed.stderr));
    let skill = fs::read_to_string(f.home.join(".claude/skills/shard/SKILL.md")).unwrap();
    assert!(skill.starts_with("---\nname: shard\n"));
    assert!(skill.contains(&stdout(&guide)));
    assert!(!f.home.join(".codex/skills").exists(), "没有 ~/.codex 时不装");

    let custom = f.home.join("custom-skills");
    let explicit = f.run(&["--install-skill", custom.to_str().unwrap()], None);
    assert!(explicit.status.success());
    assert!(custom.join("shard/SKILL.md").is_file());
}
