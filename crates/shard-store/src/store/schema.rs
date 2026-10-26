//! 内容库与 blob 库的表结构。迁移只增不改：`user_version` 记录已执行到第几条。
//! 设计与取舍见 `docs/dev/server-sqlite-plan.md` §2。

use rusqlite::Connection;

/// shard.db 的迁移。第 N 条执行后 `user_version = N`。
const CONTENT_MIGRATIONS: &[&str] = &[r#"
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

-- 公开命名空间：真相是 inline / blob 字节，其余列同事务维护。
-- parent_key 冗余存放，供 read_dir 按父目录查子项。
CREATE TABLE nodes (
  node_id     INTEGER PRIMARY KEY,
  path        TEXT,
  path_key    TEXT,
  parent_key  TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('dir','file')),
  inline      BLOB,
  blob_sha    TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  sha         TEXT,
  created_at  TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  revision    INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  seq         INTEGER NOT NULL DEFAULT 0,
  purged_at   TEXT,
  CHECK ((path IS NULL) = (purged_at IS NOT NULL)),
  CHECK ((path IS NULL) = (path_key IS NULL)),
  CHECK (purged_at IS NOT NULL
         OR (kind = 'dir'  AND inline IS NULL AND blob_sha IS NULL AND sha IS NULL)
         OR (kind = 'file' AND (inline IS NULL) <> (blob_sha IS NULL) AND sha IS NOT NULL)),
  CHECK (path IS NULL OR (substr(path, 1, 1) <> '/' AND instr(path, '//') = 0
                          AND path_key <> 'lockbox' AND substr(path_key, 1, 8) <> 'lockbox/'))
);
CREATE UNIQUE INDEX nodes_path_key ON nodes(path_key) WHERE path_key IS NOT NULL;
CREATE INDEX nodes_parent ON nodes(parent_key) WHERE path_key IS NOT NULL;
CREATE INDEX nodes_seq ON nodes(seq);
CREATE INDEX nodes_blob ON nodes(blob_sha) WHERE blob_sha IS NOT NULL;

CREATE TABLE doc_index (
  node_id      INTEGER PRIMARY KEY REFERENCES nodes(node_id) ON DELETE CASCADE,
  doc_ns       TEXT NOT NULL CHECK (doc_ns IN ('fragment','map','flow','canvas','dataset','legacy')),
  doc_id       TEXT NOT NULL,
  lookup_scope INTEGER NOT NULL CHECK (lookup_scope IN (0,1)),
  type_tag TEXT, title TEXT, pinned INTEGER, created_at TEXT, updated_at TEXT, conflict_of TEXT
);
CREATE INDEX doc_by_ns_id ON doc_index(doc_ns, doc_id, lookup_scope);
CREATE INDEX doc_by_id ON doc_index(doc_id);
CREATE TABLE doc_tags (
  node_id INTEGER NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (node_id, tag)
) WITHOUT ROWID;
CREATE INDEX doc_tags_tag ON doc_tags(tag);
CREATE TABLE doc_links (
  node_id INTEGER NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
  link_kind TEXT NOT NULL CHECK (link_kind IN
    ('wikilink','image','csv','related','map_fragment','map_path','map_map','map_flow')),
  target TEXT NOT NULL,
  PRIMARY KEY (node_id, link_kind, target)
) WITHOUT ROWID;
CREATE INDEX doc_links_target ON doc_links(link_kind, target);

CREATE TABLE txns (
  txn_id INTEGER PRIMARY KEY,
  op_id TEXT UNIQUE,
  command TEXT NOT NULL,
  actor TEXT NOT NULL,
  device TEXT,
  request_sha TEXT,
  response BLOB,
  first_seq INTEGER,
  last_seq INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id INTEGER NOT NULL REFERENCES txns(txn_id),
  scope TEXT NOT NULL CHECK (scope IN ('public','lockbox','lockbox_manifest')),
  key TEXT NOT NULL,
  node_id INTEGER,
  exists_ INTEGER NOT NULL CHECK (exists_ IN (0,1)),
  sha TEXT,
  kind TEXT
);
CREATE INDEX changes_key ON changes(scope, key, seq);

CREATE TABLE revisions (
  rev_id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(node_id),
  path_at TEXT NOT NULL,
  sha TEXT,
  inline BLOB,
  blob_sha TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('import','create','edit','rename','move','trash',
                                         'restore','purge','conflict','revert','migrate')),
  txn_id INTEGER NOT NULL REFERENCES txns(txn_id),
  device TEXT,
  created_at TEXT NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX revisions_node ON revisions(node_id, rev_id DESC);
CREATE INDEX revisions_blob ON revisions(blob_sha) WHERE blob_sha IS NOT NULL;

CREATE TABLE lockbox_manifest (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL,
  sha TEXT NOT NULL,
  revision INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE lockbox_items (
  item_id TEXT PRIMARY KEY,
  envelope TEXT,
  envelope_version INTEGER NOT NULL,
  legacy_path TEXT,
  sha TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK ((deleted_at IS NULL) = (envelope IS NOT NULL))
);
CREATE TABLE lockbox_revisions (
  rev_id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL,
  envelope TEXT NOT NULL,
  sha TEXT NOT NULL,
  txn_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
"#];

/// blobs.db 的迁移。
const BLOB_MIGRATIONS: &[&str] = &[r#"
CREATE TABLE blobs (
  id INTEGER PRIMARY KEY,
  sha TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL,
  unreferenced_since TEXT
);
"#];

pub(crate) fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA secure_delete = ON;",
    )
}

pub(crate) fn migrate_content(conn: &Connection) -> rusqlite::Result<()> {
    migrate(conn, CONTENT_MIGRATIONS)
}

pub(crate) fn migrate_blobs(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA auto_vacuum = INCREMENTAL;")?;
    migrate(conn, BLOB_MIGRATIONS)
}

fn migrate(conn: &Connection, migrations: &[&str]) -> rusqlite::Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    for (index, sql) in migrations.iter().enumerate().skip(current as usize) {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.execute_batch(&format!("PRAGMA user_version = {}", index + 1))?;
        tx.commit()?;
    }
    Ok(())
}
