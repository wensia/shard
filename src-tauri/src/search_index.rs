//! Disposable, public-only search projections. The vault remains the source of truth.
//! Callers must use this store only on a background thread and never while holding
//! the vault write gate, scan gate, or publication lock.

use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

#[cfg(unix)]
use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};

use rusqlite::{params, Connection, Error, ErrorCode, OptionalExtension};
use sha2::{Digest, Sha256};
use shard_core::search::SearchProjectionBlock;

const SCHEMA_VERSION: i64 = 2;
const INDEX_FORMAT: &str = "search-projection-assets-v2";
const BATCH_SIZE: usize = 1_000;

#[derive(Default)]
pub(crate) struct IndexRegistry {
    root: OnceLock<PathBuf>,
    active: Mutex<Option<(PathBuf, Arc<IndexStore>)>>,
}

impl IndexRegistry {
    pub(crate) fn set_root(&self, root: PathBuf) {
        let _ = self.root.set(root);
    }

    pub(crate) fn open(&self, vault: &Path) -> Option<Arc<IndexStore>> {
        let root = self.root.get()?;
        let vault = shard_core::normalized_vault_key(vault);
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some((path, store)) = active.as_ref() {
            if path == &vault {
                if !store.invalid.load(Ordering::Acquire) {
                    return Some(Arc::clone(store));
                }
                let (_, retired) = active.take().unwrap();
                let database_path = retired.path.clone();
                drop(retired);
                discard_database(&database_path);
            }
        }
        let store = IndexStore::open(root, &vault).ok()?;
        let store = Arc::new(store);
        *active = Some((vault, Arc::clone(&store)));
        Some(store)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CachedDoc {
    pub(crate) search_kind: String,
    pub(crate) object_id: Option<String>,
    pub(crate) archived: bool,
    pub(crate) title: String,
    pub(crate) tags: Vec<String>,
    pub(crate) updated_at: Option<String>,
    pub(crate) revision: String,
    pub(crate) projection_version: u32,
    pub(crate) blocks: Vec<SearchProjectionBlock>,
}

#[derive(Debug, Clone)]
pub(crate) struct CachedFile {
    pub(crate) path: String,
    pub(crate) source_kind: String,
    pub(crate) mtime_ns: i128,
    pub(crate) size: u64,
    pub(crate) ino: u64,
    pub(crate) ctime_ns: i128,
    pub(crate) content_hash: String,
    pub(crate) indexed_at_ns: i128,
    pub(crate) parse_error: bool,
    pub(crate) doc: Option<CachedDoc>,
    pub(crate) asset_references: Vec<String>,
}

pub(crate) type IndexEntry = CachedFile;

pub(crate) struct IndexStore {
    vault: PathBuf,
    path: PathBuf,
    invalid: AtomicBool,
    conn: Mutex<Connection>,
}

impl IndexStore {
    fn open(root: &Path, vault: &Path) -> rusqlite::Result<Self> {
        let directory = root.join("search-index").join("v1");
        fs::create_dir_all(&directory).map_err(io_error)?;
        let digest = Sha256::digest(vault_bytes(vault));
        let name = digest[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path = directory.join(format!("{name}.sqlite3"));
        let vault_name = vault.to_string_lossy().into_owned();
        let mut conn = match connect(&path) {
            Ok(conn) => conn,
            Err(error) => {
                if is_corrupt(&error) {
                    discard_database(&path);
                }
                return Err(error);
            }
        };
        let result = initialize(&mut conn, &vault_name);
        match result {
            Ok(InitAction::Ready) => {}
            Ok(InitAction::Recreate) => {
                drop(conn);
                discard_database(&path);
                conn = connect(&path)?;
                create_schema(&mut conn, &vault_name)?;
            }
            Err(error) => {
                drop(conn);
                if is_corrupt(&error) {
                    discard_database(&path);
                }
                return Err(error);
            }
        }
        Ok(Self {
            vault: vault.to_path_buf(),
            path,
            invalid: AtomicBool::new(false),
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn discard_if_corrupt(&self, error: &Error) {
        if is_corrupt(error) {
            self.invalid.store(true, Ordering::Release);
            discard_database(&self.path);
        }
    }

    pub(crate) fn load_files(&self) -> rusqlite::Result<HashMap<String, CachedFile>> {
        let conn = self.conn.lock().unwrap_or_else(|error| error.into_inner());
        let mut statement = conn.prepare(
            "SELECT f.path, f.source_kind, f.mtime_ns, f.size, f.ino, f.ctime_ns, \
                    f.content_hash, f.indexed_at_ns, f.parse_error, \
                    d.search_kind, d.object_id, d.archived, d.title, d.tags_json, \
                    d.updated_at, d.revision, d.projection_version, d.blocks_json \
             FROM files f LEFT JOIN docs d ON d.path = f.path",
        )?;
        let rows = statement.query_map([], |row| {
            let doc = if let Some(search_kind) = row.get::<_, Option<String>>(9)? {
                let tags_json: String = row.get(13)?;
                let blocks_json: String = row.get(17)?;
                Some(CachedDoc {
                    search_kind,
                    object_id: row.get(10)?,
                    archived: row.get::<_, i64>(11)? != 0,
                    title: row.get(12)?,
                    tags: serde_json::from_str(&tags_json)
                        .map_err(|error| decode_error(13, error))?,
                    updated_at: row.get(14)?,
                    revision: row.get(15)?,
                    projection_version: row.get::<_, u32>(16)?,
                    blocks: serde_json::from_str(&blocks_json)
                        .map_err(|error| decode_error(17, error))?,
                })
            } else {
                None
            };
            Ok(CachedFile {
                path: row.get(0)?,
                source_kind: row.get(1)?,
                mtime_ns: i128::from(row.get::<_, i64>(2)?),
                size: row.get::<_, i64>(3)? as u64,
                ino: row.get::<_, i64>(4)? as u64,
                ctime_ns: i128::from(row.get::<_, i64>(5)?),
                content_hash: row.get(6)?,
                indexed_at_ns: i128::from(row.get::<_, i64>(7)?),
                parse_error: row.get::<_, i64>(8)? != 0,
                doc,
                asset_references: Vec::new(),
            })
        })?;
        let mut files = HashMap::new();
        for row in rows {
            let file = row?;
            files.insert(file.path.clone(), file);
        }
        Ok(files)
    }

    /// Persists file facts after checking that each public file still has the same stamp.
    /// `stale_paths` are entries absent from the current enumeration.
    pub(crate) fn apply(
        &self,
        batch: &crate::search_sources::PublicIndexBatch,
        stale_paths: &[String],
    ) -> rusqlite::Result<()> {
        self.apply_rows(batch.entries(), stale_paths)
    }

    pub(crate) fn asset_references(&self) -> rusqlite::Result<std::collections::HashSet<String>> {
        let conn = self.conn.lock().unwrap_or_else(|error| error.into_inner());
        let mut statement = conn.prepare(
            "SELECT l.src_path, l.target FROM links l JOIN files f ON f.path = l.src_path \
             WHERE l.kind = 'asset' AND l.src_path LIKE 'notes/%'",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut references = std::collections::HashSet::new();
        for row in rows {
            let (source, target) = row?;
            if crate::is_library_reference_source(Path::new(&source)) {
                references.insert(target);
            }
        }
        Ok(references)
    }

    fn apply_rows(&self, batch: &[IndexEntry], stale_paths: &[String]) -> rusqlite::Result<()> {
        if self.invalid.load(Ordering::Acquire) {
            return Err(Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
                None,
            ));
        }
        let mut conn = self.conn.lock().unwrap_or_else(|error| error.into_inner());
        for paths in stale_paths.chunks(BATCH_SIZE) {
            let tx = conn.transaction()?;
            for path in paths {
                tx.execute("DELETE FROM files WHERE path = ?1", [path])?;
            }
            tx.commit()?;
        }
        for entries in batch.chunks(BATCH_SIZE) {
            let tx = conn.transaction()?;
            for entry in entries {
                if !self.current_public_file_matches(entry) {
                    tx.execute("DELETE FROM files WHERE path = ?1", [&entry.path])?;
                    continue;
                }
                tx.execute(
                    "INSERT INTO files (path, source_kind, mtime_ns, size, ino, ctime_ns, \
                     content_hash, indexed_at_ns, parse_error) VALUES \
                     (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
                     ON CONFLICT(path) DO UPDATE SET source_kind=excluded.source_kind, \
                     mtime_ns=excluded.mtime_ns, size=excluded.size, ino=excluded.ino, \
                     ctime_ns=excluded.ctime_ns, content_hash=excluded.content_hash, \
                     indexed_at_ns=excluded.indexed_at_ns, parse_error=excluded.parse_error",
                    params![
                        entry.path,
                        entry.source_kind,
                        to_i64(entry.mtime_ns)?,
                        to_i64_u(entry.size)?,
                        to_i64_u(entry.ino)?,
                        to_i64(entry.ctime_ns)?,
                        entry.content_hash,
                        to_i64(entry.indexed_at_ns)?,
                        entry.parse_error,
                    ],
                )?;
                tx.execute("DELETE FROM docs WHERE path = ?1", [&entry.path])?;
                tx.execute("DELETE FROM links WHERE src_path = ?1", [&entry.path])?;
                for target in &entry.asset_references {
                    tx.execute(
                        "INSERT INTO links (src_path, kind, target) VALUES (?1, 'asset', ?2)",
                        params![entry.path, target],
                    )?;
                }
                if let Some(doc) = &entry.doc {
                    tx.execute(
                        "INSERT INTO docs (path, search_kind, object_id, archived, title, \
                         tags_json, updated_at, revision, projection_version, blocks_json) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                        params![
                            entry.path,
                            doc.search_kind,
                            doc.object_id,
                            doc.archived,
                            doc.title,
                            serde_json::to_string(&doc.tags).map_err(encode_error)?,
                            doc.updated_at,
                            doc.revision,
                            doc.projection_version,
                            serde_json::to_string(&doc.blocks).map_err(encode_error)?,
                        ],
                    )?;
                }
            }
            tx.commit()?;
        }
        Ok(())
    }

    /// Used immediately after a public object moves into the lockbox.
    pub(crate) fn forget(&self, paths: &[String]) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap_or_else(|error| error.into_inner());
        for batch in paths.chunks(BATCH_SIZE) {
            let tx = conn.transaction()?;
            for path in batch {
                tx.execute("DELETE FROM files WHERE path = ?1", [path])?;
            }
            tx.commit()?;
        }
        let busy: i64 = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
        if busy != 0 {
            return Err(Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                Some("WAL checkpoint could not truncate".to_owned()),
            ));
        }
        Ok(())
    }

    fn current_public_file_matches(&self, entry: &IndexEntry) -> bool {
        let Some(relative) = safe_public_path(&entry.path, &entry.source_kind) else {
            return false;
        };
        let path = self.vault.join(relative);
        // Reject symlinks in every path component, including an altered public root.
        let mut current = self.vault.clone();
        for component in relative.components() {
            current.push(component.as_os_str());
            let Ok(meta) = fs::symlink_metadata(&current) else {
                return false;
            };
            if meta.file_type().is_symlink() {
                return false;
            }
        }
        let Ok(meta) = fs::symlink_metadata(path) else {
            return false;
        };
        if !meta.is_file() {
            return false;
        }
        let (mtime_ns, ino, ctime_ns) = file_stamp(&meta);
        entry.mtime_ns == mtime_ns
            && entry.size == meta.len()
            && entry.ino == ino
            && entry.ctime_ns == ctime_ns
    }
}

enum InitAction {
    Ready,
    Recreate,
}

fn initialize(conn: &mut Connection, vault: &str) -> rusqlite::Result<InitAction> {
    let integrity: String = conn.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Ok(InitAction::Recreate);
    }
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version == 0 {
        let has_tables: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%')",
            [],
            |row| row.get(0),
        )?;
        if has_tables {
            return Ok(InitAction::Recreate);
        }
        create_schema(conn, vault)?;
        return Ok(InitAction::Ready);
    }
    if version != SCHEMA_VERSION {
        return Ok(InitAction::Recreate);
    }
    let table_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('meta', 'files', 'docs', 'links')",
        [],
        |row| row.get(0),
    )?;
    if table_count != 4 {
        return Ok(InitAction::Recreate);
    }
    let meta = |key: &str| -> rusqlite::Result<Option<String>> {
        conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()
    };
    if meta("index_format")? != Some(INDEX_FORMAT.to_owned())
        || meta("vault_path")? != Some(vault.to_owned())
    {
        return Ok(InitAction::Recreate);
    }
    if meta("app_version")? != Some(env!("CARGO_PKG_VERSION").to_owned()) {
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM files", [])?;
        tx.execute(
            "UPDATE meta SET value = ?1 WHERE key = 'app_version'",
            [env!("CARGO_PKG_VERSION")],
        )?;
        tx.commit()?;
    }
    Ok(InitAction::Ready)
}

