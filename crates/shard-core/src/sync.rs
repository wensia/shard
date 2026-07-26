//! 同步协议的报文。**客户端与服务端共用这一份定义。**
//!
//! # 为什么增量游标是 seq 而不是时间戳
//!
//! 服务端每次写入在同一个事务里分配一个单调递增的 `seq`，客户端记住见过的最大
//! 值，下次带着它来要更新的。用时间戳做游标会在时钟偏移下**静默漏数据**：设备
//! 的钟慢了几秒，那几秒里服务端接收的改动就永远不会被这台设备拉到。
//!
//! # 为什么每条都带 base_revision
//!
//! 推送不是「把我这份写进去」，而是「如果它还停在我看到的那一版，就写进去」。
//! 服务端据此做 CAS，不匹配就回 [`PushOutcome::Conflict`] 并附上当前版本。
//! 冲突**从不覆盖**——客户端把本地那份另存为冲突副本，用户一条都不会丢。

use serde::{Deserialize, Serialize};

/// 协议版本。两端不一致时服务端直接拒绝，不猜测对方的意图。
pub const PROTOCOL_VERSION: u32 = 1;

/// 一条笔记在协议里的完整形状。
///
/// 刻意与 `fragments` 表逐列对应：同步要搬运的是整行，少一列就意味着那个字段
/// 在设备之间会莫名其妙地丢失或回退。导出台账（`export_path` / `export_dirty`）
/// 是**本地**产物的记录，不属于协议——每台设备的导出目录本来就可以不一样。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FragmentPayload {
    pub id: String,
    /// 明文正文。密匣条目恒为 `None`——服务器全程只见密文。
    pub content: Option<String>,
    pub content_hash: String,
    pub created_at: String,
    pub updated_at: String,
    pub updated_at_ms: i64,
    pub archived_at: Option<String>,
    /// 墓碑。非 `None` 即已删除，但行仍然要同步——没有墓碑，离线设备会把
    /// 已在别处删掉的笔记推回来。
    pub deleted_at: Option<String>,
    pub pinned: bool,
    pub lockbox: bool,
    pub category: Option<String>,
    pub ai_status: String,
    pub source: String,
    pub tags: Vec<String>,
    pub revision: i64,
    pub updated_by_device: String,
    /// 这条是谁的冲突副本。
    pub conflict_of: Option<String>,
    pub cipher: Option<CipherEnvelope>,
    /// 正文引用到的附件摘要。二进制走 `/v1/attachments`，不进这个报文。
    #[serde(default)]
    pub attachment_hashes: Vec<String>,
}

/// 密匣信封。服务端**只存不解**，也没有任何解开它的材料。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CipherEnvelope {
    pub version: i64,
    pub nonce: String,
    pub text: String,
    pub key_alg: Option<String>,
    pub key_text: Option<String>,
    pub key_id: Option<String>,
}

/// 一份思维导图。整档搬运，不拆节点。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapPayload {
    pub id: String,
    pub title: String,
    pub doc_json: String,
    pub doc_hash: String,
    pub revision: i64,
    pub node_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub updated_at_ms: i64,
    pub deleted_at: Option<String>,
}

/// 附件元数据。二进制单独走 HTTP 端点。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPayload {
    pub hash: String,
    pub mime_type: String,
    pub byte_size: i64,
    pub created_at: String,
    pub deleted_at: Option<String>,
}

/// 一次推送里的一条改动。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PushItem {
    Fragment {
        /// 客户端看到的版本。`None` 表示「我认为这是新建」。
        base_revision: Option<i64>,
        payload: Box<FragmentPayload>,
    },
    Map {
        base_revision: Option<i64>,
        payload: Box<MapPayload>,
    },
    /// 附件元数据只增不改，没有并发语义，因此不带 base_revision。
    Attachment { payload: AttachmentPayload },
}

impl PushItem {
    /// 用于把结果对回请求项的标识。
    pub fn entity_id(&self) -> &str {
        match self {
            PushItem::Fragment { payload, .. } => &payload.id,
            PushItem::Map { payload, .. } => &payload.id,
            PushItem::Attachment { payload } => &payload.hash,
        }
    }

