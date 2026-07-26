//! 笔记库的行模型。
//!
//! 这些结构只描述**存储层**的形状，不直接暴露给前端。前端可见的 `Fragment`
//! 仍定义在 `lib.rs`，两者之间的转换在 `notes::repo` 与调用方完成——存储层
//! 多出来的字段（revision / seq / content_hash / 导出台账）不该泄漏到 UI 类型里。

use chrono::DateTime;

/// 密匣的信封密文。与 `lib.rs` 的 `LockboxEncryptedFragment` 一一对应。
///
/// 存储层**从不解密**：导入、影子写、导出全部原样搬运密文，
/// 解密只发生在解锁后的读取路径上。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CipherEnvelope {
    pub version: i64,
    pub nonce: String,
    pub text: String,
    pub key_alg: Option<String>,
    pub key_text: Option<String>,
    /// 标识用哪把密钥封装。多设备并发解锁可能产生多把历史密钥，
    /// 缺了它就无从判断该用哪把解封。历史数据为 None。
    pub key_id: Option<String>,
}

/// 写入一条笔记所需的全部字段。
#[derive(Debug, Clone)]
pub(crate) struct NoteWrite {
    pub id: String,
    /// 明文正文。密匣条目必须为 `None`——schema 层的 CHECK 会兜底拒绝，
    /// 但调用方不应该依赖那个报错。
    pub content: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
    pub category: Option<String>,
    pub ai_status: String,
    pub source: String,
    pub archived: bool,
    pub pinned: bool,
    pub cipher: Option<CipherEnvelope>,
    /// 对应的 Markdown 产物路径（vault 相对路径）。
    pub export_path: Option<String>,
}

impl NoteWrite {
    /// 从库里的一行重建写入参数。
    ///
    /// 写入是**整行覆盖**语义，所以「只改置顶」这类命令也必须把其余字段原样带
    /// 回去。让每个命令自己拼一遍，迟早有一个会漏掉某个字段，表现出来就是改个
    /// 置顶把分类弄丢了。
    pub(crate) fn from_row(row: &FragmentRow) -> Self {
        Self {
            id: row.id.clone(),
            content: row.content.clone(),
            created_at: row.created_at.clone(),
            updated_at: row.updated_at.clone(),
            tags: row.tags.clone(),
            category: row.category.clone(),
            ai_status: row.ai_status.clone(),
            source: row.source.clone(),
            archived: row.archived,
            pinned: row.pinned,
            cipher: row.cipher.clone(),
            export_path: row.export_path.clone(),
        }
    }

    pub(crate) fn is_lockbox(&self) -> bool {
        self.cipher.is_some()
    }

    /// 内容指纹：明文条目取正文，密匣条目取密文。
    ///
    /// 导入幂等与导出脏检测都靠它，**不靠文件 mtime**——mtime 会被 checkout、
    /// 同步工具、备份还原改写，不是可靠的内容标识。
    pub(crate) fn content_hash(&self) -> String {
        let material = match (&self.cipher, &self.content) {
            (Some(cipher), _) => cipher.text.as_str(),
            (None, Some(content)) => content.as_str(),
            (None, None) => "",
        };
        crate::hash_text(material)
    }
}

/// 从库里读出的一整行。
///
/// Phase 2 只有测试在读它——读路径要到 Phase 3 才从文件切到 DB。
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct FragmentRow {
    pub id: String,
    pub content: Option<String>,
    pub content_hash: String,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
    pub category: Option<String>,
    pub ai_status: String,
    pub source: String,
    pub archived: bool,
    pub pinned: bool,
    pub lockbox: bool,
    pub revision: i64,
    pub cipher: Option<CipherEnvelope>,
    pub export_path: Option<String>,
    /// 库内容比磁盘产物新，需要重新导出。
    pub export_dirty: bool,
}

/// RFC3339 时间戳转毫秒。
///
/// 解析失败返回 0 而不是报错：`updated_at` 来自用户可编辑的 YAML frontmatter，
/// 一条格式古怪的时间戳不该让整条笔记无法入库。0 会让它在按时间排序时沉底，
/// 这是可接受的降级——数据仍在，只是排序位置不理想。
pub(crate) fn to_millis(timestamp: &str) -> i64 {
    DateTime::parse_from_rfc3339(timestamp)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(content: Option<&str>, cipher: Option<CipherEnvelope>) -> NoteWrite {
        NoteWrite {
            id: "f1".into(),
            content: content.map(str::to_string),
            created_at: "2026-07-26T10:00:00+08:00".into(),
            updated_at: "2026-07-26T10:00:00+08:00".into(),
            tags: vec![],
            category: None,
            ai_status: "none".into(),
            source: "desktop".into(),
            archived: false,
            pinned: false,
            cipher,
            export_path: None,
        }
    }

    fn envelope(text: &str) -> CipherEnvelope {
        CipherEnvelope {
            version: 1,
            nonce: "n".into(),
            text: text.into(),
            key_alg: None,
            key_text: None,
            key_id: None,
        }
    }

    #[test]
    fn plain_hash_covers_content() {
        let a = sample(Some("hello"), None);
        let b = sample(Some("hello"), None);
        let c = sample(Some("world"), None);
        assert_eq!(a.content_hash(), b.content_hash());
        assert_ne!(a.content_hash(), c.content_hash());
    }

    /// 密匣条目的指纹必须取密文——明文根本不在这一层出现。
    #[test]
    fn lockbox_hash_covers_ciphertext() {
        let a = sample(None, Some(envelope("cipher-a")));
        let b = sample(None, Some(envelope("cipher-b")));
        assert_ne!(a.content_hash(), b.content_hash());
        assert!(a.is_lockbox());
    }

    #[test]
    fn millis_parses_rfc3339_and_degrades_gracefully() {
        assert!(to_millis("2026-07-26T10:00:00+08:00") > 0);
        // 格式古怪不该让整条笔记入不了库。
        assert_eq!(to_millis("昨天下午"), 0);
        assert_eq!(to_millis(""), 0);
    }
}
