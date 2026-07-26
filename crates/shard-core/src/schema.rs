//! 笔记库的表定义。**客户端与服务端跑同一套。**
//!
//! 让两端共用一份 DDL 而不是各写各的，是因为 schema 漂移的症状极其隐蔽：
//! 同步过去的数据落在一个少了某列、或某个 CHECK 宽了一档的表里，不会报错，
//! 只会在很久以后表现为「这条笔记在另一台设备上不太对」。
//!
//! 迁移只增不改：已发布版本的 `sql` 不允许再修改，要改就追加新版本。
//!
//! # 设计要点
//!
//! - **归档是打标不是移动目录**。文件系统时代 `archive_fragment` 把文件挪进
//!   `archive/`，挪完就回不去了；这里 `archived_at` 置空即可撤销。
//! - **永不硬删**。`deleted_at` 墓碑是多端同步的必需品：没有它，离线设备会把
//!   已在别处删除的笔记重新推回来（幽灵复活）。所有读查询都必须带
//!   `WHERE deleted_at IS NULL`。
//! - **密匣明文永不落库**，由表级 CHECK 在 schema 层强制，不依赖调用方自觉。
//! - **不给 `ai_status` / `source` 加 CHECK**。它们来自用户可编辑的 YAML
//!   frontmatter，历史文件里可能是任意值；加了 CHECK 会让一个手工改过的文件
//!   毁掉整批导入。取值约束由前端 TS 类型表达，存储层保持宽松。

/// 单个版本的 DDL。`version` 从 1 开始，同一组内必须严格递增。
pub struct Migration {
    pub version: i64,
    pub sql: &'static str,
}

/// 笔记库的全部迁移，按版本升序。
pub const NOTES_MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        sql: V1_SQL,
    },
    Migration {
        version: 2,
        sql: V2_SQL,
    },
    Migration {
        version: 3,
        sql: V3_SQL,
    },
];

const V1_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS fragments (
    id                TEXT PRIMARY KEY,

    -- 明文正文。lockbox = 1 时恒为 NULL：明文永不落库。
    content           TEXT,
    -- sha256(content)，密匣条目则是 sha256(cipher_text)。
    -- 导入幂等与导出脏检测都靠它，不靠 mtime。
    content_hash      TEXT NOT NULL,

    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    -- 毫秒时间戳，用于增量拉取游标与稳定排序（字符串时间戳比较靠不住）。
    updated_at_ms     INTEGER NOT NULL,

    -- 非 NULL 即已归档；与 deleted_at 是两个正交概念，不可混用。
    archived_at       TEXT,
    -- 墓碑。非 NULL 即已删除，所有读查询必须过滤。
    deleted_at        TEXT,

    pinned            INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    lockbox           INTEGER NOT NULL DEFAULT 0 CHECK (lockbox IN (0, 1)),
    category          TEXT,
    ai_status         TEXT NOT NULL DEFAULT 'none',
    source            TEXT NOT NULL DEFAULT 'desktop',

    -- 乐观并发：所有 UPDATE 走 CAS（WHERE revision = ?），rows_affected = 0 即冲突。
    revision          INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_by_device TEXT NOT NULL DEFAULT '',
    -- 服务端分配的单调序号，客户端本地为 NULL。增量拉取用它而非时间戳
    -- （时钟偏移会让基于时间的增量漏数据）。
    seq               INTEGER,
    -- 这条是谁的冲突副本；非 NULL 时前端显示可跳转的冲突徽章。
    conflict_of       TEXT,

    attachment_count  INTEGER NOT NULL DEFAULT 0,

    -- 密匣信封加密。与 LockboxEncryptedFragment 字段一一对应，导入时原样搬密文、不解密。
    cipher_version    INTEGER,
    cipher_nonce      TEXT,
    cipher_text       TEXT,
    cipher_key_alg    TEXT,
    cipher_key_text   TEXT,
    -- 标识用哪把密钥封装的。多设备并发解锁时可能存在多把历史密钥，
    -- 没有它就无法判断该用哪把解封。
    cipher_key_id     TEXT,

    -- Markdown 降级为导出产物后的台账。
    export_path       TEXT,
    exported_at       TEXT,
    export_dirty      INTEGER NOT NULL DEFAULT 1 CHECK (export_dirty IN (0, 1)),

    -- 明文与密文互斥，且密匣条目必须有密文。在 schema 层堵死明文泄漏。
    CHECK (
        (lockbox = 0 AND content IS NOT NULL)
        OR
        (lockbox = 1 AND content IS NULL AND cipher_text IS NOT NULL)
    )
);