fn create_schema(conn: &mut Connection, vault: &str) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
         CREATE TABLE files (
           path TEXT PRIMARY KEY, source_kind TEXT NOT NULL,
           mtime_ns INTEGER NOT NULL, size INTEGER NOT NULL, ino INTEGER NOT NULL,
           ctime_ns INTEGER NOT NULL, content_hash TEXT NOT NULL,
           indexed_at_ns INTEGER NOT NULL, parse_error INTEGER NOT NULL
         ) WITHOUT ROWID;
         CREATE TABLE docs (
           path TEXT NOT NULL UNIQUE REFERENCES files(path) ON DELETE CASCADE,
           search_kind TEXT NOT NULL, object_id TEXT, archived INTEGER NOT NULL,
           title TEXT NOT NULL, tags_json TEXT NOT NULL, updated_at TEXT,
           revision TEXT NOT NULL, projection_version INTEGER NOT NULL,
           blocks_json TEXT NOT NULL
         );
         CREATE INDEX docs_by_object ON docs(object_id);
         CREATE TABLE links (
           src_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
           kind TEXT NOT NULL, target TEXT NOT NULL,
           PRIMARY KEY (src_path, kind, target)
         ) WITHOUT ROWID;
         CREATE INDEX links_by_target ON links(target, kind);",
    )?;
    for (key, value) in [
        ("index_format", INDEX_FORMAT),
        ("vault_path", vault),
        ("app_version", env!("CARGO_PKG_VERSION")),
    ] {
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
    }
    tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
    tx.commit()
}

