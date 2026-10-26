//! 带令牌读写字节：桌面在线客户端代理图片（`GET /api/files/…`）、读修订原文（`/api/history/…`）、
//! 上传附件（`HEAD/PUT /api/blobs/<sha>`）。RPC 之外的这几条路径都是幂等的，网络失败照样按客户端的
//! 重试间隔重试。

use std::thread;

use crate::client::{describe_transport, Client, RemoteError};

/// 单个文件的读取上限（与服务器 `/api/files` 的上限一致）。
pub const MAX_FETCH_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedBytes {
    pub status: u16,
    pub content_type: Option<String>,
    pub etag: Option<String>,
    pub cache_control: Option<String>,
    pub content_security_policy: Option<String>,
    pub bytes: Vec<u8>,
}

impl FetchedBytes {
    pub fn is_ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

fn header(response: &ureq::http::Response<ureq::Body>, name: &str) -> Option<String> {
    response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_string)
}

impl Client {
    fn url(&self, path: &str) -> String {
        format!("{}/{}", self.server(), path.trim_start_matches('/'))
    }

    /// 网络失败按重试间隔重试；拿到任何 HTTP 响应（含 4xx/5xx）都原样返回，由调用方判断。
    fn with_retries<T>(&self, what: &str, mut attempt: impl FnMut() -> Result<T, ureq::Error>) -> Result<T, RemoteError> {
        let mut delays = self.options().retry_delays.iter();
        loop {
            match attempt() {
                Ok(value) => return Ok(value),
                Err(error) => match delays.next() {
                    Some(delay) => thread::sleep(*delay),
                    None => {
                        return Err(self.error(what, None, "NETWORK", format!("连不上 Shard 服务器：{}", describe_transport(&error)), None))
                    }
                },
            }
        }
    }

    /// `GET <服务器>/<path>`（path 形如 `api/files/notes/a.png`，调用方负责百分号编码）。
    pub fn get_bytes(&self, path: &str) -> Result<FetchedBytes, RemoteError> {
        let url = self.url(path);
        let authorization = format!("Bearer {}", self.token());
        self.with_retries(path, || {
            let mut response = self.agent().get(&url).header("Authorization", &authorization).call()?;
            let status = response.status().as_u16();
            let fetched = FetchedBytes {
                status,
                content_type: header(&response, "content-type"),
                etag: header(&response, "etag"),
                cache_control: header(&response, "cache-control"),
                content_security_policy: header(&response, "content-security-policy"),
                bytes: Vec::new(),
            };
            let bytes = response.body_mut().with_config().limit(MAX_FETCH_BYTES).read_to_vec()?;
            Ok(FetchedBytes { bytes, ..fetched })
        })
    }

    /// 按内容哈希上传（已有就跳过），返回 sha。服务端重算哈希，不一致返回 422。
    pub fn upload_blob(&self, bytes: &[u8]) -> Result<String, RemoteError> {
        let sha = sha256_hex(bytes);
        let url = self.url(&format!("api/blobs/{sha}"));
        let authorization = format!("Bearer {}", self.token());
        let exists = self.with_retries("upload_blob", || {
            let response = self.agent().head(&url).header("Authorization", &authorization).call()?;
            Ok(response.status().as_u16())
        })?;
        match exists {
            200 => return Ok(sha),
            404 => {}
            401 => return Err(self.error("upload_blob", Some(401), "UNAUTHENTICATED", "登录已失效。".to_string(), None)),
            status => return Err(self.error("upload_blob", Some(status), &format!("HTTP_{status}"), format!("服务器返回 HTTP {status}"), None)),
        }
        let status = self.with_retries("upload_blob", || {
            let response = self
                .agent()
                .put(&url)
                .header("Authorization", &authorization)
                .header("Content-Type", "application/octet-stream")
                .send(bytes)?;
            Ok(response.status().as_u16())
        })?;
        if (200..300).contains(&status) {
            Ok(sha)
        } else {
            Err(self.error("upload_blob", Some(status), &format!("HTTP_{status}"), format!("上传失败：服务器返回 HTTP {status}"), None))
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        test_server::{fake_server, Reply},
        ClientOptions,
    };
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    fn options() -> ClientOptions {
        ClientOptions::new("shard-test/1", "test").retry_base(Duration::from_millis(1))
    }

    #[test]
    fn get_bytes_sends_the_token_and_returns_headers_and_body() {
        let server = fake_server(|request| {
            assert_eq!(request.method, "GET");
            assert_eq!(request.path, "/api/files/notes/a.png");
            assert_eq!(request.header("authorization"), Some("Bearer shd_dev_t"));
            Reply::status(200, "PNGBYTES")
        });
        let client = Client::new(&server, "shd_dev_t", options()).unwrap();
        let fetched = client.get_bytes("api/files/notes/a.png").unwrap();
        assert!(fetched.is_ok());
        assert_eq!(fetched.bytes, b"PNGBYTES");
    }

    #[test]
    fn get_bytes_returns_http_errors_instead_of_failing() {
        let server = fake_server(|_| Reply::status(404, r#"{"code":"NOT_FOUND"}"#));
        let client = Client::new(&server, "shd_dev_t", options()).unwrap();
        assert_eq!(client.get_bytes("/api/files/x.png").unwrap().status, 404);
    }

    #[test]
    fn upload_skips_existing_blobs_and_puts_missing_ones() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let server = fake_server(move |request| {
            log.lock().unwrap().push((request.method.clone(), request.path.clone(), request.body.clone()));
            match request.method.as_str() {
                "HEAD" if request.path.ends_with(&sha256_hex(b"old")) => Reply::status(200, ""),
                "HEAD" => Reply::status(404, ""),
                _ => Reply::status(201, ""),
            }
        });
        let client = Client::new(&server, "shd_dev_t", options()).unwrap();
        assert_eq!(client.upload_blob(b"old").unwrap(), sha256_hex(b"old"));
        assert_eq!(client.upload_blob(b"new").unwrap(), sha256_hex(b"new"));
        let seen = seen.lock().unwrap();
        let methods: Vec<&str> = seen.iter().map(|(method, _, _)| method.as_str()).collect();
        assert_eq!(methods, ["HEAD", "HEAD", "PUT"]);
        assert_eq!(seen[2].2, "new");
    }

    #[test]
    fn network_failures_become_network_errors_after_retries() {
        let client = Client::new("http://127.0.0.1:9", "shd_dev_t", options()).unwrap();
        let error = client.get_bytes("api/files/a.png").unwrap_err();
        assert_eq!(error.code, "NETWORK");
    }
}