    pub fn entity_kind(&self) -> EntityKind {
        match self {
            PushItem::Fragment { .. } => EntityKind::Fragment,
            PushItem::Map { .. } => EntityKind::Map,
            PushItem::Attachment { .. } => EntityKind::Attachment,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntityKind {
    Fragment,
    Map,
    Attachment,
}

impl EntityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EntityKind::Fragment => "fragment",
            EntityKind::Map => "map",
            EntityKind::Attachment => "attachment",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "fragment" => Some(EntityKind::Fragment),
            "map" => Some(EntityKind::Map),
            "attachment" => Some(EntityKind::Attachment),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    pub protocol_version: u32,
    /// 推送方的设备标识，写进被改动行的 `updated_by_device`。
    pub device_id: String,
    pub items: Vec<PushItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResponse {
    pub results: Vec<PushResult>,
    /// 这一批写入之后服务端的最大 seq。
    pub max_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub kind: EntityKind,
    pub id: String,
    pub outcome: PushOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PushOutcome {
    /// 写入成功，附上服务端分配的新版本与序号。
    Applied { revision: i64, seq: i64 },
    /// CAS 失败。`current` 是服务端当前的那一版，客户端据此另存冲突副本。
    Conflict { current: Box<ServerVersion> },
    /// 这一条本身有问题（字段非法等），不影响同批其余条目。
    Rejected { reason: String },
}

/// 冲突时回给客户端的服务端现状。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServerVersion {
    Fragment(Box<FragmentPayload>),
    Map(Box<MapPayload>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesResponse {
    pub protocol_version: u32,
    pub changes: Vec<Change>,
    /// 客户端下次该带的游标。
    pub next_seq: i64,
    /// 服务端是否还有更多数据——一批取不完时为 true。
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Change {
    Fragment { seq: i64, payload: Box<FragmentPayload> },
    Map { seq: i64, payload: Box<MapPayload> },
    Attachment { seq: i64, payload: AttachmentPayload },
}

impl Change {
    pub fn seq(&self) -> i64 {
        match self {
            Change::Fragment { seq, .. } | Change::Map { seq, .. } | Change::Attachment { seq, .. } => *seq,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fragment() -> FragmentPayload {
        FragmentPayload {
            id: "f1".into(),
            content: Some("正文".into()),
            content_hash: "h".into(),
            created_at: "2026-07-26T10:00:00+08:00".into(),
            updated_at: "2026-07-26T10:00:00+08:00".into(),
            updated_at_ms: 1,
            archived_at: None,
            deleted_at: None,
            pinned: false,
            lockbox: false,
            category: None,
            ai_status: "none".into(),
            source: "desktop".into(),
            tags: vec!["会议".into()],
            revision: 1,
            updated_by_device: "dev-a".into(),
            conflict_of: None,
            cipher: None,
            attachment_hashes: vec![],
        }
    }

    /// 报文要能原样往返：字段名或类型悄悄变了，两端就会互相看不懂。
    #[test]
    fn fragment_payload_round_trips() {
        let text = serde_json::to_string(&fragment()).unwrap();
        assert_eq!(
            serde_json::from_str::<FragmentPayload>(&text).unwrap(),
            fragment()
        );
        assert!(text.contains("contentHash"), "对外应是 camelCase：{text}");
    }

    /// `attachmentHashes` 缺省要能解析：老客户端发来的报文里没有这个字段。
    #[test]
    fn attachment_hashes_default_to_empty() {
        let mut value = serde_json::to_value(fragment()).unwrap();
        value.as_object_mut().unwrap().remove("attachmentHashes");
        let parsed: FragmentPayload = serde_json::from_value(value).unwrap();
        assert!(parsed.attachment_hashes.is_empty());
    }

    #[test]
    fn push_items_expose_their_identity() {
        let item = PushItem::Fragment {
            base_revision: Some(1),
            payload: Box::new(fragment()),
        };
        assert_eq!(item.entity_id(), "f1");
        assert_eq!(item.entity_kind(), EntityKind::Fragment);
    }

    #[test]
    fn entity_kind_round_trips_through_str() {
        for kind in [EntityKind::Fragment, EntityKind::Map, EntityKind::Attachment] {
            assert_eq!(EntityKind::from_str(kind.as_str()), Some(kind));
        }
        assert_eq!(EntityKind::from_str("nope"), None);
    }

    /// 冲突结果必须能带回服务端当前版本——客户端要靠它另存副本。
    #[test]
    fn conflict_outcome_carries_server_version() {
        let outcome = PushOutcome::Conflict {
            current: Box::new(ServerVersion::Fragment(Box::new(fragment()))),
        };
        let text = serde_json::to_string(&outcome).unwrap();
        assert!(text.contains("\"status\":\"conflict\""), "{text}");
        assert!(text.contains("f1"));
    }
}
