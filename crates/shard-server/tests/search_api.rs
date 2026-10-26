//! 服务端搜索经 HTTP 的端到端测试：导入虚构示例库 `tests/fixtures/vault-golden`，按网页端
//! `src/lib/search-api.ts` 的参数调用 `search_vault` / `read_search_target`，核对命中、缓存失效、
//! 上下文过期与结构化错误体。
//! 运行：`cargo test -p shard-server --features test-auth`。
#![cfg(feature = "test-auth")]

use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use shard_server::{app, commands, config::Config, rpc::base_registry, search, state::AppState};
use shard_store::Store;
use tower::ServiceExt;

const ORIGIN: &str = "http://localhost:18788";
const EXCERPT_ID: &str = "20261020-090000-d4e5f6a7-3a3b3c";
const TRASHED_ID: &str = "20260915-180000-e5f6a7b8-4a4b4c";

struct Harness {
    _data: tempfile::TempDir,
    app: Router,
    store: Arc<Store>,
    vault: String,
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
        search::register(&mut registry);
        let state = AppState::open(config, registry).unwrap();
        shard_store::transfer::import_vault(&state.store, &golden).unwrap();
        commands::ensure_layout(&state.store).unwrap();
        let store = Arc::clone(&state.store);
        let vault = state.vault_identity.clone();
        let app = app::build(state);
        let response = app
            .clone()
            .oneshot(Request::post("/api/test/session").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_string();
        Self { _data: data, app, store, vault, cookie, keys: AtomicUsize::new(0) }
    }

    async fn call(&self, command: &str, args: Value) -> Reply {
        let key = format!("key-{}", self.keys.fetch_add(1, Ordering::Relaxed));
        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("/api/rpc/{command}"))
            .header(header::COOKIE, &self.cookie)
            .header("x-shard-request", "1")
            .header(header::ORIGIN, ORIGIN)
            .header("sec-fetch-site", "same-origin")
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

    /// 与前端 `searchVault` 发出的请求同形。
    fn search_request(&self, query: &str, include_trash: bool, context: Value) -> Value {
        json!({
            "request": {
                "clientRequestId": format!("search-{query}"),
                "expectedVaultPath": self.vault,
                "context": context,
                "scope": "public",
                "includeTrash": include_trash,
                "queryVersion": 1,
                "projectionVersion": 1,
                "query": query,
                "limit": 50,
                "refresh": "auto"
            }
        })
    }

    async fn search(&self, query: &str, include_trash: bool) -> Value {
        self.ok("search_vault", self.search_request(query, include_trash, Value::Null)).await
    }
}