-- 时间线主查询的覆盖索引：pinned 优先、再按创建时间倒序，id 兜底保证全序
-- （keyset 分页依赖严格全序，否则同秒创建的条目会在翻页时重复或丢失）。
CREATE INDEX IF NOT EXISTS idx_fragments_timeline
    ON fragments (pinned DESC, created_at DESC, id DESC)
    WHERE deleted_at IS NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_fragments_archived
    ON fragments (created_at DESC)
    WHERE deleted_at IS NULL AND archived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fragments_updated_ms
    ON fragments (updated_at_ms);

CREATE INDEX IF NOT EXISTS idx_fragments_lockbox
    ON fragments (lockbox) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_fragments_export_dirty
    ON fragments (export_dirty) WHERE export_dirty = 1;

CREATE INDEX IF NOT EXISTS idx_fragments_conflict_of
    ON fragments (conflict_of) WHERE conflict_of IS NOT NULL;

CREATE TABLE IF NOT EXISTS fragment_tags (
    fragment_id TEXT NOT NULL REFERENCES fragments(id) ON DELETE CASCADE,
    tag         TEXT NOT NULL CHECK (length(trim(tag)) > 0),
    PRIMARY KEY (fragment_id, tag)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_fragment_tags_tag ON fragment_tags (tag);

-- 全文索引。分词由应用层的 shard_core::fts::to_fts_text 预处理（CJK 逐字切开），
-- 这里只用内置 unicode61 —— 自定义 tokenizer 无法在远端 Turso 注册，
-- 把分词放应用层才能让本地、服务端、浏览器三处行为一致。
CREATE VIRTUAL TABLE IF NOT EXISTS fragments_fts USING fts5(
    body,
    tags,
    tokenize = "unicode61 remove_diacritics 2 tokenchars '_-#/@'",
    prefix = '2 3'
);

-- FTS5 的 rowid 是整数，而 fragments 用 TEXT 主键。这张映射表让 UPDATE/DELETE
-- 能按 rowid 定位，避免对 UNINDEXED 列做全表扫描。
CREATE TABLE IF NOT EXISTS fragment_fts_ref (
    fragment_id TEXT PRIMARY KEY REFERENCES fragments(id) ON DELETE CASCADE,
    fts_rowid   INTEGER NOT NULL UNIQUE
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS db_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

-- 导入台账：记录每个源文件的 hash，让重复导入变成幂等操作。
-- 主键是 (kind, path)，但幂等判定优先用 frontmatter 里的 id——
-- 文件被移动或重命名时路径会变，id 不会。
CREATE TABLE IF NOT EXISTS import_ledger (
    source_kind TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (source_kind, source_path)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_import_ledger_target ON import_ledger (target_id);
"#;

/// v2：把剩下三类仍以文件为真相源的数据纳入库中——思维导图、图片附件元数据、
/// 密匣密钥。至此本地不再有「只存在于文件里」的数据。
const V2_SQL: &str = r#"
-- 思维导图。**整档存储，不拆节点**：现有 SHARD_MAP_MAX_NODES = 400，
-- 保存语义本就是「整档 + expected_revision + last_saved_hash」，整档存 TEXT
-- 能让既有的乐观锁语义 1:1 平移成一条 CAS UPDATE，不必重新设计并发模型。
CREATE TABLE IF NOT EXISTS shard_maps (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    -- canonical_mind_map_text() 的输出，保证同一份文档序列化结果确定。
    doc_json      TEXT NOT NULL,
    -- = hash_text(doc_json)，即前端传来的 last_saved_hash，口径必须一致。
    doc_hash      TEXT NOT NULL,
    revision      INTEGER NOT NULL CHECK (revision > 0),
    node_count    INTEGER NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deleted_at    TEXT,
    export_path   TEXT,
    export_dirty  INTEGER NOT NULL DEFAULT 1 CHECK (export_dirty IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_shard_maps_updated
    ON shard_maps (updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shard_maps_export_dirty
    ON shard_maps (export_dirty) WHERE export_dirty = 1;

-- 图片附件的**元数据**。二进制留在文件系统（本地缓存目录），这里只存内容寻址
-- 的 hash 与摄入时确定的 MIME —— 把大 blob 放进库会让体积失控，而附件本就
-- 适合按需读取。
CREATE TABLE IF NOT EXISTS attachments (
    hash        TEXT PRIMARY KEY,
    -- 摄入时用魔数嗅探定死，读取直接用这一列。不信任扩展名：内容是 SVG 而
    -- 名为 .png 的文件按扩展名判定会被当成 image/png，是一个脚本执行面。
    mime_type   TEXT NOT NULL,
    byte_size   INTEGER NOT NULL CHECK (byte_size >= 0),
    created_at  TEXT NOT NULL,
    deleted_at  TEXT
);

-- 附件与笔记的多对多关联：同一张图可能被多条笔记引用（内容寻址天然去重），
-- 因此不能把 fragment_id 直接挂在 attachments 上。
CREATE TABLE IF NOT EXISTS fragment_attachments (
    fragment_id TEXT NOT NULL REFERENCES fragments(id) ON DELETE CASCADE,
    hash        TEXT NOT NULL REFERENCES attachments(hash),
    PRIMARY KEY (fragment_id, hash)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_fragment_attachments_hash ON fragment_attachments (hash);

-- 密匣 manifest（单行）。内容与 .shard/lockbox.json 相同，全是密文。
--
-- revision 用于 CAS，修复一个真实缺陷：解锁时会写回 manifest 补生成密钥对，
-- 两台设备同时首次解锁会互相覆盖，导致先写那台在锁定态写入的片段永久无法解密。
CREATE TABLE IF NOT EXISTS lockbox_manifest (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    payload    TEXT NOT NULL,
    revision   INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at TEXT NOT NULL
);

-- 历史密钥**只增不删**。密钥轮换或并发解锁产生新密钥对后，旧密钥仍是解开
-- 既有密文的唯一途径，删掉等于永久销毁那批数据。
CREATE TABLE IF NOT EXISTS lockbox_keys (
    key_id              TEXT PRIMARY KEY,
    algorithm           TEXT NOT NULL,
    public_key          TEXT NOT NULL,
    wrapped_private_key TEXT NOT NULL,
    nonce               TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    retired_at          TEXT
);
"#;

/// v3：多端同步所需的列与表。
///
/// 客户端与服务端建同一套，各自只用其中一半——服务端不需要 outbox，客户端
/// 不分配 seq。这点冗余换来的是**只有一条 `user_version` 时间线**：两端各自
/// 追加迁移会让版本号互相踩踏，同一个数字在两边意味着不同的表结构。
const V3_SQL: &str = r#"
-- 导图与附件也要能增量拉取，同样按 seq 而不是时间戳。
ALTER TABLE shard_maps ADD COLUMN seq INTEGER;
ALTER TABLE shard_maps ADD COLUMN updated_by_device TEXT NOT NULL DEFAULT '';
ALTER TABLE attachments ADD COLUMN seq INTEGER;

CREATE INDEX IF NOT EXISTS idx_fragments_seq ON fragments (seq) WHERE seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shard_maps_seq ON shard_maps (seq) WHERE seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attachments_seq ON attachments (seq) WHERE seq IS NOT NULL;

-- 服务端侧：全局单调序列的分配器。
--
-- 分配必须与写入在**同一个事务**里完成。分开做会让并发推送拿到乱序的 seq，
-- 而增量拉取完全依赖单调性——乱一次，某台设备就会永久漏掉中间那批改动。
CREATE TABLE IF NOT EXISTS sync_seq (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO sync_seq (id, value) VALUES (1, 0);

-- 客户端侧：待推送队列。
--
-- 主键是 (kind, id)，同一条实体只保留最新一条待推——离线期间连改十次，
-- 上线时只需要推最后那一版。
CREATE TABLE IF NOT EXISTS sync_outbox (
    entity_kind   TEXT NOT NULL,
    entity_id     TEXT NOT NULL,
    -- 入队时这条在本地的版本。推送时作为 CAS 的基准。
    base_revision INTEGER,
    queued_at     TEXT NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    PRIMARY KEY (entity_kind, entity_id)
) WITHOUT ROWID;

-- 客户端侧：同步游标。
CREATE TABLE IF NOT EXISTS sync_state (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    last_pulled_seq INTEGER NOT NULL DEFAULT 0,
    last_synced_at  TEXT,
    last_error      TEXT
);
INSERT OR IGNORE INTO sync_state (id, last_pulled_seq) VALUES (1, 0);
"#;
