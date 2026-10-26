//! 测试装置：进程内的真 shard-server（导入 `tests/fixtures/vault-golden`），每台「设备」前面挡一个
//! 可开关的转发代理（断网 = 代理拒绝连接；「请求送达后丢响应」= 转发给服务器后不回响应直接断开），
//! 设备令牌直接在服务器认证库里签发（与配对批准后签发的同一种记录，不经网页通行密钥）。

#![allow(dead_code)]

use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use serde_json::{json, Value};
use shard_remote::{Client, ClientOptions, RemoteError};
use shard_server::{app, commands, config::Config, rpc::base_registry, state::AppState};
use shard_sync::{EngineOptions, RoundReport, SyncEngine, SyncEvent};

pub const RIDE: &str = "20261026-073012-a1b2c3d4-0a0b0c";
pub const MEMO: &str = "20261025-221500-b2c3d4e5-1a1b1c";

pub struct Server {
    pub url: String,
    pub state: AppState,
    pub dir: PathBuf,
    _runtime: tokio::runtime::Runtime,
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap().flatten() {
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// 在 `data` 上起服务器（与 `shard-server serve` 同样的装配：内容命令、搜索、版本历史、密匣）。`seed` 时先导入示例资料库。
pub fn start_server(data: &Path, seed: bool) -> Server {
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = Config::new(data.to_path_buf(), &format!("http://localhost:{port}"), None, false).unwrap();
    let mut registry = base_registry();
    commands::register(&mut registry);
    shard_server::search::register(&mut registry);
    shard_server::history::register(&mut registry);
    shard_server::lockbox::register(&mut registry);
    let state = AppState::open(config, registry).unwrap();
    if seed {
        let source = data.parent().unwrap().join("seed-vault");
        copy_dir(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/vault-golden"), &source);
        shard_store::transfer::import_vault(&state.store, &source).unwrap();
    }
    commands::ensure_layout(&state.store).unwrap();
    let router = app::build(state.clone());
    runtime.spawn(async move {
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });
    Server { url: format!("http://127.0.0.1:{port}"), state, dir: data.to_path_buf(), _runtime: runtime }
}

/// 签发一个设备令牌（与配对批准后的记录相同）。
pub fn issue_token(server: &Server, name: &str) -> String {
    let token = format!("shd_dev_{}", shard_core::sha256_hex(format!("{name}-{}", server.url).as_bytes()));
    server.state.auth.create_device(&format!("dev-{name}"), name, "desktop", &token, "vault").unwrap();
    token
}

pub fn client_options() -> ClientOptions {
    ClientOptions::new("shard-sync-test/1", "test").retry_base(Duration::from_millis(5))
}

/// 直接连服务器、不经代理的客户端：核对服务器上的真相。
pub fn admin(server: &Server, token: &str) -> Client {
    Client::new(&server.url, token, client_options()).unwrap()
}

// ---- 可断网的转发代理 ----

#[derive(Clone, Debug)]
pub struct Logged {
    pub method: String,
    pub path: String,
    pub key: Option<String>,
    pub status: Option<u16>,
    pub replayed: bool,
}

struct ProxyState {
    backend: Mutex<String>,
    offline: Mutex<bool>,
    /// 下一个路径含这个片段的请求：照常转给服务器，但不回响应、直接断开，并从此断网。
    drop_next: Mutex<Option<String>>,
    log: Mutex<Vec<Logged>>,
}

#[derive(Clone)]
pub struct Proxy {
    pub url: String,
    state: Arc<ProxyState>,
}

impl Proxy {
    pub fn start(backend: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let state = Arc::new(ProxyState {
            backend: Mutex::new(backend.to_string()),
            offline: Mutex::new(false),
            drop_next: Mutex::new(None),
            log: Mutex::new(Vec::new()),
        });
        let shared = Arc::clone(&state);
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let state = Arc::clone(&shared);
                thread::spawn(move || serve_one(stream, &state));
            }
        });
        Self { url, state }
    }

    pub fn set_offline(&self, offline: bool) {
        *self.state.offline.lock().unwrap() = offline;
    }

    pub fn set_backend(&self, backend: &str) {
        *self.state.backend.lock().unwrap() = backend.to_string();
    }

    pub fn drop_next_response(&self, needle: &str) {
        *self.state.drop_next.lock().unwrap() = Some(needle.to_string());
    }

    pub fn log(&self) -> Vec<Logged> {
        self.state.log.lock().unwrap().clone()
    }

    pub fn clear_log(&self) {
        self.state.log.lock().unwrap().clear();
    }

    /// 转发成功（拿到了服务器响应）的请求里，方法相同、路径以 `prefix` 开头的个数。
    pub fn count(&self, method: &str, prefix: &str) -> usize {
        self.log()
            .iter()
            .filter(|entry| entry.method == method && entry.path.starts_with(prefix) && entry.status.is_some())
            .count()
    }
}

