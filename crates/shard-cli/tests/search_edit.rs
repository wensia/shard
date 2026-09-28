use shard_core::{frontmatter::parse_fragment, vault_lock::VaultProcessLock};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Output},
};

const FIRST: &str = "20260926-061830-81b8ea9d-a2237f";
const SECOND: &str = "20260926-071830-92c9fba1-b3348e";
const THIRD: &str = "20260926-081830-a3dafcb2-c4459d";

struct Fixture {
    _directory: tempfile::TempDir,
    vault: PathBuf,
    locks: PathBuf,
    state: PathBuf,
    tmp: PathBuf,
    home: PathBuf,
    editor: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let fixture = Self {
            vault: root.join("vault"),
            locks: root.join("locks"),
            state: root.join("state"),
            tmp: root.join("tmp"),
            home: root.join("home"),
            editor: root.join("editor.sh"),
            _directory: directory,
        };
        for path in [
            &fixture.vault,
            &fixture.locks,
            &fixture.state,
            &fixture.tmp,
            &fixture.home,
        ] {
            fs::create_dir_all(path).unwrap();
        }
        fixture.editor("#!/bin/sh\n:\n");
        fixture
    }

    fn path(&self, id: &str) -> PathBuf {
        self.vault.join(format!("fragments/2026/09/{id}.md"))
    }

    fn fragment(&self, id: &str, updated: &str, tags: &str, body: &str) -> PathBuf {
        let path = self.path(id);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("---\nid: {id}\ncreated_at: 2026-09-26T06:18:30Z\nupdated_at: {updated}\ntags: {tags}\ncategory: null\nai_status: none\nsource: test\n---\n\n{body}\n")).unwrap();
        path
    }

    fn editor(&self, script: &str) {
        fs::write(&self.editor, script).unwrap();
        let mut permissions = fs::metadata(&self.editor).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&self.editor, permissions).unwrap();
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_shard-cli"));
        command
            .args(args)
            .env("SHARD_VAULT", &self.vault)
            .env("SHARD_LOCK_DIR", &self.locks)
            .env("SHARD_CLI_STATE_DIR", &self.state)
            .env("TMPDIR", &self.tmp)
            .env("HOME", &self.home)
            .env("EDITOR", &self.editor)
            .env_remove("VISUAL");
        command
    }

    fn edit_body(&self, body: &str) {
        let source = self.tmp.join("edited-body.md");
        fs::write(&source, body).unwrap();
        self.editor("#!/bin/sh\ncat \"$SHARD_TEST_BODY\" > \"$1\"\n");
    }

    fn draft_files(&self) -> Vec<PathBuf> {
        fs::read_dir(&self.tmp)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("shard-")
            })
            .collect()
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).unwrap()
}
fn stderr(output: &Output) -> String {
    String::from_utf8(output.stderr.clone()).unwrap()
}
fn assert_success(output: &Output) {
    assert!(output.status.success(), "{}", stderr(output));
}

#[test]
fn search_ranks_title_and_remembers_vault_and_ids() {
    let f = Fixture::new();
    f.fragment(FIRST, "2026-09-26T06:18:30Z", "[inbox]", "咖啡标题\n正文");
    f.fragment(
        SECOND,
        "2026-09-26T07:18:30Z",
        "[inbox]",
        "普通标题\n咖啡正文",
    );
    f.fragment(THIRD, "2026-09-26T08:18:30Z", "[inbox]", "无关内容");
    let output = f.run(&["--vault", f.vault.to_str().unwrap(), "-s", "咖啡"]);
    assert_success(&output);
    let lines: Vec<_> = stdout(&output).lines().map(str::to_string).collect();
    assert_eq!(lines.len(), 2);
    assert!(lines[0].starts_with('1') && lines[0].contains("81b8ea9d"));
    assert!(lines[1].starts_with('2') && lines[1].contains("92c9fba1"));
    let state: serde_json::Value =
        serde_json::from_slice(&fs::read(f.state.join("last-search.json")).unwrap()).unwrap();
    assert_eq!(state["vault"], f.vault.to_str().unwrap());
    assert_eq!(state["ids"], serde_json::json!([FIRST, SECOND]));
}

