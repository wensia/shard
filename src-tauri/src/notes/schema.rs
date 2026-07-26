//! 笔记库的 DDL。
//!
//! 迁移只增不改：已发布的版本 SQL 不允许再修改，要改就追加新版本
//! （见 `crate::db::migrate`）。
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

use crate::db::migrate::Migration;

/// 全部迁移，按版本升序。
pub(crate) static MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    sql: V1_SQL,
}];

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
