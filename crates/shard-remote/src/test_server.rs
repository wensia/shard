//! 单元测试用的极简 HTTP/1.1 服务器：每个连接只处理一个请求（`Connection: close`），只认 Content-Length 请求体。

use serde_json::Value;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::Arc,
    thread,
    time::Duration,
};

#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }

    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
}

pub enum Reply {
    /// 状态码 + 响应体（JSON 类型），写完关闭。
    Body(u16, String),
    /// 收到请求后不回任何响应直接断开（请求已送达、响应在网络上丢了）。
    Drop,
    /// 分块传输：逐块写出（块间稍停），写完结束响应。用于 SSE。
    Chunks(u16, Vec<Vec<u8>>),
}

impl Reply {
    pub fn status(status: u16, body: &str) -> Self {
        Self::Body(status, body.to_string())
    }

    pub fn json(status: u16, body: &Value) -> Self {
        Self::Body(status, body.to_string())
    }
}

/// 起服务器，返回 `http://127.0.0.1:<端口>`。
pub fn fake_server(handler: impl Fn(&Request) -> Reply + Send + Sync + 'static) -> String {
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

fn serve_one(mut stream: TcpStream, handler: &dyn Fn(&Request) -> Reply) {
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
    let request = Request { method, path, headers, body: String::from_utf8_lossy(&body).to_string() };
    match handler(&request) {
        Reply::Body(status, body) => {
            let response = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
        Reply::Drop => {}
        Reply::Chunks(status, chunks) => {
            let head = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
            );
            if stream.write_all(head.as_bytes()).is_err() {
                return;
            }
            for chunk in chunks {
                let mut framed = format!("{:x}\r\n", chunk.len()).into_bytes();
                framed.extend_from_slice(&chunk);
                framed.extend_from_slice(b"\r\n");
                if stream.write_all(&framed).and_then(|()| stream.flush()).is_err() {
                    return;
                }
                thread::sleep(Duration::from_millis(5));
            }
            let _ = stream.write_all(b"0\r\n\r\n");
        }
    }
    let _ = stream.shutdown(Shutdown::Both);
}
