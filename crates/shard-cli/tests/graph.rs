use shard_core::{
    frontmatter::parse_fragment,
    graph_model::{content_sha256_hex, CanvasFile, ShardMapFile},
    graph_region::{find_region, GraphRegionKind},
    vault_lock::VaultProcessLock,
};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Output, Stdio},
};

struct Fixture {
    _directory: tempfile::TempDir,
    vault: PathBuf,
    lock_dir: PathBuf,
    outline_path: PathBuf,
    flowchart_path: PathBuf,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let vault = directory.path().join("vault");
    let lock_dir = directory.path().join("locks");
    let fragments = vault.join("fragments/2026/09");
    fs::create_dir_all(&fragments).unwrap();
    let outline_path = fragments.join("outline-1.md");
    let flowchart_path = fragments.join("flow-1.md");
    fs::write(
        &outline_path,
        format!(
            "---\nid: outline-1\ncreated_at: 2026-09-28T00:00:00Z\n# 未知字段必须保留\nauthor: '00123'\nupdated_at: 2026-09-28T00:00:00Z\ntags: [inbox, outline]\ncategory: null\nai_status: none\nsource: test\n---\n\n区域前正文\n{}\n区域后正文\n",
            outline_json()
        ),
    )
    .unwrap();
    fs::write(
        &flowchart_path,
        format!(
            "---\nid: flow-1\ncreated_at: 2026-09-28T00:00:00Z\nupdated_at: 2026-09-28T00:00:00Z\ntags: [inbox, flowchart]\ncategory: null\nai_status: none\nsource: test\n---\n\n{}\n",
            flowchart_json()
        ),
    )
    .unwrap();
    Fixture {
        _directory: directory,
        vault,
        lock_dir,
        outline_path,
        flowchart_path,
    }
}

fn outline_json() -> String {
    let graph = serde_json::json!({
        "kind": "shard.map",
        "schemaVersion": 1,
        "id": "outline-1",
        "title": "根",
        "createdAt": "2026-09-28T00:00:00Z",
        "updatedAt": "2026-09-28T00:00:00Z",
        "savedWithAppVersion": "test",
        "revision": 4,
        "rootId": "root",
        "hasProtectedLinks": false,
        "nodes": {
            "root": {
                "id": "root",
                "parentId": null,
                "sortKey": "U",
                "text": "根",
                "createdAt": "2026-09-28T00:00:00Z",
                "updatedAt": "2026-09-28T00:00:00Z"
            },
            "child": {
                "id": "child",
                "parentId": "root",
                "sortKey": "U",
                "text": "第一行\n第二行",
                "createdAt": "2026-09-28T00:00:00Z",
                "updatedAt": "2026-09-28T00:00:00Z"
            }
        }
    });
    format!(
        "```shardmap\n{}\n```",
        serde_json::to_string_pretty(&graph).unwrap()
    )
}

fn flowchart_json() -> String {
    let graph = serde_json::json!({
        "kind": "shard.flow",
        "schemaVersion": 1,
        "id": "flow-1",
        "title": "流程",
        "createdAt": "2026-09-28T00:00:00Z",
        "updatedAt": "2026-09-28T00:00:00Z",
        "revision": 2,
        "nodes": [{
            "id": "step",
            "kind": "process",
            "x": 0.30000000000000004,
            "y": 1.5,
            "text": "开始"
        }],
        "edges": []
    });
    format!(
        "```shardflow\n{}\n```",
        serde_json::to_string_pretty(&graph).unwrap()
    )
}

fn cli(fixture: &Fixture, args: &[&str], input: Option<&str>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_shard-cli"));
    command
        .arg("--vault")
        .arg(&fixture.vault)
        .args(args)
        .env("SHARD_LOCK_DIR", &fixture.lock_dir)
        .env("SHARD_LOCK_TIMEOUT_MS", "100")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn().unwrap();
    if let Some(input) = input {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
    }
    child.wait_with_output().unwrap()
}

