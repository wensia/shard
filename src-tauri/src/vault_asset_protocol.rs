//! `shard-asset://` 协议：让 webview 直接按地址取 vault 里的图片。
//!
//! 以前每张图都要走 `read_fragment_image` 转成 base64 data URL，体积膨胀三分之一，整张图
//! 还常驻 JS 堆；资料库宫格、表格缩略图一多就扛不住。这里只供图片：路径先过
//! `resolve_vault_asset_path`（密匣、内部目录、越界符号链接都拒绝），再按文件头确认是
//! 图片才返回。任何失败都回 404，不在响应里带路径。
use std::{fs, path::Path, time::UNIX_EPOCH};

use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::Manager;

pub const SCHEME: &str = "shard-asset";
/// 单张图片的上限：再大的文件不往内存里整份读。
const MAX_SERVED_BYTES: u64 = 64 * 1024 * 1024;

pub fn handle(app: &tauri::AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let if_none_match = request
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok());
    // 连接了服务器：图片在服务器上，带设备令牌代理 `/api/files`（在线客户端，S8a）；
    // 离线、或本机还有没补交的写（例如离线粘贴的图）时读本机副本（S8b）。
    let runtime = app.state::<crate::remote_client::RemoteRuntime>();
    if let Some(client) = runtime.client() {
        let engine = runtime.engine();
        return serve_remote(&client, engine.as_deref(), request.method(), request.uri().path(), origin);
    }
    match crate::configured_vault_path(app) {
        Ok(vault) => serve(&vault, request.method(), request.uri().path(), origin, if_none_match),
        Err(_) => empty(StatusCode::NOT_FOUND, origin),
    }
}

/// 代理服务器的 `/api/files/<路径>`：路径原样（已百分号编码）转过去，服务器只供图片、自带 nosniff 与 SVG 沙箱 CSP。
/// 有本机副本时：同步引擎说读走本机（离线、有待补交的写）就先读副本，连不上服务器时也退回副本。
/// 失败一律 404，与本地一样不在响应里带细节。
fn serve_remote(
    client: &shard_remote::Client,
    engine: Option<&shard_sync::SyncEngine>,
    method: &Method,
    uri_path: &str,
    origin: Option<&str>,
) -> Response<Vec<u8>> {
    if method != Method::GET && method != Method::HEAD {
        return empty(StatusCode::METHOD_NOT_ALLOWED, origin);
    }
    let path = uri_path.trim_start_matches('/');
    if path.is_empty() || path.split('/').any(|part| part == ".." || part == "%2E%2E" || part == "%2e%2e") {
        return empty(StatusCode::NOT_FOUND, origin);
    }
    if let Some(engine) = engine.filter(|engine| engine.reads_local()) {
        if let Some(response) = serve_replica(engine, method, path, origin) {
            return response;
        }
    }
    let fetched = match client.get_bytes(&format!("api/files/{path}")) {
        Ok(fetched) if fetched.is_ok() => fetched,
        Ok(_) => return empty(StatusCode::NOT_FOUND, origin),
        Err(_) => {
            return engine
                .and_then(|engine| serve_replica(engine, method, path, origin))
                .unwrap_or_else(|| empty(StatusCode::NOT_FOUND, origin))
        }
    };
    let mut builder = cors(Response::builder(), origin)
        .status(StatusCode::OK)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_TYPE, fetched.content_type.as_deref().unwrap_or("application/octet-stream"))
        .header(header::CACHE_CONTROL, fetched.cache_control.as_deref().unwrap_or("no-cache"));
    if let Some(etag) = fetched.etag.as_deref() {
        builder = builder.header(header::ETAG, etag);
    }
    if let Some(policy) = fetched.content_security_policy.as_deref() {
        builder = builder.header(header::CONTENT_SECURITY_POLICY, policy);
    }
    let body = if method == Method::HEAD { Vec::new() } else { fetched.bytes };
    builder.body(body).unwrap_or_else(|_| empty(StatusCode::NOT_FOUND, origin))
}