fn connect(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_millis(2_000))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA foreign_keys=ON;
         PRAGMA secure_delete=ON;
         PRAGMA temp_store=MEMORY;",
    )?;
    Ok(conn)
}

fn discard_database(path: &Path) {
    for candidate in [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ] {
        let _ = fs::remove_file(candidate);
    }
}

fn is_corrupt(error: &Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}

fn safe_public_path<'a>(path: &'a str, kind: &str) -> Option<&'a Path> {
    let relative = Path::new(path);
    let parts: Vec<_> = relative.components().collect();
    if parts
        .iter()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    let names: Vec<_> = parts
        .iter()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect();
    let allowed = match kind {
        "markdown" => {
            matches!(names.as_slice(), [root, ..] if root == "fragments" || root == "notes")
                || matches!(names.as_slice(), [trash, root, ..] if trash == ".trash" && (root == "fragments" || root == "notes"))
        }
        "mindMap" => matches!(names.as_slice(), [root, ..] if root == "notes" || root == "maps"),
        "canvas" | "table" => matches!(names.as_slice(), [root, ..] if root == "notes"),
        "csv" => !names.is_empty(),
        _ => false,
    };
    if !allowed
        || names.iter().enumerate().any(|(index, name)| {
            name.eq_ignore_ascii_case("lockbox")
                || (name.starts_with('.') && !(index == 0 && name == ".trash"))
        })
    {
        return None;
    }
    let lower = path.to_ascii_lowercase();
    let extension_valid = match kind {
        "markdown" => lower.ends_with(".md"),
        "mindMap" => lower.ends_with(".shardmap.json"),
        "canvas" => lower.ends_with(".shardcanvas.json") || lower.ends_with(".shardflow.json"),
        "table" => lower.ends_with(".shardtable.json"),
        "csv" => lower.ends_with(".csv"),
        _ => false,
    };
    extension_valid.then_some(relative)
}

