//! 命令行专用 RPC（`commands/cli.rs`）经 HTTP 的端到端测试：把示例资料库 `tests/fixtures/vault-golden`
//! 导入内容库，用邮箱密码登录得到的 CLI 设备令牌调用，核对与 CLI 本地模式一致的结果形状、报错码与幂等。
//! 运行：`cargo test -p shard-server --features test-auth`。
#![cfg(feature = "test-auth")]

use std::{
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};

use axum::{
    body::Body,
    http::{header, HeaderMap, Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use shard_core::FsVfs;
use shard_server::{app, commands, config::Config, rpc::base_registry, state::AppState};
use shard_vault::cli as shared;
use tower::ServiceExt;

const ORIGIN: &str = "http://localhost:18789";
const MEMO_ID: &str = "20261025-221500-b2c3d4e5-1a1b1c";
const RIDE_ID: &str = "20261026-073012-a1b2c3d4-0a0b0c";
const TRASHED_ID: &str = "20260915-180000-e5f6a7b8-4a4b4c";
const BOOK_NOTE: &str = "notes/读书/置身事内.md";
const DATASET: &str = "datasets/阅读记录.csv";
const HEADER: [&str; 5] = ["id", "书名", "作者", "封面", "读完日期"];

fn golden() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/vault-golden")
}

struct Harness {
    _data: tempfile::TempDir,
    app: Router,
    token: String,
    keys: AtomicUsize,
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

impl Harness {
    /// 导入示例资料库，设置好账号后像 `shard login` 一样用邮箱密码换设备令牌（kind=cli）：之后的调用都以 CLI 设备身份发出。
    async fn new() -> Self {
        let data = tempfile::tempdir().unwrap();
        let config = Config::new(data.path().to_path_buf(), ORIGIN, None, false).unwrap();
        let mut registry = base_registry();
        commands::register(&mut registry);
        let state = AppState::open(config, registry).unwrap();
        shard_store::transfer::import_vault(&state.store, &golden()).unwrap();
        commands::ensure_layout(&state.store).unwrap();
        state.auth.create_setup_token("setup-token", "setup").unwrap();
        let app = app::build(state);
        let mut harness = Self { _data: data, app, token: String::new(), keys: AtomicUsize::new(0) };
        harness.token = harness.login().await;
        harness
    }

    async fn send(&self, request: Request<Body>) -> Reply {
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        Reply { status, headers, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null) }
    }

    fn json_post(uri: &str) -> axum::http::request::Builder {
        Request::post(uri).header(header::CONTENT_TYPE, "application/json")
    }

    async fn login(&self) -> String {
        let account = json!({ "token": "setup-token", "email": "me@example.com", "password": "correct horse battery" });
        let setup = self
            .send(
                Self::json_post("/api/auth/setup")
                    .header("x-shard-request", "1")
                    .header(header::ORIGIN, ORIGIN)
                    .body(Body::from(account.to_string()))
                    .unwrap(),
            )
            .await;
        assert_eq!(setup.status, StatusCode::OK, "{}", setup.body);
        let login = json!({ "email": "me@example.com", "password": "correct horse battery", "name": "测试命令行", "kind": "cli" });
        let issued = self.send(Self::json_post("/api/device/login").body(Body::from(login.to_string())).unwrap()).await;
        assert_eq!(issued.status, StatusCode::OK, "{}", issued.body);
        issued.body["token"].as_str().unwrap().to_string()
    }

    /// 与 CLI 一样：Bearer 设备令牌、北京时间、写命令带幂等键（不需要 CSRF 头）。
    async fn call_with_key(&self, command: &str, key: &str, args: Value) -> Reply {
        let request = Request::post(format!("/api/rpc/{command}"))
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .header(header::CONTENT_TYPE, "application/json")
            .header("idempotency-key", key)
            .header("x-shard-utc-offset", "480")
            .body(Body::from(args.to_string()))
            .unwrap();
        self.send(request).await
    }

    async fn call(&self, command: &str, args: Value) -> Reply {
        let key = format!("cli-{}", self.keys.fetch_add(1, Ordering::Relaxed));
        self.call_with_key(command, &key, args).await
    }

    async fn ok(&self, command: &str, args: Value) -> Value {
        let reply = self.call(command, args).await;
        assert_eq!(reply.status, StatusCode::OK, "{command} 失败：{}", reply.body);
        reply.body
    }

    async fn error(&self, command: &str, args: Value, status: StatusCode, code: &str) -> String {
        let reply = self.call(command, args).await;
        assert_eq!(reply.status, status, "{command}：{}", reply.body);
        assert_eq!(reply.body["code"], code, "{command}：{}", reply.body);
        reply.body["message"].as_str().unwrap().to_string()
    }

    /// 经网页端同一个命令读回一条内容的原文 sha（`list_fragments` 的 fileSha）。
    async fn file_sha(&self, id: &str) -> String {
        let state = self.ok("list_fragments", json!({})).await;
        state["fragments"]
            .as_array()
            .unwrap()
            .iter()
            .find(|fragment| fragment["id"] == id)
            .map(|fragment| fragment["fileSha"].as_str().unwrap().to_string())
            .unwrap_or_default()
    }
}

fn keys(value: &Value) -> Vec<&str> {
    let mut keys: Vec<&str> = value.as_object().expect("应当是对象").keys().map(String::as_str).collect();
    keys.sort_unstable();
    keys
}

fn kinds_and_paths(listing: &Value) -> Vec<String> {
    listing
        .as_array()
        .unwrap()
        .iter()
        .map(|item| format!("{}:{}", item["kind"].as_str().unwrap(), item["path"].as_str().unwrap()))
        .collect()
}

#[tokio::test]
async fn resolve_and_read_match_the_local_cli() {
    let h = Harness::new().await;
    for target in [RIDE_ID, "a1b2c3d4", "fragments/2026/10/20261026-073012-a1b2c3d4-0a0b0c.md"] {
        let resolved = h.ok("resolve_target", json!({ "target": target })).await;
        assert_eq!(
            resolved,
            json!({ "id": RIDE_ID, "path": "fragments/2026/10/20261026-073012-a1b2c3d4-0a0b0c.md", "kind": "fragment" })
        );
    }
    let note = h.ok("resolve_target", json!({ "target": BOOK_NOTE })).await;
    assert_eq!(note["kind"], "note");

    // 片段命中多条：409 AMBIGUOUS，报错里列出候选 id。
    let ambiguous = h.error("resolve_target", json!({ "target": "2026" }), StatusCode::CONFLICT, "AMBIGUOUS").await;
    assert!(ambiguous.contains("请用完整 id"));
    // 回收站里的、不足 4 个字符的、不存在的：404 NOT_FOUND，与 CLI 同一条提示。
    for target in [TRASHED_ID, "a1b", "不存在", "notes/读书/不存在.md"] {
        let message = h.error("read_document", json!({ "target": target }), StatusCode::NOT_FOUND, "NOT_FOUND").await;
        assert!(message.contains("--graph-read"), "{message}");
    }

    let read = h.ok("read_document", json!({ "target": BOOK_NOTE })).await;
    assert_eq!(
        keys(&read),
        ["body", "createdAt", "id", "kind", "path", "sha", "source", "tags", "title", "updatedAt"]
    );
    assert_eq!(read["title"], "置身事内");
    assert_eq!(read["tags"], json!(["inbox", "note", "读书"]));
    assert_eq!(read["source"], "desktop");
    assert!(read["body"].as_str().unwrap().starts_with("# 置身事内\n\n兰小欢，2021。"));
    assert!(read["body"].as_str().unwrap().ends_with("#读书"));
    assert_eq!(read["sha"], h.file_sha(read["id"].as_str().unwrap()).await);

    // 与 CLI 本地模式同一份实现：直接在示例资料库目录上读，结果逐字段相同。
    let local_vfs = FsVfs::new(golden());
    let entries = shared::load_text_entries(&local_vfs).unwrap();
    let shared::Resolved::Found(entry) = shared::resolve_target(&entries, BOOK_NOTE, None) else {
        panic!("本地应能解析");
    };
    let local = serde_json::to_value(shared::read_document(&local_vfs, entry).unwrap()).unwrap();
    assert_eq!(local, read);
}

#[tokio::test]
async fn append_reads_modifies_and_writes_in_one_transaction() {
    let h = Harness::new().await;
    let before = h.ok("read_document", json!({ "target": MEMO_ID })).await;

    // 末尾是列表、追加的也是列表项：接成同一个列表；正文里的新标签收进 frontmatter。
    let args = json!({ "target": "b2c3d4e5", "text": "- [ ] 买牛奶 #生活" });
    let first = h.call_with_key("append_document", "append-once", args.clone()).await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    let appended = first.body;
    assert_eq!(keys(&appended), ["changed", "id", "path", "sha", "tags"]);
    assert_eq!(appended["changed"], true);
    assert_eq!(appended["tags"], json!(["inbox", "备忘", "生活"]));
    assert_eq!(appended["sha"], h.file_sha(MEMO_ID).await);
    let after = h.ok("read_document", json!({ "target": MEMO_ID })).await;
    assert_eq!(
        after["body"],
        format!("{}\n- [ ] 买牛奶 #生活", before["body"].as_str().unwrap())
    );
    assert!(after["updatedAt"].as_str().unwrap().ends_with("+08:00"), "按客户端时区刷新 updated_at");
    assert_eq!(after["createdAt"], before["createdAt"]);
    assert_eq!(after["source"], "desktop", "其余 frontmatter 不动");

    // 同一个幂等键重试：原样返回，不追加第二次。
    let again = h.call_with_key("append_document", "append-once", args).await;
    assert_eq!(again.status, StatusCode::OK);
    assert_eq!(again.headers["idempotent-replayed"], "true");
    assert_eq!(again.body, appended);
    assert_eq!(h.ok("read_document", json!({ "target": MEMO_ID })).await["sha"], appended["sha"]);

    // 段落另起一段。
    let paragraph = h.ok("append_document", json!({ "target": MEMO_ID, "text": "补充说明" })).await;
    let body = h.ok("read_document", json!({ "target": MEMO_ID })).await["body"].as_str().unwrap().to_string();
    assert!(body.ends_with("- [ ] 买牛奶 #生活\n\n补充说明"));

    // 基线不符：409 STALE_BASE，不写。
    h.error(
        "append_document",
        json!({ "target": MEMO_ID, "text": "不该写入", "expectedSha": appended["sha"] }),
        StatusCode::CONFLICT,
        "STALE_BASE",
    )
    .await;
    let with_base = h
        .ok("append_document", json!({ "target": MEMO_ID, "text": "带基线", "expectedSha": paragraph["sha"] }))
        .await;
    assert_eq!(with_base["changed"], true);

    // 密匣、frontmatter、空内容：与 CLI 本地同一条报错，不写。
    let lockbox = h
        .error("append_document", json!({ "target": MEMO_ID, "text": "秘密 #密匣" }), StatusCode::BAD_REQUEST, "COMMAND_FAILED")
        .await;
    assert_eq!(lockbox, shared::LOCKBOX_MESSAGE);
    let frontmatter = h
        .error(
            "append_document",
            json!({ "target": MEMO_ID, "text": "---\ntitle: x\n---\n正文" }),
            StatusCode::BAD_REQUEST,
            "COMMAND_FAILED",
        )
        .await;
    assert_eq!(frontmatter, shared::FRONTMATTER_MESSAGE);
    h.error("append_document", json!({ "target": MEMO_ID, "text": "  " }), StatusCode::BAD_REQUEST, "COMMAND_FAILED")
        .await;
    assert_eq!(h.ok("read_document", json!({ "target": MEMO_ID })).await["sha"], with_base["sha"]);
}

#[tokio::test]
async fn rewrite_checks_the_base_in_one_transaction_and_never_edits_another_file() {
    let h = Harness::new().await;
    let before = h.ok("read_document", json!({ "target": RIDE_ID })).await;
    let args = json!({ "target": before["path"], "body": "改写后的正文 #新\n", "expectedSha": before["sha"] });
    let first = h.call_with_key("rewrite_document", "rewrite-once", args.clone()).await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    let rewritten = first.body;
    assert_eq!(keys(&rewritten), ["changed", "id", "path", "sha", "tags"]);
    assert_eq!(rewritten["changed"], true);
    assert_eq!(rewritten["tags"], json!(["inbox", "新"]));
    assert_eq!(rewritten["sha"], h.file_sha(RIDE_ID).await);
    let after = h.ok("read_document", json!({ "target": RIDE_ID })).await;
    assert_eq!(after["body"], "改写后的正文 #新");
    assert_eq!(after["source"], "desktop", "其余 frontmatter 不动");
    assert!(after["updatedAt"].as_str().unwrap().ends_with("+08:00"));
    // 幂等重放：原样返回。
    let again = h.call_with_key("rewrite_document", "rewrite-once", args).await;
    assert_eq!(again.headers["idempotent-replayed"], "true");
    assert_eq!(again.body, rewritten);

    // 旧基线：409 STALE_BASE，不写；正文没变：changed=false，sha 不变；sha 必填。
    h.error(
        "rewrite_document",
        json!({ "target": RIDE_ID, "body": "覆盖", "expectedSha": before["sha"] }),
        StatusCode::CONFLICT,
        "STALE_BASE",
    )
    .await;
    let same = h
        .ok("rewrite_document", json!({ "target": RIDE_ID, "body": "改写后的正文 #新", "expectedSha": rewritten["sha"] }))
        .await;
    assert_eq!((same["changed"].as_bool(), &same["sha"]), (Some(false), &rewritten["sha"]));
    h.error("rewrite_document", json!({ "target": RIDE_ID, "body": "x" }), StatusCode::BAD_REQUEST, "INVALID_ARGS").await;
    let empty = h
        .error(
            "rewrite_document",
            json!({ "target": RIDE_ID, "body": "  ", "expectedSha": rewritten["sha"] }),
            StatusCode::BAD_REQUEST,
            "COMMAND_FAILED",
        )
        .await;
    assert_eq!(empty, shared::EMPTY_BODY_MESSAGE);

    // 移进回收站之后：按 id 找不到，404，不会去改回收站里的文件。
    h.ok("set_fragment_archived", json!({ "id": MEMO_ID, "archived": true })).await;
    let memo_sha = h.file_sha(MEMO_ID).await;
    h.error(
        "rewrite_document",
        json!({ "target": MEMO_ID, "body": "不该写", "expectedSha": memo_sha }),
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;
    h.error("append_document", json!({ "target": MEMO_ID, "text": "不该写" }), StatusCode::NOT_FOUND, "NOT_FOUND").await;
    assert_eq!(h.file_sha(MEMO_ID).await, memo_sha);
}

#[tokio::test]
async fn notes_are_created_in_new_folders_with_device_source() {
    let h = Harness::new().await;
    let note = h
        .ok(
            "create_note",
            json!({ "title": "周会纪要", "folder": "项目/周会", "body": "## 结论\n\n- 下周发布 #发布" }),
        )
        .await;
    assert_eq!(keys(&note), ["id", "path", "sha", "tags"]);
    assert_eq!(note["path"], "notes/项目/周会/周会纪要.md");
    assert_eq!(note["tags"], json!(["inbox", "note", "发布"]));
    let read = h.ok("read_document", json!({ "target": note["id"] })).await;
    assert_eq!(read["source"], "cli", "CLI 设备新建的内容记为 cli");
    assert!(read["body"].as_str().unwrap().starts_with("# 周会纪要\n\n## 结论"));
    assert!(read["createdAt"].as_str().unwrap().ends_with("+08:00"));
    assert_eq!(read["sha"], note["sha"]);

    // 重名加 -2；notes/ 前缀写法等价；--source 覆盖；空正文只有标题。
    let again = h
        .ok("create_note", json!({ "title": "周会纪要", "folder": "notes/项目/周会", "body": "", "source": "codex" }))
        .await;
    assert_eq!(again["path"], "notes/项目/周会/周会纪要-2.md");
    let read = h.ok("read_document", json!({ "target": again["path"] })).await;
    assert_eq!(read["source"], "codex");
    assert_eq!(read["body"], "# 周会纪要");

    h.error("create_note", json!({ "title": "x", "body": "", "source": "a\nb" }), StatusCode::BAD_REQUEST, "INVALID_ARGS")
        .await;
    let lockbox = h
        .error("create_note", json!({ "title": "x", "body": "#密匣 秘密" }), StatusCode::BAD_REQUEST, "COMMAND_FAILED")
        .await;
    assert_eq!(lockbox, shared::LOCKBOX_MESSAGE);
    h.error("create_note", json!({ "title": "x", "folder": "../外面", "body": "" }), StatusCode::BAD_REQUEST, "COMMAND_FAILED")
        .await;
}

#[tokio::test]
async fn tags_documents_and_library_listing() {
    let h = Harness::new().await;
    let tags = h.ok("list_tags", json!({})).await;
    assert_eq!(
        tags,
        json!([
            { "tag": "备忘", "count": 1 },
            { "tag": "工作", "count": 1 },
            { "tag": "摘录", "count": 1 },
            { "tag": "灵感", "count": 1 },
            { "tag": "读书", "count": 1 },
            { "tag": "骑行", "count": 1 },
        ])
    );

    // 最近修改在前；不带正文时没有 body 键；limit 只截列表，total 是全部。
    let recent = h.ok("list_documents", json!({ "limit": 2 })).await;
    assert_eq!(recent["total"], 7);
    let documents = recent["documents"].as_array().unwrap();
    assert_eq!(documents.len(), 2);
    assert_eq!(documents[0]["title"], "周报 10-26");
    assert_eq!(documents[0]["kind"], "note");
    assert_eq!(documents[1]["id"], RIDE_ID);
    assert_eq!(keys(&documents[1]), ["createdAt", "id", "kind", "path", "tags", "title", "updatedAt"]);

    h.ok("create_note", json!({ "title": "随记", "body": "#读书 再读一遍" })).await;
    assert_eq!(h.ok("list_tags", json!({})).await[0], json!({ "tag": "读书", "count": 2 }));
    let all = h.ok("list_documents", json!({ "withBody": true })).await;
    let all = all["documents"].as_array().unwrap();
    assert_eq!(all.len(), 8);
    assert!(all.iter().all(|document| document["body"].is_string()));
    assert!(all.iter().all(|document| document["id"] != TRASHED_ID), "回收站不在");

    let listing = h.ok("list_library", json!({})).await;
    assert_eq!(
        kinds_and_paths(&listing),
        [
            "mindmap:notes/季度规划.shardmap.json",
            "folder:notes/证件",
            "folder:notes/读书",
            "note:notes/读书/书单.md",
            "note:notes/读书/置身事内.md",
            "note:notes/随记.md",
            "folder:notes/项目",
            "note:notes/项目/周报 10-26.md",
            "dataset:datasets/阅读记录.csv",
        ]
    );
    let sub = h.ok("list_library", json!({ "folder": "读书" })).await;
    assert_eq!(kinds_and_paths(&sub), ["note:notes/读书/书单.md", "note:notes/读书/置身事内.md"]);
    // 找不到：状态码 404（离线补交据此判断已删除），错误码照旧（命令行本地与远程一致）。
    h.error("list_library", json!({ "folder": "没有这个" }), StatusCode::NOT_FOUND, "COMMAND_FAILED").await;

    // 与 CLI 本地同一份实现：示例资料库目录上直接列，结果相同（服务端多一篇刚建的笔记）。
    let local = shared::list_library_items(&FsVfs::new(golden()), None).unwrap();
    let local = serde_json::to_value(local).unwrap();
    let mut remote = kinds_and_paths(&listing);
    remote.retain(|item| item != "note:notes/随记.md");
    assert_eq!(kinds_and_paths(&local), remote);

    let folder = h.ok("ensure_library_folder", json!({ "folder": "项目/新/子" })).await;
    assert_eq!(folder, json!({ "path": "notes/项目/新/子" }));
    let sub = h.ok("list_library", json!({ "folder": "notes/项目" })).await;
    assert_eq!(
        kinds_and_paths(&sub),
        ["note:notes/项目/周报 10-26.md", "folder:notes/项目/新", "folder:notes/项目/新/子"]
    );
}

#[tokio::test]
async fn dataset_records_append_idempotently_by_primary_key() {
    let h = Harness::new().await;
    let record = |id: &str, title: &str| json!({ "id": id, "书名": title, "作者": "某人" });
    let args = json!({ "path": DATASET, "expectedHeader": HEADER, "records": [record("4", "新书"), record("4", "新书")] });
    let first = h.ok("append_dataset_records", args).await;
    assert_eq!(keys(&first), ["appended", "sha", "skipped"]);
    assert_eq!((first["appended"].as_u64(), first["skipped"].as_u64()), (Some(1), Some(1)));

    // 换一个幂等键重放同样的记录：按主键跳过，sha 不变。
    let retry = h
        .ok("append_dataset_records", json!({ "path": DATASET, "expectedHeader": HEADER, "records": [record("4", "新书")] }))
        .await;
    assert_eq!(retry, json!({ "appended": 0, "skipped": 1, "sha": first["sha"] }));

    let dataset = h.ok("read_dataset", json!({ "path": DATASET })).await;
    let rows = dataset["table"]["rows"].as_array().unwrap();
    assert_eq!(rows.last().unwrap(), &json!(["4", "新书", "某人", "", ""]));
    assert_eq!(dataset["sha"], first["sha"]);

    let conflict = h
        .error(
            "append_dataset_records",
            json!({ "path": DATASET, "expectedHeader": HEADER, "records": [record("5", "另一本"), record("1", "改了书名")] }),
            StatusCode::CONFLICT,
            "KEY_CONFLICT",
        )
        .await;
    assert_eq!(conflict, "主键冲突");
    h.error(
        "append_dataset_records",
        json!({ "path": DATASET, "expectedHeader": ["id"], "records": [] }),
        StatusCode::CONFLICT,
        "HEADER_CHANGED",
    )
    .await;
    h.error(
        "append_dataset_records",
        json!({ "path": DATASET, "expectedHeader": HEADER, "records": [{ "id": "6", "多余": "x" }] }),
        StatusCode::BAD_REQUEST,
        "COMMAND_FAILED",
    )
    .await;
    // 冲突与报错整批不写。
    assert_eq!(h.ok("read_dataset", json!({ "path": DATASET })).await["sha"], first["sha"]);
}
