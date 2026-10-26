//! 版本历史与导出经 HTTP 的端到端测试：在虚构示例库 `tests/fixtures/vault-golden` 上
//! 改碎片、恢复旧版本、彻底删除后找回、立即抹除（要求重新验证通行密钥）、导出 zip。
//! 运行：`cargo test -p shard-server --features test-auth`。
#![cfg(feature = "test-auth")]

use std::{
    io::Read,
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
use shard_server::{app, commands, config::Config, history, rpc::base_registry, state::AppState};
use tower::ServiceExt;

const ORIGIN: &str = "http://localhost:18788";
/// 示例库里「骑行」那条碎片。
const RIDE_ID: &str = "20261026-073012-a1b2c3d4-0a0b0c";
const RIDE_PATH: &str = "fragments/2026/10/20261026-073012-a1b2c3d4-0a0b0c.md";
const IMAGE_PATH: &str = "notes/证件/营业执照（示例）.png";

struct Harness {
    _data: tempfile::TempDir,
    app: Router,
    cookie: String,
    keys: AtomicUsize,
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    bytes: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes).unwrap_or(Value::Null)
    }
}

impl Harness {
    async fn new() -> Self {
        let golden = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/vault-golden");
        let data = tempfile::tempdir().unwrap();
        let config = Config::new(data.path().to_path_buf(), ORIGIN, None, false).unwrap();
        let mut registry = base_registry();
        commands::register(&mut registry);
        history::register(&mut registry);
        let state = AppState::open(config, registry).unwrap();
        shard_store::transfer::import_vault(&state.store, &golden).unwrap();
        commands::ensure_layout(&state.store).unwrap();
        let app = app::build(state);
        let response = app
            .clone()
            .oneshot(Request::post("/api/test/session").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_string();
        Self { _data: data, app, cookie, keys: AtomicUsize::new(0) }
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
        let bytes = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        Reply { status, headers, bytes }
    }

    async fn get(&self, uri: &str) -> Reply {
        self.send(self.browser(Method::GET, uri).body(Body::empty()).unwrap()).await
    }

    async fn call(&self, command: &str, args: Value) -> Reply {
        let key = format!("key-{}", self.keys.fetch_add(1, Ordering::Relaxed));
        let request = self
            .browser(Method::POST, &format!("/api/rpc/{command}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header("idempotency-key", key)
            .header("x-shard-utc-offset", "480")
            .body(Body::from(args.to_string()))
            .unwrap();
        self.send(request).await
    }

    async fn ok(&self, command: &str, args: Value) -> Value {
        let reply = self.call(command, args).await;
        assert_eq!(reply.status, StatusCode::OK, "{command} 失败：{}", String::from_utf8_lossy(&reply.bytes));
        reply.json()
    }

    async fn step_up(&self) {
        let reply = self.send(self.browser(Method::POST, "/api/test/step-up").body(Body::empty()).unwrap()).await;
        assert_eq!(reply.status, StatusCode::OK);
    }

    /// 登录本身算一次验证；测「需要重新验证」前先让它过期。
    async fn expire_step_up(&self) {
        let reply = self.send(self.browser(Method::POST, "/api/test/step-up?expire=1").body(Body::empty()).unwrap()).await;
        assert_eq!(reply.status, StatusCode::OK);
    }

    async fn fragment(&self, id: &str) -> Option<Value> {
        let listed = self.ok("list_fragments", json!({})).await;
        listed["fragments"].as_array().unwrap().iter().find(|fragment| fragment["id"] == id).cloned()
    }
}

fn reasons(listed: &Value) -> Vec<String> {
    listed["revisions"].as_array().unwrap().iter().map(|rev| rev["reason"].as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn old_versions_can_be_previewed_and_restored() {
    let h = Harness::new().await;
    let original = h.fragment(RIDE_ID).await.unwrap();
    let edited = h.ok("update_fragment", json!({ "id": RIDE_ID, "content": "改成一句话。" })).await;

    // 碎片按 id 查，笔记按路径查。
    let listed = h.ok("list_revisions", json!({ "id": RIDE_ID })).await;
    assert_eq!(listed["path"], RIDE_PATH);
    assert_eq!(reasons(&listed), ["edit", "import"]);
    let revisions = listed["revisions"].as_array().unwrap();
    assert_eq!(revisions[0]["sha"], edited["fileSha"]);
    assert_eq!(revisions[1]["sha"], original["fileSha"]);
    let first = revisions[1]["revId"].as_i64().unwrap();

    // 原始字节：文本内联预览，加 download 变成附件。
    let raw = h.get(&format!("/api/history/{first}")).await;
    assert_eq!(raw.status, StatusCode::OK);
    assert_eq!(raw.headers[header::CONTENT_TYPE], "text/plain; charset=utf-8");
    assert!(String::from_utf8(raw.bytes.clone()).unwrap().contains("早上沿江骑了 32 公里"));
    assert_eq!(shard_store::sha256_hex(&raw.bytes), original["fileSha"].as_str().unwrap());
    let download = h.get(&format!("/api/history/{first}?download=1")).await;
    assert_eq!(download.headers[header::CONTENT_TYPE], "application/octet-stream");
    assert!(download.headers[header::CONTENT_DISPOSITION].to_str().unwrap().starts_with("attachment; filename*=UTF-8''"));
    assert_eq!(h.get("/api/history/999999").await.status, StatusCode::NOT_FOUND);

    // 基线不对：与保存一样进冲突流程。
    let stale = h.call("restore_revision", json!({ "revId": first, "expectedSha": original["fileSha"] })).await;
    assert_eq!(stale.status, StatusCode::CONFLICT);
    assert_eq!(stale.json()["code"], "STALE_BASE");

    let restored = h.ok("restore_revision", json!({ "revId": first, "expectedSha": edited["fileSha"] })).await;
    assert_eq!(restored, json!({ "path": RIDE_PATH, "sha": original["fileSha"], "revived": false }));
    assert_eq!(h.fragment(RIDE_ID).await.unwrap()["content"], original["content"]);
    assert_eq!(reasons(&h.ok("list_revisions", json!({ "path": RIDE_PATH })).await), ["revert", "edit", "import"]);

    // 图片按文件头给出图片类型。
    let image = h.ok("list_revisions", json!({ "path": IMAGE_PATH })).await;
    let image_rev = image["revisions"][0]["revId"].as_i64().unwrap();
    assert_eq!(h.get(&format!("/api/history/{image_rev}")).await.headers[header::CONTENT_TYPE], "image/png");
    assert_eq!(h.call("list_revisions", json!({ "path": "notes/没有这篇.md" })).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn purged_items_come_back_with_their_history() {
    let h = Harness::new().await;
    let original = h.fragment(RIDE_ID).await.unwrap();
    let archived = h.ok("set_fragment_archived", json!({ "id": RIDE_ID, "archived": true })).await;
    let trash_path = archived["path"].as_str().unwrap().to_string();
    h.ok("purge_from_trash", json!({ "path": trash_path })).await;
    assert!(h.fragment(RIDE_ID).await.is_none());
    assert_eq!(h.call("list_revisions", json!({ "path": trash_path })).await.status, StatusCode::NOT_FOUND);

    let deleted = h.ok("list_deleted_entries", json!({})).await;
    assert_eq!(deleted["retentionDays"], 30);
    let entries = deleted["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry["path"], trash_path.as_str());
    assert_eq!(entry["sha"], archived["fileSha"]);
    let node_id = entry["nodeId"].as_i64().unwrap();
    let history = h.ok("list_revisions", json!({ "nodeId": node_id })).await;
    assert_eq!(reasons(&history), ["purge", "trash", "import"]);

    // 找回：放回回收站外的原位置（碎片回到时间线），沿用原节点。
    let restored = h.ok("restore_revision", json!({ "revId": entry["revId"] })).await;
    assert_eq!(restored["revived"], true);
    assert_eq!(restored["path"], RIDE_PATH);
    let back = h.fragment(RIDE_ID).await.unwrap();
    assert_eq!(back["archived"], false);
    assert_eq!(back["content"], original["content"]);
    assert_eq!(reasons(&h.ok("list_revisions", json!({ "id": RIDE_ID })).await), ["revert", "purge", "trash", "import"]);
    assert_eq!(h.ok("list_deleted_entries", json!({})).await["entries"], json!([]));

    // 删除时刻的记录没有内容可恢复。
    let purge_rev = history["revisions"][0]["revId"].clone();
    assert_eq!(h.call("restore_revision", json!({ "revId": purge_rev })).await.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn erasing_requires_a_fresh_passkey_check() {
    let h = Harness::new().await;
    h.ok("delete_library_entry", json!({ "path": IMAGE_PATH })).await;
    h.ok("empty_trash", json!({ "scope": "all" })).await;
    let entries = h.ok("list_deleted_entries", json!({})).await["entries"].as_array().unwrap().clone();
    let node_ids: Vec<i64> = entries.iter().map(|entry| entry["nodeId"].as_i64().unwrap()).collect();
    assert!(!node_ids.is_empty());

    h.expire_step_up().await;
    let refused = h.call("erase_deleted_entries", json!({ "nodeIds": node_ids })).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    assert_eq!(refused.json()["code"], "STEP_UP_REQUIRED");
    assert_eq!(h.ok("list_deleted_entries", json!({})).await["entries"].as_array().unwrap().len(), entries.len());

    h.step_up().await;
    let erased = h.ok("erase_deleted_entries", json!({ "nodeIds": node_ids })).await;
    assert_eq!(erased["nodes"].as_u64().unwrap() as usize, node_ids.len());
    assert_eq!(h.ok("list_deleted_entries", json!({})).await["entries"], json!([]));
    let rev = entries[0]["revId"].as_i64().unwrap();
    assert_eq!(h.get(&format!("/api/history/{rev}")).await.status, StatusCode::NOT_FOUND);

    // 在用条目的历史不能抹。
    let live = h.ok("list_revisions", json!({ "path": RIDE_PATH })).await["nodeId"].clone();
    assert_eq!(h.call("erase_deleted_entries", json!({ "nodeIds": [live] })).await.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn export_zip_requires_step_up_and_contains_the_vault() {
    let h = Harness::new().await;
    h.expire_step_up().await;
    let refused = h.get("/api/export.zip?utcOffset=480").await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);

    h.step_up().await;
    let reply = h.get("/api/export.zip?utcOffset=480").await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.headers[header::CONTENT_TYPE], "application/zip");
    let disposition = reply.headers[header::CONTENT_DISPOSITION].to_str().unwrap();
    assert!(disposition.starts_with("attachment; filename*=UTF-8''shard-export-"), "{disposition}");

    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(reply.bytes)).unwrap();
    let golden = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/vault-golden");
    for rel in [RIDE_PATH, IMAGE_PATH, "notes/读书/置身事内.md", "datasets/阅读记录.csv"] {
        let mut file = archive.by_name(rel).unwrap_or_else(|_| panic!("zip 里缺 {rel}"));
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, std::fs::read(golden.join(rel)).unwrap(), "{rel} 与示例库逐字节一致");
    }
}
