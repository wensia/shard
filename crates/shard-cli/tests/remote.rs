//! 远程模式的端到端测试：测试进程里起一个真的 shard-server（绑 127.0.0.1:0，导入示例资料库
//! `tests/fixtures/vault-golden` 再加一篇大纲、一篇流程图），以子进程运行 shard-cli 二进制走
//! `shard login` 配对，之后所有命令都经 HTTP 读写服务器。
//!
//! 「用户在浏览器里批准配对码」「在网页里吊销设备」直接调服务器认证库的同一个函数
//! （HTTP 端点本身由 shard-server 的测试覆盖），这样 dev-dependency 不必打开 `test-auth`：
//! 那个特性会签发免密会话，绝不能有机会被特性合并带进别的构建。
//! 令牌用文件后备（`SHARD_TOKEN_STORE=file`），不碰用户的钥匙串。登录与退出要求终端，
//! 测试里用 `SHARD_CLI_TEST_ALLOW_NONINTERACTIVE_LOGIN=1` 放行（另有一条测试核对不放行时会拒绝）。

use serde_json::{json, Value};
use shard_server::{
    app, auth::tokens::normalize_user_code, commands, config::Config, rpc::base_registry, state::AppState,
};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{Arc, Mutex},
    thread,
};

const RIDE_ID: &str = "20261026-073012-a1b2c3d4-0a0b0c";
const MEMO_ID: &str = "20261025-221500-b2c3d4e5-1a1b1c";
const BOOK_NOTE: &str = "notes/读书/置身事内.md";
const DATASET: &str = "datasets/阅读记录.csv";

struct Server {
    url: String,
    origin: String,
    state: AppState,
    _data: tempfile::TempDir,
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

fn outline_fragment() -> String {
    let graph = json!({
        "kind": "shard.map", "schemaVersion": 1, "id": "outline-1", "title": "根",
        "createdAt": "2026-09-28T00:00:00Z", "updatedAt": "2026-09-28T00:00:00Z",
        "savedWithAppVersion": "test", "revision": 4, "rootId": "root", "hasProtectedLinks": false,
        "nodes": {
            "root": { "id": "root", "parentId": null, "sortKey": "U", "text": "根",
                "createdAt": "2026-09-28T00:00:00Z", "updatedAt": "2026-09-28T00:00:00Z" },
            "child": { "id": "child", "parentId": "root", "sortKey": "U", "text": "第一行\n第二行",
                "createdAt": "2026-09-28T00:00:00Z", "updatedAt": "2026-09-28T00:00:00Z" }
        }
    });
    format!(
        "---\nid: outline-1\ncreated_at: 2026-09-28T00:00:00Z\nupdated_at: 2026-09-28T00:00:00Z\ntags: [inbox, outline]\ncategory: null\nai_status: none\nsource: test\n---\n\n区域前正文\n```shardmap\n{}\n```\n区域后正文\n",
        serde_json::to_string_pretty(&graph).unwrap()
    )
}

fn flowchart_fragment() -> String {
    let graph = json!({
        "kind": "shard.flow", "schemaVersion": 1, "id": "flow-1", "title": "流程",
        "createdAt": "2026-09-28T00:00:00Z", "updatedAt": "2026-09-28T00:00:00Z", "revision": 2,
        "nodes": [{ "id": "step", "kind": "process", "x": 0.30000000000000004, "y": 1.5, "text": "开始" }],
        "edges": []
    });
    format!(
        "---\nid: flow-1\ncreated_at: 2026-09-28T00:00:00Z\nupdated_at: 2026-09-28T00:00:00Z\ntags: [inbox, flowchart]\ncategory: null\nai_status: none\nsource: test\n---\n\n```shardflow\n{}\n```\n",
        serde_json::to_string_pretty(&graph).unwrap()
    )
}

/// 起一个导入了示例资料库的 shard-server，与 `shard-server serve` 同样的装配（含搜索）。
fn start_server(root: &Path) -> Server {
    let source = root.join("source-vault");
    copy_dir(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/vault-golden"),
        &source,
    );
    fs::write(source.join("fragments/2026/10/outline-1.md"), outline_fragment()).unwrap();
    fs::write(source.join("fragments/2026/10/flow-1.md"), flowchart_fragment()).unwrap();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let origin = format!("http://localhost:{port}");
    let data = tempfile::tempdir().unwrap();
    let config = Config::new(data.path().to_path_buf(), &origin, None, false).unwrap();
    let mut registry = base_registry();
    commands::register(&mut registry);
    shard_server::search::register(&mut registry);
    let state = AppState::open(config, registry).unwrap();
    shard_store::transfer::import_vault(&state.store, &source).unwrap();
    commands::ensure_layout(&state.store).unwrap();
    let router = app::build(state.clone());
    runtime.spawn(async move {
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    });
    Server { url: format!("http://127.0.0.1:{port}"), origin, state, _data: data, _runtime: runtime }
}

/// 文件后备的令牌文件：`remote-token-<sha256(服务器地址) 前 16 位>`。
fn token_file(state: &Path, server: &str) -> PathBuf {
    state.join(format!("remote-token-{}", &shard_core::sha256_hex(server.as_bytes())[..16]))
}

/// 一次 HTTP 请求（测试用的假服务器 / 代理只认 Content-Length 请求体）。
struct Request {
    path: String,
    headers: HashMap<String, String>,
    body: String,
}

/// 极简 HTTP 服务器：每个连接只处理一个请求，回 `Connection: close`。`handler` 返回 `None` 时
/// 不回任何响应直接断开（模拟请求已送达、响应在网络上丢了）。返回 `http://127.0.0.1:<端口>`。
fn fake_server(handler: impl Fn(&Request) -> Option<(u16, String)> + Send + Sync + 'static) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let handler = Arc::new(handler);
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let handler = Arc::clone(&handler);
            thread::spawn(move || serve_one(stream, &*handler));
        }
    });
    url
}