fn hit_paths(response: &Value) -> Vec<String> {
    response["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|hit| hit["target"]["path"].as_str().unwrap().to_string())
        .collect()
}

fn hit_with_object(response: &Value, id: &str) -> Value {
    response["hits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|hit| hit["target"]["objectId"] == id)
        .unwrap_or_else(|| panic!("没有命中 {id}：{response}"))
        .clone()
}

#[tokio::test]
async fn chinese_queries_hit_notes_and_fragments() {
    let h = Harness::new().await;
    let found = h.search("置身事内", false).await;
    assert_eq!(found["clientRequestId"], "search-置身事内");
    assert_eq!(found["indexState"], "ready");
    assert_eq!(found["context"]["vaultPath"], h.vault);
    assert_eq!(found["context"]["privacyEpoch"], "0");
    assert!(found["snapshotId"].as_str().is_some_and(|id| !id.is_empty()));
    let paths = hit_paths(&found);
    assert!(paths.contains(&"notes/读书/置身事内.md".to_string()), "{paths:?}");
    // 碎片正文里的 [[置身事内]] 也算命中。
    let excerpt = hit_with_object(&found, EXCERPT_ID);
    assert_eq!(excerpt["target"]["kind"], "fragment");
    assert_eq!(excerpt["target"]["scope"], "public");
    assert_eq!(excerpt["target"]["archived"], false);
    assert_eq!(found["total"].as_u64().unwrap() as usize, paths.len());

    // 单字查询（FTS 做不到的）同样精确扫描。
    let single = h.search("读", false).await;
    assert!(hit_paths(&single).contains(&"notes/读书/置身事内.md".to_string()));
    assert!(h.search("这句话不存在于示例库", false).await["hits"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn trash_is_searched_only_when_asked() {
    let h = Harness::new().await;
    assert!(h.search("归档的旧碎片", false).await["hits"].as_array().unwrap().is_empty());
    let with_trash = h.search("归档的旧碎片", true).await;
    let trashed = hit_with_object(&with_trash, TRASHED_ID);
    assert_eq!(trashed["target"]["archived"], true);
    assert!(trashed["target"]["path"].as_str().unwrap().starts_with(".trash/"));
}

#[tokio::test]
async fn read_search_target_returns_the_fragment() {
    let h = Harness::new().await;
    let found = h.search("土地财政", false).await;
    let hit = hit_with_object(&found, EXCERPT_ID);
    let read = h
        .ok(
            "read_search_target",
            json!({
                "request": {
                    "clientRequestId": "read-1",
                    "expectedVaultPath": h.vault,
                    "context": found["context"],
                    "target": hit["target"],
                    "expectedRevision": hit["revision"]
                }
            }),
        )
        .await;
    assert_eq!(read["clientRequestId"], "read-1");
    assert_eq!(read["target"], hit["target"]);
    // 搜索预览一律只读（与桌面一致），编辑走打开文档。
    assert_eq!(read["readOnly"], true);
    assert_eq!(read["fragment"]["id"], EXCERPT_ID);
    assert!(read["fragment"]["content"].as_str().unwrap().contains("土地财政"));
    assert!(read["revision"].as_str().is_some_and(|revision| !revision.is_empty()));
}

#[tokio::test]
async fn writes_invalidate_the_cached_snapshot() {
    let h = Harness::new().await;
    let before = h.search("独角兽", false).await;
    assert!(before["hits"].as_array().unwrap().is_empty());

    let created = h.ok("create_fragment", json!({ "content": "网页端记下的独角兽" })).await;
    let id = created["id"].as_str().unwrap();
    let after = h.search("独角兽", false).await;
    assert_eq!(hit_with_object(&after, id)["target"]["kind"], "fragment");
    assert_ne!(after["snapshotId"], before["snapshotId"]);

    // 内容没变时复用同一份快照。
    assert_eq!(h.search("独角兽", false).await["snapshotId"], after["snapshotId"]);
}

#[tokio::test]
async fn stale_context_lockbox_and_bad_requests_return_structured_errors() {
    let h = Harness::new().await;
    let context = h.search("骑行", false).await["context"].clone();
    // 带着当前上下文能继续搜。
    h.ok("search_vault", h.search_request("骑行", false, context.clone())).await;

    // 从备份恢复后 epoch 轮换：旧上下文过期。
    h.store.rotate_epoch().unwrap();
    let expired = h.call("search_vault", h.search_request("骑行", false, context.clone())).await;
    assert_eq!(expired.status, StatusCode::CONFLICT);
    assert_eq!(expired.body["code"], "contextExpired");
    assert_eq!(expired.body["error"], json!({ "code": "contextExpired" }));

    // 别的资料库的身份。
    let mut other = h.search_request("骑行", false, Value::Null);
    other["request"]["expectedVaultPath"] = json!("shard://elsewhere/0000");
    let changed = h.call("search_vault", other).await;
    assert_eq!(changed.status, StatusCode::CONFLICT);
    assert_eq!(changed.body["error"], json!({ "code": "vaultChanged" }));

    // 密匣只在客户端解密，服务端一律 locked。
    let mut lockbox = h.search_request("骑行", false, Value::Null);
    lockbox["request"]["scope"] = json!("lockbox");
    let locked = h.call("search_vault", lockbox).await;
    assert_eq!(locked.status, StatusCode::CONFLICT);
    assert_eq!(locked.body["error"], json!({ "code": "locked" }));

    // 不认识的查询版本是请求错误，带原因。
    let mut version = h.search_request("骑行", false, Value::Null);
    version["request"]["queryVersion"] = json!(99);
    let invalid = h.call("search_vault", version).await;
    assert_eq!(invalid.status, StatusCode::BAD_REQUEST);
    assert_eq!(invalid.body["error"], json!({ "code": "invalidRequest", "reason": "unsupportedQueryVersion" }));

    // 契约冻结：多余字段拒绝。
    let mut extra = h.search_request("骑行", false, Value::Null);
    extra["request"]["extra"] = json!(true);
    assert_eq!(h.call("search_vault", extra).await.status, StatusCode::BAD_REQUEST);
}
