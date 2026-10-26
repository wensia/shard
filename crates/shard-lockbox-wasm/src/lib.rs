//! 浏览器里的密匣（骨架）：先验证加密格式能编到 wasm 并解开固定向量。
use wasm_bindgen::prelude::*;

/// 用口令解开 manifest 里的主密钥，再解开一条信封，返回载荷 JSON 文本。
#[wasm_bindgen(js_name = openWithPassword)]
pub fn open_with_password(manifest: &str, password: &str, envelope: &str) -> Result<String, JsError> {
    let manifest = shard_lockbox::Manifest::parse(manifest).map_err(|error| JsError::new(&error))?;
    let master_key = manifest.unwrap_with_password(password).map_err(|error| JsError::new(&error))?;
    let read_keys = manifest.read_keys(&master_key).map_err(|error| JsError::new(&error))?;
    let plaintext = shard_lockbox::open_text(envelope, &read_keys).map_err(|error| JsError::new(&error))?;
    String::from_utf8(plaintext).map_err(|error| JsError::new(&error.to_string()))
}