fn serve_one(mut stream: TcpStream, handler: &dyn Fn(&Request) -> Option<(u16, String)>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let path = line.split_whitespace().nth(1).unwrap_or_default().to_string();
    let mut headers = HashMap::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).unwrap();
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
    reader.read_exact(&mut body).unwrap();
    let request = Request { path, headers, body: String::from_utf8_lossy(&body).to_string() };
    if let Some((status, body)) = handler(&request) {
        let response = format!(
            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
    }
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

/// 把请求原样转给真服务器，返回它的响应。
fn forward(backend: &str, request: &Request) -> (u16, String) {
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
    let mut builder = agent.post(format!("{backend}{}", request.path));
    for name in ["authorization", "idempotency-key", "x-shard-utc-offset", "content-type"] {
        if let Some(value) = request.headers.get(name) {
            builder = builder.header(name, value.as_str());
        }
    }
    let mut response = builder.send(request.body.clone()).unwrap();
    let status = response.status().as_u16();
    (status, response.body_mut().read_to_string().unwrap())
}

struct Fixture {
    server: Server,
    root: PathBuf,
    state: PathBuf,
    home: PathBuf,
    tmp: PathBuf,
    editor: PathBuf,
    _directory: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let server = start_server(root);
        let (state, home, tmp) = (root.join("state"), root.join("home"), root.join("tmp"));
        for path in [&state, &home, &tmp] {
            fs::create_dir_all(path).unwrap();
        }
        Self {
            server,
            root: root.to_path_buf(),
            state,
            home,
            tmp,
            editor: root.join("editor.sh"),
            _directory: directory,
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_shard-cli"));
        command
            .args(args)
            .env("SHARD_CLI_STATE_DIR", &self.state)
            .env("HOME", &self.home)
            .env("TMPDIR", &self.tmp)
            .env("SHARD_TOKEN_STORE", "file")
            .env("SHARD_LOGIN_POLL_MS", "50")
            .env("SHARD_RETRY_DELAY_MS", "10")
            .env("SHARD_BIN", env!("CARGO_BIN_EXE_shard-cli"))
            .env("SHARD_CLI_TEST_ALLOW_NONINTERACTIVE_LOGIN", "1")
            .env_remove("SHARD_VAULT")
            .env_remove("SHARD_SOURCE")
            .env_remove("SHARD_LOCK_DIR")
            .env_remove("EDITOR")
            .env_remove("VISUAL")
            .env_remove("XDG_CONFIG_HOME");
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
        child.stdin.take().unwrap().write_all(input.unwrap_or("").as_bytes()).unwrap();
        child.wait_with_output().unwrap()
    }

    fn json(&self, args: &[&str], input: Option<&str>) -> Value {
        let output = self.run(args, input);
        assert!(output.status.success(), "{args:?} 失败：{}", stderr(&output));
        serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|_| panic!("{args:?} 的输出不是 JSON：{}", stdout(&output)))
    }

    /// `shard login <服务器>`：读出配对码，替用户批准，等 CLI 拿到令牌退出。返回设备 id。
    fn login(&self) -> String {
        self.login_to(&self.server.url, &self.server, None)
    }

    /// 登录 `url`（真服务器或它前面的代理）；`confirm` 是切换服务器时在标准输入里的回答。
    fn login_to(&self, url: &str, server: &Server, confirm: Option<&str>) -> String {
        let mut child = self
            .command(&["login", url, "--name", "测试命令行"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(confirm.unwrap_or("").as_bytes()).unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let prompt = lines.next().unwrap().unwrap();
        assert!(prompt.starts_with(&format!("在浏览器打开 {}/pair 输入配对码 ", server.origin)), "{prompt}");
        let code = prompt.rsplit(' ').next().unwrap().to_string();
        assert_eq!(code.len(), 9, "配对码形如 XXXX-XXXX：{code}");
        let approved = server.state.auth.approve_pairing(&normalize_user_code(&code)).unwrap();
        assert_eq!(approved.as_deref(), Some("测试命令行"));
        let rest = lines.map(Result::unwrap).collect::<Vec<_>>().join("\n");
        let mut error = String::new();
        child.stderr.take().unwrap().read_to_string(&mut error).unwrap();
        assert!(child.wait().unwrap().success(), "{error}");
        assert!(rest.contains("已登录"), "{rest}");
        let config: Value = serde_json::from_str(&fs::read_to_string(self.state.join("remote.json")).unwrap()).unwrap();
        assert_eq!(config["server"], url);
        assert_eq!(config["name"], "测试命令行");
        config["deviceId"].as_str().unwrap().to_string()
    }

    fn token_files(&self) -> Vec<String> {
        let mut names = fs::read_dir(&self.state)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("remote-token"))
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    fn editor(&self, script: &str) {
        fs::write(&self.editor, script).unwrap();
        fs::set_permissions(&self.editor, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn drafts(&self) -> Vec<PathBuf> {
        fs::read_dir(&self.tmp)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.file_name().unwrap().to_string_lossy().starts_with("shard-"))
            .collect()
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).to_string()
}

fn error_code(output: &Output) -> String {
    let value: Value = serde_json::from_slice(&output.stderr)
        .unwrap_or_else(|_| panic!("stderr 不是 JSON：{}", stderr(output)));
    value["error"]["code"].as_str().unwrap().to_string()
}

fn listing(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| format!("{}:{}", item["kind"].as_str().unwrap(), item["path"].as_str().unwrap()))
        .collect()
}

#[test]
fn login_whoami_explicit_local_and_logout() {
    let f = Fixture::new();
    // 没登录：本地模式（这台测试机上没有资料库）。
    let before = f.run(&["--whoami", "--json"], None);
    assert_eq!(before.status.code(), Some(1));
    assert_eq!(serde_json::from_slice::<Value>(&before.stdout).unwrap()["mode"], "local");

    let device = f.login();
    let token = token_file(&f.state, &f.server.url);
    assert!(fs::read_to_string(&token).unwrap().starts_with("shd_dev_"));
    assert_eq!(fs::metadata(&token).unwrap().permissions().mode() & 0o777, 0o600);

    let who = f.json(&["--whoami", "--json"], None);
    assert_eq!(who["mode"], "remote");
    assert_eq!(who["server"], f.server.url);
    assert_eq!(who["deviceId"], device);
    assert_eq!(who["connected"], true);
    let text = f.run(&["--whoami"], None);
    assert!(stdout(&text).contains("远程模式") && stdout(&text).contains("连接：正常"), "{}", stdout(&text));

    // 以 login 开头、后面跟几个普通词的是碎片内容：在服务器上新建，不是登录。
    let fragment_like = f.run(&["login", "今天", "登录了"], None);
    assert!(fragment_like.status.success(), "{}", stderr(&fragment_like));
    let path = stdout(&fragment_like).trim().to_string();
    assert_eq!(f.json(&["--read", &path, "--json"], None)["body"], "login 今天 登录了");
    // 形状不对的账号命令：用法错误，不落碎片。
    let wrong = f.run(&["logout", "now"], None);
    assert_eq!(wrong.status.code(), Some(1));
    assert!(stderr(&wrong).contains("用法"), "{}", stderr(&wrong));
    let help = f.run(&["login", "--help"], None);
    assert!(help.status.success() && stdout(&help).contains("shard login <服务器地址>"));

    // 显式 --vault / SHARD_VAULT：强制本地，服务器不受影响。
    let local = f.home.join("本地库");
    fs::create_dir_all(local.join("notes")).unwrap();
    let created = f.json(&["--vault", local.to_str().unwrap(), "--json", "只写本地"], None);
    assert!(local.join(created["path"].as_str().unwrap()).is_file());
    let missing = f.run(&["--read", created["id"].as_str().unwrap(), "--json"], None);
    assert_eq!(error_code(&missing), "NOT_FOUND", "远程模式下读不到本地新建的");
    let env_local = f.command(&["--whoami", "--json"]).env("SHARD_VAULT", &local).output().unwrap();
    assert!(env_local.status.success());
    assert_eq!(serde_json::from_slice::<Value>(&env_local.stdout).unwrap()["mode"], "local");

    // 重新登录同一台服务器：提示旧设备仍有效。
    let mut child = f
        .command(&["login"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let code = lines.next().unwrap().unwrap().rsplit(' ').next().unwrap().to_string();
    f.server.state.auth.approve_pairing(&normalize_user_code(&code)).unwrap();
    let _ = lines.count();
    let mut error = String::new();
    child.stderr.take().unwrap().read_to_string(&mut error).unwrap();
    assert!(child.wait().unwrap().success(), "{error}");
    assert!(error.contains(&device) && error.contains("吊销"), "{error}");

    let out = f.run(&["logout"], None);
    assert!(out.status.success());
    assert!(stdout(&out).contains("吊销"), "{}", stdout(&out));
    assert!(f.token_files().is_empty());
    assert!(!f.state.join("remote.json").exists());
    let after = f.run(&["--whoami", "--json"], None);
    assert_eq!(serde_json::from_slice::<Value>(&after.stdout).unwrap()["mode"], "local");
}

#[test]
fn login_and_logout_refuse_non_interactive_callers() {
    let f = Fixture::new();
    for args in [&["login", f.server.url.as_str()][..], &["logout"]] {
        let output = f
            .command(args)
            .env_remove("SHARD_CLI_TEST_ALLOW_NONINTERACTIVE_LOGIN")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert!(stderr(&output).contains("只能由你本人在终端里运行"), "{}", stderr(&output));
    }
    assert!(!f.state.join("remote.json").exists());
    assert!(f.token_files().is_empty());
}

#[test]
fn switching_servers_keeps_the_new_token_and_needs_confirmation() {
    let f = Fixture::new();
    let other = start_server(&f.root.join("other"));
    f.login();
    let first_token = token_file(&f.state, &f.server.url);
    assert!(first_token.exists());

    // 不确认：取消，仍用原来的服务器。
    let declined = f.command(&["login", &other.url]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let declined = {
        let mut child = declined;
        child.stdin.take().unwrap().write_all(b"n\n").unwrap();
        child.wait_with_output().unwrap()
    };
    assert_eq!(declined.status.code(), Some(1));
    assert!(stderr(&declined).contains(&other.url) && stderr(&declined).contains("已取消"), "{}", stderr(&declined));
    assert_eq!(f.json(&["--whoami", "--json"], None)["server"], f.server.url);

    // 输入 y 确认后切换：新令牌按服务器单独存放，旧服务器的令牌删掉，之后的读写都能用。
    f.login_to(&other.url, &other, Some("y\n"));
    assert!(!first_token.exists());
    assert!(token_file(&f.state, &other.url).exists());
    assert_eq!(f.token_files().len(), 1);
    let who = f.json(&["--whoami", "--json"], None);
    assert_eq!((who["server"].as_str(), who["connected"].as_bool()), (Some(other.url.as_str()), Some(true)));
    assert!(f.json(&["--tags", "--json"], None).as_array().is_some());
}

#[test]
fn broken_remote_config_can_still_be_logged_out() {
    let f = Fixture::new();
    f.login();
    fs::write(f.state.join("remote.json"), "{ 坏掉的").unwrap();
    fs::write(token_file(&f.state, "http://127.0.0.1:1"), "shd_dev_stray").unwrap();
    let broken = f.run(&["--tags", "--json"], None);
    assert_eq!(broken.status.code(), Some(1));
    assert!(stderr(&broken).contains("shard logout"), "{}", stderr(&broken));

    let out = f.run(&["logout"], None);
    assert!(out.status.success(), "{}", stderr(&out));
    assert!(stdout(&out).contains("已损坏") && stdout(&out).contains("2 个"), "{}", stdout(&out));
    assert!(!f.state.join("remote.json").exists());
    assert!(f.token_files().is_empty());

    // 公网明文地址的配置会被拒绝（规则同登录）。
    fs::write(
        f.state.join("remote.json"),
        json!({ "server": "http://shard.example.com", "deviceId": "dev_x", "name": "x" }).to_string(),
    )
    .unwrap();
    fs::write(token_file(&f.state, "http://shard.example.com"), "shd_dev_x").unwrap();
    let insecure = f.run(&["--tags", "--json"], None);
    assert_eq!(insecure.status.code(), Some(1));
    assert!(stderr(&insecure).contains("https"), "{}", stderr(&insecure));
}

#[test]
fn writes_retry_with_the_same_idempotency_key_and_commit_once() {
    let f = Fixture::new();
    let backend = f.server.url.clone();
    // 代理：第一次 create_fragment 转给服务器（已提交）后回 503；第一次 append_document 转发后
    // 不回响应直接断开（网络失败）。其余原样转发。记下每次写请求的幂等键。
    let seen = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    let log = Arc::clone(&seen);
    let proxy = fake_server(move |request| {
        let response = forward(&backend, request);
        let key = request.headers.get("idempotency-key").cloned().unwrap_or_default();
        let mut log = log.lock().unwrap();
        let first = !log.iter().any(|(path, _)| path == &request.path);
        if request.path.starts_with("/api/rpc/") {
            log.push((request.path.clone(), key));
        }
        match request.path.as_str() {
            "/api/rpc/create_fragment" if first => Some((503, String::new())),
            "/api/rpc/append_document" if first => None,
            _ => Some(response),
        }
    });
    f.login_to(&proxy, &f.server, None);

    let created = f.json(&["--json", "重试只提交一次 #重试"], None);
    let appended = f.json(&["--append", created["id"].as_str().unwrap(), "--json", "追加一次"], None);
    assert_eq!(appended["changed"], true);

    let seen = seen.lock().unwrap();
    for command in ["/api/rpc/create_fragment", "/api/rpc/append_document"] {
        let keys = seen.iter().filter(|(path, _)| path == command).map(|(_, key)| key.clone()).collect::<Vec<_>>();
        assert_eq!(keys.len(), 2, "{command} 应重试一次：{keys:?}");
        assert!(!keys[0].is_empty());
        assert_eq!(keys[0], keys[1], "{command} 重试复用同一个幂等键");
    }
    drop(seen);
    // 服务器只提交了一次：只有一条碎片，正文只追加了一次。
    let hits = f.json(&["-s", "重试只提交一次", "--json"], None);
    assert_eq!(hits.as_array().unwrap().len(), 1, "{hits}");
    let body = f.json(&["--read", created["id"].as_str().unwrap(), "--json"], None)["body"].clone();
    assert_eq!(body, "重试只提交一次 #重试\n\n追加一次");
}

#[test]
fn remote_search_fetches_more_until_enough_text_results() {
    let f = Fixture::new();
    // 假服务器：每次搜索先返回一批导图（非文本），只有取满上限 200 条时最后才有 5 篇碎片。
    let limits = Arc::new(Mutex::new(Vec::<u64>::new()));
    let log = Arc::clone(&limits);
    let hit = |kind: &str, id: Option<String>, index: usize| {
        json!({
            "target": {
                "key": format!("k{index}"), "vaultPath": "v", "scope": "public",
                "path": format!("notes/{index}.md"), "kind": kind, "objectId": id, "archived": false
            },
            "title": format!("标题{index}"), "titleParts": [{ "text": format!("标题{index}"), "hit": false }],
            "tags": ["inbox"], "updatedAt": "2026-10-26T08:00:00+08:00", "revision": "r",
            "matchedFields": ["body"], "preview": [{ "text": "命中", "hit": true }], "revealHint": "text"
        })
    };
    let server = fake_server(move |request| match request.path.as_str() {
        "/api/rpc/server_status" => Some((200, json!({ "vault": "v", "headSeq": 1 }).to_string())),
        "/api/rpc/search_vault" => {
            let body: Value = serde_json::from_str(&request.body).unwrap();
            let limit = body["request"]["limit"].as_u64().unwrap();
            log.lock().unwrap().push(limit);
            let mut hits = (0..limit.min(150) as usize).map(|index| hit("mindmap", None, index)).collect::<Vec<_>>();
            if limit == 200 {
                hits.extend((0..5).map(|index| hit("fragment", Some(format!("id-{index}")), 1000 + index)));
            }
            let total = hits.len();
            Some((
                200,
                json!({
                    "clientRequestId": "x", "context": { "vaultPath": "v", "vaultEpoch": "e", "privacyEpoch": "0" },
                    "snapshotId": "s", "indexState": "ready", "expiresAt": null, "hits": hits,
                    "total": total, "skippedFiles": 0, "warning": null
                })
                .to_string(),
            ))
        }
        _ => Some((404, json!({ "code": "UNKNOWN_COMMAND", "message": "没有" }).to_string())),
    });
    fs::write(
        f.state.join("remote.json"),
        json!({ "server": server, "deviceId": "dev_x", "name": "x" }).to_string(),
    )
    .unwrap();
    fs::write(token_file(&f.state, &server), "shd_dev_fake").unwrap();

    let hits = f.json(&["-s", "命中", "-n", "3", "--json"], None);
    assert_eq!(hits.as_array().unwrap().len(), 3, "{hits}");
    assert_eq!(hits[0]["id"], "id-0");
    assert_eq!(*limits.lock().unwrap(), [53, 106, 200], "不够数时翻倍再取，最多到服务端上限");

    // 响应缺字段：BAD_RESPONSE，不当成功。
    let bad = fake_server(|_| Some((200, json!({ "id": "x" }).to_string())));
    fs::write(f.state.join("remote.json"), json!({ "server": bad, "deviceId": "dev_x", "name": "x" }).to_string()).unwrap();
    fs::write(token_file(&f.state, &bad), "shd_dev_fake").unwrap();
    let output = f.run(&["--json", "缺字段的响应"], None);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(error_code(&output), "BAD_RESPONSE");
}

#[test]
fn remote_reads_writes_and_searches_like_local() {
    let f = Fixture::new();
    f.login();

    // 不带关键词：按最近修改列出（大纲、流程图与回收站不在）。
    let recent = f.json(&["-s", "--json", "-n", "2"], None);
    assert_eq!(recent.as_array().unwrap().len(), 2);
    assert_eq!(recent[0]["title"], "周报 10-26");
    assert_eq!(recent[0]["kind"], "note");
    assert_eq!(recent[1]["id"], RIDE_ID);
    assert_eq!(recent[1]["createdAt"], "2026-10-26T07:30:12+08:00");

    // 关键词：服务器搜索（search_vault）。JSON 里 createdAt 为 null。
    let hits = f.json(&["-s", "骑行", "--json"], None);
    assert_eq!(hits.as_array().unwrap().len(), 1, "{hits}");
    assert_eq!(hits[0]["id"], RIDE_ID);
    assert_eq!(hits[0]["kind"], "fragment");
    assert_eq!(hits[0]["path"], "fragments/2026/10/20261026-073012-a1b2c3d4-0a0b0c.md");
    assert!(hits[0]["createdAt"].is_null());
    for key in ["index", "title", "tags", "updatedAt", "preview"] {
        assert!(hits[0].get(key).is_some(), "缺少 {key}");
    }
    let none = f.json(&["-s", "不存在的词", "--json"], None);
    assert_eq!(none, json!([]));
    let text = f.run(&["-s", "骑行"], None);
    assert!(text.status.success(), "{}", stderr(&text));
    assert!(stdout(&text).starts_with('1') && stdout(&text).contains("a1b2c3d4"), "{}", stdout(&text));
    let remembered: Value = serde_json::from_slice(&fs::read(f.state.join("last-search.json")).unwrap()).unwrap();
    assert_eq!(remembered["vault"], f.server.url);
    // 上次搜索的序号在本机换算成 id。
    assert_eq!(f.json(&["--read", "1", "--json"], None)["id"], RIDE_ID);

    // 读取：id、短 id、路径；歧义、不存在、大纲。
    let read = f.json(&["--read", RIDE_ID, "--json"], None);
    let mut keys = read.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    keys.sort();
    assert_eq!(keys, ["body", "createdAt", "id", "kind", "path", "sha", "source", "tags", "title", "updatedAt"]);
    assert!(read["body"].as_str().unwrap().starts_with("早上沿江骑了 32 公里"));
    let short = f.run(&["--read", "a1b2c3d4"], None);
    assert_eq!(stdout(&short), format!("{}\n", read["body"].as_str().unwrap()));
    assert_eq!(f.json(&["--read", BOOK_NOTE, "--json"], None)["kind"], "note");
    let ambiguous = f.run(&["--read", "2026", "--json"], None);
    assert_eq!(ambiguous.status.code(), Some(1));
    assert_eq!(error_code(&ambiguous), "AMBIGUOUS");
    assert_eq!(error_code(&f.run(&["--read", "不存在的", "--json"], None)), "NOT_FOUND");
    let outline = f.run(&["--read", "outline-1", "--json"], None);
    assert_eq!(error_code(&outline), "NOT_FOUND");
    assert!(stderr(&outline).contains("--graph-read"));

    // 新建碎片：参数与标准输入；--source 照记，没给时服务器按设备种类记为 cli。
    let created = f.json(&["--json", "--source", "claude-code", "#读书 读完了"], None);
    assert_eq!(created["tags"], json!(["inbox", "读书"]));
    assert_eq!(created["sha"].as_str().unwrap().len(), 64);
    assert!(created["path"].as_str().unwrap().starts_with("fragments/"));
    let created_read = f.json(&["--read", created["id"].as_str().unwrap(), "--json"], None);
    assert_eq!(created_read["source"], "claude-code");
    assert_eq!(created_read["sha"], created["sha"]);
    let piped = f.json(&["--json"], Some("#摘录 第一行\n\n第二行\n"));
    let piped_read = f.json(&["--read", piped["id"].as_str().unwrap(), "--json"], None);
    assert_eq!(piped_read["body"], "#摘录 第一行\n\n第二行");
    assert_eq!(piped_read["source"], "cli");
    let env_source = f.command(&["--json", "环境变量来源"]).env("SHARD_SOURCE", "codex").output().unwrap();
    let env_source: Value = serde_json::from_slice(&env_source.stdout).unwrap();
    assert_eq!(f.json(&["--read", env_source["id"].as_str().unwrap(), "--json"], None)["source"], "codex");
    let bad_source = f.run(&["--json", "--source", "a\nb", "不该写"], None);
    assert_eq!(error_code(&bad_source), "ERROR");
    let frontmatter = f.run(&["--json"], Some("---\ntitle: x\n---\n正文"));
    assert_eq!(error_code(&frontmatter), "ERROR");

    // 改写：sha 不符退出码 2 且不覆盖；正文没变 changed=false。
    let sha = read["sha"].as_str().unwrap();
    assert_eq!(f.run(&["--update", RIDE_ID], Some("新正文")).status.code(), Some(1));
    let updated = f.json(&["--update", RIDE_ID, "--expect", sha, "--json"], Some("新正文 #新\n"));
    assert_eq!(updated["changed"], true);
    assert_eq!(updated["tags"], json!(["inbox", "新"]));
    let after = f.json(&["--read", RIDE_ID, "--json"], None);
    assert_eq!(after["sha"], updated["sha"]);
    assert_eq!(after["source"], "desktop", "其余 frontmatter 不动");
    let stale = f.run(&["--update", RIDE_ID, "--expect", sha, "--json"], Some("覆盖"));
    assert_eq!(stale.status.code(), Some(2));
    assert_eq!(error_code(&stale), "CONFLICT");
    assert_eq!(f.json(&["--read", RIDE_ID, "--json"], None)["body"], "新正文 #新");
    let same = f.json(
        &["--update", RIDE_ID, "--expect", updated["sha"].as_str().unwrap(), "--json"],
        Some("新正文 #新"),
    );
    assert_eq!(same["changed"], false);
    assert_eq!(same["sha"], updated["sha"]);

    // 追加：接续列表、另起段落、--expect 不符 CONFLICT。
    f.json(&["--append", MEMO_ID, "--json", "/复选框", "买牛奶"], None);
    let appended = f.json(&["--append", "b2c3d4e5", "--json"], Some("补充说明 #生活"));
    assert_eq!(appended["tags"], json!(["inbox", "备忘", "生活"]));
    let memo = f.json(&["--read", MEMO_ID, "--json"], None);
    assert!(memo["body"].as_str().unwrap().ends_with("- [ ] 给车换链条 #备忘\n- [ ] 买牛奶\n\n补充说明 #生活"));
    let stale = f.run(&["--append", MEMO_ID, "--expect", "stale", "--json", "不该写入"], None);
    assert_eq!(stale.status.code(), Some(2));
    assert_eq!(error_code(&stale), "CONFLICT");

    // 资料库笔记：文件夹自动创建、重名加 -2、--source 照记。
    let note = f.json(
        &["--note", "周会纪要", "--folder", "项目/周会", "--json", "--source", "codex"],
        Some("## 结论\n\n- 下周发布 #发布\n"),
    );
    assert_eq!(note["path"], "notes/项目/周会/周会纪要.md");
    assert_eq!(note["tags"], json!(["inbox", "note", "发布"]));
    let note_read = f.json(&["--read", "notes/项目/周会/周会纪要.md", "--json"], None);
    assert_eq!(note_read["source"], "codex");
    assert!(note_read["body"].as_str().unwrap().starts_with("# 周会纪要\n\n## 结论"));
    let again = f.json(&["--note", "周会纪要", "--folder", "notes/项目/周会", "--json"], None);
    assert_eq!(again["path"], "notes/项目/周会/周会纪要-2.md");
    let lockbox = f.run(&["--note", "秘密", "--json"], Some("#密匣 不能写"));
    assert_eq!(error_code(&lockbox), "ERROR");

    // 标签与目录。
    let tags = f.json(&["--tags", "--json"], None);
    let tags = tags.as_array().unwrap();
    assert!(tags.contains(&json!({ "tag": "读书", "count": 2 })), "{tags:?}");
    assert!(tags.contains(&json!({ "tag": "摘录", "count": 2 })), "{tags:?}");
    assert!(tags.windows(2).all(|pair| pair[0]["count"].as_u64() >= pair[1]["count"].as_u64()));
    assert!(stdout(&f.run(&["--tags"], None)).contains("#读书\t2\n"));
    let ls = listing(&f.json(&["--ls", "--json"], None));
    for expected in [
        "mindmap:notes/季度规划.shardmap.json",
        "folder:notes/项目/周会",
        "note:notes/项目/周会/周会纪要-2.md",
        "dataset:datasets/阅读记录.csv",
    ] {
        assert!(ls.contains(&expected.to_string()), "{ls:?}");
    }
    let sub = f.run(&["--ls", "项目"], None);
    assert_eq!(
        stdout(&sub),
        "notes/项目/周会/\nnotes/项目/周会/周会纪要-2.md\nnotes/项目/周会/周会纪要.md\nnotes/项目/周报 10-26.md\n"
    );

    // 非交互环境没有编辑器时提示改用 --read / --update，不下载整个资料库。
    let edit = f.run(&["-e", RIDE_ID], None);
    assert_eq!(edit.status.code(), Some(1));
    assert!(stderr(&edit).contains("--update"));
}

#[test]
fn remote_datasets_append_idempotently() {
    let f = Fixture::new();
    f.login();
    let read = f.json(&["--read-dataset", DATASET, "--json"], None);
    assert_eq!(read["header"], json!(["id", "书名", "作者", "封面", "读完日期"]));
    assert_eq!(read["primaryKey"], "id");
    assert_eq!(read["rows"].as_array().unwrap().len(), 3);
    assert!(stdout(&f.run(&["--read-dataset", DATASET], None)).contains("2,长安的荔枝,马伯庸"));

    let input = r#"{"expectedHeader":["id","书名","作者","封面","读完日期"],"records":[{"id":"4","书名":"新书"}]}"#;
    let first = f.run(&["--append-dataset", DATASET], Some(input));
    assert!(first.status.success(), "{}", stderr(&first));
    let first: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!((first["appended"].as_u64(), first["skipped"].as_u64()), (Some(1), Some(0)));
    // 重试同一批：按主键跳过（服务器用新的幂等键，靠主键幂等）。
    let retry = f.json(&["--append-dataset", DATASET], Some(input));
    assert_eq!(retry, json!({ "appended": 0, "skipped": 1, "sha": first["sha"] }));

    let conflict = f.run(
        &["--json", "--append-dataset", DATASET],
        Some(r#"{"expectedHeader":["id","书名","作者","封面","读完日期"],"records":[{"id":"1","书名":"改了"}]}"#),
    );
    assert_eq!(conflict.status.code(), Some(3));
    assert_eq!(error_code(&conflict), "KEY_CONFLICT");
    let header = f.run(&["--json", "--append-dataset", DATASET], Some(r#"{"expectedHeader":["id"],"records":[]}"#));
    assert_eq!(header.status.code(), Some(2));
    assert_eq!(error_code(&header), "HEADER_CHANGED");
    assert_eq!(f.json(&["--read-dataset", DATASET, "--json"], None)["sha"], first["sha"]);

    let created = f.json(
        &["--create-dataset", "新表", "--folder", "项目/表格", "--json"],
        Some(r#"{"header":["id","名称"],"rows":[["1","一"]],"primaryKey":"id"}"#),
    );
    assert_eq!(created["path"], "datasets/新表.csv");
    assert_eq!(created["notePath"], "notes/项目/表格/新表.md");
    let plain = f.json(
        &["--create-dataset", "根目录表", "--json", "--source", "claude-code"],
        Some(r#"{"header":["id"],"primaryKey":"id"}"#),
    );
    assert_eq!(plain["notePath"], "notes/根目录表.md");
    assert_eq!(f.json(&["--read", "notes/根目录表.md", "--json"], None)["source"], "claude-code");
    let note = f.json(&["--read", "notes/项目/表格/新表.md", "--json"], None);
    assert!(note["body"].as_str().unwrap().contains("\"src\": \"datasets/新表.csv\""));
}

#[test]
fn remote_graph_commands_read_modify_and_write_with_base() {
    let f = Fixture::new();
    f.login();
    let read = f.json(&["--graph-read", "outline-1"], None);
    assert_eq!(read["kind"], "outline");
    assert_eq!(read["graph"]["nodes"]["child"]["text"], "第一行\n第二行");
    let sha = read["fileSha"].as_str().unwrap().to_string();
    let exported = f.run(&["--graph-outline", "outline-1"], None);
    assert_eq!(stdout(&exported), "- 根\n  - 第一行 第二行\n");

    let set = f.json(&["--graph-set-text", "outline-1", "child", "改过的文字", "--expect", &sha], None);
    let sha2 = set["fileSha"].as_str().unwrap().to_string();
    assert_ne!(sha2, sha);
    let stale = f.run(&["--graph-set-text", "outline-1", "child", "旧基线", "--expect", &sha], None);
    assert_eq!(stale.status.code(), Some(2), "{}", stderr(&stale));
    assert!(stderr(&stale).contains("文件已被修改"));

    let added = f.json(&["--graph-add-child", "outline-1", "root", "新子节点", "--expect", &sha2], None);
    let node = added["nodeId"].as_str().unwrap().to_string();
    assert!(node.starts_with("node-cli-"));
    let sha3 = added["fileSha"].as_str().unwrap().to_string();
    let after = f.json(&["--graph-read", "outline-1"], None);
    assert_eq!(after["graph"]["nodes"][&node]["text"], "新子节点");
    assert_eq!(after["graph"]["revision"], 6, "每次写回版本加一");
    assert_eq!(stdout(&f.run(&["--graph-outline", "outline-1"], None)), "- 根\n  - 改过的文字\n  - 新子节点\n");

    let root = f.run(&["--graph-remove", "outline-1", "root", "--expect", &sha3], None);
    assert_eq!(root.status.code(), Some(1));
    assert!(stderr(&root).contains("不能删除大纲根节点"));
    let removed = f.json(&["--graph-remove", "outline-1", &node, "--expect", &sha3], None);
    let sha4 = removed["fileSha"].as_str().unwrap().to_string();
    assert!(f.json(&["--graph-read", "outline-1"], None)["graph"]["nodes"].get(&node).is_none());

    // 整份写回：图 JSON 从标准输入给，id 与类型要与碎片一致。
    let mut graph = f.json(&["--graph-read", "outline-1"], None)["graph"].clone();
    graph["nodes"]["root"]["text"] = json!("新的根");
    let written = f.json(&["--graph-write", "outline-1", "--expect", &sha4], Some(&graph.to_string()));
    assert_ne!(written["fileSha"], json!(sha4));
    graph["id"] = json!("别的");
    let mismatched = f.run(
        &["--graph-write", "outline-1", "--expect", written["fileSha"].as_str().unwrap()],
        Some(&graph.to_string()),
    );
    assert_eq!(mismatched.status.code(), Some(1));
    assert!(stderr(&mismatched).contains("不一致"));

    // 流程图：改节点文字；不支持加子节点。
    let flow = f.json(&["--graph-read", "flow-1"], None);
    assert_eq!(flow["kind"], "flowchart");
    let flow_sha = flow["fileSha"].as_str().unwrap().to_string();
    let flow_set = f.json(&["--graph-set-text", "flow-1", "step", "结束", "--expect", &flow_sha], None);
    assert_eq!(f.json(&["--graph-read", "flow-1"], None)["graph"]["nodes"][0]["text"], "结束");
    let unsupported = f.run(
        &["--graph-add-child", "flow-1", "step", "x", "--expect", flow_set["fileSha"].as_str().unwrap()],
        None,
    );
    assert!(stderr(&unsupported).contains("只有大纲支持添加子节点"));
    assert!(stderr(&f.run(&["--graph-outline", "flow-1"], None)).contains("目标不是大纲"));
    assert!(stderr(&f.run(&["--graph-read", RIDE_ID], None)).contains("大纲"));
}

#[test]
fn remote_external_editor_saves_with_sha_and_keeps_conflicts() {
    let f = Fixture::new();
    f.login();
    let body = f.tmp.join("edited-body.md");
    fs::write(&body, "编辑器里改的 #改\n").unwrap();
    f.editor("#!/bin/sh\ncat \"$SHARD_TEST_BODY\" > \"$1\"\n");
    let saved = f.command(&["-e", RIDE_ID]).env("EDITOR", &f.editor).env("SHARD_TEST_BODY", &body).output().unwrap();
    assert!(saved.status.success(), "{}", stderr(&saved));
    assert!(stdout(&saved).contains("已保存：fragments/2026/10/20261026-073012-a1b2c3d4-0a0b0c.md"));
    let read = f.json(&["--read", RIDE_ID, "--json"], None);
    assert_eq!(read["body"], "编辑器里改的 #改");
    assert_eq!(read["tags"], json!(["inbox", "改"]));
    assert!(f.drafts().is_empty());

    // 编辑期间别处改了这条：不覆盖，修改留在临时文件，退出码 2。
    fs::write(&body, "我的修改\n").unwrap();
    f.editor(&format!(
        "#!/bin/sh\ncat \"$SHARD_TEST_BODY\" > \"$1\"\n\"$SHARD_BIN\" --append {RIDE_ID} 外部追加 > /dev/null\n"
    ));
    let conflict = f.command(&["-e", RIDE_ID]).env("EDITOR", &f.editor).env("SHARD_TEST_BODY", &body).output().unwrap();
    assert_eq!(conflict.status.code(), Some(2), "{}", stderr(&conflict));
    assert!(stderr(&conflict).contains("你的修改保存在："));
    assert_eq!(f.json(&["--read", RIDE_ID, "--json"], None)["body"], "编辑器里改的 #改\n\n外部追加");
    let drafts = f.drafts();
    assert_eq!(drafts.len(), 1);
    assert_eq!(fs::read_to_string(&drafts[0]).unwrap(), "我的修改\n");

    // 正文没变：不写。
    let unchanged = f.command(&["-e", "a1b2c3d4"]).env("EDITOR", "true").output().unwrap();
    assert!(stdout(&unchanged).contains("没有改动"), "{}", stderr(&unchanged));
}

#[test]
fn revoked_token_and_unreachable_server_have_clear_errors() {
    let f = Fixture::new();
    let device = f.login();
    assert!(f.server.state.auth.revoke_device(&device).unwrap(), "在网页里吊销这台设备");
    let revoked = f.run(&["--read", RIDE_ID, "--json"], None);
    assert_eq!(revoked.status.code(), Some(1));
    assert_eq!(error_code(&revoked), "UNAUTHENTICATED");
    assert!(stderr(&revoked).contains(&format!("shard login {}", f.server.url)));
    let plain = f.run(&["--tags"], None);
    assert!(stderr(&plain).starts_with("shard: 服务器不认这台设备的登录令牌"), "{}", stderr(&plain));
    let who = f.run(&["--whoami", "--json"], None);
    assert_eq!(who.status.code(), Some(1));
    assert_eq!(serde_json::from_slice::<Value>(&who.stdout).unwrap()["connected"], false);

    // 服务器地址不可达：NETWORK，中文说明。
    fs::write(
        f.state.join("remote.json"),
        json!({ "server": "http://127.0.0.1:9", "deviceId": "dev_x", "name": "x" }).to_string(),
    )
    .unwrap();
    fs::write(token_file(&f.state, "http://127.0.0.1:9"), "shd_dev_x").unwrap();
    let unreachable = f.run(&["--tags", "--json"], None);
    assert_eq!(unreachable.status.code(), Some(1));
    assert_eq!(error_code(&unreachable), "NETWORK");
    assert!(stderr(&unreachable).contains("连不上 Shard 服务器 http://127.0.0.1:9"));

    // 配置在、令牌不在：提示重新登录。
    fs::remove_file(token_file(&f.state, "http://127.0.0.1:9")).unwrap();
    let no_token = f.run(&["--tags", "--json"], None);
    assert_eq!(error_code(&no_token), "UNAUTHENTICATED");
    assert!(stderr(&no_token).contains("shard login http://127.0.0.1:9"));
}

#[test]
fn login_polling_backs_off_through_gateway_errors() {
    let f = Fixture::new();
    // 假服务器：配对开始正常，换令牌先回两次 503（服务重启中）、一次 428（还没批准），再发令牌。
    let polls = Arc::new(Mutex::new(0usize));
    let counter = Arc::clone(&polls);
    let server = fake_server(move |request| match request.path.as_str() {
        "/api/device/start" => Some((
            200,
            json!({ "deviceCode": "dc", "userCode": "ABCD-EFGH", "verificationUri": "http://127.0.0.1/pair", "expiresIn": 60, "interval": 1 })
                .to_string(),
        )),
        "/api/device/token" => {
            let mut count = counter.lock().unwrap();
            *count += 1;
            Some(match *count {
                1 | 2 => (503, String::new()),
                3 => (428, json!({ "code": "AUTHORIZATION_PENDING", "message": "等待" }).to_string()),
                _ => (200, json!({ "token": "shd_dev_fake", "deviceId": "dev_fake", "name": "x" }).to_string()),
            })
        }
        _ => Some((404, String::new())),
    });
    let output = f.command(&["login", &server]).stdin(Stdio::null()).output().unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(*polls.lock().unwrap(), 4);
    assert_eq!(fs::read_to_string(token_file(&f.state, &server)).unwrap(), "shd_dev_fake");
}