fn file_stamp(meta: &fs::Metadata) -> (i128, u64, i128) {
    #[cfg(unix)]
    {
        (
            i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec()),
            meta.ino(),
            i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec()),
        )
    }
    #[cfg(not(unix))]
    {
        use std::time::UNIX_EPOCH;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_nanos() as i128)
            .unwrap_or_default();
        (mtime, 0, 0)
    }
}

fn vault_bytes(vault: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        vault.as_os_str().as_bytes().to_vec()
    }
    #[cfg(not(unix))]
    {
        vault.to_string_lossy().as_bytes().to_vec()
    }
}

fn to_i64(value: i128) -> rusqlite::Result<i64> {
    i64::try_from(value).map_err(|error| Error::ToSqlConversionFailure(Box::new(error)))
}

fn to_i64_u(value: u64) -> rusqlite::Result<i64> {
    i64::try_from(value).map_err(|error| Error::ToSqlConversionFailure(Box::new(error)))
}

fn io_error(error: std::io::Error) -> Error {
    Error::ToSqlConversionFailure(Box::new(error))
}

fn encode_error(error: serde_json::Error) -> Error {
    Error::ToSqlConversionFailure(Box::new(error))
}

fn decode_error(index: usize, error: serde_json::Error) -> Error {
    Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, Box::new(error))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, IndexEntry) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("cache");
        let vault = directory.path().join("vault");
        fs::create_dir_all(vault.join("notes")).unwrap();
        let file = vault.join("notes/doc.md");
        fs::write(&file, "public text").unwrap();
        let meta = fs::metadata(file).unwrap();
        let (mtime_ns, ino, ctime_ns) = file_stamp(&meta);
        let entry = IndexEntry {
            path: "notes/doc.md".to_owned(),
            source_kind: "markdown".to_owned(),
            mtime_ns,
            size: meta.len(),
            ino,
            ctime_ns,
            content_hash: "revision".to_owned(),
            indexed_at_ns: mtime_ns + 3_000_000_000,
            parse_error: false,
            doc: Some(CachedDoc {
                search_kind: "note".to_owned(),
                object_id: Some("test-id".to_owned()),
                archived: false,
                title: "Test".to_owned(),
                tags: vec!["tag".to_owned()],
                updated_at: None,
                revision: "revision".to_owned(),
                projection_version: 1,
                blocks: vec![SearchProjectionBlock::Text {
                    text: "public text".to_owned(),
                }],
            }),
            asset_references: Vec::new(),
        };
        (directory, root, vault, entry)
    }

    #[test]
    fn search_index_schema_mismatch_recreates_db() {
        let (_directory, root, vault, entry) = fixture();
        let store = IndexStore::open(&root, &vault).unwrap();
        store.apply_rows(&[entry], &[]).unwrap();
        assert_eq!(store.load_files().unwrap().len(), 1);
        let path = store.path().to_owned();
        drop(store);

        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 999).unwrap();
        drop(conn);

        let rebuilt = IndexStore::open(&root, &vault).unwrap();
        assert!(rebuilt.load_files().unwrap().is_empty());
        let version: i64 = rebuilt
            .conn
            .lock()
            .unwrap()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn search_index_format_or_app_version_change_clears_rows() {
        let (_directory, root, vault, entry) = fixture();
        let store = IndexStore::open(&root, &vault).unwrap();
        store.apply_rows(&[entry.clone()], &[]).unwrap();
        let path = store.path().to_owned();
        drop(store);

        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE meta SET value = 'old-format' WHERE key = 'index_format'",
            [],
        )
        .unwrap();
        drop(conn);
        let rebuilt = IndexStore::open(&root, &vault).unwrap();
        assert!(rebuilt.load_files().unwrap().is_empty());
        rebuilt.apply_rows(&[entry], &[]).unwrap();
        drop(rebuilt);

        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE meta SET value = 'old-app' WHERE key = 'app_version'",
            [],
        )
        .unwrap();
        drop(conn);
        let cleared = IndexStore::open(&root, &vault).unwrap();
        assert!(cleared.load_files().unwrap().is_empty());
        let version: String = cleared
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT value FROM meta WHERE key = 'app_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn search_index_vault_path_mismatch_recreates_db() {
        let (_directory, root, vault, entry) = fixture();
        let store = IndexStore::open(&root, &vault).unwrap();
        store.apply_rows(&[entry], &[]).unwrap();
        let path = store.path().to_owned();
        drop(store);

        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE meta SET value = 'other-vault' WHERE key = 'vault_path'",
            [],
        )
        .unwrap();
        drop(conn);

        let rebuilt = IndexStore::open(&root, &vault).unwrap();
        assert!(rebuilt.load_files().unwrap().is_empty());
        let stored_vault: String = rebuilt
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT value FROM meta WHERE key = 'vault_path'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_vault, vault.to_string_lossy());
    }

    #[test]
    fn search_index_stale_apply_after_forget_does_not_resurrect() {
        let (_directory, root, vault, entry) = fixture();
        let store = IndexStore::open(&root, &vault).unwrap();
        store.apply_rows(&[entry.clone()], &[]).unwrap();
        fs::remove_file(vault.join(&entry.path)).unwrap();
        store.forget(&[entry.path.clone()]).unwrap();
        store.apply_rows(&[entry], &[]).unwrap();
        assert!(store.load_files().unwrap().is_empty());
    }
}