#[test]
fn search_and_case_fullwidth_recent_and_limit() {
    let f = Fixture::new();
    f.fragment(FIRST, "2026-09-26T06:18:30Z", "[inbox]", "Shard 咖啡");
    f.fragment(SECOND, "2026-09-26T07:18:30Z", "[inbox]", "shard 茶");
    f.fragment(THIRD, "2026-09-26T08:18:30Z", "[inbox]", "咖啡");
    let both = f.run(&["-s", "Shard", "咖啡"]);
    assert_success(&both);
    assert_eq!(stdout(&both).lines().count(), 1);
    assert!(stdout(&both).contains("81b8ea9d"));
    let ascii = f.run(&["-s", "shard", "--json"]);
    let fullwidth = f.run(&["-s", "ＳＨＡＲＤ", "--json"]);
    assert_success(&ascii);
    assert_success(&fullwidth);
    let ids = |output: &Output| -> Vec<String> {
        serde_json::from_slice::<Vec<serde_json::Value>>(&output.stdout)
            .unwrap()
            .iter()
            .map(|value| value["id"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(ids(&ascii), ids(&fullwidth));
    let recent = f.run(&["-s"]);
    assert_success(&recent);
    assert!(stdout(&recent).lines().next().unwrap().contains("a3dafcb2"));
    let limited = f.run(&["-s", "-n", "1"]);
    assert_success(&limited);
    assert_eq!(stdout(&limited).lines().count(), 1);
}

#[test]
fn search_excludes_trash_hidden_and_graphs_and_handles_empty_json() {
    let f = Fixture::new();
    f.fragment(FIRST, "2026-09-26T06:18:30Z", "[inbox]", "可见 银行");
    f.fragment(
        SECOND,
        "2026-09-26T07:18:30Z",
        "[inbox, outline]",
        "大纲 银行",
    );
    let hidden = f.path(".hidden");
    fs::write(&hidden, fs::read(f.path(FIRST)).unwrap()).unwrap();
    let trash = f.vault.join(".trash/fragments/deleted.md");
    fs::create_dir_all(trash.parent().unwrap()).unwrap();
    fs::write(trash, fs::read(f.path(FIRST)).unwrap()).unwrap();
    let output = f.run(&["-s", "银行", "--json"]);
    assert_success(&output);
    let hits: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(hits.len(), 1);
    let hit = &hits[0];
    for key in [
        "index",
        "id",
        "path",
        "title",
        "kind",
        "tags",
        "createdAt",
        "preview",
    ] {
        assert!(hit.get(key).is_some(), "缺少 {key}");
    }
    assert_eq!(hit["id"], FIRST);
    assert_eq!(hit["kind"], "fragment");
    let empty = f.run(&["-s", "不存在的词", "--json"]);
    assert_success(&empty);
    assert_eq!(stdout(&empty).trim(), "[]");
    let text = f.run(&["-s", "不存在的词"]);
    assert_eq!(text.status.code(), Some(1));
}

#[test]
fn edit_by_index_preserves_frontmatter_bytes_and_removes_draft() {
    let f = Fixture::new();
    f.fragment(FIRST, "2026-09-26T08:18:30Z", "[inbox]", "先命中 咖啡");
    let target = f.path(SECOND);
    fs::write(&target, format!("---\nid: {SECOND}\ncreated_at: 2026-09-26T06:18:30Z\n# 第 0 列注释\nauthor: 张三 # 行尾注释\nupdated_at: 2026-09-26T07:18:30Z\ntags: [inbox, 旧标签]\ncategory: null\nai_status: none\nsource: test\n---\n\n后命中 咖啡\n")).unwrap();
    assert_success(&f.run(&["-s", "咖啡"]));
    f.edit_body("已改正文 #新标签\n");
    let output = f
        .command(&["-e", "2"])
        .env("SHARD_TEST_BODY", f.tmp.join("edited-body.md"))
        .output()
        .unwrap();
    assert_success(&output);
    assert!(stdout(&output).contains(&format!("已保存：fragments/2026/09/{SECOND}.md")));
    let text = fs::read_to_string(&target).unwrap();
    assert!(text.ends_with("已改正文 #新标签\n"));
    assert!(text.contains(&format!(
        "id: {SECOND}\ncreated_at: 2026-09-26T06:18:30Z\n# 第 0 列注释\nauthor: 张三 # 行尾注释\n"
    )));
    let parsed = parse_fragment(&text).unwrap();
    assert_eq!(parsed.frontmatter.tags, vec!["inbox", "新标签"]);
    assert_ne!(parsed.frontmatter.updated_at, "2026-09-26T07:18:30Z");
    assert!(f.draft_files().is_empty());
}

#[test]
fn unchanged_and_document_type() {
    let f = Fixture::new();
    let path = f.fragment(
        FIRST,
        "2026-09-26T06:18:30Z",
        "[document, inbox]",
        "# 标题\n内容",
    );
    let before = fs::read(&path).unwrap();
    let unchanged = f.run(&["-e", FIRST]);
    assert_success(&unchanged);
    assert!(stdout(&unchanged).contains("没有改动"));
    assert_eq!(fs::read(&path).unwrap(), before);
    f.edit_body("# 标题\n新内容 #note #读书\n");
    let changed = f
        .command(&["-e", FIRST])
        .env("SHARD_TEST_BODY", f.tmp.join("edited-body.md"))
        .output()
        .unwrap();
    assert_success(&changed);
    assert_eq!(
        parse_fragment(&fs::read_to_string(path).unwrap())
            .unwrap()
            .frontmatter
            .tags,
        vec!["document", "inbox", "读书"]
    );
}

#[test]
fn rejects_lockbox_and_empty_body() {
    let f = Fixture::new();
    let path = f.fragment(FIRST, "2026-09-26T06:18:30Z", "[inbox]", "原文");
    let before = fs::read(&path).unwrap();
    f.edit_body("私密 #密匣\n");
    let rejected = f
        .command(&["-e", FIRST])
        .env("SHARD_TEST_BODY", f.tmp.join("edited-body.md"))
        .output()
        .unwrap();
    assert_eq!(rejected.status.code(), Some(1));
    assert!(stderr(&rejected).contains("你的修改保存在："));
    assert_eq!(f.draft_files().len(), 1);
    assert_eq!(fs::read(&path).unwrap(), before);
    f.edit_body("");
    let empty = f
        .command(&["-e", FIRST])
        .env("SHARD_TEST_BODY", f.tmp.join("edited-body.md"))
        .output()
        .unwrap();
    assert_eq!(empty.status.code(), Some(1));
    assert!(stderr(&empty).contains("内容为空"));
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn conflict_preserves_external_change_and_draft() {
    let f = Fixture::new();
    let path = f.fragment(FIRST, "2026-09-26T06:18:30Z", "[inbox]", "原文");
    f.edit_body("我的修改\n");
    f.editor("#!/bin/sh\ncat \"$SHARD_TEST_BODY\" > \"$1\"\nprintf '外部追加\\n' >> \"$SHARD_TEST_SOURCE\"\n");
    let output = f
        .command(&["-e", FIRST])
        .env("SHARD_TEST_BODY", f.tmp.join("edited-body.md"))
        .env("SHARD_TEST_SOURCE", &path)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(stderr(&output).contains("你的修改保存在："));
    assert!(fs::read_to_string(&path)
        .unwrap()
        .ends_with("原文\n外部追加\n"));
    assert_eq!(f.draft_files().len(), 1);
}

#[test]
fn held_lock_and_editor_failure_do_not_write() {
    let f = Fixture::new();
    let path = f.fragment(FIRST, "2026-09-26T06:18:30Z", "[inbox]", "原文");
    let before = fs::read(&path).unwrap();
    f.edit_body("我的修改\n");
    let held = VaultProcessLock::acquire(&f.locks, &f.vault, None).unwrap();
    let blocked = f
        .command(&["-e", FIRST])
        .env("SHARD_TEST_BODY", f.tmp.join("edited-body.md"))
        .env("SHARD_LOCK_TIMEOUT_MS", "200")
        .output()
        .unwrap();
    assert_eq!(blocked.status.code(), Some(1));
    assert!(stderr(&blocked).contains("Shard 正在写入资料库，请稍后重试"));
    assert!(stderr(&blocked).contains("你的修改保存在："));
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(f.draft_files().len(), 1);
    drop(held);
    f.editor("#!/bin/sh\nexit 9\n");
    let failed = f.run(&["-e", FIRST]);
    assert_eq!(failed.status.code(), Some(1));
    assert_eq!(fs::read(path).unwrap(), before);
    assert_eq!(f.draft_files().len(), 1);
}

#[test]
fn select_id_keyword_ambiguity_and_recent() {
    let f = Fixture::new();
    let first = f.fragment(FIRST, "2026-09-26T06:18:30Z", "[inbox]", "银行 第一条");
    let second = f.fragment(SECOND, "2026-09-26T07:18:30Z", "[inbox]", "银行 第二条");
    let third = f.fragment(THIRD, "2026-09-26T08:18:30Z", "[inbox]", "唯一关键词");
    f.edit_body("银行 编辑后\n");
    let edit = |args: &[&str]| {
        f.command(args)
            .env("SHARD_TEST_BODY", f.tmp.join("edited-body.md"))
            .output()
            .unwrap()
    };
    assert_success(&edit(&["-e", "81b8"]));
    assert!(fs::read_to_string(&first).unwrap().contains("编辑后"));
    f.edit_body("编辑后\n");
    assert_success(&edit(&["-e", "唯一关键词"]));
    assert!(fs::read_to_string(&third).unwrap().contains("编辑后"));
    let ambiguous = f.run(&["-e", "银行"]);
    assert_eq!(ambiguous.status.code(), Some(1));
    assert!(stderr(&ambiguous).contains("匹配到 2 条"));
    assert!(stderr(&ambiguous).contains("81b8ea9d"));
    f.edit_body("二次编辑\n");
    assert_success(&edit(&["-e", "1"]));
    assert!(fs::read_to_string(&first).unwrap().contains("二次编辑"));
    assert!(fs::read_to_string(&second).unwrap().contains("银行 第二条"));
    f.editor("#!/bin/sh\n:\n");
    let recent = f.run(&["-e"]);
    assert_success(&recent);
    assert!(stdout(&recent).contains("没有改动"));
    assert!(stderr(&recent).contains("编辑 81b8ea9d"));
}

#[test]
fn index_other_vault_and_out_of_range_fall_back_without_wrong_missing_error() {
    let f = Fixture::new();
    f.fragment(FIRST, "2026-09-26T06:18:30Z", "[inbox]", "搜索词");
    assert_success(&f.run(&["-s", "搜索词"]));
    let outside = f.tmp.join("other-vault");
    let outside_fragment = outside.join(format!("fragments/2026/09/{SECOND}.md"));
    fs::create_dir_all(outside_fragment.parent().unwrap()).unwrap();
    fs::write(
        &outside_fragment,
        fs::read_to_string(f.path(FIRST))
            .unwrap()
            .replace(FIRST, SECOND),
    )
    .unwrap();
    let other = f
        .command(&["-e", "1", "--vault", outside.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(other.status.code(), Some(1));
    assert!(!stderr(&other).contains("上次搜索的第 1 条已不存在"));
    let out_of_range = f.run(&["-e", "2"]);
    assert_eq!(out_of_range.status.code(), Some(1));
    assert!(!stderr(&out_of_range).contains("上次搜索的第 2 条已不存在"));
}

#[test]
fn rejects_outline_and_keeps_capture_commands() {
    let f = Fixture::new();
    let outline = f.fragment(
        FIRST,
        "2026-09-26T06:18:30Z",
        "[inbox, outline]",
        "大纲内容",
    );
    let before = fs::read(&outline).unwrap();
    let rejected = f.run(&["-e", FIRST]);
    assert_eq!(rejected.status.code(), Some(1));
    assert!(
        stderr(&rejected).contains("还没有可编辑的碎片") || stderr(&rejected).contains("没有找到")
    );
    assert_eq!(fs::read(outline).unwrap(), before);
    assert_success(&f.run(&["今天心情很好"]));
    assert_success(&f.run(&["search", "银行"]));
    let files = fs::read_dir(f.vault.join("fragments/2026/09"))
        .unwrap()
        .flatten()
        .map(|entry| fs::read_to_string(entry.path()).unwrap())
        .collect::<Vec<_>>();
    assert!(files.iter().any(|text| text.contains("今天心情很好")));
    assert!(files.iter().any(|text| text.contains("search 银行")));
}
