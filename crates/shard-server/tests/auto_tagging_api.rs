//! The same server worker covers browser sessions and desktop/iOS device writes.
#![cfg(feature = "test-auth")]

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use shard_server::{
    app, auto_tagging, commands, config::Config, rpc, state::AppState, tagging_model::ModelClient,
};
use tower::ServiceExt;

const ORIGIN: &str = "http://localhost:18788";

struct Harness {
    _dir: tempfile::TempDir,
    state: AppState,
    app: Router,
    cookie: String,
    key: AtomicUsize,
}

impl Harness {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = rpc::base_registry();
        commands::register(&mut registry);
        let state = AppState::open(
            Config::new(dir.path().into(), ORIGIN, None, false).unwrap(),
            registry,
        )
        .unwrap();
        commands::ensure_layout(&state.store).unwrap();
        for kind in ["desktop", "ios"] {
            state
                .auth
                .create_device(
                    kind,
                    kind,
                    // iOS ServerRemote uses the existing desktop device-token protocol.
                    "desktop",
                    &format!("test-{kind}-token"),
                    "read,write",
                )
                .unwrap();
        }
        let app = app::build(state.clone());
        let reply = app
            .clone()
            .oneshot(
                Request::post("/api/test/session")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let cookie = reply.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        Self {
            _dir: dir,
            state,
            app,
            cookie,
            key: AtomicUsize::new(0),
        }
    }

    async fn request(&self, device: Option<&str>, method: Method, uri: &str, body: Value) -> Value {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .header(
                "idempotency-key",
                format!("test-op-{}", self.key.fetch_add(1, Ordering::Relaxed)),
            );
        if let Some(device) = device {
            request = request.header(header::AUTHORIZATION, format!("Bearer test-{device}-token"));
        } else {
            request = request
                .header(header::COOKIE, &self.cookie)
                .header(header::ORIGIN, ORIGIN)
                .header("x-shard-request", "1")
                .header("sec-fetch-site", "same-origin");
        }
        let reply = self
            .app
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = reply.status();
        let bytes = reply.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&bytes)
        );
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn rpc(&self, device: Option<&str>, name: &str, body: Value) -> Value {
        self.request(device, Method::POST, &format!("/api/rpc/{name}"), body)
            .await
    }

    async fn fragment(&self, id: &Value) -> Value {
        let result = self.rpc(None, "list_fragments", json!({})).await;
        result["fragments"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == *id)
            .unwrap()
            .clone()
    }
}

#[tokio::test]
async fn browser_desktop_and_ios_saves_share_tagging_and_sync_results() {
    let h = Harness::new().await;
    h.rpc(
        None,
        "create_fragment",
        json!({"content":"已有分类", "tags":["骑行","装备"]}),
    )
    .await;
    let mut created = Vec::new();
    for device in [None, Some("desktop"), Some("ios")] {
        created.push(
            h.rpc(
                device,
                "create_fragment",
                json!({"content":"长途骑行前试装车包。", "tags":[]}),
            )
            .await,
        );
    }
    let requests = Arc::new(AtomicUsize::new(0));
    let counter = requests.clone();
    let model = Router::new().route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
        counter.fetch_add(1, Ordering::SeqCst);
        async move {
            let input: Value = serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
            let vocabulary = input["existing_tags"].as_array().unwrap();
            assert!(vocabulary.contains(&json!("骑行")) && vocabulary.contains(&json!("装备")));
            let items: Vec<_> = input["items"].as_array().unwrap().iter()
                .map(|entry| json!({"id":entry["id"], "tags":["骑行","装备"]})).collect();
            Json(json!({"choices":[{"finish_reason":"stop", "message":{"content":json!({"items":items}).to_string()}}]}))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = ModelClient::new(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        "test-model",
        "test-key",
    )
    .unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, model).await.unwrap();
    });
    let mut events = h.state.events.subscribe();
    for _ in 0..6 {
        auto_tagging::process_once(&h.state, &client).await.unwrap();
    }
    assert_eq!(requests.load(Ordering::SeqCst), 3);
    let mut changes = 0;
    while let Ok(event) = events.try_recv() {
        changes += event.changes.len();
    }
    assert_eq!(
        changes, 3,
        "tag writes must publish committed changes for SSE clients"
    );
    for original in &created {
        let tagged = h.fragment(&original["id"]).await;
        assert_eq!(tagged["content"], original["content"]);
        assert_ne!(tagged["fileSha"], original["fileSha"]);
        assert!(tagged["tags"].as_array().unwrap().contains(&json!("骑行")));
        let fetched = h
            .request(
                Some("ios"),
                Method::POST,
                "/api/sync/fetch",
                json!({"paths":[original["path"]]}),
            )
            .await;
        let raw = String::from_utf8(
            STANDARD
                .decode(fetched["items"][0]["data"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert!(raw.contains("骑行") && raw.contains("装备"));
        assert_eq!(fetched["items"][0]["sha"], tagged["fileSha"]);
    }
    // Explicit removal remains removed for the same content, including after another scan.
    h.rpc(
        None,
        "update_fragment_tags",
        json!({"id":created[0]["id"], "tags":["inbox"]}),
    )
    .await;
    for _ in 0..2 {
        auto_tagging::process_once(&h.state, &client).await.unwrap();
    }
    assert_eq!(requests.load(Ordering::SeqCst), 3);
    assert_eq!(
        h.fragment(&created[0]["id"]).await["tags"],
        json!(["inbox"])
    );
    // The editor's normal body save only supplies body-derived tags; server keeps AI topics.
    let tagged = h.fragment(&created[1]["id"]).await;
    let edited = h
        .rpc(
            Some("desktop"),
            "update_fragment",
            json!({
                "id":tagged["id"], "content":"长途骑行前试装车包，调整了绑带。",
                "tags":["inbox"], "expectedFileSha":tagged["fileSha"]
            }),
        )
        .await;
    assert!(edited["tags"].as_array().unwrap().contains(&json!("装备")));
    task.abort();
}

#[tokio::test]
async fn shutdown_cancels_an_inflight_model_request_without_waiting_for_its_timeout() {
    let h = Harness::new().await;
    h.rpc(
        None,
        "create_fragment",
        json!({"content":"记录骑行路线。", "tags":[]}),
    )
    .await;
    let started = Arc::new(tokio::sync::Notify::new());
    let signal = started.clone();
    let model = Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let signal = signal.clone();
            async move {
                signal.notify_one();
                std::future::pending::<Json<Value>>().await
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = ModelClient::new(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        "test-model",
        "test-key",
    )
    .unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, model).await.unwrap();
    });
    let worker = auto_tagging::spawn(h.state.clone(), client);
    tokio::time::timeout(std::time::Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    h.state.begin_shutdown();
    tokio::time::timeout(std::time::Duration::from_secs(1), worker)
        .await
        .unwrap()
        .unwrap();
    task.abort();
}