fn success_json(fixture: &Fixture, args: &[&str], input: Option<&str>) -> serde_json::Value {
    let output = cli(fixture, args, input);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn read(fixture: &Fixture, id: &str) -> serde_json::Value {
    success_json(fixture, &["--graph-read", id], None)
}

fn assert_graph_files_parse(fixture: &Fixture) {
    let outline_text = fs::read_to_string(&fixture.outline_path).unwrap();
    let outline = parse_fragment(&outline_text).unwrap();
    let outline_region = find_region(&outline.body, GraphRegionKind::Outline).unwrap();
    serde_json::from_str::<ShardMapFile>(&outline_region.json_text).unwrap();

    let flowchart_text = fs::read_to_string(&fixture.flowchart_path).unwrap();
    let flowchart = parse_fragment(&flowchart_text).unwrap();
    let flowchart_region = find_region(&flowchart.body, GraphRegionKind::Flowchart).unwrap();
    serde_json::from_str::<CanvasFile>(&flowchart_region.json_text).unwrap();
}

#[test]
fn reads_json_and_exports_outline() {
    let fixture = fixture();
    let result = read(&fixture, "outline-1");
    assert_eq!(result["id"], "outline-1");
    assert_eq!(result["kind"], "outline");
    assert_eq!(result["graph"]["nodes"]["child"]["text"], "第一行\n第二行");
    assert_eq!(
        result["fileSha"],
        content_sha256_hex(&fs::read_to_string(&fixture.outline_path).unwrap())
    );

    let outline = cli(&fixture, &["--graph-outline", "outline-1"], None);
    assert!(outline.status.success());
    assert_eq!(
        String::from_utf8(outline.stdout).unwrap(),
        "- 根\n  - 第一行 第二行\n"
    );

    let rejected = cli(&fixture, &["--graph-outline", "flow-1"], None);
    assert_eq!(rejected.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("目标不是大纲"));
}

#[test]
fn writes_full_graph_and_mutates_nodes_while_preserving_fragment_bytes() {
    let fixture = fixture();
    let before = fs::read_to_string(&fixture.outline_path).unwrap();
    let initial = read(&fixture, "outline-1");

    let set = success_json(
        &fixture,
        &[
            "--graph-set-text",
            "outline-1",
            "child",
            "改写",
            "--expect",
            initial["fileSha"].as_str().unwrap(),
        ],
        None,
    );
    let after_set = fs::read_to_string(&fixture.outline_path).unwrap();
    assert!(after_set.contains("# 未知字段必须保留\nauthor: '00123'"));
    let before_parsed = parse_fragment(&before).unwrap();
    let before_region = find_region(&before_parsed.body, GraphRegionKind::Outline).unwrap();
    let after_parsed = parse_fragment(&after_set).unwrap();
    let after_region = find_region(&after_parsed.body, GraphRegionKind::Outline).unwrap();
    assert_eq!(
        &before_parsed.body[..before_region.range.start],
        &after_parsed.body[..after_region.range.start]
    );
    assert_eq!(
        &before_parsed.body[before_region.range.end..],
        &after_parsed.body[after_region.range.end..]
    );
    assert_ne!(before, after_set);
    assert_eq!(set["fileSha"], content_sha256_hex(&after_set));
    assert_eq!(
        read(&fixture, "outline-1")["graph"]["nodes"]["child"]["text"],
        "改写"
    );
    assert_eq!(
        read(&fixture, "outline-1")["graph"]["nodes"]["child"]["updatedAt"],
        "2026-09-28T00:00:00Z"
    );

    let added = success_json(
        &fixture,
        &[
            "--graph-add-child",
            "outline-1",
            "child",
            "孙节点",
            "--expect",
            set["fileSha"].as_str().unwrap(),
        ],
        None,
    );
    let node_id = added["nodeId"].as_str().unwrap();
    assert_eq!(
        read(&fixture, "outline-1")["graph"]["nodes"][node_id]["text"],
        "孙节点"
    );

    let removed = success_json(
        &fixture,
        &[
            "--graph-remove",
            "outline-1",
            "child",
            "--expect",
            added["fileSha"].as_str().unwrap(),
        ],
        None,
    );
    let after_remove = read(&fixture, "outline-1");
    assert!(after_remove["graph"]["nodes"].get("child").is_none());
    assert!(after_remove["graph"]["nodes"].get(node_id).is_none());
    assert_eq!(removed["fileSha"], after_remove["fileSha"]);

    let mut graph = after_remove["graph"].clone();
    graph["title"] = "完整写入".into();
    graph["revision"] = 0.into();
    graph["savedWithAppVersion"] = "external".into();
    let written = success_json(
        &fixture,
        &[
            "--graph-write",
            "outline-1",
            "--expect",
            removed["fileSha"].as_str().unwrap(),
        ],
        Some(&serde_json::to_string(&graph).unwrap()),
    );
    let final_read = read(&fixture, "outline-1");
    assert_eq!(final_read["graph"]["title"], "完整写入");
    assert_eq!(final_read["graph"]["revision"], 8);
    assert_eq!(final_read["graph"]["savedWithAppVersion"], "external");
    assert_eq!(written["fileSha"], final_read["fileSha"]);
    assert_graph_files_parse(&fixture);
}

#[test]
fn updates_flowchart_text_and_full_json() {
    let fixture = fixture();
    let initial = read(&fixture, "flow-1");
    let updated = success_json(
        &fixture,
        &[
            "--graph-set-text",
            "flow-1",
            "step",
            "结束",
            "--expect",
            initial["fileSha"].as_str().unwrap(),
        ],
        None,
    );
    let read_back = read(&fixture, "flow-1");
    assert_eq!(read_back["graph"]["nodes"][0]["text"], "结束");
    assert_eq!(
        read_back["graph"]["nodes"][0]["x"].as_f64(),
        Some(0.1 + 0.2)
    );

    let mut graph = read_back["graph"].clone();
    graph["title"] = "完整流程".into();
    let written = success_json(
        &fixture,
        &[
            "--graph-write",
            "flow-1",
            "--expect",
            updated["fileSha"].as_str().unwrap(),
        ],
        Some(&serde_json::to_string(&graph).unwrap()),
    );
    let final_read = read(&fixture, "flow-1");
    assert_eq!(final_read["graph"]["title"], "完整流程");
    assert_eq!(final_read["graph"]["revision"], 4);
    assert_eq!(written["fileSha"], final_read["fileSha"]);
    assert_graph_files_parse(&fixture);
}

#[test]
fn rejects_stale_sha_wrong_type_root_removal_and_archived_writes() {
    let fixture = fixture();
    let bytes = fs::read(&fixture.outline_path).unwrap();
    let stale = cli(
        &fixture,
        &[
            "--graph-set-text",
            "outline-1",
            "child",
            "不应写入",
            "--expect",
            "stale",
        ],
        None,
    );
    assert_eq!(stale.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&stale.stderr).contains("文件已被修改，请重新读取"));
    assert_eq!(fs::read(&fixture.outline_path).unwrap(), bytes);

    let mismatched = fs::read_to_string(&fixture.outline_path)
        .unwrap()
        .replace("\"id\": \"outline-1\"", "\"id\": \"other-outline\"");
    fs::write(&fixture.outline_path, &mismatched).unwrap();
    let mismatched_sha = content_sha256_hex(&mismatched);
    let rejected = cli(
        &fixture,
        &[
            "--graph-set-text",
            "outline-1",
            "child",
            "不应写入",
            "--expect",
            &mismatched_sha,
        ],
        None,
    );
    assert_eq!(rejected.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("id 或类型与碎片不一致"));
    assert_eq!(
        fs::read_to_string(&fixture.outline_path).unwrap(),
        mismatched
    );
    fs::write(&fixture.outline_path, &bytes).unwrap();

    let flow = read(&fixture, "flow-1");
    let wrong_type = cli(
        &fixture,
        &[
            "--graph-add-child",
            "flow-1",
            "step",
            "无效",
            "--expect",
            flow["fileSha"].as_str().unwrap(),
        ],
        None,
    );
    assert_eq!(wrong_type.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&wrong_type.stderr).contains("只有大纲支持添加子节点"));

    let outline = read(&fixture, "outline-1");
    let root = cli(
        &fixture,
        &[
            "--graph-remove",
            "outline-1",
            "root",
            "--expect",
            outline["fileSha"].as_str().unwrap(),
        ],
        None,
    );
    assert_eq!(root.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&root.stderr).contains("不能删除大纲根节点"));

    let trash = fixture.vault.join(".trash/fragments/archived.md");
    fs::create_dir_all(trash.parent().unwrap()).unwrap();
    fs::write(&trash, fs::read(&fixture.outline_path).unwrap()).unwrap();
    fs::remove_file(&fixture.outline_path).unwrap();
    let archived = read(&fixture, "outline-1");
    let rejected = cli(
        &fixture,
        &[
            "--graph-set-text",
            "outline-1",
            "child",
            "不应写入",
            "--expect",
            archived["fileSha"].as_str().unwrap(),
        ],
        None,
    );
    assert_eq!(rejected.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("找不到公开片段"));
}

#[test]
fn write_commands_require_expect_and_time_out_on_held_lock() {
    let fixture = fixture();
    let missing_expect = cli(
        &fixture,
        &["--graph-set-text", "outline-1", "child", "无效"],
        None,
    );
    assert_eq!(missing_expect.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&missing_expect.stderr).contains("必须带 --expect"));

    let before = fs::read(&fixture.outline_path).unwrap();
    let read = read(&fixture, "outline-1");
    let _held = VaultProcessLock::acquire(&fixture.lock_dir, &fixture.vault, None).unwrap();
    let unlocked_read = cli(&fixture, &["--graph-read", "outline-1"], None);
    assert!(
        unlocked_read.status.success(),
        "{}",
        String::from_utf8_lossy(&unlocked_read.stderr)
    );
    let blocked = cli(
        &fixture,
        &[
            "--graph-set-text",
            "outline-1",
            "child",
            "不应写入",
            "--expect",
            read["fileSha"].as_str().unwrap(),
        ],
        None,
    );
    assert_eq!(blocked.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("Shard 正在写入资料库，请稍后重试"));
    assert_eq!(fs::read(&fixture.outline_path).unwrap(), before);
}
