//! 债务追踪模块：记录双向债务（借入/借出）、分次还款、标签与到期提醒。
//!
//! 数据落盘在 `<vault>/debts/debts.sqlite3`（SQLite，通过 rusqlite 的 bundled
//! feature 静态编译，无需系统安装 libsqlite3）。"剩余未还金额"与"是否已结清"
//! 都是从 `repayments` 表实时聚合出的派生值，不落库、不缓存，避免出现本金/
//! 还款记录改动后忘记同步汇总字段的一致性问题。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use chrono::{Local, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use crate::{ensure_vault_dirs, run_blocking, unique_suffix};

/// 首次建库（`PRAGMA user_version = 0`）时执行的全部 DDL。执行完成后调用方
/// 负责把 `PRAGMA user_version` 设为 1。这里不包含连接级 PRAGMA（
/// foreign_keys / journal_mode / busy_timeout），那 3 条在 `open_debt_db`
/// 里对每个新打开的连接单独执行。
const SCHEMA_V1_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS debts (
    id                TEXT PRIMARY KEY,
    direction         TEXT NOT NULL CHECK (direction IN ('borrow_in', 'lend_out')),
    counterparty      TEXT NOT NULL CHECK (length(trim(counterparty)) > 0),
    counterparty_key  TEXT NOT NULL,
    principal_cents   INTEGER NOT NULL CHECK (principal_cents > 0),
    due_date          TEXT,
    note              TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    archived_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_debts_counterparty_key ON debts (counterparty_key);
CREATE INDEX IF NOT EXISTS idx_debts_due_date          ON debts (due_date) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_debts_direction         ON debts (direction);
CREATE INDEX IF NOT EXISTS idx_debts_archived_at       ON debts (archived_at);

CREATE TABLE IF NOT EXISTS repayments (
    id           TEXT PRIMARY KEY,
    debt_id      TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    paid_on      TEXT NOT NULL,
    note         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repayments_debt_id ON repayments (debt_id);
CREATE INDEX IF NOT EXISTS idx_repayments_paid_on ON repayments (paid_on);

CREATE TABLE IF NOT EXISTS debt_tags (
    debt_id TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL CHECK (length(trim(tag)) > 0),
    PRIMARY KEY (debt_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_debt_tags_tag ON debt_tags (tag);

CREATE VIEW IF NOT EXISTS debt_balances AS
SELECT
    d.id AS debt_id,
    d.principal_cents AS principal_cents,
    COALESCE(SUM(r.amount_cents), 0) AS paid_cents,
    d.principal_cents - COALESCE(SUM(r.amount_cents), 0) AS remaining_cents,
    CASE WHEN d.principal_cents - COALESCE(SUM(r.amount_cents), 0) <= 0 THEN 1 ELSE 0 END AS is_settled
FROM debts d
LEFT JOIN repayments r ON r.debt_id = d.id
GROUP BY d.id;
"#;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Repayment {
    id: String,
    debt_id: String,
    amount_cents: i64,
    paid_on: String,
    note: String,
    created_at: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Debt {
    id: String,
    /// `"borrow_in"` | `"lend_out"`，原始字符串直接透传给前端，不做二次映射
    /// （与仓库现有 `Fragment.git_status` 直接透传 snake_case 字符串值的先例一致）。
    direction: String,
    counterparty: String,
    principal_cents: i64,
    due_date: Option<String>,
    note: String,
    tags: Vec<String>,
    created_at: String,
    updated_at: String,
    archived: bool,
    paid_cents: i64,
    remaining_cents: i64,
    settled: bool,
    repayments: Vec<Repayment>,
}

// ---------------------------------------------------------------------------
// 连接管理
// ---------------------------------------------------------------------------

fn debts_dir(vault: &Path) -> PathBuf {
    vault.join("debts")
}

fn open_debt_db(vault: &Path) -> Result<Connection, String> {
    let dir = debts_dir(vault);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    ensure_debts_gitignore(&dir)?;

    let conn = Connection::open(dir.join("debts.sqlite3")).map_err(|error| error.to_string())?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 5000;",
    )
    .map_err(|error| error.to_string())?;
    migrate_schema(&conn)?;
    Ok(conn)
}

fn migrate_schema(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;

    if version < 1 {
        conn.execute_batch(SCHEMA_V1_SQL)
            .map_err(|error| error.to_string())?;
        conn.execute_batch("PRAGMA user_version = 1;")
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn ensure_debts_gitignore(dir: &Path) -> Result<(), String> {
    let path = dir.join(".gitignore");
    if !path.exists() {
        std::fs::write(
            &path,
            "*.sqlite3-journal\n*.sqlite3-wal\n*.sqlite3-shm\n",
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// id 生成：沿用 lib.rs 既有 unique_suffix() 约定，不引入 uuid crate
// ---------------------------------------------------------------------------

fn new_debt_id() -> String {
    format!(
        "debt-{}-{}",
        Local::now().format("%Y%m%d-%H%M%S"),
        unique_suffix()
    )
}

fn new_repayment_id() -> String {
    format!(
        "repay-{}-{}",
        Local::now().format("%Y%m%d-%H%M%S"),
        unique_suffix()
    )
}

// ---------------------------------------------------------------------------
// 校验辅助
// ---------------------------------------------------------------------------

fn validate_date(value: &str, field: &str) -> Result<(), String> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| format!("{field}格式不正确，应为 YYYY-MM-DD"))
}

fn validate_direction(value: &str) -> Result<(), String> {
    match value {
        "borrow_in" | "lend_out" => Ok(()),
        other => Err(format!("未知的债务方向：{other}")),
    }
}

/// 标签规范化：trim、过滤空值、按首次出现顺序去重；不做大小写折叠（中文标签
/// "亲戚"不该被小写化）。独立于 `lib.rs` 的 `normalize_tags`（后者会无条件注入
/// `"inbox"` 标签，是 Fragment 专属逻辑，语义不通用）。
fn normalize_debt_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    tags.into_iter()
        .filter_map(|tag| {
            let trimmed = tag.trim().to_string();
            if trimmed.is_empty() || !seen.insert(trimmed.clone()) {
                None
            } else {
                Some(trimmed)
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 查询辅助
// ---------------------------------------------------------------------------

const DEBT_SELECT_COLUMNS: &str = "d.id, d.direction, d.counterparty, d.principal_cents, \
    d.due_date, d.note, d.created_at, d.updated_at, d.archived_at, \
    b.paid_cents, b.remaining_cents, b.is_settled";

fn map_debt_row(row: &Row<'_>) -> rusqlite::Result<Debt> {
    let archived_at: Option<String> = row.get("archived_at")?;
    let is_settled: i64 = row.get("is_settled")?;

    Ok(Debt {
        id: row.get("id")?,
        direction: row.get("direction")?,
        counterparty: row.get("counterparty")?,
        principal_cents: row.get("principal_cents")?,
        due_date: row.get("due_date")?,
        note: row.get("note")?,
        tags: Vec::new(),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        archived: archived_at.is_some(),
        paid_cents: row.get("paid_cents")?,
        remaining_cents: row.get("remaining_cents")?,
        settled: is_settled != 0,
        repayments: Vec::new(),
    })
}

fn fetch_tags(conn: &Connection, debt_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT tag FROM debt_tags WHERE debt_id = ?1 ORDER BY tag")
        .map_err(|error| error.to_string())?;

    let rows = stmt
        .query_map(params![debt_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn fetch_repayments(conn: &Connection, debt_id: &str) -> Result<Vec<Repayment>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, debt_id, amount_cents, paid_on, note, created_at \
             FROM repayments WHERE debt_id = ?1 ORDER BY paid_on ASC, created_at ASC",
        )
        .map_err(|error| error.to_string())?;

    let rows = stmt
        .query_map(params![debt_id], |row| {
            Ok(Repayment {
                id: row.get(0)?,
                debt_id: row.get(1)?,
                amount_cents: row.get(2)?,
                paid_on: row.get(3)?,
                note: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

/// 查询单条完整 `Debt`（含 tags 与 repayments），供各写操作在提交后复用，
/// 保证所有 command 的返回值口径统一。
fn fetch_debt(conn: &Connection, id: &str) -> Result<Debt, String> {
    let sql = format!(
        "SELECT {DEBT_SELECT_COLUMNS} FROM debts d JOIN debt_balances b ON b.debt_id = d.id WHERE d.id = ?1"
    );
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;

    let row = stmt
        .query_row(params![id], map_debt_row)
        .optional()
        .map_err(|error| error.to_string())?;

    let mut debt = row.ok_or_else(|| "找不到该笔债务".to_string())?;
    debt.tags = fetch_tags(conn, id)?;
    debt.repayments = fetch_repayments(conn, id)?;
    Ok(debt)
}

/// 一次性列出全部债务（含各自的 tags/repayments）。个人记账场景下 debt 总数
/// 在几十到几百量级，这里对每条 debt 各发一次 tags 查询和一次 repayments 查询
/// （N+1）是有意选择：代码可读性和正确性优先于过早优化；真出现性能问题再改成
/// 批量查询后按 debt_id 分组。
fn list_all_debts(conn: &Connection) -> Result<Vec<Debt>, String> {
    let sql = format!(
        "SELECT {DEBT_SELECT_COLUMNS} FROM debts d JOIN debt_balances b ON b.debt_id = d.id ORDER BY d.created_at DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;

    let mut debts = stmt
        .query_map([], map_debt_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    for debt in debts.iter_mut() {
        debt.tags = fetch_tags(conn, &debt.id)?;
        debt.repayments = fetch_repayments(conn, &debt.id)?;
    }

    Ok(debts)
}

fn debt_exists(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.query_row("SELECT 1 FROM debts WHERE id = ?1", params![id], |row| {
        row.get::<_, i64>(0)
    })
    .optional()
    .map(|value| value.is_some())
    .map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// #[tauri::command]（7 个，均 Result<T, String>，均用 run_blocking 包裹同步 rusqlite 调用）
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn list_debts(app: tauri::AppHandle) -> Result<Vec<Debt>, String> {
    run_blocking(move || {
        let vault = ensure_vault_dirs(&app)?;
        let conn = open_debt_db(&vault)?;
        list_all_debts(&conn)
    })
    .await
}

#[tauri::command]
pub(crate) async fn create_debt(
    app: tauri::AppHandle,
    direction: String,
    counterparty: String,
    principal_cents: i64,
    due_date: Option<String>,
    note: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Debt, String> {
    run_blocking(move || {
        validate_direction(&direction)?;

        let counterparty = counterparty.trim().to_string();
        if counterparty.is_empty() {
            return Err("对方姓名不能为空".to_string());
        }
        if principal_cents <= 0 {
            return Err("本金必须大于 0".to_string());
        }
        if let Some(date) = &due_date {
            validate_date(date, "到期日")?;
        }

        let vault = ensure_vault_dirs(&app)?;
        let mut conn = open_debt_db(&vault)?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;

        let id = new_debt_id();
        let key = counterparty.to_lowercase();
        let now = Local::now().to_rfc3339();

        tx.execute(
            "INSERT INTO debts \
             (id, direction, counterparty, counterparty_key, principal_cents, due_date, note, created_at, updated_at, archived_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, NULL)",
            params![
                id,
                direction,
                counterparty,
                key,
                principal_cents,
                due_date,
                note.unwrap_or_default(),
                now
            ],
        )
        .map_err(|error| error.to_string())?;

        for tag in normalize_debt_tags(tags.unwrap_or_default()) {
            tx.execute(
                "INSERT INTO debt_tags (debt_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )
            .map_err(|error| error.to_string())?;
        }

        tx.commit().map_err(|error| error.to_string())?;
        fetch_debt(&conn, &id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn update_debt(
    app: tauri::AppHandle,
    id: String,
    counterparty: String,
    principal_cents: i64,
    due_date: Option<String>,
    note: Option<String>,
    tags: Option<Vec<String>>,
    // 注意：没有 direction 参数——方向创建后不可改，录错方向的唯一修正路径是
    // 删除重建（见技术合约 1 号裁定表第 4 行 / 第 3.2 节说明）。
) -> Result<Debt, String> {
    run_blocking(move || {
        let counterparty = counterparty.trim().to_string();
        if counterparty.is_empty() {
            return Err("对方姓名不能为空".to_string());
        }
        if principal_cents <= 0 {
            return Err("本金必须大于 0".to_string());
        }
        if let Some(date) = &due_date {
            validate_date(date, "到期日")?;
        }

        let vault = ensure_vault_dirs(&app)?;
        let mut conn = open_debt_db(&vault)?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;

        let key = counterparty.to_lowercase();
        let now = Local::now().to_rfc3339();

        let affected = tx
            .execute(
                "UPDATE debts SET counterparty = ?1, counterparty_key = ?2, principal_cents = ?3, \
                 due_date = ?4, note = ?5, updated_at = ?6 WHERE id = ?7",
                params![
                    counterparty,
                    key,
                    principal_cents,
                    due_date,
                    note.unwrap_or_default(),
                    now,
                    id
                ],
            )
            .map_err(|error| error.to_string())?;

        if affected == 0 {
            return Err("找不到该笔债务".to_string());
        }

        tx.execute("DELETE FROM debt_tags WHERE debt_id = ?1", params![id])
            .map_err(|error| error.to_string())?;

        for tag in normalize_debt_tags(tags.unwrap_or_default()) {
            tx.execute(
                "INSERT INTO debt_tags (debt_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )
            .map_err(|error| error.to_string())?;
        }

        tx.commit().map_err(|error| error.to_string())?;
        fetch_debt(&conn, &id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_debt_archived(
    app: tauri::AppHandle,
    id: String,
    archived: bool,
) -> Result<Debt, String> {
    run_blocking(move || {
        let vault = ensure_vault_dirs(&app)?;
        let conn = open_debt_db(&vault)?;

        let now = Local::now().to_rfc3339();
        let archived_at: Option<String> = if archived { Some(now.clone()) } else { None };

        let affected = conn
            .execute(
                "UPDATE debts SET archived_at = ?1, updated_at = ?2 WHERE id = ?3",
                params![archived_at, now, id],
            )
            .map_err(|error| error.to_string())?;

        if affected == 0 {
            return Err("找不到该笔债务".to_string());
        }

        fetch_debt(&conn, &id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn delete_debt(app: tauri::AppHandle, id: String) -> Result<Vec<Debt>, String> {
    run_blocking(move || {
        let vault = ensure_vault_dirs(&app)?;
        let conn = open_debt_db(&vault)?;

        // 级联删除（repayments / debt_tags）在 SQLite 里由外键约束原子完成，
        // 依赖连接已 PRAGMA foreign_keys = ON（open_debt_db 里已设置），不需要
        // 额外手动包一层事务。
        let affected = conn
            .execute("DELETE FROM debts WHERE id = ?1", params![id])
            .map_err(|error| error.to_string())?;

        if affected == 0 {
            return Err("找不到该笔债务".to_string());
        }

        list_all_debts(&conn)
    })
    .await
}

#[tauri::command]
pub(crate) async fn add_repayment(
    app: tauri::AppHandle,
    debt_id: String,
    amount_cents: i64,
    paid_on: String,
    note: Option<String>,
) -> Result<Debt, String> {
    run_blocking(move || {
        if amount_cents <= 0 {
            return Err("还款金额必须大于 0".to_string());
        }
        validate_date(&paid_on, "还款日期")?;

        let vault = ensure_vault_dirs(&app)?;
        let mut conn = open_debt_db(&vault)?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;

        if !debt_exists(&tx, &debt_id)? {
            return Err("找不到该笔债务".to_string());
        }

        let repayment_id = new_repayment_id();
        let now = Local::now().to_rfc3339();

        // 不校验"是否超过剩余本金"——允许超额还款（多还、历史数据回填顺序颠倒、
        // 本金录错后更正等场景均合理），remaining_cents 允许为负。
        tx.execute(
            "INSERT INTO repayments (id, debt_id, amount_cents, paid_on, note, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                repayment_id,
                debt_id,
                amount_cents,
                paid_on,
                note.unwrap_or_default(),
                now
            ],
        )
        .map_err(|error| error.to_string())?;

        tx.execute(
            "UPDATE debts SET updated_at = ?1 WHERE id = ?2",
            params![now, debt_id],
        )
        .map_err(|error| error.to_string())?;

        tx.commit().map_err(|error| error.to_string())?;
        fetch_debt(&conn, &debt_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn delete_repayment(
    app: tauri::AppHandle,
    debt_id: String,
    repayment_id: String,
) -> Result<Debt, String> {
    run_blocking(move || {
        let vault = ensure_vault_dirs(&app)?;
        let mut conn = open_debt_db(&vault)?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;

        let affected = tx
            .execute(
                "DELETE FROM repayments WHERE id = ?1 AND debt_id = ?2",
                params![repayment_id, debt_id],
            )
            .map_err(|error| error.to_string())?;

        if affected == 0 {
            return Err("找不到该笔还款记录".to_string());
        }

        let now = Local::now().to_rfc3339();
        tx.execute(
            "UPDATE debts SET updated_at = ?1 WHERE id = ?2",
            params![now, debt_id],
        )
        .map_err(|error| error.to_string())?;

        tx.commit().map_err(|error| error.to_string())?;
        fetch_debt(&conn, &debt_id)
    })
    .await
}

// ---------------------------------------------------------------------------
// 单元测试：覆盖建表、CRUD、级联删除、debt_balances 视图计算
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_db() -> (tempfile::TempDir, Connection) {
        let tempdir = tempfile::tempdir().unwrap();
        let conn = open_debt_db(tempdir.path()).unwrap();
        (tempdir, conn)
    }

    #[test]
    fn creates_schema_and_sets_user_version() {
        let (_tempdir, conn) = open_test_db();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, 1);

        let table_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'debts'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 1);
    }

    #[test]
    fn writes_debts_gitignore_next_to_database() {
        let tempdir = tempfile::tempdir().unwrap();
        open_debt_db(tempdir.path()).unwrap();
        let gitignore = tempdir.path().join("debts").join(".gitignore");
        assert!(gitignore.exists());
        let contents = std::fs::read_to_string(gitignore).unwrap();
        assert!(contents.contains("*.sqlite3-wal"));
    }

    #[test]
    fn create_and_fetch_round_trips_tags_and_balances() {
        let (_tempdir, mut conn) = open_test_db();
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO debts (id, direction, counterparty, counterparty_key, principal_cents, due_date, note, created_at, updated_at, archived_at) \
             VALUES ('debt-1', 'lend_out', 'Alice', 'alice', 10000, '2026-08-01', '', '2026-07-01T00:00:00+08:00', '2026-07-01T00:00:00+08:00', NULL)",
            [],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO debt_tags (debt_id, tag) VALUES ('debt-1', '朋友')",
            [],
        )
        .unwrap();
        tx.commit().unwrap();

        let debt = fetch_debt(&conn, "debt-1").unwrap();
        assert_eq!(debt.counterparty, "Alice");
        assert_eq!(debt.tags, vec!["朋友".to_string()]);
        assert_eq!(debt.paid_cents, 0);
        assert_eq!(debt.remaining_cents, 10000);
        assert!(!debt.settled);
        assert!(!debt.archived);
    }

    #[test]
    fn repayments_reduce_remaining_and_settle_when_fully_paid() {
        let (_tempdir, conn) = open_test_db();
        conn.execute(
            "INSERT INTO debts (id, direction, counterparty, counterparty_key, principal_cents, due_date, note, created_at, updated_at, archived_at) \
             VALUES ('debt-2', 'borrow_in', 'Bob', 'bob', 5000, NULL, '', '2026-07-01T00:00:00+08:00', '2026-07-01T00:00:00+08:00', NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO repayments (id, debt_id, amount_cents, paid_on, note, created_at) \
             VALUES ('repay-1', 'debt-2', 3000, '2026-07-05', '', '2026-07-05T00:00:00+08:00')",
            [],
        )
        .unwrap();

        let debt = fetch_debt(&conn, "debt-2").unwrap();
        assert_eq!(debt.paid_cents, 3000);
        assert_eq!(debt.remaining_cents, 2000);
        assert!(!debt.settled);

        conn.execute(
            "INSERT INTO repayments (id, debt_id, amount_cents, paid_on, note, created_at) \
             VALUES ('repay-2', 'debt-2', 3000, '2026-07-10', '', '2026-07-10T00:00:00+08:00')",
            [],
        )
        .unwrap();

        // 超额还款：3000 + 3000 = 6000 > 5000 本金，remaining 应为负数且视为已结清。
        let debt = fetch_debt(&conn, "debt-2").unwrap();
        assert_eq!(debt.paid_cents, 6000);
        assert_eq!(debt.remaining_cents, -1000);
        assert!(debt.settled);
    }

    #[test]
    fn deleting_debt_cascades_to_repayments_and_tags() {
        let (_tempdir, conn) = open_test_db();
        conn.execute(
            "INSERT INTO debts (id, direction, counterparty, counterparty_key, principal_cents, due_date, note, created_at, updated_at, archived_at) \
             VALUES ('debt-3', 'lend_out', 'Carol', 'carol', 1000, NULL, '', '2026-07-01T00:00:00+08:00', '2026-07-01T00:00:00+08:00', NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO repayments (id, debt_id, amount_cents, paid_on, note, created_at) \
             VALUES ('repay-3', 'debt-3', 500, '2026-07-05', '', '2026-07-05T00:00:00+08:00')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO debt_tags (debt_id, tag) VALUES ('debt-3', '亲戚')",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM debts WHERE id = 'debt-3'", [])
            .unwrap();

        let repayment_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM repayments WHERE debt_id = 'debt-3'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let tag_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM debt_tags WHERE debt_id = 'debt-3'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(repayment_count, 0);
        assert_eq!(tag_count, 0);
    }

    #[test]
    fn normalize_debt_tags_trims_dedupes_and_preserves_order() {
        let tags = normalize_debt_tags(vec![
            "  朋友 ".to_string(),
            "".to_string(),
            "朋友".to_string(),
            "信用卡".to_string(),
        ]);
        assert_eq!(tags, vec!["朋友".to_string(), "信用卡".to_string()]);
    }

    #[test]
    fn validate_date_rejects_malformed_strings() {
        assert!(validate_date("2026-07-24", "到期日").is_ok());
        assert!(validate_date("2026/07/24", "到期日").is_err());
        assert!(validate_date("not-a-date", "到期日").is_err());
    }

    #[test]
    fn validate_direction_only_accepts_known_values() {
        assert!(validate_direction("borrow_in").is_ok());
        assert!(validate_direction("lend_out").is_ok());
        assert!(validate_direction("owe").is_err());
    }

    #[test]
    fn list_all_debts_orders_by_created_at_desc_and_embeds_repayments() {
        let (_tempdir, conn) = open_test_db();
        conn.execute(
            "INSERT INTO debts (id, direction, counterparty, counterparty_key, principal_cents, due_date, note, created_at, updated_at, archived_at) \
             VALUES ('debt-old', 'lend_out', 'Dan', 'dan', 100, NULL, '', '2026-01-01T00:00:00+08:00', '2026-01-01T00:00:00+08:00', NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO debts (id, direction, counterparty, counterparty_key, principal_cents, due_date, note, created_at, updated_at, archived_at) \
             VALUES ('debt-new', 'borrow_in', 'Eve', 'eve', 200, NULL, '', '2026-06-01T00:00:00+08:00', '2026-06-01T00:00:00+08:00', NULL)",
            [],
        )
        .unwrap();

        let debts = list_all_debts(&conn).unwrap();
        assert_eq!(debts.len(), 2);
        assert_eq!(debts[0].id, "debt-new");
        assert_eq!(debts[1].id, "debt-old");
        assert!(debts[0].repayments.is_empty());
    }
}