/// 从本机副本（已确认层 ∪ 离线写下的）读图片：与服务器 `/api/files` 同样只供文件头确认是图片的内容。
fn serve_replica(engine: &shard_sync::SyncEngine, method: &Method, path: &str, origin: Option<&str>) -> Option<Response<Vec<u8>>> {
    let reference = percent_decode(path)?;
    let bytes = engine.local_file(&reference)?;
    if bytes.len() as u64 > MAX_SERVED_BYTES {
        return None;
    }
    let mime_type = shard_core::image::image_mime_type(Path::new(&reference), &bytes)?;
    let mut builder = cors(Response::builder(), origin)
        .status(StatusCode::OK)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_TYPE, mime_type)
        .header(header::CACHE_CONTROL, "no-cache");
    if mime_type == "image/svg+xml" {
        builder = builder.header(header::CONTENT_SECURITY_POLICY, "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }
    let body = if method == Method::HEAD { Vec::new() } else { bytes };
    builder.body(body).ok()
}

pub fn serve(
    vault: &Path,
    method: &Method,
    uri_path: &str,
    origin: Option<&str>,
    if_none_match: Option<&str>,
) -> Response<Vec<u8>> {
    if method != Method::GET && method != Method::HEAD {
        return empty(StatusCode::METHOD_NOT_ALLOWED, origin);
    }
    let Some(reference) = percent_decode(uri_path.trim_start_matches('/')) else {
        return empty(StatusCode::NOT_FOUND, origin);
    };
    let vfs = shard_core::FsVfs::new(vault);
    let Ok(path) = crate::resolve_vault_asset_path(&vfs, &reference) else {
        return empty(StatusCode::NOT_FOUND, origin);
    };
    let Ok(metadata) = fs::metadata(&path) else {
        return empty(StatusCode::NOT_FOUND, origin);
    };
    if metadata.len() > MAX_SERVED_BYTES {
        return empty(StatusCode::NOT_FOUND, origin);
    }
    // 先只读文件头认类型（改了扩展名的大文件不整份读进内存），确认是图片再读全文。
    let Some(mime_type) = crate::sniff_library_asset_mime_type(&vfs, &path) else {
        return empty(StatusCode::NOT_FOUND, origin);
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let etag = format!("\"{modified:x}-{:x}\"", metadata.len());
    let immutable = is_content_addressed(vault, &path);
    if if_none_match == Some(etag.as_str()) {
        return with_common_headers(Response::builder(), origin, &etag, immutable)
            .status(StatusCode::NOT_MODIFIED)
            .body(Vec::new())
            .unwrap_or_else(|_| empty(StatusCode::NOT_FOUND, origin));
    }
    let Ok(bytes) = fs::read(&path) else {
        return empty(StatusCode::NOT_FOUND, origin);
    };
    let mut builder = with_common_headers(Response::builder(), origin, &etag, immutable)
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_type)
        .header(header::CONTENT_LENGTH, bytes.len());
    if mime_type == "image/svg+xml" {
        // 直接打开 SVG 时也不能跑脚本、不能外连。
        builder = builder.header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        );
    }
    let body = if method == Method::HEAD { Vec::new() } else { bytes };
    builder
        .body(body)
        .unwrap_or_else(|_| empty(StatusCode::NOT_FOUND, origin))
}

fn with_common_headers(
    builder: tauri::http::response::Builder,
    origin: Option<&str>,
    etag: &str,
    immutable: bool,
) -> tauri::http::response::Builder {
    let builder = builder
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::ETAG, etag)
        .header(
            header::CACHE_CONTROL,
            if immutable { "public, max-age=31536000, immutable" } else { "no-cache" },
        );
    cors(builder, origin)
}

