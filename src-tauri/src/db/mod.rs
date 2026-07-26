//! 记账库与笔记库共用的 libSQL 连接管理。
//!
//! 由 `debt.rs` 里已经跑通并验证过的那套逻辑泛型化而来（原 `DebtDb` /
//! `build_database` / `connect_with_pragmas` / `migrate_schema` / `open_conn`）。
//! 每个库通过实现 [`DbSpec`] 声明自己的目录、文件名、迁移与远端凭据来源，
//! 其余全部共用。
//!
//! # 为什么必须缓存 `Database` 句柄
//!
//! `Builder` 构建 embedded replica 时会做一次远程握手与初始同步，成本很高。
//! 更要命的是 libSQL 某些模式下 `Database::connect()` 内部含
//! `block_in_place` + 一次网络往返（见 `libsql-0.9.30/src/database.rs`），
//! 放在命令热路径上会阻塞 UI 线程，违反 AGENTS.md 的 Runtime Rules。
//! 所以 `Database` 按缓存键懒建一次并复用，`Connection` 本身很轻，每次现连。
//!
//! # 连接级 PRAGMA 的禁区
//!
//! [`connect_with_pragmas`] 只设 `foreign_keys` 与 `busy_timeout`。
//! **不要**在这里设置 `journal_mode` 或 `synchronous`：embedded replica 与
//! 后续可能启用的同步模式都依赖 WAL，改动会破坏复制。

pub(crate) mod migrate;

use std::marker::PhantomData;
use std::path::Path;
use std::sync::Arc;

use libsql::{Connection, Database};
use tauri::async_runtime::Mutex;

use crate::{ensure_vault_dirs, read_app_config, AppConfig};
use migrate::Migration;

/// 一个逻辑数据库的静态描述。
pub(crate) trait DbSpec: Send + Sync + 'static {
    /// vault 下存放该库的子目录名。
    const SUBDIR: &'static str;
    /// 数据库主文件名。
    const FILE_NAME: &'static str;

    /// 主库文件本身是否也要写进 `.gitignore`。
    ///
    /// 笔记库是可以从 Markdown 或服务端完全重建的**本地缓存**，且是会频繁变动
    /// 的大二进制文件——进版本库只会让仓库迅速膨胀，必须忽略。
    /// 记账库目前仍是它自己的唯一真相源，保持被跟踪（沿用既有行为）。
    const IGNORE_MAIN_DB: bool;

    /// 该库的全部迁移，按 `version` 升序。
    fn migrations() -> &'static [Migration];

    /// 从应用配置里取远端凭据。**两项都非空**时才返回 `Some`，
    /// 否则退化为纯本地库（离线可用、不做云同步）。
    fn remote(cfg: &AppConfig) -> Option<(String, String)>;
}

/// 跨命令共享的库句柄缓存，注册进 `tauri::Builder::manage`。
pub(crate) struct DbHandle<S: DbSpec> {
    cache: Mutex<Option<CachedDb>>,
    // 用 `fn() -> S` 而非 `S`：让 DbHandle 无条件 Send + Sync（tauri State 要求），
    // 且不引入对 S 的型变约束。
    _spec: PhantomData<fn() -> S>,
}

impl<S: DbSpec> Default for DbHandle<S> {
    fn default() -> Self {
        Self {
            cache: Mutex::new(None),
            _spec: PhantomData,
        }
    }
}

struct CachedDb {
    /// 缓存键 `"<vault_path>|<remote_url>"`。换 vault 或改远端地址时键不同，
    /// 触发重建。
    key: String,
    db: Arc<Database>,
    /// 是否为 embedded replica（配了远端），决定读取前是否值得 `sync()`。
    remote: bool,
}

impl<S: DbSpec> DbHandle<S> {
    /// 取一个已就绪（含 PRAGMA 与 schema）的连接。
    ///
    /// `sync_first` 为 true 且当前是 embedded replica 时，先尽力 `sync()` 拉取
    /// 远端改动。**同步失败仅忽略，不阻断本地读取**——离线可用优先于数据最新。
    pub(crate) async fn conn(
        &self,
        app: &tauri::AppHandle,
        sync_first: bool,
    ) -> Result<Connection, String> {
        let (db, remote) = self.database(app).await?;
        if sync_first && remote {
            let _ = db.sync().await;
        }
        connect_with_pragmas(&db).await
    }

    /// 丢弃缓存的句柄，下次访问按最新配置重建。配置变更后必须调用。
    pub(crate) async fn invalidate(&self) {
        *self.cache.lock().await = None;
    }

    async fn database(&self, app: &tauri::AppHandle) -> Result<(Arc<Database>, bool), String> {
        let vault = ensure_vault_dirs(app)?;
        let cfg = read_app_config(app)?;
        let key = cache_key::<S>(&vault, &cfg);

        let mut guard = self.cache.lock().await;
        if let Some(cached) = guard.as_ref() {
            if cached.key == key {
                return Ok((cached.db.clone(), cached.remote));
            }
        }

        let (db, remote) = build_database::<S>(&vault, &cfg).await?;
        let db = Arc::new(db);
        // 只在首建时迁移；后续命中缓存不再重复。
        let conn = connect_with_pragmas(&db).await?;
        migrate::apply(&conn, S::migrations()).await?;
        *guard = Some(CachedDb {
            key,
            db: db.clone(),
            remote,
        });
        Ok((db, remote))
    }
}

