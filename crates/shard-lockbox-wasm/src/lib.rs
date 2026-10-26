//! 浏览器里的密匣：[`session::Session`] 在内存资料库上跑与桌面相同的密匣领域逻辑，主密钥只在 wasm 内存里。
//! 这里只是 wasm-bindgen 外壳：JSON 进、JSON 出，不含逻辑。
use wasm_bindgen::prelude::*;

pub mod session;

/// 一个密匣会话（每个标签页一个，跑在 Web Worker 里）。
#[wasm_bindgen]
pub struct LockboxSession {
    inner: session::Session,
}

impl Default for LockboxSession {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl LockboxSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self { inner: session::Session::new() }
    }

    /// 执行一个命令。返回 JSON：`{"ok": 结果}`、`{"error": "界面显示的报错"}` 或 `{"searchError": {...}}`。
    pub fn call(&mut self, method: &str, args: &str) -> String {
        let args = match serde_json::from_str(args) {
            Ok(args) => args,
            Err(error) => return serde_json::json!({ "error": format!("参数无效：{error}") }).to_string(),
        };
        match self.inner.call(method, args) {
            Ok(value) => serde_json::json!({ "ok": value }),
            Err(session::CallError::Message(message)) => serde_json::json!({ "error": message }),
            Err(session::CallError::Search(error)) => serde_json::json!({ "searchError": error }),
        }
        .to_string()
    }
}

/// 用口令解开 manifest 里的主密钥，再解开一条信封，返回载荷 JSON 文本（固定向量测试用）。
#[wasm_bindgen(js_name = openWithPassword)]
pub fn open_with_password(manifest: &str, password: &str, envelope: &str) -> Result<String, JsError> {
    let manifest = shard_lockbox::Manifest::parse(manifest).map_err(|error| JsError::new(&error))?;
    let master_key = manifest.unwrap_with_password(password).map_err(|error| JsError::new(&error))?;
    let read_keys = manifest.read_keys(&master_key).map_err(|error| JsError::new(&error))?;
    let plaintext = shard_lockbox::open_text(envelope, &read_keys).map_err(|error| JsError::new(&error))?;
    String::from_utf8(plaintext).map_err(|error| JsError::new(&error.to_string()))
}