fn empty(status: StatusCode, origin: Option<&str>) -> Response<Vec<u8>> {
    cors(Response::builder(), origin)
        .status(status)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(Vec::new())
        .expect("固定头部的空响应总能构造")
}

/// 导出分享图要把图片画进 canvas 再读像素，跨 scheme 取图必须带 CORS，否则画布被污染。
/// 只回显应用自己的来源。
fn cors(builder: tauri::http::response::Builder, origin: Option<&str>) -> tauri::http::response::Builder {
    match origin.filter(|origin| allowed_origin(origin)) {
        Some(origin) => builder
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            .header(header::VARY, "Origin"),
        None => builder.header(header::VARY, "Origin"),
    }
}

fn allowed_origin(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) || (cfg!(debug_assertions)
        && (origin.starts_with("http://localhost:") || origin.starts_with("http://127.0.0.1:")))
}

/// `assets/<hh>/<64 位 hex>.<ext>` 的内容永不变，可以让 webview 永久缓存。
fn is_content_addressed(vault: &Path, path: &Path) -> bool {
    let Ok(canonical_vault) = vault.canonicalize() else {
        return false;
    };
    let Ok(relative) = path.strip_prefix(&canonical_vault) else {
        return false;
    };
    let parts: Vec<_> = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    let [root, bucket, name] = parts.as_slice() else {
        return false;
    };
    let stem = name.split('.').next().unwrap_or_default();
    root == "assets"
        && stem.len() == 64
        && stem.bytes().all(|byte| byte.is_ascii_hexdigit())
        && stem[..2].eq_ignore_ascii_case(bucket)
}

