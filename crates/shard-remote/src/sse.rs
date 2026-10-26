//! `GET <服务器>/api/events` 的 SSE：阻塞读取（ureq）与增量解析。
//!
//! 服务器推 `vault-changed`（带 `id:` = 变更序号）、`resync`（游标落后或广播溢出，客户端改走全量对账）、
//! `lockbox-changed`（不带 id，不推进公开内容的游标），每 20 秒一行心跳注释。
//!
//! 用法（桌面后台线程）：`client.events(上次的 id)` 打开一条流，逐个取事件转发给界面；流结束（`None`）或
//! 读出错（`Some(Err)`）后按退避重连，并把 [`EventStream::last_event_id`] 作为下一次的 `Last-Event-ID`，
//! 服务器从那之后补发，不漏不重。打开时 401（[`RemoteError::is_unauthenticated`]）表示令牌已吊销，别再重连。
//! 要提前结束就给流设 [`EventStream::with_stop_flag`]：最迟在下一次心跳（20 秒内）时停下。

use crate::client::{describe_transport, error_body, Client, RemoteError};
use std::{
    collections::VecDeque,
    io::{self, Read},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

/// 服务器每 20 秒发一次心跳；这么久一个字节都读不到就当连接已死（例如睡眠唤醒后），结束这条流。
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// 打开失败时错误体的上限。
const ERROR_BODY_LIMIT: u64 = 1024 * 1024;
/// SSE 错误里的「命令名」。
const EVENTS: &str = "events";
const BOM: &[u8] = b"\xEF\xBB\xBF";

/// 一条完整的 SSE 消息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    /// 事件名；没写 `event:` 时为 `message`。
    pub event: String,
    /// 多行 `data:` 用换行连接。
    pub data: String,
    /// 派发时的「最后事件 id」：按 SSE 规范，`id:` 会延续到之后不带 id 的事件；从没收到过时为 `None`。
    pub id: Option<String>,
}

/// 增量解析 SSE 字节流：喂进任意切分的块（可以切开 `\r\n`、切开多字节 UTF-8 字符），吐出完整的消息。
/// 注释行（`:` 开头，心跳）与未知字段忽略；`retry:` 忽略（重连节奏由调用方决定）。
#[derive(Debug, Clone, Default)]
pub struct SseParser {
    buffer: Vec<u8>,
    bom_checked: bool,
    event: String,
    data: Vec<String>,
    last_id: String,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// 续传时从上次的事件 id 接着解析：之后不带 `id:` 的事件仍报这个 id。
    pub fn with_last_event_id(last_event_id: Option<&str>) -> Self {
        Self { last_id: last_event_id.unwrap_or_default().to_string(), ..Self::default() }
    }

    /// 重连时该发的 `Last-Event-ID`；从没收到过（或服务器用空的 `id:` 清掉了）时为 `None`。
    pub fn last_event_id(&self) -> Option<&str> {
        Some(self.last_id.as_str()).filter(|id| !id.is_empty())
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buffer.extend_from_slice(chunk);
        if !self.bom_checked {
            // 流开头的 UTF-8 BOM 要去掉；它本身也可能被切开。
            if self.buffer.len() < BOM.len() && BOM.starts_with(&self.buffer) {
                return Vec::new();
            }
            if self.buffer.starts_with(BOM) {
                self.buffer.drain(..BOM.len());
            }
            self.bom_checked = true;
        }
        let mut events = Vec::new();
        let mut start = 0;
        while let Some(offset) = self.buffer[start..].iter().position(|byte| matches!(byte, b'\r' | b'\n')) {
            let end = start + offset;
            let carriage = self.buffer[end] == b'\r';
            // 块边界可能正好切开 `\r\n`：末尾单独一个 `\r` 先别当换行，等下一块。
            if carriage && end + 1 == self.buffer.len() {
                break;
            }
            let width = if carriage && self.buffer[end + 1] == b'\n' { 2 } else { 1 };
            // 只解码完整的行：多字节字符不会被块边界切坏。
            let line = String::from_utf8_lossy(&self.buffer[start..end]).into_owned();
            start = end + width;
            self.line(&line, &mut events);
        }
        self.buffer.drain(..start);
        events
    }

    fn line(&mut self, line: &str, events: &mut Vec<SseEvent>) {
        if line.is_empty() {
            if !self.data.is_empty() {
                let event = if self.event.is_empty() { "message".to_string() } else { std::mem::take(&mut self.event) };
                events.push(SseEvent {
                    event,
                    data: self.data.join("\n"),
                    id: self.last_event_id().map(str::to_string),
                });
            }
            self.event.clear();
            self.data.clear();
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = value.to_string(),
            "data" => self.data.push(value.to_string()),
            "id" if !value.contains('\0') => self.last_id = value.to_string(),
            _ => {}
        }
    }
}