/// 缓存键取实际生效的远端地址：没有 token 时 url 不影响连接方式，
/// 也就不该参与缓存判定。
fn cache_key<S: DbSpec>(vault: &Path, cfg: &AppConfig) -> String {
    let url = S::remote(cfg).map(|(url, _)| url).unwrap_or_default();
    format!("{}|{}", vault.display(), url)
}

async fn build_database<S: DbSpec>(
    vault: &Path,
    cfg: &AppConfig,
) -> Result<(Database, bool), String> {
    let dir = vault.join(S::SUBDIR);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    ensure_db_gitignore(&dir, S::FILE_NAME, S::IGNORE_MAIN_DB)?;
    let path = dir.join(S::FILE_NAME);

    match S::remote(cfg) {
        Some((url, token)) => {
            let db = libsql::Builder::new_remote_replica(path, url, token)
                .build()
                .await
                .map_err(|error| format!("连接 Turso 云端失败：{error}"))?;
            Ok((db, true))
        }
        None => {
            let db = libsql::Builder::new_local(path)
                .build()
                .await
                .map_err(|error| error.to_string())?;
            Ok((db, false))
        }
    }
}

/// 每个新连接都要设的连接级 PRAGMA。
///
/// `foreign_keys` 在 SQLite 里是连接作用域，级联删除依赖它必须逐连接开启。
/// 见模块文档中的「PRAGMA 禁区」。
pub(crate) async fn connect_with_pragmas(db: &Database) -> Result<Connection, String> {
    let conn = db.connect().map_err(|error| error.to_string())?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
        .await
        .map_err(|error| error.to_string())?;
    Ok(conn)
}

/// libSQL 副本除主库外还会生成 -wal/-shm 及内部元数据文件，这些一律不进 Git。
///
/// `ignore_main` 为 true 时连主库文件一起忽略——见 [`DbSpec::IGNORE_MAIN_DB`]。
///
/// 采用「缺什么补什么」而非整文件覆写：用户可能手工加过自己的规则，不该被抹掉；
/// 同时既有 vault 里那份只有 -wal/-shm 的旧文件也能自动补上新增规则。
fn ensure_db_gitignore(dir: &Path, main_file: &str, ignore_main: bool) -> Result<(), String> {
    let path = dir.join(".gitignore");
    let mut wanted: Vec<String> = vec![
        "*.sqlite3-journal".into(),
        "*.sqlite3-wal".into(),
        "*.sqlite3-shm".into(),
        "*.sqlite3-client_wal_index".into(),
    ];
    if ignore_main {
        wanted.push(main_file.to_string());
    }

    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let missing: Vec<&String> = wanted
        .iter()
        .filter(|rule| !existing.lines().any(|line| line.trim() == rule.as_str()))
        .collect();

    if missing.is_empty() {
        return Ok(());
    }

    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    for rule in missing {
        content.push_str(rule);
        content.push('\n');
    }
    std::fs::write(&path, content).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_rules(dir: &Path) -> Vec<String> {
        std::fs::read_to_string(dir.join(".gitignore"))
            .unwrap()
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    }

    /// 笔记库是可重建的本地缓存，主库文件必须被忽略，否则每次保存都会在
    /// 仓库里塞进一个变动的大二进制文件。
    #[test]
    fn ignores_main_db_when_requested() {
        let dir = tempfile::tempdir().unwrap();
        ensure_db_gitignore(dir.path(), "notes.sqlite3", true).unwrap();
        assert!(read_rules(dir.path()).contains(&"notes.sqlite3".to_string()));
    }

    /// 记账库仍是自己的真相源，保持被跟踪。
    #[test]
    fn keeps_main_db_tracked_by_default() {
        let dir = tempfile::tempdir().unwrap();
        ensure_db_gitignore(dir.path(), "debts.sqlite3", false).unwrap();
        let rules = read_rules(dir.path());
        assert!(!rules.contains(&"debts.sqlite3".to_string()));
        assert!(rules.contains(&"*.sqlite3-wal".to_string()));
    }

    /// 既有 vault 里那份只有 -wal/-shm 的旧 .gitignore 要能自动补上新规则，
    /// 且用户自己加的规则不能被抹掉。
    #[test]
    fn appends_missing_rules_without_clobbering_user_edits() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".gitignore"),
            "*.sqlite3-wal\n# 我自己加的\nscratch/\n",
        )
        .unwrap();

        ensure_db_gitignore(dir.path(), "notes.sqlite3", true).unwrap();

        let rules = read_rules(dir.path());
        assert!(rules.contains(&"scratch/".to_string()), "用户规则必须保留");
        assert!(rules.contains(&"# 我自己加的".to_string()));
        assert!(rules.contains(&"notes.sqlite3".to_string()), "缺的规则要补上");
        assert_eq!(
            rules.iter().filter(|r| *r == "*.sqlite3-wal").count(),
            1,
            "已存在的规则不该重复追加"
        );
    }

    /// 重复调用必须幂等，不能每次启动都往文件里追加一遍。
    #[test]
    fn is_idempotent_across_runs() {
        let dir = tempfile::tempdir().unwrap();
        ensure_db_gitignore(dir.path(), "notes.sqlite3", true).unwrap();
        let first = read_rules(dir.path());
        ensure_db_gitignore(dir.path(), "notes.sqlite3", true).unwrap();
        assert_eq!(first, read_rules(dir.path()));
    }
}