fn percent_decode(encoded: &str) -> Option<String> {
    let raw = encoded.as_bytes();
    let mut bytes = Vec::with_capacity(raw.len());
    let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%' {
            let pair = std::str::from_utf8(raw.get(index + 1..index + 3)?).ok()?;
            bytes.push(u8::from_str_radix(pair, 16).ok()?);
            index += 3;
        } else {
            bytes.push(raw[index]);
            index += 1;
        }
    }
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use shard_core::FsVfs;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";

    fn vault() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        shard_core::ensure_vault_layout(&FsVfs::new(dir.path())).unwrap();
        dir
    }

    fn encode(path: &str) -> String {
        path.bytes()
            .map(|byte| match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (byte as char).to_string()
                }
                _ => format!("%{byte:02X}"),
            })
            .collect()
    }

    fn get(vault: &Path, path: &str, origin: Option<&str>) -> Response<Vec<u8>> {
        serve(vault, &Method::GET, &format!("/{}", encode(path)), origin, None)
    }

    /// 每个请求的（首行, Authorization 头）。
    type SeenRequests = std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>;

    /// 极简 HTTP 服务器：记下每个请求的首行与 Authorization 头，回一张「图片」。
    fn image_server() -> (String, SeenRequests) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = std::sync::Arc::clone(&seen);
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut authorization = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line.trim().is_empty() {
                        break;
                    }
                    if let Some(value) = line.strip_prefix("authorization: ").or_else(|| line.strip_prefix("Authorization: ")) {
                        authorization = value.trim().to_string();
                    }
                }
                log.lock().unwrap().push((first.trim().to_string(), authorization));
                let body = PNG;
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nETag: \"abc\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(head.as_bytes()).unwrap();
                stream.write_all(body).unwrap();
            }
        });
        (url, seen)
    }

    #[test]
    fn remote_mode_proxies_images_with_the_device_token() {
        let (url, seen) = image_server();
        let client = shard_remote::Client::new(&url, "shd_dev_t", shard_remote::ClientOptions::new("t/1", "t")).unwrap();
        let path = format!("/{}", encode("notes/证件/营业执照 1.jpg"));
        let response = serve_remote(&client, None, &Method::GET, &path, Some("tauri://localhost"));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(response.headers()[header::ETAG], "\"abc\"");
        assert_eq!(response.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "tauri://localhost");
        assert_eq!(response.body(), PNG);
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, format!("GET /api/files{path} HTTP/1.1"));
        assert_eq!(seen[0].1, "Bearer shd_dev_t");

        // 跳出与非读方法不转发。
        assert_eq!(serve_remote(&client, None, &Method::GET, "/notes/../.shard/lockbox.json", None).status(), StatusCode::NOT_FOUND);
        assert_eq!(serve_remote(&client, None, &Method::POST, &path, None).status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(seen.len(), 1);
    }

    #[test]
    fn serves_images_anywhere_public_with_sniffed_type() {
        let dir = vault();
        let vault = dir.path();
        fs::create_dir_all(vault.join("notes/证件")).unwrap();
        fs::write(vault.join("notes/证件/营业执照 1.jpg"), PNG).unwrap();

        let response = get(vault, "notes/证件/营业执照 1.jpg", Some("tauri://localhost"));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(response.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "tauri://localhost");
        assert_eq!(response.body(), PNG);

        let head = serve(vault, &Method::HEAD, &format!("/{}", encode("notes/证件/营业执照 1.jpg")), None, None);
        assert_eq!(head.status(), StatusCode::OK);
        assert!(head.body().is_empty());
        assert!(head.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
    }

    #[test]
    fn content_addressed_assets_are_immutable_and_revalidate_by_etag() {
        let dir = vault();
        let vault = dir.path();
        let hash = "ab".repeat(32);
        fs::create_dir_all(vault.join("assets/ab")).unwrap();
        fs::write(vault.join(format!("assets/ab/{hash}.png")), PNG).unwrap();

        let response = get(vault, &format!("shard-attachment:{hash}"), None);
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers()[header::CACHE_CONTROL].to_str().unwrap().contains("immutable"));
        let etag = response.headers()[header::ETAG].to_str().unwrap().to_string();

        let cached = serve(
            vault,
            &Method::GET,
            &format!("/{}", encode(&format!("assets/ab/{hash}.png"))),
            None,
            Some(&etag),
        );
        assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
        assert!(cached.body().is_empty());
    }

    #[test]
    fn refuses_non_images_private_and_internal_paths() {
        let dir = vault();
        let vault = dir.path();
        fs::create_dir_all(vault.join("lockbox")).unwrap();
        fs::write(vault.join("lockbox/secret.png"), PNG).unwrap();
        fs::write(vault.join(".shard/config.png"), PNG).unwrap();
        fs::write(vault.join("notes/readme.md"), "# 文档").unwrap();
        fs::write(vault.join("notes/fake.png"), "<html>x</html>").unwrap();

        for path in [
            "lockbox/secret.png",
            ".shard/config.png",
            "notes/readme.md",
            "notes/fake.png",
            "notes/missing.png",
            "../etc/passwd",
            "https://example.com/a.png",
        ] {
            let response = get(vault, path, None);
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            assert!(response.body().is_empty(), "{path}");
        }
        assert_eq!(
            serve(vault, &Method::POST, "/notes%2Freadme.md", None, None).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(get(vault, "notes/%ZZ", None).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn sandboxes_svg_and_only_echoes_app_origins() {
        let dir = vault();
        let vault = dir.path();
        fs::write(vault.join("notes/a.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();

        let response = get(vault, "notes/a.svg", Some("https://evil.example"));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/svg+xml");
        assert!(response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .contains("sandbox"));
        assert!(response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
    }

    #[test]
    fn serves_legacy_extensionless_assets() {
        let dir = vault();
        let vault = dir.path();
        fs::create_dir_all(vault.join("assets/2026/06")).unwrap();
        fs::write(vault.join("assets/2026/06/2026-06-13-195937-b858-png"), PNG).unwrap();

        let response = get(vault, "assets/2026/06/2026-06-13-195937-b858-png", None);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
    }
}
