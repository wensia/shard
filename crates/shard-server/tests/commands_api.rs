//! 公开内容命令经 HTTP 的端到端测试：先把一个小的旧 vault 导入内容库，再按网页端的参数调用，
//! 核对返回形状（驼峰键名与桌面 DTO 一致）、冲突与幂等、密匣拦截。
//! 运行：`cargo test -p shard-server --features test-auth`。
#![cfg(feature = "test-auth")]

use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
};

use axum::{
    body::Body,
    http::{header, HeaderMap, Method, Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use shard_server::{app, commands, config::Config, rpc::base_registry, state::AppState};
use tower::ServiceExt;

const ORIGIN: &str = "http://localhost:18788";
const PUBLIC_ID: &str = "20261001-090000-aaaaaaaa-000001";
const PINNED_ID: &str = "20260901-080000-eeeeeeee-000005";
const TRASHED_ID: &str = "20260901-090000-bbbbbbbb-000002";
const LOCKBOX_ID: &str = "20261002-090000-cccccccc-000003";
const PLAN_ID: &str = "20261005-090000-dddddddd-000006";
/// 1×1 PNG。
const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

fn write(root: &Path, rel: &str, bytes: &[u8]) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
}

fn fragment(id: &str, created_at: &str, tags: &[&str], extra: &str, body: &str) -> String {
    let tags = tags.iter().map(|tag| format!("- {tag}\n")).collect::<String>();
    format!(
        "---\nid: {id}\ncreated_at: {created_at}\nupdated_at: {created_at}\ntags:\n{tags}category: null\nai_status: none\n{extra}source: desktop\n---\n\n{body}"
    )
}

/// 小的旧 vault：公开碎片（含置顶、回收站里的）、两篇互相引用的笔记、命名图片、GBK CSV、
/// 密匣 manifest 与一条密匣信封。
fn sample_vault(root: &Path) {
    write(root, ".shard/format.json", br#"{"markdownDialect":2}"#);
    write(root, ".shard/lockbox.json", b"{\n  \"version\": 1\n}\n");
    write(root, "datasets/.gitattributes", b"*.csv merge=binary\n");
    write(
        root,
        &format!("fragments/2026/10/{PUBLIC_ID}.md"),
        fragment(PUBLIC_ID, "2026-10-01T09:00:00+08:00", &["inbox"], "", "碎片正文 #读书\n").as_bytes(),
    );
    write(
        root,
        &format!("fragments/2026/09/{PINNED_ID}.md"),
        fragment(PINNED_ID, "2026-09-01T08:00:00+08:00", &["inbox"], "pinned: true\n", "置顶的旧碎片\n").as_bytes(),
    );
    write(
        root,
        &format!(".trash/fragments/2026/09/{TRASHED_ID}.md"),
        fragment(TRASHED_ID, "2026-09-01T09:00:00+08:00", &["inbox"], "", "归档的\n").as_bytes(),
    );
    write(
        root,
        "notes/项目/计划.md",
        fragment(PLAN_ID, "2026-10-05T09:00:00+08:00", &["inbox", "note"], "", "# 计划\n\n先读 [[参考资料]]。\n").as_bytes(),
    );
    write(
        root,
        "notes/项目/参考资料.md",
        fragment("20261005-100000-ffffffff-000007", "2026-10-05T10:00:00+08:00", &["inbox", "note"], "", "# 参考资料\n")
            .as_bytes(),
    );
    write(root, "notes/证件/图.png", PNG);
    // GBK 编码：只读，可转换。
    write(root, "datasets/旧表.csv", b"\xca\xe9\xc3\xfb,\xc8\xd5\xc6\xda\r\n\xd6\xc3\xc9\xed,2026\r\n");
    write(
        root,
        &format!("lockbox/fragments/2026/10/{LOCKBOX_ID}.shard"),
        format!("{{\n  \"version\": 1,\n  \"id\": \"{LOCKBOX_ID}\",\n  \"nonce\": \"n\",\n  \"ciphertext\": \"c\"\n}}\n")
            .as_bytes(),
    );
}

struct Harness {
    _dirs: (tempfile::TempDir, tempfile::TempDir),
    app: Router,
    cookie: String,
    keys: AtomicUsize,
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

impl Harness {
    async fn new() -> Self {
        let source = tempfile::tempdir().unwrap();
        sample_vault(source.path());
        let data = tempfile::tempdir().unwrap();
        let config = Config::new(data.path().to_path_buf(), ORIGIN, None, false).unwrap();
        let mut registry = base_registry();
        commands::register(&mut registry);
        let state = AppState::open(config, registry).unwrap();
        shard_store::transfer::import_vault(&state.store, source.path()).unwrap();
        commands::ensure_layout(&state.store).unwrap();
        let app = app::build(state);
        let response = app
            .clone()
            .oneshot(Request::post("/api/test/session").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_string();
        Self { _dirs: (source, data), app, cookie, keys: AtomicUsize::new(0) }
    }

    fn browser(&self, method: Method, uri: &str) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(header::COOKIE, &self.cookie)
            .header("x-shard-request", "1")
            .header(header::ORIGIN, ORIGIN)
            .header("sec-fetch-site", "same-origin")
    }

    async fn send(&self, request: Request<Body>) -> Reply {
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        Reply { status, headers, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null) }
    }

    /// 与网页端 `httpTransport` 一样：每次调用一个新的幂等键，北京时间。
    async fn call_with_key(&self, command: &str, key: &str, args: Value) -> Reply {
        let request = self
            .browser(Method::POST, &format!("/api/rpc/{command}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header("idempotency-key", key)
            .header("x-shard-utc-offset", "480")
            .body(Body::from(args.to_string()))
            .unwrap();
        self.send(request).await
    }

    async fn call(&self, command: &str, args: Value) -> Reply {
        let key = format!("key-{}", self.keys.fetch_add(1, Ordering::Relaxed));
        self.call_with_key(command, &key, args).await
    }

    /// 期望成功，返回结果。
    async fn ok(&self, command: &str, args: Value) -> Value {
        let reply = self.call(command, args).await;
        assert_eq!(reply.status, StatusCode::OK, "{command} 失败：{}", reply.body);
        reply.body
    }

    async fn put_blob(&self, bytes: &[u8]) -> String {
        let sha = shard_core::sha256_hex(bytes);
        let reply =
            self.send(self.browser(Method::PUT, &format!("/api/blobs/{sha}")).body(Body::from(bytes.to_vec())).unwrap()).await;
        assert_eq!(reply.status, StatusCode::CREATED);
        sha
    }

    async fn manifest_paths(&self) -> Vec<String> {
        let reply = self.send(self.browser(Method::GET, "/api/sync/manifest").body(Body::empty()).unwrap()).await;
        reply.body["entries"].as_array().unwrap().iter().map(|entry| entry["path"].as_str().unwrap().to_string()).collect()
    }

    async fn fragment(&self, id: &str) -> Value {
        let state = self.ok("list_fragments", json!({})).await;
        state["fragments"].as_array().unwrap().iter().find(|fragment| fragment["id"] == id).cloned().unwrap_or(Value::Null)
    }
}

fn keys(value: &Value) -> Vec<&str> {
    let mut keys: Vec<&str> = value.as_object().expect("应当是对象").keys().map(String::as_str).collect();
    keys.sort_unstable();
    keys
}

/// 桌面 `Fragment` 的 JSON 键（`conflictOf` 为空时省略）。
const FRAGMENT_KEYS: &[&str] = &[
    "aiStatus", "archived", "category", "content", "createdAt", "error", "fileSha", "gitStatus", "id", "lockbox", "path",
    "pinned", "properties", "related", "tags", "updatedAt",
];

fn assert_library_mutation(value: &Value) {
    let mut expected = vec!["tree", "updatedImageRefs", "updatedLinks"];
    if value.get("fragment").is_some() {
        expected.push("fragment");
        expected.sort_unstable();
    }
    assert_eq!(keys(value), expected);
    assert_eq!(
        keys(&value["tree"]),
        ["assets", "entries", "fragmentEntries", "fragmentStream", "fragmentTrashEntries", "trashEntries"]
    );
}

/// 资料库树里按路径找条目（递归进目录）。
fn find_entry<'a>(entries: &'a Value, path: &str) -> Option<&'a Value> {
    entries.as_array()?.iter().find_map(|entry| {
        if entry["path"] == path {
            Some(entry)
        } else {
            entry.get("children").and_then(|children| find_entry(children, path))
        }
    })
}

#[tokio::test]
async fn list_fragments_matches_the_desktop_vault_state() {
    let h = Harness::new().await;
    let state = h.ok("list_fragments", json!({})).await;
    assert_eq!(keys(&state), ["fragments", "git", "lockbox", "vaultPath"]);
    assert!(state["vaultPath"].as_str().unwrap().starts_with("shard://localhost/"));
    assert_eq!(
        state["git"],
        json!({ "branch": "main", "shortCommit": "no git", "hasRemote": false, "status": "no_git", "error": null, "ahead": 0, "behind": 0 })
    );
    // 服务器上密匣永远锁着；manifest 在就算已设置。ttlSeconds 与桌面 LOCKBOX_TTL 一致。
    assert_eq!(state["lockbox"], json!({ "configured": true, "unlocked": false, "expiresAt": null, "ttlSeconds": 900 }));

    let fragments = state["fragments"].as_array().unwrap();
    let ids: Vec<&str> = fragments.iter().map(|fragment| fragment["id"].as_str().unwrap()).collect();
    // 置顶在前，其余按创建时间从新到旧；密匣条目不出现。
    assert_eq!(ids[0], PINNED_ID);
    assert!(!ids.contains(&LOCKBOX_ID));
    for id in [PUBLIC_ID, TRASHED_ID, PLAN_ID] {
        assert!(ids.contains(&id), "缺少 {id}");
    }
    let public = fragments.iter().find(|fragment| fragment["id"] == PUBLIC_ID).unwrap();
    assert_eq!(keys(public), FRAGMENT_KEYS);
    assert_eq!(public["path"], format!("fragments/2026/10/{PUBLIC_ID}.md"));
    assert_eq!(public["lockbox"], false);
    let trashed = fragments.iter().find(|fragment| fragment["id"] == TRASHED_ID).unwrap();
    assert_eq!(trashed["archived"], true);

    // 内容库只有方言 v2：网页端读列表前的迁移询问直接得到「不用迁移」。
    assert_eq!(h.ok("list_markdown_dialect_migration", json!({})).await, json!({ "dialect": 2, "sources": [] }));
}

#[tokio::test]
async fn create_and_update_fragments_with_conflicts_and_idempotent_replay() {
    let h = Harness::new().await;
    let before = h.ok("list_fragments", json!({})).await["fragments"].as_array().unwrap().len();

    let args = json!({ "content": "  网页端新建  ", "tags": ["读书"] });
    let first = h.call_with_key("create_fragment", "create-once", args.clone()).await;
    assert_eq!(first.status, StatusCode::OK);
    let created = first.body;
    assert_eq!(keys(&created), FRAGMENT_KEYS);
    assert_eq!(created["content"], "网页端新建\n");
    assert_eq!(created["tags"], json!(["inbox", "读书"]));
    let id = created["id"].as_str().unwrap().to_string();
    // 按客户端时区（+08:00）算 id 与月份目录。
    assert!(created["createdAt"].as_str().unwrap().ends_with("+08:00"));
    assert!(created["path"].as_str().unwrap().starts_with("fragments/"));

    // 同一个幂等键重试：原样返回，不再建第二条。
    let again = h.call_with_key("create_fragment", "create-once", args).await;
    assert_eq!(again.status, StatusCode::OK);
    assert_eq!(again.headers["idempotent-replayed"], "true");
    assert_eq!(again.body, created);
    let after = h.ok("list_fragments", json!({})).await["fragments"].as_array().unwrap().len();
    assert_eq!(after, before + 1);

    // 带正确的保存基线保存。
    let saved = h
        .ok(
            "update_fragment",
            json!({ "id": id, "content": "改过的正文", "tags": ["读书", "想法"], "expectedFileSha": created["fileSha"] }),
        )
        .await;
    assert_eq!(saved["content"], "改过的正文\n");
    assert_ne!(saved["fileSha"], created["fileSha"]);

    // 旧基线：409 STALE_BASE，前端按前缀进入冲突流程；文件不变。
    let stale = h
        .call("update_fragment", json!({ "id": id, "content": "覆盖", "tags": [], "expectedFileSha": created["fileSha"] }))
        .await;
    assert_eq!(stale.status, StatusCode::CONFLICT);
    assert_eq!(stale.body["code"], "STALE_BASE");
    assert!(stale.body["message"].as_str().unwrap().starts_with("STALE_BASE:"));
    assert_eq!(h.fragment(&id).await["content"], "改过的正文\n");

    // 不带基线（expectedFileSha 省略）与桌面一样不校验。
    let tags_only = h.ok("update_fragment_tags", json!({ "id": id, "tags": ["想法"] })).await;
    assert_eq!(tags_only["tags"], json!(["想法"]));
    let pinned = h.ok("set_fragment_pinned", json!({ "id": id, "pinned": true })).await;
    assert_eq!(pinned["pinned"], true);
    let archived = h.ok("set_fragment_archived", json!({ "id": id, "archived": true })).await;
    assert_eq!(archived["archived"], true);
    assert!(archived["path"].as_str().unwrap().starts_with(".trash/fragments/"));

    // 空正文与桌面同一条报错。
    let empty = h.call("update_fragment", json!({ "id": PUBLIC_ID, "content": "  " })).await;
    assert_eq!(empty.status, StatusCode::BAD_REQUEST);
    assert_eq!(empty.body["message"], "片段内容不能为空");
    // 参数缺键：400 INVALID_ARGS。
    let missing = h.call("set_fragment_pinned", json!({ "id": PUBLIC_ID })).await;
    assert_eq!(missing.status, StatusCode::BAD_REQUEST);
    assert_eq!(missing.body["code"], "INVALID_ARGS");
}

#[tokio::test]
async fn lockbox_branches_are_rejected_without_touching_content() {
    let h = Harness::new().await;
    let original = h.fragment(PUBLIC_ID).await;
    let expect_lockbox = |reply: Reply| {
        assert_eq!(reply.status, StatusCode::CONFLICT, "{}", reply.body);
        assert_eq!(reply.body["code"], "LOCKBOX_UNAVAILABLE");
        assert_eq!(reply.body["message"], "密匣内容暂时只能在桌面端处理。");
    };
    // 新标签含密匣：桌面会把公开碎片整体移进密匣。
    expect_lockbox(h.call("update_fragment_tags", json!({ "id": PUBLIC_ID, "tags": ["密匣"] })).await);
    expect_lockbox(
        h.call(
            "update_fragment",
            json!({ "id": PUBLIC_ID, "content": "要藏起来", "tags": ["密匣"], "expectedFileSha": original["fileSha"] }),
        )
        .await,
    );
    expect_lockbox(h.call("create_fragment", json!({ "content": "私密", "tags": ["密匣"] })).await);
    expect_lockbox(h.call("move_fragment_to_lockbox", json!({ "id": PUBLIC_ID })).await);
    // 目标本身是密匣条目。
    expect_lockbox(h.call("update_fragment", json!({ "id": LOCKBOX_ID, "content": "x" })).await);
    expect_lockbox(h.call("set_fragment_pinned", json!({ "id": LOCKBOX_ID, "pinned": true })).await);
    expect_lockbox(h.call("set_fragment_archived", json!({ "id": LOCKBOX_ID, "archived": true })).await);
    expect_lockbox(
        h.call("set_fragment_property", json!({ "id": LOCKBOX_ID, "key": "rating", "value": { "type": "number", "value": "3" } }))
            .await,
    );
    expect_lockbox(h.call("remove_fragment_property", json!({ "id": LOCKBOX_ID, "key": "rating" })).await);
    assert_eq!(h.fragment(PUBLIC_ID).await, original);
}

#[tokio::test]
async fn properties_and_relations_round_trip() {
    let h = Harness::new().await;
    let registry = h.ok("read_property_registry", json!({})).await;
    assert_eq!(keys(&registry), ["registry", "sha"]);
    let registered = h
        .ok("register_property_type", json!({ "key": "rating", "propertyType": "number", "expectedSha": registry["sha"] }))
        .await;
    assert_eq!(registered["registry"]["properties"]["rating"], json!({ "type": "number" }));
    let fragment = h
        .ok("set_fragment_property", json!({ "id": PUBLIC_ID, "key": "rating", "value": { "type": "number", "value": "4" } }))
        .await;
    assert_eq!(fragment["properties"], json!([{ "key": "rating", "value": { "kind": "number", "text": "4" }, "editable": true }]));
    let removed = h.ok("remove_fragment_property", json!({ "id": PUBLIC_ID, "key": "rating" })).await;
    assert_eq!(removed["properties"], json!([]));

    let linked = h.ok("link_fragments", json!({ "sourceId": PUBLIC_ID, "targetId": PINNED_ID, "origin": "manual", "note": null })).await;
    assert_eq!(linked["related"][0]["targetId"], PINNED_ID);
    let unlinked = h.ok("unlink_fragments", json!({ "sourceId": PUBLIC_ID, "targetId": PINNED_ID })).await;
    assert_eq!(unlinked["related"], json!([]));
    // 关联密匣条目由领域代码拒绝（与桌面同一条报错，不是密匣分支）。
    let to_lockbox = h.call("link_fragments", json!({ "sourceId": PUBLIC_ID, "targetId": LOCKBOX_ID, "origin": "manual" })).await;
    assert_eq!(to_lockbox.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn library_notes_rename_rewrites_links_and_trash_round_trips() {
    let h = Harness::new().await;
    let tree = h.ok("list_library_tree", json!({})).await;
    assert_eq!(
        keys(&tree),
        ["assets", "entries", "fragmentEntries", "fragmentStream", "fragmentTrashEntries", "trashEntries"]
    );
    let plan = find_entry(&tree["entries"], "notes/项目/计划.md").expect("资料库树里应有计划.md");
    assert_eq!(keys(plan), ["createdAt", "kind", "modifiedAt", "name", "path", "size"]);
    assert_eq!(plan["kind"], "markdown");
    assert_eq!(keys(&tree["fragmentStream"]), ["totalCount", "years"]);
    assert!(tree["fragmentTrashEntries"].as_array().unwrap().iter().any(|entry| entry["path"]
        == format!(".trash/fragments/2026/09/{TRASHED_ID}.md")));

    // 新建笔记（parentPath 与网页端一样传字符串）。
    let created = h.ok("create_library_note", json!({ "parentPath": "notes/项目", "title": "周报" })).await;
    assert_library_mutation(&created);
    assert_eq!(created["fragment"]["path"], "notes/项目/周报.md");
    assert_eq!(created["fragment"]["content"], "# 周报\n");
    assert!(find_entry(&created["tree"]["entries"], "notes/项目/周报.md").is_some());
    let directory = h.ok("create_library_directory", json!({ "parentPath": "notes", "name": "归档" })).await;
    assert!(find_entry(&directory["tree"]["entries"], "notes/归档").is_some());

    // 改名：引用它的 wikilink 在同一个事务里改写。
    let renamed = h.ok("rename_library_entry", json!({ "path": "notes/项目/参考资料.md", "newName": "资料汇编" })).await;
    assert_library_mutation(&renamed);
    assert_eq!(renamed["updatedLinks"], 1);
    assert_eq!(renamed["updatedImageRefs"], 0);
    assert!(find_entry(&renamed["tree"]["entries"], "notes/项目/资料汇编.md").is_some());
    assert!(h.fragment(PLAN_ID).await["content"].as_str().unwrap().contains("[[资料汇编]]"));

    // 移动。
    let moved = h.ok("move_library_entry", json!({ "path": "notes/项目/周报.md", "destinationDirectory": "notes/归档" })).await;
    assert!(find_entry(&moved["tree"]["entries"], "notes/归档/周报.md").is_some());

    // 回收站往返：删除 → 恢复 → 再删除 → 彻底删除 → 清空。
    let deleted = h.ok("delete_library_entry", json!({ "path": "notes/项目/计划.md" })).await;
    assert!(find_entry(&deleted["tree"]["entries"], "notes/项目/计划.md").is_none());
    assert!(find_entry(&deleted["tree"]["trashEntries"], ".trash/notes/项目/计划.md").is_some());
    let restored = h.ok("restore_from_trash", json!({ "path": ".trash/notes/项目/计划.md" })).await;
    assert!(find_entry(&restored["tree"]["entries"], "notes/项目/计划.md").is_some());
    assert!(find_entry(&restored["tree"]["trashEntries"], ".trash/notes/项目/计划.md").is_none());
    h.ok("delete_library_entry", json!({ "path": "notes/项目/计划.md" })).await;
    let purged = h.ok("purge_from_trash", json!({ "path": ".trash/notes/项目/计划.md" })).await;
    assert!(find_entry(&purged["tree"]["trashEntries"], ".trash/notes/项目/计划.md").is_none());
    let emptied = h.ok("empty_trash", json!({ "scope": "all" })).await;
    assert_eq!(emptied["tree"]["trashEntries"], json!([]));
    assert_eq!(emptied["tree"]["fragmentTrashEntries"], json!([]));

    // 碎片 ⇄ 笔记。
    let note = h.ok("convert_fragment_to_note", json!({ "id": PUBLIC_ID, "destinationDirectory": "notes", "title": "读书笔记" })).await;
    assert_library_mutation(&note);
    assert_eq!(note["fragment"]["path"], "notes/读书笔记.md");
    let back = h.ok("convert_note_to_fragment", json!({ "id": PUBLIC_ID })).await;
    assert!(back["fragment"]["path"].as_str().unwrap().starts_with("fragments/"));
}

#[tokio::test]
async fn mind_map_conflict_copy_survives_the_failed_save() {
    let h = Harness::new().await;
    let created = h.ok("create_mind_map", json!({ "title": "季度规划", "sourceFragmentId": null, "parentPath": null })).await;
    assert_eq!(keys(&created), ["file", "lastSavedHash", "path"]);
    assert_eq!(created["path"], "notes/季度规划.shardmap.json");
    let id = created["file"]["id"].as_str().unwrap().to_string();
    let revision = created["file"]["revision"].as_u64().unwrap();
    assert_eq!(h.ok("list_mind_maps", json!({})).await[0]["id"], id);

    let mut edited = created["file"].clone();
    edited["title"] = json!("季度规划（改）");
    let conflict_args = json!({ "id": id, "file": edited, "expectedRevision": revision, "lastSavedHash": "0".repeat(64) });
    let conflict = h.call_with_key("write_mind_map", "map-conflict", conflict_args.clone()).await;
    assert_eq!(conflict.status, StatusCode::BAD_REQUEST);
    let message = conflict.body["message"].as_str().unwrap().to_string();
    assert!(message.starts_with("导图已被外部修改，已另存冲突副本：maps/.conflicts/"), "{message}");
    let copy = message.split('：').nth(1).unwrap().to_string();
    // 出错也提交了：冲突副本在库里。
    let conflicts = |paths: Vec<String>| paths.into_iter().filter(|path| path.starts_with("maps/.conflicts/") && path.ends_with(".shardmap.json")).collect::<Vec<_>>();
    assert_eq!(conflicts(h.manifest_paths().await), vec![copy.clone()]);

    // 同一个幂等键重试：原样回放同一个错误，不再写第二份副本。
    let replay = h.call_with_key("write_mind_map", "map-conflict", conflict_args).await;
    assert_eq!(replay.status, StatusCode::BAD_REQUEST);
    assert_eq!(replay.body["message"], message.as_str());
    assert_eq!(conflicts(h.manifest_paths().await), vec![copy]);

    // 正确基线保存成功，版本 +1。
    let saved = h
        .ok("write_mind_map", json!({ "id": id, "file": edited, "expectedRevision": revision, "lastSavedHash": created["lastSavedHash"] }))
        .await;
    assert_eq!(saved["file"]["revision"], revision + 1);
    assert_eq!(h.ok("read_mind_map", json!({ "id": id })).await["file"]["title"], "季度规划（改）");

    let stale_delete = h.call("delete_mind_map", json!({ "id": id, "expectedRevision": revision })).await;
    assert_eq!(stale_delete.status, StatusCode::BAD_REQUEST);
    assert_eq!(h.ok("delete_mind_map", json!({ "id": id, "expectedRevision": revision + 1 })).await, json!([]));
}

fn flow(id: &str) -> Value {
    json!({
        "kind": "shard.flow", "schemaVersion": 1, "id": id, "title": "中文画布",
        "createdAt": "2026-09-07T00:00:00.000Z", "updatedAt": "2026-09-07T00:00:00.000Z", "revision": 0,
        "nodes": [
            { "id": "first", "kind": "process", "x": 463.52000000000004, "y": 0, "text": "准备" },
            { "id": "second", "kind": "decision", "x": 300, "y": 0, "text": "通过？" }
        ],
        "edges": [{ "id": "forward", "source": "first", "target": "second", "label": "开始" }]
    })
}

#[tokio::test]
async fn canvas_create_read_write_and_conflict_copy() {
    let h = Harness::new().await;
    let created = h.ok("create_canvas", json!({ "parentPath": "notes", "title": "中文画布", "file": flow("canvas-web") })).await;
    assert_eq!(keys(&created), ["file", "lastSavedHash", "path"]);
    assert_eq!(created["path"], "notes/中文画布.shardflow.json");
    assert_eq!(created["file"]["revision"], 1);
    // 坐标经 JSON 往返保持 IEEE-754 精确值。
    assert_eq!(created["file"]["nodes"][0]["x"].as_f64().unwrap().to_bits(), 463.52000000000004_f64.to_bits());

    let read = h.ok("read_canvas", json!({ "path": "notes/中文画布.shardflow.json" })).await;
    assert_eq!(read, created);
    let documents = h.ok("list_diagram_documents", json!({})).await;
    assert!(documents.as_array().unwrap().iter().any(|document| document["id"] == "canvas-web"));

    let mut file = read["file"].clone();
    file["nodes"][0]["text"] = json!("第一步完成");
    let saved = h
        .ok(
            "write_canvas",
            json!({ "path": read["path"], "file": file, "expectedRevision": 1, "lastSavedHash": read["lastSavedHash"] }),
        )
        .await;
    assert_eq!(saved["file"]["revision"], 2);
    assert_eq!(saved["file"]["nodes"][0]["text"], "第一步完成");

    // 同一份内容按旧基线重发是「上次保存的重试」，领域代码原样返回已保存的版本。
    let retried = h
        .ok(
            "write_canvas",
            json!({ "path": read["path"], "file": file, "expectedRevision": 1, "lastSavedHash": read["lastSavedHash"] }),
        )
        .await;
    assert_eq!(retried, saved);
    // 旧基线上的另一份改动：冲突副本写进 .shard/canvas/conflicts/ 并保留。
    file["nodes"][1]["text"] = json!("另一处改动");
    let conflict = h
        .call(
            "write_canvas",
            json!({ "path": read["path"], "file": file, "expectedRevision": 1, "lastSavedHash": read["lastSavedHash"] }),
        )
        .await;
    assert_eq!(conflict.status, StatusCode::BAD_REQUEST);
    let message = conflict.body["message"].as_str().unwrap();
    assert!(message.starts_with("画布已被外部修改，已保留冲突副本：.shard/canvas/conflicts/"), "{message}");
    let copy = message.split('：').nth(1).unwrap();
    assert!(h.manifest_paths().await.iter().any(|path| path == copy));

    // 与桌面一样拒绝不认识的字段。
    let unknown = h.call("read_canvas", json!({ "path": "notes/中文画布.shardflow.json", "extra": 1 })).await;
    assert_eq!(unknown.status, StatusCode::BAD_REQUEST);
    assert_eq!(unknown.body["code"], "INVALID_ARGS");
}

#[tokio::test]
async fn graph_fragments_create_read_and_write() {
    let h = Harness::new().await;
    let created = h
        .ok("create_graph_fragment", json!({ "kind": "flowchart", "operationId": "web-graph-op-1", "graph": null, "tags": [] }))
        .await;
    assert_eq!(keys(&created), ["fragment", "graph"]);
    let id = created["fragment"]["id"].as_str().unwrap().to_string();
    assert_eq!(created["graph"]["kind"], "shard.flow");
    let read = h.ok("read_graph_fragment", json!({ "id": id })).await;
    assert_eq!(read["graph"], created["graph"]);
    let mut graph = read["graph"].clone();
    graph["title"] = json!("改过的流程");
    let written = h
        .ok("write_graph_fragment", json!({ "id": id, "graph": graph, "expectedFileSha": read["fragment"]["fileSha"] }))
        .await;
    assert_eq!(written["graph"]["title"], "改过的流程");
    let stale = h.call("write_graph_fragment", json!({ "id": id, "graph": graph, "expectedFileSha": read["fragment"]["fileSha"] })).await;
    assert_eq!(stale.status, StatusCode::CONFLICT);
    // 图形碎片不能进密匣：领域报错，不是密匣分支。
    let locked = h
        .call("create_graph_fragment", json!({ "kind": "outline", "operationId": "web-graph-op-2", "graph": null, "tags": ["密匣"] }))
        .await;
    assert_eq!(locked.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn datasets_apply_ops_with_stale_base_and_normalize() {
    let h = Harness::new().await;
    let created = h
        .ok("create_dataset", json!({ "title": "阅读记录", "header": ["书名", "日期"], "rows": [["置身", "2026"]], "primaryKey": null }))
        .await;
    assert_eq!(
        keys(&created),
        ["convertible", "dialect", "editable", "path", "readOnlyReason", "schema", "schemaSha", "sha", "table"]
    );
    let path = created["path"].as_str().unwrap().to_string();
    let applied = h
        .ok(
            "apply_dataset_ops",
            json!({
                "path": path, "expectedSha": created["sha"], "expectedSchemaSha": created["schemaSha"],
                "ops": [{ "op": "setCells", "cells": [{ "row": 0, "column": 0, "value": "新书" }] }]
            }),
        )
        .await;
    assert_eq!(applied["table"]["rows"][0][0], "新书");
    let stale = h
        .call(
            "apply_dataset_ops",
            json!({ "path": path, "expectedSha": created["sha"], "expectedSchemaSha": created["schemaSha"], "ops": [] }),
        )
        .await;
    assert_eq!(stale.status, StatusCode::CONFLICT);
    assert_eq!(stale.body["code"], "STALE_BASE");

    // CSV 原字节：number[]。
    let bytes: Vec<u8> = serde_json::from_value(h.ok("read_csv_file", json!({ "path": path })).await).unwrap();
    assert!(String::from_utf8(bytes).unwrap().contains("新书"));
    let csvs = h.ok("list_csv_files", json!({})).await;
    assert!(csvs.as_array().unwrap().iter().any(|csv| csv["path"] == path));

    // 导入的 GBK CSV 只读、可转换；转换后可编辑。
    let legacy = h.ok("read_dataset", json!({ "path": "datasets/旧表.csv" })).await;
    assert_eq!(legacy["editable"], false);
    assert_eq!(legacy["convertible"], true);
    let normalized = h.ok("normalize_csv_file", json!({ "path": "datasets/旧表.csv", "expectedSha": legacy["sha"] })).await;
    assert_eq!(normalized["editable"], true);
    assert_eq!(normalized["table"]["header"], json!(["书名", "日期"]));

    let library = h
        .ok(
            "create_library_dataset",
            json!({ "parentPath": "notes", "title": "书单", "header": ["书名"], "rows": [["一"]], "primaryKey": null }),
        )
        .await;
    assert_eq!(keys(&library), ["dataset", "library"]);
    assert_library_mutation(&library["library"]);

    // XLSX：取不到 blob 是 400 BLOB_MISSING；不是 xlsx 时与桌面同样报解析错误。
    let missing = h.call("read_import_xlsx_blob", json!({ "blobSha": "a".repeat(64) })).await;
    assert_eq!(missing.status, StatusCode::BAD_REQUEST);
    assert_eq!(missing.body["code"], "BLOB_MISSING");
    let garbage = h.put_blob(b"not a zip").await;
    let invalid = h.call("read_import_xlsx_blob", json!({ "blobSha": garbage })).await;
    assert_eq!(invalid.status, StatusCode::BAD_REQUEST);
    assert_eq!(invalid.body["code"], "COMMAND_FAILED");
}

#[tokio::test]
async fn images_go_through_the_blob_store() {
    let h = Harness::new().await;
    let sha = h.put_blob(PNG).await;
    let saved = h.ok("save_fragment_image", json!({ "fileName": "截图.png", "blobSha": sha })).await;
    assert_eq!(saved, json!(format!("assets/{}/{sha}.png", &sha[..2])));
    let served = h.send(h.browser(Method::GET, &format!("/api/files/{}", saved.as_str().unwrap())).body(Body::empty()).unwrap()).await;
    assert_eq!(served.status, StatusCode::OK);
    assert_eq!(served.headers[header::CONTENT_TYPE], "image/png");

    let missing = h.call("save_fragment_image", json!({ "fileName": "a.png", "blobSha": "b".repeat(64) })).await;
    assert_eq!(missing.status, StatusCode::BAD_REQUEST);
    assert_eq!(missing.body["code"], "BLOB_MISSING");
    let not_image = h.put_blob(b"plain text").await;
    let rejected = h.call("save_fragment_image", json!({ "fileName": "a.txt", "blobSha": not_image })).await;
    assert_eq!(rejected.status, StatusCode::BAD_REQUEST);
    assert_eq!(rejected.body["message"], "不支持的图片格式");

    // 资料库导入：按原文件名放进目录，重名加后缀；不是图片的记进 skipped。
    let imported = h
        .ok(
            "import_library_blobs",
            json!({
                "files": [
                    { "name": "图.png", "blobSha": sha },
                    { "name": "图.png", "blobSha": sha },
                    { "name": "说明.txt", "blobSha": not_image }
                ],
                "directory": "notes/证件"
            }),
        )
        .await;
    assert_eq!(keys(&imported), ["imported", "skipped", "tree"]);
    assert_eq!(imported["imported"], json!(["notes/证件/图-2.png", "notes/证件/图-3.png"]));
    assert_eq!(imported["skipped"], json!([{ "path": "说明.txt", "reason": "不支持的图片格式" }]));
    assert!(imported["tree"]["assets"].is_array());

    let references = h.ok("image_references", json!({ "path": "notes/证件/图.png" })).await;
    assert_eq!(references, json!([]));
    let existing = h.ok("existing_vault_images", json!({ "paths": ["notes/证件/图.png", "notes/证件/没有.png"] })).await;
    assert_eq!(existing, json!(["notes/证件/图.png"]));
    let data_url = h.ok("read_fragment_image", json!({ "path": "notes/证件/图.png" })).await;
    assert!(data_url.as_str().unwrap().starts_with("data:image/png;base64,"));
}

#[tokio::test]
async fn create_commands_accept_an_optional_source() {
    let h = Harness::new().await;
    let source_of = |reply: Value| reply["source"].as_str().unwrap_or_default().to_string();
    // 缺省按调用方记（浏览器会话 web）；空白当作没给。
    let plain = h.ok("create_fragment", json!({ "content": "默认来源" })).await;
    assert_eq!(source_of(h.ok("read_document", json!({ "target": plain["id"] })).await), "web");
    let blank = h.ok("create_fragment", json!({ "content": "空白来源", "source": "  " })).await;
    assert_eq!(source_of(h.ok("read_document", json!({ "target": blank["id"] })).await), "web");
    // 给了就照记（命令行的 --source），返回形状不变。
    let named = h.ok("create_fragment", json!({ "content": "助手写的", "tags": ["读书"], "source": " claude-code " })).await;
    assert_eq!(keys(&named), FRAGMENT_KEYS);
    assert_eq!(named["tags"], json!(["inbox", "读书"]));
    assert_eq!(source_of(h.ok("read_document", json!({ "target": named["id"] })).await), "claude-code");
    // 不合规：400 INVALID_ARGS，不写。
    let before = h.ok("list_fragments", json!({})).await["fragments"].as_array().unwrap().len();
    for source in ["多行\n来源", &"长".repeat(41)] {
        let reply = h.call("create_fragment", json!({ "content": "不该写", "source": source })).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.body);
        assert_eq!(reply.body["code"], "INVALID_ARGS");
    }
    assert_eq!(h.ok("list_fragments", json!({})).await["fragments"].as_array().unwrap().len(), before);

    // 数据集的说明笔记同样可以带来源。
    let created = h
        .ok(
            "create_library_dataset",
            json!({ "title": "来源表", "header": ["id"], "rows": [], "primaryKey": "id", "source": "codex" }),
        )
        .await;
    let note = created["library"]["fragment"]["path"].clone();
    assert_eq!(source_of(h.ok("read_document", json!({ "target": note })).await), "codex");
    let reply = h
        .call("create_library_dataset", json!({ "title": "坏来源表", "header": ["id"], "rows": [], "source": "a\u{7}" }))
        .await;
    assert_eq!(reply.body["code"], "INVALID_ARGS");
}

/// 桌面离线新建后补交：id 与创建时间用客户端的；同 id 再建拒绝；冲突副本记下来源。
#[tokio::test]
async fn create_fragment_accepts_client_ids_times_and_conflict_sources() {
    let h = Harness::new().await;
    let id = "20261031-235900-0a1b2c3d-4e5f60";
    let created = h
        .ok("create_fragment", json!({ "content": "离线时记下的", "id": id, "createdAt": "2026-10-31T23:59:00+08:00" }))
        .await;
    assert_eq!(created["id"], id);
    // 按客户端的时间进 10 月目录（服务器此刻可能已是 11 月或 UTC 的另一天）。
    assert_eq!(created["path"], format!("fragments/2026/10/{id}.md"));
    assert_eq!(created["createdAt"], "2026-10-31T23:59:00+08:00");

    let again = h.call("create_fragment", json!({ "content": "别的内容", "id": id, "createdAt": "2026-10-31T23:59:00+08:00" })).await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    assert_eq!(again.body["code"], "FRAGMENT_EXISTS");

    let copy = h.ok("create_fragment", json!({ "content": "冲突时本地的版本", "conflictOf": id })).await;
    assert_eq!(copy["conflictOf"], id);
    assert_ne!(copy["id"], id);

    for bad in [
        json!({ "content": "x", "id": "../etc", "createdAt": "2026-10-31T23:59:00+08:00" }),
        json!({ "content": "x", "id": id }),
        json!({ "content": "x", "id": "20261031-235900-0a1b2c3d-4e5f61", "createdAt": "昨天" }),
        json!({ "content": "x", "conflictOf": "not-an-id" }),
    ] {
        assert_eq!(h.call("create_fragment", bad.clone()).await.status, StatusCode::BAD_REQUEST, "{bad}");
    }
}
