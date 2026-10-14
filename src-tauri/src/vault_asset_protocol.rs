//! `shard-asset://` 协议：让 webview 直接按地址取 vault 里的图片。
//!
//! 以前每张图都要走 `read_fragment_image` 转成 base64 data URL，体积膨胀三分之一，整张图
//! 还常驻 JS 堆；资料库宫格、表格缩略图一多就扛不住。这里只供图片：路径先过
//! `resolve_vault_asset_path`（密匣、内部目录、越界符号链接都拒绝），再按文件头确认是
//! 图片才返回。任何失败都回 404，不在响应里带路径。
use std::{fs, path::Path, time::UNIX_EPOCH};

use tauri::http::{header, Method, Request, Response, StatusCode};

pub const SCHEME: &str = "shard-asset";

pub fn handle(app: &tauri::AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let if_none_match = request
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok());
    match crate::configured_vault_path(app) {
        Ok(vault) => serve(&vault, request.method(), request.uri().path(), origin, if_none_match),
        Err(_) => empty(StatusCode::NOT_FOUND, origin),
    }
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
    let Ok(path) = crate::resolve_vault_asset_path(vault, &reference) else {
        return empty(StatusCode::NOT_FOUND, origin);
    };
    let Ok(metadata) = fs::metadata(&path) else {
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
    // 只认文件头：扩展名是 .png、内容却是 HTML 的文件不供出去。
    let Some(mime_type) = shard_core::image::sniff_image_mime_type(&bytes) else {
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

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";

    fn vault() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        shard_core::ensure_vault_layout(dir.path()).unwrap();
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