fn serve_one(mut stream: TcpStream, state: &ProxyState) {
    if *state.offline.lock().unwrap() {
        let _ = stream.shutdown(std::net::Shutdown::Both);
        return;
    }
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let mut headers = HashMap::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).unwrap_or(0) == 0 {
            return;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let length = headers.get("content-length").and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
    let mut body = vec![0u8; length];
    if reader.read_exact(&mut body).is_err() {
        return;
    }
    let drop_this = {
        let mut drop_next = state.drop_next.lock().unwrap();
        match drop_next.as_deref() {
            Some(needle) if path.contains(needle) => {
                *drop_next = None;
                true
            }
            _ => false,
        }
    };
    let backend = state.backend.lock().unwrap().clone();
    let forwarded = forward(&backend, &method, &path, &headers, body);
    let key = headers.get("idempotency-key").cloned();
    let (status, response_headers, response_body) = match forwarded {
        Ok(response) => response,
        Err(_) => {
            state.log.lock().unwrap().push(Logged { method, path, key, status: None, replayed: false });
            let _ = stream.shutdown(std::net::Shutdown::Both);
            return;
        }
    };
    let replayed = response_headers.iter().any(|(name, value)| name == "idempotent-replayed" && value == "true");
    state.log.lock().unwrap().push(Logged { method: method.clone(), path, key, status: Some(status), replayed });
    if drop_this {
        // 请求已经送达、服务器已经提交；响应丢在网络上，网络随即断开。
        *state.offline.lock().unwrap() = true;
        let _ = stream.shutdown(std::net::Shutdown::Both);
        return;
    }
    let mut head = format!("HTTP/1.1 {status} X\r\n");
    for (name, value) in &response_headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", if method == "HEAD" { 0 } else { response_body.len() }));
    let _ = stream.write_all(head.as_bytes());
    if method != "HEAD" {
        let _ = stream.write_all(&response_body);
    }
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

type Forwarded = (u16, Vec<(String, String)>, Vec<u8>);

fn forward(backend: &str, method: &str, path: &str, headers: &HashMap<String, String>, body: Vec<u8>) -> Result<Forwarded, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
    let url = format!("{backend}{path}");
    let pass = ["authorization", "idempotency-key", "x-shard-utc-offset", "content-type", "last-event-id"];
    macro_rules! with_headers {
        ($builder:expr) => {{
            let mut builder = $builder;
            for name in pass {
                if let Some(value) = headers.get(name) {
                    builder = builder.header(name, value.as_str());
                }
            }
            builder
        }};
    }
    let response = match method {
        "GET" => with_headers!(agent.get(&url)).call(),
        "HEAD" => with_headers!(agent.head(&url)).call(),
        "POST" => with_headers!(agent.post(&url)).send(&body[..]),
        "PUT" => with_headers!(agent.put(&url)).send(&body[..]),
        other => return Err(format!("代理不支持 {other}")),
    };
    let mut response = response.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let keep = ["content-type", "idempotent-replayed", "etag", "cache-control"];
    let response_headers = response
        .headers()
        .iter()
        .filter(|(name, _)| keep.contains(&name.as_str()))
        .map(|(name, value)| (name.to_string(), value.to_str().unwrap_or_default().to_string()))
        .collect();
    let bytes = if method == "HEAD" {
        Vec::new()
    } else {
        response.body_mut().with_config().limit(u64::MAX).read_to_vec().map_err(|error| error.to_string())?
    };
    Ok((status, response_headers, bytes))
}

// ---- 一台设备：同步引擎 + 它自己的代理 ----

pub struct Device {
    pub engine: Arc<SyncEngine>,
    pub proxy: Proxy,
    pub events: Arc<Mutex<Vec<SyncEvent>>>,
    pub dir: PathBuf,
}

impl Device {
    pub fn new(server: &Server, root: &Path, name: &str) -> Self {
        let token = issue_token(server, name);
        let proxy = Proxy::start(&server.url);
        let client = Client::new(&proxy.url, token, client_options()).unwrap();
        let dir = root.join(name);
        let mut options = EngineOptions::new(dir.join("remote"));
        options.recovered_dir = Some(dir.join("recovered"));
        options.device_id = format!("dev-{name}");
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let engine = SyncEngine::open(client, options, move |event| sink.lock().unwrap().push(event)).unwrap();
        Self { engine: Arc::new(engine), proxy, events, dir }
    }

    pub fn sync(&self) -> RoundReport {
        self.engine.sync_round()
    }

    pub fn offline(&self) {
        self.proxy.set_offline(true);
    }

    pub fn online(&self) {
        self.proxy.set_offline(false);
        self.engine.retry_now();
    }

    pub fn call(&self, command: &str, args: Value) -> Value {
        self.engine.invoke(command, args).unwrap_or_else(|error| panic!("{command} 失败：{error:?}"))
    }

    pub fn try_call(&self, command: &str, args: Value) -> Result<Value, RemoteError> {
        self.engine.invoke(command, args)
    }

    /// 本机可见的内容（副本 ∪ overlay），不论在线与否。
    pub fn local(&self, command: &str, args: Value) -> Value {
        self.engine.local_read(command, args).unwrap_or_else(|error| panic!("本地 {command} 失败：{error:?}"))
    }

    pub fn conflicts(&self) -> Vec<(String, Option<String>, String)> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                SyncEvent::Conflict { id, copy_id, reason } => Some((id.clone(), copy_id.clone(), reason.clone())),
                _ => None,
            })
            .collect()
    }
}

/// 列表里的碎片（按 id 排序，便于比较两端是否一致）。
pub fn fragments(state: &Value) -> Vec<Value> {
    let mut list = state["fragments"].as_array().cloned().unwrap_or_default();
    list.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    list
}

pub fn fragment(state: &Value, id: &str) -> Option<Value> {
    state["fragments"].as_array()?.iter().find(|fragment| fragment["id"] == id).cloned()
}

pub fn by_content<'a>(state: &'a Value, needle: &str) -> Vec<&'a Value> {
    state["fragments"]
        .as_array()
        .map(|list| list.iter().filter(|fragment| fragment["content"].as_str().unwrap_or_default().contains(needle)).collect())
        .unwrap_or_default()
}

/// 碎片正文（去掉首尾空白：文件末尾的换行属于原文格式）。
pub fn text(fragment: &Value) -> String {
    fragment["content"].as_str().unwrap_or_default().trim().to_string()
}

pub fn update_args(fragment: &Value, content: &str) -> Value {
    json!({
        "id": fragment["id"],
        "content": content,
        "tags": fragment["tags"],
        "expectedFileSha": fragment["fileSha"],
    })
}