/// 一条 SSE 连接上的事件：`Iterator<Item = Result<SseEvent, RemoteError>>`。
///
/// - `None`：连接结束（服务器关闭或设了停止标志）。
/// - `Some(Err(_))`：读出错（网络断开、60 秒没有任何数据），之后返回 `None`。
pub struct EventStream {
    reader: Box<dyn Read + Send>,
    parser: SseParser,
    pending: VecDeque<SseEvent>,
    server: String,
    stop: Option<Arc<AtomicBool>>,
    finished: bool,
}

impl std::fmt::Debug for EventStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventStream")
            .field("server", &self.server)
            .field("last_event_id", &self.last_event_id())
            .field("pending", &self.pending.len())
            .field("finished", &self.finished)
            .finish_non_exhaustive()
    }
}

impl EventStream {
    /// 从任意字节流读（测试或自定义传输用）。`last_event_id` 是续传的起点。
    pub fn from_reader(reader: impl Read + Send + 'static, last_event_id: Option<&str>) -> Self {
        Self::new(Box::new(reader), "", last_event_id)
    }

    fn new(reader: Box<dyn Read + Send>, server: &str, last_event_id: Option<&str>) -> Self {
        Self {
            reader,
            parser: SseParser::with_last_event_id(last_event_id),
            pending: VecDeque::new(),
            server: server.to_string(),
            stop: None,
            finished: false,
        }
    }

    /// 标志置为 true 后，下一次读到数据（最迟下一次心跳）时结束这条流。
    pub fn with_stop_flag(mut self, stop: Arc<AtomicBool>) -> Self {
        self.stop = Some(stop);
        self
    }

    /// 重连时该发的 `Last-Event-ID`。
    pub fn last_event_id(&self) -> Option<&str> {
        self.parser.last_event_id()
    }

    fn stopped(&self) -> bool {
        self.stop.as_ref().is_some_and(|stop| stop.load(Ordering::SeqCst))
    }
}

impl Iterator for EventStream {
    type Item = Result<SseEvent, RemoteError>;

