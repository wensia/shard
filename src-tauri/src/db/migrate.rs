//! 基于 `PRAGMA user_version` 的顺序迁移。
//!
//! 每个库（记账、笔记）各自给出一组 [`Migration`]，[`apply`] 负责把当前版本
//! 推进到最新。迁移只增不改：已发布的 `Migration` 的 `sql` 不允许再修改，
//! 否则老库和新库会分叉——要改就追加新版本。

use libsql::Connection;

/// 单个版本的 DDL。`version` 从 1 开始，同一组内必须严格递增。
pub(crate) struct Migration {
    pub version: i64,
    pub sql: &'static str,
}

/// 读当前 `user_version`，按序执行所有更高版本的迁移。
///
/// 已是最新版时不做任何事，因此可以在每次开库时无条件调用。
pub(crate) async fn apply(conn: &Connection, migrations: &[Migration]) -> Result<(), String> {
    let current = user_version(conn).await?;

    for migration in migrations.iter().filter(|m| m.version > current) {
        conn.execute_batch(migration.sql)
            .await
            .map_err(|error| format!("迁移到 v{} 失败：{error}", migration.version))?;
        // PRAGMA 不接受绑定参数，只能字面量拼接。version 是编译期常量，
        // 不来自用户输入，无注入面。
        conn.execute_batch(&format!("PRAGMA user_version = {};", migration.version))
            .await
            .map_err(|error| format!("写入 user_version={} 失败：{error}", migration.version))?;
    }

    Ok(())
}

pub(crate) async fn user_version(conn: &Connection) -> Result<i64, String> {
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
