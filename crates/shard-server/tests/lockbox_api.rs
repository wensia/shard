//! 密匣接口经 HTTP 的端到端测试：客户端用 `shard-lockbox` 加密，服务器只存密文。
//! 覆盖设置（manifest CAS）、成批写入的整批成败、删除与重建、结构校验、网页解锁开关、SSE 推送，
//! 以及公开碎片移入密匣后库文件与 WAL 里不留明文（金丝雀）。
//! 运行：`cargo test -p shard-server --features test-auth`。
#![cfg(feature = "test-auth")]

use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use shard_lockbox::{Envelope, Manifest, WriteKey};
use shard_server::{app, commands, config::Config, history, lockbox, rpc::base_registry, state::AppState};
use tower::ServiceExt;

const ORIGIN: &str = "http://localhost:18788";
const PASSWORD: &str = "lockbox password";
const RIDE_ID: &str = "20261026-073012-a1b2c3d4-0a0b0c";

struct Harness {
    data: tempfile::TempDir,
    app: Router,
    cookie: String,
    keys: AtomicUsize,
}

struct Reply {
    status: StatusCode,
    body: Value,
}

impl Harness {
    async fn new() -> Self {
        let golden = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/vault-golden");
        let data = tempfile::tempdir().unwrap();
        let config = Config::new(data.path().to_path_buf(), ORIGIN, None, false).unwrap();
        let mut registry = base_registry();
        commands::register(&mut registry);
        history::register(&mut registry);
        lockbox::register(&mut registry);
        let state = AppState::open(config, registry).unwrap();
        shard_store::transfer::import_vault(&state.store, &golden).unwrap();
        commands::ensure_layout(&state.store).unwrap();
        let app = app::build(state);
        let response = app
            .clone()
            .oneshot(Request::post("/api/test/session").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_string();
        Self { data, app, cookie, keys: AtomicUsize::new(0) }
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

    async fn call(&self, command: &str, args: Value) -> Reply {
        let key = format!("key-{}", self.keys.fetch_add(1, Ordering::Relaxed));
        let request = self
            .browser(Method::POST, &format!("/api/rpc/{command}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header("idempotency-key", key)
            .header("x-shard-utc-offset", "480")
            .body(Body::from(args.to_string()))
            .unwrap();
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        Reply { status, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null) }
    }

    async fn ok(&self, command: &str, args: Value) -> Value {
        let reply = self.call(command, args).await;
        assert_eq!(reply.status, StatusCode::OK, "{command} 失败：{}", reply.body);
        reply.body
    }

    fn db_file(&self, name: &str) -> PathBuf {
        self.data.path().join(name)
    }
}

/// 客户端设置密匣：返回 (manifest, 主密钥)。
fn new_manifest() -> (Manifest, Vec<u8>) {
    let master_key = shard_lockbox::random_bytes(32);
    let manifest = Manifest::build(PASSWORD, &shard_lockbox::generate_recovery_key(), &master_key).unwrap();
    (manifest, master_key)
}

fn sealed(manifest: &Manifest, id: &str, body: &str) -> String {
    let public_key = manifest.write_public_key().unwrap().unwrap();
    let payload = json!({ "frontmatter": { "id": id }, "body": body }).to_string();
    Envelope::seal(&WriteKey::Public(public_key), id, payload.as_bytes()).unwrap().to_text().unwrap()
}

fn item_path(id: &str) -> String {
    format!("lockbox/fragments/2026/10/{id}.shard")
}

#[tokio::test]
async fn setup_write_and_read_back_only_ciphertext() {
    let h = Harness::new().await;
    let empty = h.ok("lockbox_snapshot", json!({})).await;
    assert_eq!(empty["configured"], false);
    assert_eq!(empty["items"], json!([]));
    assert_eq!(empty["webUnlock"], true);

    let (manifest, master_key) = new_manifest();
    let body = manifest.to_text().unwrap();
    let setup = h.ok("lockbox_apply", json!({ "manifest": { "body": body, "expectedSha": null } })).await;
    let manifest_sha = setup["manifest"]["sha"].clone();
    // 再「设置」一次：已经有了，CAS 拒绝。
    let again = h.call("lockbox_apply", json!({ "manifest": { "body": body, "expectedSha": null } })).await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    assert_eq!(again.body["code"], "STALE_BASE");

    let first = "20261026-100000-aaaaaaaa-000001";
    let second = "20261026-100100-bbbbbbbb-000002";
    let written = h
        .ok(
            "lockbox_apply",
            json!({ "items": [
                { "op": "put", "id": first, "envelope": sealed(&manifest, first, "第一条私密"), "path": item_path(first), "expectedSha": null },
                { "op": "put", "id": second, "envelope": sealed(&manifest, second, "第二条私密"), "path": item_path(second), "expectedSha": null },
            ] }),
        )
        .await;
    let first_sha = written["items"][0]["sha"].as_str().unwrap().to_string();

    // 快照里只有密文；客户端用口令解开。
    let snapshot = h.ok("lockbox_snapshot", json!({})).await;
    assert_eq!(snapshot["configured"], true);
    assert_eq!(snapshot["manifest"]["sha"], manifest_sha);
    let fetched = Manifest::parse(snapshot["manifest"]["body"].as_str().unwrap()).unwrap();
    let read_keys = fetched.read_keys(&fetched.unwrap_with_password(PASSWORD).unwrap()).unwrap();
    assert_eq!(read_keys.master_key, master_key);
    let items = snapshot["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let plain: Value = serde_json::from_slice(&shard_lockbox::open_text(items[0]["envelope"].as_str().unwrap(), &read_keys).unwrap()).unwrap();
    assert_eq!(plain["body"], "第一条私密");
    assert_eq!(items[0]["path"], item_path(first));
    assert!(!items[0]["envelope"].as_str().unwrap().contains("私密"));

    // 一批里有一条基线不对：整批不写。
    let stale = h
        .call(
            "lockbox_apply",
            json!({ "items": [
                { "op": "put", "id": first, "envelope": sealed(&manifest, first, "改过"), "expectedSha": first_sha },
                { "op": "delete", "id": second, "expectedSha": "0".repeat(64) },
            ] }),
        )
        .await;
    assert_eq!(stale.status, StatusCode::CONFLICT);
    let unchanged = h.ok("lockbox_snapshot", json!({})).await;
    assert_eq!(unchanged["items"][0]["sha"], first_sha.as_str());
    assert_eq!(unchanged["items"].as_array().unwrap().len(), 2);

    // 删除后同一 id 可以重新写入；路径缺省时沿用原来的。
    let second_sha = unchanged["items"][1]["sha"].clone();
    h.ok("lockbox_apply", json!({ "items": [{ "op": "delete", "id": second, "expectedSha": second_sha }] })).await;
    assert_eq!(h.ok("lockbox_snapshot", json!({})).await["items"].as_array().unwrap().len(), 1);
    h.ok("lockbox_apply", json!({ "items": [{ "op": "put", "id": second, "envelope": sealed(&manifest, second, "回来了"), "expectedSha": null }] }))
        .await;
    let back = h.ok("lockbox_snapshot", json!({})).await;
    assert_eq!(back["items"][1]["path"], item_path(second));

    // 结构校验：信封 id 不符、路径跳出、manifest 不是 manifest。
    let mismatched = h
        .call("lockbox_apply", json!({ "items": [{ "op": "put", "id": "other", "envelope": sealed(&manifest, first, "x"), "expectedSha": null }] }))
        .await;
    assert_eq!(mismatched.status, StatusCode::BAD_REQUEST);
    let escaping = h
        .call(
            "lockbox_apply",
            json!({ "items": [{ "op": "put", "id": "x1", "envelope": sealed(&manifest, "x1", "x"), "path": "lockbox/../notes/x.shard", "expectedSha": null }] }),
        )
        .await;
    assert_eq!(escaping.status, StatusCode::BAD_REQUEST);
    let bogus = h.call("lockbox_apply", json!({ "manifest": { "body": "{}", "expectedSha": manifest_sha } })).await;
    assert_eq!(bogus.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn web_unlock_switch_withholds_envelopes_from_browsers() {
    let h = Harness::new().await;
    let (manifest, _) = new_manifest();
    h.ok("lockbox_apply", json!({ "manifest": { "body": manifest.to_text().unwrap(), "expectedSha": null } })).await;
    let id = "20261026-100000-aaaaaaaa-000001";
    h.ok("lockbox_apply", json!({ "items": [{ "op": "put", "id": id, "envelope": sealed(&manifest, id, "私密"), "path": item_path(id), "expectedSha": null }] }))
        .await;

    h.ok("set_lockbox_web_unlock", json!({ "allowed": false })).await;
    let withheld = h.ok("lockbox_snapshot", json!({})).await;
    assert_eq!(withheld["webUnlock"], false);
    assert_eq!(withheld["itemsWithheld"], true);
    assert_eq!(withheld["items"], json!([]));
    // manifest 照给：锁着时用公钥写入不需要口令。
    assert!(withheld["manifest"]["body"].is_string());

    h.ok("set_lockbox_web_unlock", json!({ "allowed": true })).await;
    assert_eq!(h.ok("lockbox_snapshot", json!({})).await["items"].as_array().unwrap().len(), 1);
}

async fn read_lockbox_changed(body: &mut Body) {
    let mut text = String::new();
    while !text.contains("event: lockbox-changed") {
        let frame = tokio::time::timeout(Duration::from_secs(5), body.frame()).await.expect("SSE 超时").unwrap().unwrap();
        if let Some(data) = frame.data_ref() {
            text.push_str(&String::from_utf8_lossy(data));
        }
    }
}

#[tokio::test]
async fn lockbox_writes_are_pushed_over_sse() {
    let h = Harness::new().await;
    let response = h.app.clone().oneshot(h.browser(Method::GET, "/api/events").body(Body::empty()).unwrap()).await.unwrap();
    let mut body = response.into_body();
    let (manifest, _) = new_manifest();
    h.ok("lockbox_apply", json!({ "manifest": { "body": manifest.to_text().unwrap(), "expectedSha": null } })).await;
    read_lockbox_changed(&mut body).await;
    // 网页解锁开关也推：其他已解锁的页面据此重取快照、立即上锁。
    h.ok("set_lockbox_web_unlock", json!({ "allowed": false })).await;
    read_lockbox_changed(&mut body).await;
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

#[tokio::test]
async fn sealing_a_public_fragment_leaves_no_plaintext_behind() {
    let h = Harness::new().await;
    let (manifest, _) = new_manifest();
    h.ok("lockbox_apply", json!({ "manifest": { "body": manifest.to_text().unwrap(), "expectedSha": null } })).await;

    const CANARY: &str = "CANARY-密匣-9f1e";
    let created = h.ok("create_fragment", json!({ "content": format!("{CANARY} 第一版") })).await;
    let id = created["id"].as_str().unwrap().to_string();
    // 换个时间窗口外也一样：再改一次，修订表里有两版明文。
    let updated = h.ok("update_fragment", json!({ "id": id, "content": format!("{CANARY} 第二版") })).await;
    let present = ["shard.db", "shard.db-wal"].iter().any(|name| contains(&std::fs::read(h.db_file(name)).unwrap_or_default(), CANARY.as_bytes()));
    assert!(present, "移入前库里应当有明文");

    let envelope = sealed(&manifest, &id, &format!("{CANARY} 第二版"));
    let item = json!({ "id": id, "envelope": envelope, "path": item_path(&id) });
    // 基线不对：什么都不动。
    let stale = h.call("seal_fragment_into_lockbox", json!({ "fragmentId": id, "expectedFileSha": created["fileSha"], "item": item })).await;
    assert_eq!(stale.status, StatusCode::CONFLICT);

    let sealed_reply = h.ok("seal_fragment_into_lockbox", json!({ "fragmentId": id, "expectedFileSha": updated["fileSha"], "item": item })).await;
    assert!(sealed_reply["removedPath"].as_str().unwrap().starts_with("fragments/"));
    let fragments = h.ok("list_fragments", json!({})).await;
    assert!(!fragments["fragments"].as_array().unwrap().iter().any(|fragment| fragment["id"] == id.as_str()));
    // 明文历史不可找回。
    assert_eq!(h.call("list_revisions", json!({ "id": id })).await.status, StatusCode::NOT_FOUND);
    assert_eq!(h.ok("list_deleted_entries", json!({})).await["entries"], json!([]));
    assert_eq!(h.ok("lockbox_snapshot", json!({})).await["items"][0]["id"], id.as_str());

    for name in ["shard.db", "shard.db-wal", "blobs.db", "blobs.db-wal"] {
        let bytes = std::fs::read(h.db_file(name)).unwrap_or_default();
        assert!(!contains(&bytes, CANARY.as_bytes()), "{name} 里还有明文");
    }
    // 同 id 已在密匣：拒绝再移一次。
    let ride = h.ok("list_fragments", json!({})).await["fragments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|fragment| fragment["id"] == RIDE_ID)
        .cloned()
        .unwrap();
    let wrong_id = h
        .call(
            "seal_fragment_into_lockbox",
            json!({ "fragmentId": RIDE_ID, "expectedFileSha": ride["fileSha"], "item": { "id": id, "envelope": sealed(&manifest, &id, "x"), "path": item_path(&id) } }),
        )
        .await;
    assert_eq!(wrong_id.status, StatusCode::BAD_REQUEST);
}