    fn next(&mut self) -> Option<Self::Item> {
        let mut chunk = [0u8; 8192];
        loop {
            if self.finished || self.stopped() {
                self.finished = true;
                return None;
            }
            if let Some(event) = self.pending.pop_front() {
                return Some(Ok(event));
            }
            match self.reader.read(&mut chunk) {
                Ok(0) => {
                    self.finished = true;
                    return None;
                }
                Ok(read) => {
                    let events = self.parser.push(&chunk[..read]);
                    self.pending.extend(events);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => {
                    self.finished = true;
                    return Some(Err(RemoteError {
                        server: self.server.clone(),
                        command: EVENTS.to_string(),
                        status: None,
                        code: "NETWORK".to_string(),
                        message: format!("网络错误：{error}"),
                        detail: None,
                    }));
                }
            }
        }
    }
}

impl Client {
    /// 打开 `GET /api/events`。`last_event_id` 是上一条流的 [`EventStream::last_event_id`]（首次连接给 `None`，
    /// 服务器从当前开始推）。不重试：重连节奏（退避、唤醒后立即重连）由调用方决定。
    pub fn events(&self, last_event_id: Option<&str>) -> Result<EventStream, RemoteError> {
        let mut request = self
            .agent()
            .get(format!("{}/api/events", self.server()))
            .header("Authorization", format!("Bearer {}", self.token()))
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache");
        if let Some(id) = last_event_id.filter(|id| !id.is_empty()) {
            request = request.header("Last-Event-ID", id);
        }
        let response = request
            .config()
            .timeout_global(None)
            .timeout_per_read(Some(READ_TIMEOUT))
            .build()
            .call()
            .map_err(|error| self.error(EVENTS, None, "NETWORK", describe_transport(&error), None))?;
        let status = response.status().as_u16();
        if status != 200 {
            let text = response
                .into_body()
                .into_with_config()
                .limit(ERROR_BODY_LIMIT)
                .read_to_string()
                .unwrap_or_default();
            let (code, message, detail) = error_body(status, &text);
            return Err(self.error(EVENTS, Some(status), &code, message, detail));
        }
        Ok(EventStream::new(Box::new(response.into_body().into_reader()), self.server(), last_event_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        client::ClientOptions,
        test_server::{fake_server, Reply},
    };
    use serde_json::json;
    use std::sync::Mutex;

    const SAMPLE: &str = ": keep-alive\n\nevent: vault-changed\nid: 7\ndata: {\"a\":\ndata: 1}\n\nevent: resync\r\nid: 9\r\ndata: {}\r\n\r\n";

    fn expected_sample() -> Vec<SseEvent> {
        vec![
            SseEvent { event: "vault-changed".into(), id: Some("7".into()), data: "{\"a\":\n1}".into() },
            SseEvent { event: "resync".into(), id: Some("9".into()), data: "{}".into() },
        ]
    }

    fn feed(parser: &mut SseParser, bytes: &[u8], size: usize) -> Vec<SseEvent> {
        bytes.chunks(size).flat_map(|chunk| parser.push(chunk)).collect()
    }

    #[test]
    fn any_chunking_yields_the_same_messages() {
        for size in 1..=SAMPLE.len() {
            let mut parser = SseParser::new();
            assert_eq!(feed(&mut parser, SAMPLE.as_bytes(), size), expected_sample(), "块大小 {size}");
            assert_eq!(parser.last_event_id(), Some("9"));
        }
    }

    #[test]
    fn split_crlf_and_lone_cr_line_endings() {
        let mut parser = SseParser::new();
        // `\r` 在块末尾：等下一块，不能把后面的 `\n` 当成空行提前派发。
        assert!(parser.push(b"data: a\r").is_empty());
        assert!(parser.push(b"\ndata: b\r").is_empty());
        assert_eq!(
            parser.push(b"\n\r\n"),
            [SseEvent { event: "message".into(), data: "a\nb".into(), id: None }]
        );
        // 只用 `\r` 换行：末尾的 `\r` 要等下一块才知道是不是 `\r\n`。
        assert!(parser.push(b"event: x\rdata: c\r\r").is_empty());
        assert_eq!(parser.push(b"data: d\r"), [SseEvent { event: "x".into(), data: "c".into(), id: None }]);
        // 下一块不以 `\n` 开头：前面的 `\r` 单独当换行。
        assert_eq!(
            parser.push(b"\rdata: e\n\n"),
            [
                SseEvent { event: "message".into(), data: "d".into(), id: None },
                SseEvent { event: "message".into(), data: "e".into(), id: None },
            ]
        );
    }

    #[test]
    fn multibyte_characters_survive_chunk_boundaries_and_bom_is_dropped() {
        let text = "\u{feff}event: 变化\ndata: {\"标题\":\"骑行 🚲\"}\n\n";
        for size in 1..=4 {
            let mut parser = SseParser::new();
            assert_eq!(
                feed(&mut parser, text.as_bytes(), size),
                [SseEvent { event: "变化".into(), data: "{\"标题\":\"骑行 🚲\"}".into(), id: None }],
                "块大小 {size}"
            );
        }
        // BOM 只在流开头去掉。
        let mut parser = SseParser::new();
        assert_eq!(parser.push("data: \u{feff}x\n\n".as_bytes())[0].data, "\u{feff}x");
    }

    #[test]
    fn fields_follow_the_sse_rules() {
        let mut parser = SseParser::with_last_event_id(Some("41"));
        let events = parser.push(
            b": comment\n\
              event: lockbox-changed\ndata: {}\n\n\
              event: ignored-without-data\n\n\
              data\n\n\
              data:no-space\nid: 42\nretry: 10\nunknown: x\n\n\
              id: bad\0id\ndata: y\n\n\
              id\ndata: z\n\n",
        );
        assert_eq!(
            events,
            [
                SseEvent { event: "lockbox-changed".into(), data: "{}".into(), id: Some("41".into()) },
                SseEvent { event: "message".into(), data: "".into(), id: Some("41".into()) },
                SseEvent { event: "message".into(), data: "no-space".into(), id: Some("42".into()) },
                SseEvent { event: "message".into(), data: "y".into(), id: Some("42".into()) },
                SseEvent { event: "message".into(), data: "z".into(), id: None },
            ]
        );
        assert_eq!(parser.last_event_id(), None, "空的 id: 清掉续传点");
        // 没有空行收尾的半条消息不派发。
        assert!(parser.push(b"data: half").is_empty());
        assert!(parser.push(b"\n").is_empty());
    }

    /// 每次 read 只给几个字节、并在数据读完后报错的读取器。
    struct Trickle {
        bytes: Vec<u8>,
        position: usize,
        step: usize,
        fail_at_end: bool,
    }

    impl Read for Trickle {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.position >= self.bytes.len() {
                return if self.fail_at_end { Err(io::Error::new(io::ErrorKind::TimedOut, "读超时")) } else { Ok(0) };
            }
            let end = (self.position + self.step.min(buf.len())).min(self.bytes.len());
            let read = end - self.position;
            buf[..read].copy_from_slice(&self.bytes[self.position..end]);
            self.position = end;
            Ok(read)
        }
    }

    #[test]
    fn streams_yield_events_then_end_or_report_read_errors() {
        let reader = Trickle { bytes: SAMPLE.as_bytes().to_vec(), position: 0, step: 3, fail_at_end: false };
        let mut stream = EventStream::from_reader(reader, Some("5"));
        assert_eq!(stream.last_event_id(), Some("5"));
        let events = stream.by_ref().collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(events, expected_sample());
        assert_eq!(stream.last_event_id(), Some("9"));
        assert!(stream.next().is_none());

        let reader = Trickle { bytes: b"data: a\n\n".to_vec(), position: 0, step: 64, fail_at_end: true };
        let mut stream = EventStream::from_reader(reader, None);
        assert_eq!(stream.next().unwrap().unwrap().data, "a");
        let error = stream.next().unwrap().unwrap_err();
        assert!(error.is_network() && error.is("NETWORK") && error.command == "events", "{error:?}");
        assert!(error.message.contains("读超时"), "{}", error.message);
        assert!(stream.next().is_none(), "出错后结束");
    }

    /// 只发心跳的无尽流（每次读一整行心跳）。
    struct Heartbeats;

    /// 一次心跳的字节数（`: keep-alive\n\n`）。
    const HEARTBEAT: u64 = 14;

    impl Read for Heartbeats {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let beat = b": keep-alive\n\n";
            let read = beat.len().min(buf.len());
            buf[..read].copy_from_slice(&beat[..read]);
            Ok(read)
        }
    }

