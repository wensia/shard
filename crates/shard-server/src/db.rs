//! 服务端的库连接与迁移。
//!
//! 与客户端跑**同一套** DDL（`shard_core::NOTES_MIGRATIONS`）。服务端只是多用
//! 了其中的 `sync_seq`，少用了 outbox —— 表结构本身一个字都不差。

use libsql::{Connection, Database};

use crate::config::Config;

pub struct Store {
    database: Database,
}

impl Store {
    pub async fn open(config: &Config) -> Result<Self, String> {
        std::fs::create_dir_all(&config.data_dir)
            .map_err(|error| format!("创建数据目录失败：{error}"))?;
        std::fs::create_dir_all(config.attachments_dir())
            .map_err(|error| format!("创建附件目录失败：{error}"))?;

        let database = libsql::Builder::new_local(config.database_path())
            .build()
            .await
            .map_err(|error| format!("打开数据库失败：{error}"))?;

        let store = Self { database };
        let conn = store.conn().await?;
        apply_pragmas(&conn).await?;
        migrate(&conn).await?;
        Ok(store)
    }

    pub async fn conn(&self) -> Result<Connection, String> {
        self.database
            .connect()
            .map_err(|error| format!("获取连接失败：{error}"))
    }
}

/// WAL + NORMAL：读写并发不互相阻塞，掉电最多丢掉最后一个未落盘的事务，
/// 而不是损坏整个库。`foreign_keys` 必须显式开——SQLite 默认是关的，
/// 关着的话 `fragment_attachments` 的引用完整性形同虚设。
async fn apply_pragmas(conn: &Connection) -> Result<(), String> {
    for pragma in [
        "PRAGMA journal_mode = WAL;",
        "PRAGMA synchronous = NORMAL;",
        "PRAGMA foreign_keys = ON;",
        "PRAGMA busy_timeout = 5000;",
    ] {
        conn.execute_batch(pragma)
            .await
            .map_err(|error| format!("设置 {pragma} 失败：{error}"))?;
    }
    Ok(())
}

async fn migrate(conn: &Connection) -> Result<(), String> {
    let current = user_version(conn).await?;

    for migration in shard_core::NOTES_MIGRATIONS
        .iter()
        .filter(|m| m.version > current)
    {
        conn.execute_batch(migration.sql)
            .await
            .map_err(|error| format!("迁移到 v{} 失败：{error}", migration.version))?;
        conn.execute_batch(&format!("PRAGMA user_version = {};", migration.version))
            .await
            .map_err(|error| format!("写入 user_version 失败：{error}"))?;
    }

    Ok(())
}

pub async fn user_version(conn: &Connection) -> Result<i64, String> {
    let mut rows = conn
        .query("PRAGMA user_version", ())
        .await
        .map_err(|error| error.to_string())?;
    rows.next()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "无法读取 user_version".to_string())?
        .get(0)
        .map_err(|error| error.to_string())
}

/// 取下一个全局序号。
///
/// **必须在调用方的事务里执行**，与那一行的写入同生共死。如果分配成功而写入
/// 回滚了，这个号就成了空洞；反过来如果写入成功而分配没跟上，两行会共用一个
/// seq，增量拉取时后一行会被永久跳过。
pub async fn next_seq(conn: &Connection) -> Result<i64, String> {
    conn.execute("UPDATE sync_seq SET value = value + 1 WHERE id = 1", ())
        .await
        .map_err(|error| format!("分配序号失败：{error}"))?;

    let mut rows = conn
        .query("SELECT value FROM sync_seq WHERE id = 1", ())
        .await
        .map_err(|error| error.to_string())?;
    rows.next()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "序号表为空".to_string())?
        .get(0)
        .map_err(|error| error.to_string())
}

/// 当前最大序号。客户端拉取到这里就算追平了。
pub async fn current_seq(conn: &Connection) -> Result<i64, String> {
    let mut rows = conn
        .query("SELECT value FROM sync_seq WHERE id = 1", ())
        .await
        .map_err(|error| error.to_string())?;
    rows.next()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "序号表为空".to_string())?
        .get(0)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
pub(crate) async fn open_memory() -> Connection {
    let database = libsql::Builder::new_local(":memory:").build().await.unwrap();
    let conn = database.connect().unwrap();
    apply_pragmas(&conn).await.unwrap();
    migrate(&conn).await.unwrap();
    conn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrations_land_on_the_latest_version() {
        let conn = open_memory().await;
        let latest = shard_core::NOTES_MIGRATIONS
            .iter()
            .map(|m| m.version)
            .max()
            .unwrap();
        assert_eq!(user_version(&conn).await.unwrap(), latest);
    }

    /// 服务端要用到的表都在共享 DDL 里建好了。
    #[tokio::test]
    async fn server_side_tables_exist() {
        let conn = open_memory().await;
        for table in ["fragments", "shard_maps", "attachments", "sync_seq"] {
            let mut rows = conn
                .query(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    libsql::params![table],
                )
                .await
                .unwrap();
            let found: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
            assert_eq!(found, 1, "缺少表 {table}");
        }
    }

    #[tokio::test]
    async fn seq_allocation_is_monotonic() {
        let conn = open_memory().await;
        assert_eq!(current_seq(&conn).await.unwrap(), 0);

        let mut previous = 0;
        for _ in 0..5 {
            let seq = next_seq(&conn).await.unwrap();
            assert!(seq > previous, "序号必须严格递增：{seq} <= {previous}");
            previous = seq;
        }
        assert_eq!(current_seq(&conn).await.unwrap(), previous);
    }

    /// 分配发生在事务里、事务回滚了，这个号不该留下痕迹。
    #[tokio::test]
    async fn seq_allocation_rolls_back_with_its_transaction() {
        let conn = open_memory().await;
        next_seq(&conn).await.unwrap();

        let tx = conn.transaction().await.unwrap();
        next_seq(&tx).await.unwrap();
        tx.rollback().await.unwrap();

        assert_eq!(
            current_seq(&conn).await.unwrap(),
            1,
            "回滚的事务不该消耗序号"
        );
    }
}