    #[test]
    fn stop_flags_end_idle_streams_at_the_next_heartbeat() {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let reader = Heartbeats.take(HEARTBEAT * 1000).chain(&b"data: late\n\n"[..]);
        let mut stream = EventStream::from_reader(reader, None).with_stop_flag(Arc::clone(&stop));
        flag.store(true, Ordering::SeqCst);
        assert!(stream.next().is_none());
        // 没设标志时会一直读到真正的事件。
        let reader = Heartbeats.take(HEARTBEAT * 1000).chain(&b"data: late\n\n"[..]);
        let mut stream = EventStream::from_reader(reader, None);
        assert_eq!(stream.next().unwrap().unwrap().data, "late");
    }

    #[test]
    fn clients_open_event_streams_with_resume_ids() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let server = fake_server(move |request| {
            log.lock().unwrap().push(request.clone());
            if request.header("authorization") != Some("Bearer shd_dev_ok") {
                return Reply::json(401, &json!({ "code": "UNAUTHENTICATED", "message": "请重新配对" }));
            }
            Reply::Chunks(
                200,
                vec![
                    b": connected\n\n".to_vec(),
                    b"event: vault-changed\nid: 12\ndata: {\"vault\":".to_vec(),
                    b"\"v\"}\r".to_vec(),
                    b"\n\r\nevent: lockbox-changed\ndata: {}\n\n".to_vec(),
                ],
            )
        });
        let options = ClientOptions::new("shard-test/1", "t");
        let client = Client::new(&server, "shd_dev_ok", options.clone()).unwrap();
        let mut stream = client.events(Some("10")).unwrap();
        let events = stream.by_ref().collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(
            events,
            [
                SseEvent { event: "vault-changed".into(), data: "{\"vault\":\"v\"}".into(), id: Some("12".into()) },
                SseEvent { event: "lockbox-changed".into(), data: "{}".into(), id: Some("12".into()) },
            ]
        );
        assert_eq!(stream.last_event_id(), Some("12"));
        client.events(None).unwrap().for_each(drop);

        let revoked = Client::new(&server, "shd_dev_revoked", options).unwrap().events(None).unwrap_err();
        assert!(revoked.is_unauthenticated() && revoked.is("UNAUTHENTICATED"), "{revoked:?}");
        assert_eq!((revoked.command.as_str(), revoked.message.as_str()), ("events", "请重新配对"));

        let seen = seen.lock().unwrap();
        assert_eq!((seen[0].method.as_str(), seen[0].path.as_str()), ("GET", "/api/events"));
        assert_eq!(seen[0].header("last-event-id"), Some("10"));
        assert_eq!(seen[0].header("accept"), Some("text/event-stream"));
        assert_eq!(seen[0].header("user-agent"), Some("shard-test/1"));
        assert_eq!(seen[1].header("last-event-id"), None, "首次连接不带续传点");

        let unreachable = Client::new("http://127.0.0.1:9", "t", ClientOptions::new("t", "t")).unwrap().events(None);
        assert!(unreachable.is_err_and(|error| error.is_network()));
    }
}
