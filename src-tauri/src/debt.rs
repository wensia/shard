//! 债务追踪（记账）模块：记录双向债务（借入/借出）、分次还款、标签与到期提醒。
//!
//! 存储后端为 **libSQL（Turso）**。数据仍落在 `<vault>/debts/debts.sqlite3`：
//! - 若 `AppConfig` 配置了 `turso_url` + `turso_auth_token`，用 embedded replica
//!   打开（本地文件是可离线读取的副本，写入转发到远程 primary，并可 `sync()`
//!   拉取其它设备的改动）；
//! - 否则退化为纯本地 libSQL 文件（`new_local`），离线可用、不做云同步。
//!
//! "剩余未还金额"与"是否已结清"都是从 `repayments` 表实时聚合出的派生值
//! （`debt_balances` 视图），不落库、不缓存，避免本金/还款记录改动后忘记同步
//! 汇总字段的一致性问题。
//!
//! libSQL 是 SQLite 的完整 fork，原 rusqlite 版依赖的外键级联删除、CHECK 约束、
//! `CREATE VIEW`、`PRAGMA user_version` 迁移全部沿用，schema 未做任何裁剪。

use std::collections::HashSet;

use chrono::{DateTime, Local, NaiveDate, TimeZone};
use libsql::{params, Connection, Row};
use serde::Serialize;

use crate::db::{migrate::Migration, DbHandle, DbSpec};
use crate::{read_app_config, unique_suffix, AppConfig};

/// 首次建库（`PRAGMA user_version = 0`）时执行的全部 DDL。执行完成后调用方
/// 负责把 `PRAGMA user_version` 设为 1。这里不包含连接级 PRAGMA（
/// foreign_keys / busy_timeout），那些在每个新打开的连接上单独执行。
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
    /// `"borrow_in"` | `"lend_out"`，原始字符串直接透传给前端，不做二次映射。
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

/// 暴露给前端的 Turso 配置视图。**不回传 token 明文**，只回传是否已配置，
/// 避免密钥经 IPC 泄漏到前端日志/DevTools。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TursoConfigView {
    url: Option<String>,
    has_token: bool,
}

// ---------------------------------------------------------------------------
// 库定义。连接缓存、迁移推进与连接级 PRAGMA 全部由 crate::db 泛型实现并与
// 笔记库共用，这里只声明记账库自己的目录、文件名、迁移和远端凭据来源。
// ---------------------------------------------------------------------------

/// 记账库的静态描述。连接缓存、迁移与 PRAGMA 都由 [`crate::db`] 泛型实现，
/// 这里只声明本库独有的部分。
pub(crate) struct DebtSpec;

static DEBT_MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    sql: SCHEMA_V1_SQL,
}];

impl DbSpec for DebtSpec {
    const SUBDIR: &'static str = "debts";
    const FILE_NAME: &'static str = "debts.sqlite3";
    // 记账库目前仍是自己的唯一真相源，保持被 Git 跟踪（沿用既有行为）。
    const IGNORE_MAIN_DB: bool = false;

    fn migrations() -> &'static [Migration] {
        DEBT_MIGRATIONS
    }

    /// `turso_url` 与 `turso_auth_token` 都非空时返回 `(url, token)`，否则 `None`
    /// （纯本地模式）。
    fn remote(cfg: &AppConfig) -> Option<(String, String)> {
        let url = cfg
            .turso_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())?;
        let token = cfg
            .turso_auth_token
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())?;
        Some((url.to_string(), token.to_string()))
    }
}

/// 注册进 `tauri::Builder::manage`，跨命令共享的记账库缓存。
pub(crate) type DebtDb = DbHandle<DebtSpec>;

/// 打开一个已就绪（含 PRAGMA、schema）的连接供命令使用。`sync_first` 为 true
/// 且当前是 embedded replica 时，先尽力 `sync()` 拉取远程改动（失败仅忽略，
/// 不阻断本地读取，保证离线可用）。
async fn open_conn(
    app: &tauri::AppHandle,
    state: &DebtDb,
    sync_first: bool,
) -> Result<Connection, String> {
    state.conn(app, sync_first).await
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

/// 把手动指定的创建日期（`YYYY-MM-DD`）补齐成本地时区的 RFC3339 时刻。
///
/// 时分秒取自 `reference`（编辑时是这笔债务原有的 `created_at`，新建时为
/// `None` 则用当前时刻），这样同一天录入的多笔债务仍保留 `ORDER BY created_at`
/// 的先后次序，改日期也不会把既有顺序打乱成并列的 00:00:00。
fn compose_created_at(date: &str, reference: Option<&str>) -> Result<String, String> {
    let day = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| "创建日期格式不正确，应为 YYYY-MM-DD".to_string())?;
    let time = reference
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Local).time())
        .unwrap_or_else(|| Local::now().time());

    Local
        .from_local_datetime(&day.and_time(time))
        .earliest()
        .map(|value| value.to_rfc3339())
        .ok_or_else(|| "创建日期无法转换为本地时间".to_string())
}

fn validate_direction(value: &str) -> Result<(), String> {
    match value {
        "borrow_in" | "lend_out" => Ok(()),
        other => Err(format!("未知的债务方向：{other}")),
    }
}

/// 标签规范化：trim、过滤空值、按首次出现顺序去重；不做大小写折叠（中文标签
/// "亲戚"不该被小写化）。
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

/// 按 `DEBT_SELECT_COLUMNS` 的固定列序（0..12）取值。libSQL 的 `Row::get` 只支持
/// 按下标取，不支持按列名，故这里依赖 SELECT 列顺序，不要随意调整两者之一。
fn map_debt_row(row: &Row) -> libsql::Result<Debt> {
    let archived_at: Option<String> = row.get(8)?;
    let is_settled: i64 = row.get(11)?;

    Ok(Debt {
        id: row.get(0)?,
        direction: row.get(1)?,
        counterparty: row.get(2)?,
        principal_cents: row.get(3)?,
        due_date: row.get(4)?,
        note: row.get(5)?,
        tags: Vec::new(),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        archived: archived_at.is_some(),
        paid_cents: row.get(9)?,
        remaining_cents: row.get(10)?,
        settled: is_settled != 0,
        repayments: Vec::new(),
    })
}

async fn fetch_tags(conn: &Connection, debt_id: &str) -> Result<Vec<String>, String> {
    let mut rows = conn
        .query(
            "SELECT tag FROM debt_tags WHERE debt_id = ?1 ORDER BY tag",
            params![debt_id],
        )
        .await
        .map_err(|error| error.to_string())?;

    let mut tags = Vec::new();
    while let Some(row) = rows.next().await.map_err(|error| error.to_string())? {
        tags.push(row.get::<String>(0).map_err(|error| error.to_string())?);
    }
    Ok(tags)
}

async fn fetch_repayments(conn: &Connection, debt_id: &str) -> Result<Vec<Repayment>, String> {
    let mut rows = conn
        .query(
            "SELECT id, debt_id, amount_cents, paid_on, note, created_at \
             FROM repayments WHERE debt_id = ?1 ORDER BY paid_on ASC, created_at ASC",
            params![debt_id],
        )
        .await
        .map_err(|error| error.to_string())?;

    let mut repayments = Vec::new();
    while let Some(row) = rows.next().await.map_err(|error| error.to_string())? {
        repayments.push(Repayment {
            id: row.get(0).map_err(|error| error.to_string())?,
            debt_id: row.get(1).map_err(|error| error.to_string())?,
            amount_cents: row.get(2).map_err(|error| error.to_string())?,
            paid_on: row.get(3).map_err(|error| error.to_string())?,
            note: row.get(4).map_err(|error| error.to_string())?,
            created_at: row.get(5).map_err(|error| error.to_string())?,
        });
    }
    Ok(repayments)
}

/// 查询单条完整 `Debt`（含 tags 与 repayments），供各写操作提交后复用，
/// 保证所有命令的返回值口径统一。
async fn fetch_debt(conn: &Connection, id: &str) -> Result<Debt, String> {
    let sql = format!(
        "SELECT {DEBT_SELECT_COLUMNS} FROM debts d JOIN debt_balances b ON b.debt_id = d.id WHERE d.id = ?1"
    );
    let mut rows = conn
        .query(&sql, params![id])
        .await
        .map_err(|error| error.to_string())?;

    let row = rows.next().await.map_err(|error| error.to_string())?;
    let mut debt = match row {
        Some(row) => map_debt_row(&row).map_err(|error| error.to_string())?,
        None => return Err("找不到该笔债务".to_string()),
    };
    debt.tags = fetch_tags(conn, id).await?;
    debt.repayments = fetch_repayments(conn, id).await?;
    Ok(debt)
}

/// 一次性列出全部债务（含各自的 tags/repayments）。个人记账场景下 debt 总数
/// 在几十到几百量级，这里对每条 debt 各发一次 tags/repayments 查询（N+1）是有意
/// 选择：可读性与正确性优先于过早优化；真出现性能问题再改批量查询。
async fn list_all_debts(conn: &Connection) -> Result<Vec<Debt>, String> {
    let sql = format!(
        "SELECT {DEBT_SELECT_COLUMNS} FROM debts d JOIN debt_balances b ON b.debt_id = d.id ORDER BY d.created_at DESC"
    );
    let mut rows = conn
        .query(&sql, ())
        .await
        .map_err(|error| error.to_string())?;

    let mut debts = Vec::new();
    while let Some(row) = rows.next().await.map_err(|error| error.to_string())? {
        debts.push(map_debt_row(&row).map_err(|error| error.to_string())?);
    }

    for debt in debts.iter_mut() {
        debt.tags = fetch_tags(conn, &debt.id).await?;
        debt.repayments = fetch_repayments(conn, &debt.id).await?;
    }

    Ok(debts)
}

/// 读取单笔债务已存的 `created_at`；记录不存在时返回 `None`，由后续 UPDATE 的
/// `affected == 0` 统一报"找不到该笔债务"。
async fn fetch_created_at(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    let mut rows = conn
        .query("SELECT created_at FROM debts WHERE id = ?1", params![id])
        .await
        .map_err(|error| error.to_string())?;

    match rows.next().await.map_err(|error| error.to_string())? {
        Some(row) => row.get::<String>(0).map(Some).map_err(|error| error.to_string()),
        None => Ok(None),
    }
}

async fn debt_exists(conn: &Connection, id: &str) -> Result<bool, String> {
    let mut rows = conn
        .query("SELECT 1 FROM debts WHERE id = ?1", params![id])
        .await
        .map_err(|error| error.to_string())?;
    Ok(rows
        .next()
        .await
        .map_err(|error| error.to_string())?
        .is_some())
}

// ---------------------------------------------------------------------------
// #[tauri::command]：libSQL 原生 async，直接 .await，不再需要 run_blocking 包裹
// 同步调用。命令名与参数形状与原 rusqlite 版完全一致，前端 src/lib/api.ts 不用改。
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn list_debts(
    app: tauri::AppHandle,
    state: tauri::State<'_, DebtDb>,
) -> Result<Vec<Debt>, String> {
    // 列表是最需要看到其它设备最新改动的读操作，配了云端就先 sync。
    let conn = open_conn(&app, &state, true).await?;
    list_all_debts(&conn).await
}

#[tauri::command]
pub(crate) async fn create_debt(
    app: tauri::AppHandle,
    state: tauri::State<'_, DebtDb>,
    direction: String,
    counterparty: String,
    principal_cents: i64,
    due_date: Option<String>,
    note: Option<String>,
    tags: Option<Vec<String>>,
    created_at: Option<String>,
) -> Result<Debt, String> {
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

    let now = Local::now().to_rfc3339();
    // 创建日期可手动指定（补录旧账），留空则按当前时刻记；updated_at 始终是
    // 真实的写入时刻，不跟着手填的创建日期回拨。
    let created_at_value = match created_at.as_deref().map(str::trim) {
        Some(date) if !date.is_empty() => compose_created_at(date, None)?,
        _ => now.clone(),
    };

    let conn = open_conn(&app, &state, false).await?;
    let tx = conn.transaction().await.map_err(|error| error.to_string())?;

    let id = new_debt_id();
    let key = counterparty.to_lowercase();

    tx.execute(
        "INSERT INTO debts \
         (id, direction, counterparty, counterparty_key, principal_cents, due_date, note, created_at, updated_at, archived_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
        params![
            id.clone(),
            direction,
            counterparty,
            key,
            principal_cents,
            due_date,
            note.unwrap_or_default(),
            created_at_value,
            now
        ],
    )
    .await
    .map_err(|error| error.to_string())?;

    for tag in normalize_debt_tags(tags.unwrap_or_default()) {
        tx.execute(
            "INSERT INTO debt_tags (debt_id, tag) VALUES (?1, ?2)",
            params![id.clone(), tag],
        )
        .await
        .map_err(|error| error.to_string())?;
    }

    tx.commit().await.map_err(|error| error.to_string())?;
    fetch_debt(&conn, &id).await
}

#[tauri::command]
pub(crate) async fn update_debt(
    app: tauri::AppHandle,
    state: tauri::State<'_, DebtDb>,
    id: String,
    counterparty: String,
    principal_cents: i64,
    due_date: Option<String>,
    note: Option<String>,
    tags: Option<Vec<String>>,
    created_at: Option<String>,
    // 注意：没有 direction 参数——方向创建后不可改，录错方向的唯一修正路径是
    // 删除重建。
) -> Result<Debt, String> {
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

    let conn = open_conn(&app, &state, false).await?;

    // 手填创建日期时沿用原记录的时分秒，日期不变则写回同一个值，同天多笔的既有
    // 排序不受影响。
    let created_at_value = match created_at.as_deref().map(str::trim) {
        Some(date) if !date.is_empty() => {
            let previous = fetch_created_at(&conn, &id).await?;
            Some(compose_created_at(date, previous.as_deref())?)
        }
        _ => None,
    };

    let tx = conn.transaction().await.map_err(|error| error.to_string())?;

    let key = counterparty.to_lowercase();
    let now = Local::now().to_rfc3339();

    let affected = tx
        .execute(
            "UPDATE debts SET counterparty = ?1, counterparty_key = ?2, principal_cents = ?3, \
             due_date = ?4, note = ?5, updated_at = ?6, created_at = COALESCE(?7, created_at) \
             WHERE id = ?8",
            params![
                counterparty,
                key,
                principal_cents,
                due_date,
                note.unwrap_or_default(),
                now,
                created_at_value,
                id.clone()
            ],
        )
        .await
        .map_err(|error| error.to_string())?;

    if affected == 0 {
        return Err("找不到该笔债务".to_string());
    }

    tx.execute(
        "DELETE FROM debt_tags WHERE debt_id = ?1",
        params![id.clone()],
    )
    .await
    .map_err(|error| error.to_string())?;

    for tag in normalize_debt_tags(tags.unwrap_or_default()) {
        tx.execute(
            "INSERT INTO debt_tags (debt_id, tag) VALUES (?1, ?2)",
            params![id.clone(), tag],
        )
        .await
        .map_err(|error| error.to_string())?;
    }

    tx.commit().await.map_err(|error| error.to_string())?;
    fetch_debt(&conn, &id).await
}

#[tauri::command]
pub(crate) async fn set_debt_archived(
    app: tauri::AppHandle,
    state: tauri::State<'_, DebtDb>,
    id: String,
    archived: bool,
) -> Result<Debt, String> {
    let conn = open_conn(&app, &state, false).await?;

    let now = Local::now().to_rfc3339();
    let archived_at: Option<String> = if archived { Some(now.clone()) } else { None };

    let affected = conn
        .execute(
            "UPDATE debts SET archived_at = ?1, updated_at = ?2 WHERE id = ?3",
            params![archived_at, now, id.clone()],
        )
        .await
        .map_err(|error| error.to_string())?;

    if affected == 0 {
        return Err("找不到该笔债务".to_string());
    }

    fetch_debt(&conn, &id).await
}

#[tauri::command]
pub(crate) async fn delete_debt(
    app: tauri::AppHandle,
    state: tauri::State<'_, DebtDb>,
    id: String,
) -> Result<Vec<Debt>, String> {
    let conn = open_conn(&app, &state, false).await?;

    // 级联删除（repayments / debt_tags）由外键约束原子完成，依赖连接已开启
    // PRAGMA foreign_keys = ON（connect_with_pragmas 里已设置）。
    let affected = conn
        .execute("DELETE FROM debts WHERE id = ?1", params![id])
        .await
        .map_err(|error| error.to_string())?;

    if affected == 0 {
        return Err("找不到该笔债务".to_string());
    }

    list_all_debts(&conn).await
}

#[tauri::command]
pub(crate) async fn add_repayment(
    app: tauri::AppHandle,
    state: tauri::State<'_, DebtDb>,
    debt_id: String,
    amount_cents: i64,
    paid_on: String,
    note: Option<String>,
) -> Result<Debt, String> {
    if amount_cents <= 0 {
        return Err("还款金额必须大于 0".to_string());
    }
    validate_date(&paid_on, "还款日期")?;

    let conn = open_conn(&app, &state, false).await?;
    let tx = conn.transaction().await.map_err(|error| error.to_string())?;

    if !debt_exists(&tx, &debt_id).await? {
        return Err("找不到该笔债务".to_string());
    }

    let repayment_id = new_repayment_id();
    let now = Local::now().to_rfc3339();

    // 不校验"是否超过剩余本金"——允许超额还款（多还、历史回填顺序颠倒、本金
    // 录错后更正等场景均合理），remaining_cents 允许为负。
    tx.execute(
        "INSERT INTO repayments (id, debt_id, amount_cents, paid_on, note, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            repayment_id,
            debt_id.clone(),
            amount_cents,
            paid_on,
            note.unwrap_or_default(),
            now.clone()
        ],
    )
    .await
    .map_err(|error| error.to_string())?;

    tx.execute(
        "UPDATE debts SET updated_at = ?1 WHERE id = ?2",
        params![now, debt_id.clone()],
    )
    .await
    .map_err(|error| error.to_string())?;

    tx.commit().await.map_err(|error| error.to_string())?;
    fetch_debt(&conn, &debt_id).await
}

#[tauri::command]
pub(crate) async fn delete_repayment(
    app: tauri::AppHandle,
    state: tauri::State<'_, DebtDb>,
    debt_id: String,
    repayment_id: String,
) -> Result<Debt, String> {
    let conn = open_conn(&app, &state, false).await?;
    let tx = conn.transaction().await.map_err(|error| error.to_string())?;

    let affected = tx
        .execute(
            "DELETE FROM repayments WHERE id = ?1 AND debt_id = ?2",
            params![repayment_id, debt_id.clone()],
        )
        .await
        .map_err(|error| error.to_string())?;

    if affected == 0 {
        return Err("找不到该笔还款记录".to_string());
    }

    let now = Local::now().to_rfc3339();
    tx.execute(
        "UPDATE debts SET updated_at = ?1 WHERE id = ?2",
        params![now, debt_id.clone()],
    )
    .await
    .map_err(|error| error.to_string())?;

    tx.commit().await.map_err(|error| error.to_string())?;
    fetch_debt(&conn, &debt_id).await
}

// ---------------------------------------------------------------------------
// Turso 云端配置命令：写入 AppConfig 并清空 DebtDb 缓存以便下次按新配置重建。
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn get_turso_config(app: tauri::AppHandle) -> Result<TursoConfigView, String> {
    let cfg = read_app_config(&app)?;
    Ok(TursoConfigView {
        url: cfg
            .turso_url
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        has_token: cfg
            .turso_auth_token
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
    })
}

#[tauri::command]
pub(crate) async fn set_turso_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, DebtDb>,
    url: Option<String>,
    // token 为 None 表示"保持不变"；传空串表示"清除 token"。
    token: Option<String>,
) -> Result<TursoConfigView, String> {
    let mut cfg = read_app_config(&app)?;

    let normalized_url = url.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(u) = &normalized_url {
        if !(u.starts_with("libsql://") || u.starts_with("https://") || u.starts_with("http://")) {
            return Err("Turso 地址应以 libsql:// 或 https:// 开头".to_string());
        }
    }
    cfg.turso_url = normalized_url;

    if let Some(token) = token {
        let trimmed = token.trim().to_string();
        cfg.turso_auth_token = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        };
    }

    crate::write_app_config(&app, &cfg)?;

    // 配置变更后失效缓存，下一次记账命令按新配置重建 Database。
    state.invalidate().await;

    Ok(TursoConfigView {
        url: cfg
            .turso_url
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        has_token: cfg
            .turso_auth_token
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
    })
}

// ---------------------------------------------------------------------------
// 单元测试：覆盖建表、CRUD、级联删除、debt_balances 视图计算。
// 用 libSQL 本地 `:memory:` 库，async 运行时由 #[tokio::test] 提供。
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    async fn open_test_conn() -> Connection {
        let db = libsql::Builder::new_local(":memory:")
            .build()
            .await
            .unwrap();
        let conn = crate::db::connect_with_pragmas(&db).await.unwrap();
        crate::db::migrate::apply(&conn, DebtSpec::migrations())
            .await
            .unwrap();
        conn
    }

    #[tokio::test]
    async fn creates_schema_and_sets_user_version() {
        let conn = open_test_conn().await;
        let mut rows = conn.query("PRAGMA user_version", ()).await.unwrap();
        let version: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
        assert_eq!(version, 1);

        let mut rows = conn
            .query(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'debts'",
                (),
            )
            .await
            .unwrap();
        let table_count: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
        assert_eq!(table_count, 1);
    }

    #[tokio::test]
    async fn create_and_fetch_round_trips_tags_and_balances() {
        let conn = open_test_conn().await;
        conn.execute(
            "INSERT INTO debts (id, direction, counterparty, counterparty_key, principal_cents, due_date, note, created_at, updated_at, archived_at) \
             VALUES ('debt-1', 'lend_out', 'Alice', 'alice', 10000, '2026-08-01', '', '2026-07-01T00:00:00+08:00', '2026-07-01T00:00:00+08:00', NULL)",
            (),
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO debt_tags (debt_id, tag) VALUES ('debt-1', '朋友')",
            (),
        )
        .await
        .unwrap();

        let debt = fetch_debt(&conn, "debt-1").await.unwrap();
        assert_eq!(debt.counterparty, "Alice");
        assert_eq!(debt.tags, vec!["朋友".to_string()]);
        assert_eq!(debt.paid_cents, 0);
        assert_eq!(debt.remaining_cents, 10000);
        assert!(!debt.settled);
        assert!(!debt.archived);
    }

    #[tokio::test]
    async fn repayments_reduce_remaining_and_settle_when_fully_paid() {
        let conn = open_test_conn().await;
        conn.execute(
            "INSERT INTO debts (id, direction, counterparty, counterparty_key, principal_cents, due_date, note, created_at, updated_at, archived_at) \
             VALUES ('debt-2', 'borrow_in', 'Bob', 'bob', 5000, NULL, '', '2026-07-01T00:00:00+08:00', '2026-07-01T00:00:00+08:00', NULL)",
            (),
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO repayments (id, debt_id, amount_cents, paid_on, note, created_at) \
             VALUES ('repay-1', 'debt-2', 3000, '2026-07-05', '', '2026-07-05T00:00:00+08:00')",
            (),
        )
        .await
        .unwrap();

        let debt = fetch_debt(&conn, "debt-2").await.unwrap();
        assert_eq!(debt.paid_cents, 3000);
        assert_eq!(debt.remaining_cents, 2000);
        assert!(!debt.settled);

        conn.execute(
            "INSERT INTO repayments (id, debt_id, amount_cents, paid_on, note, created_at) \
             VALUES ('repay-2', 'debt-2', 3000, '2026-07-10', '', '2026-07-10T00:00:00+08:00')",
            (),
        )
        .await
        .unwrap();

        // 超额还款：3000 + 3000 = 6000 > 5000 本金，remaining 应为负且视为已结清。
        let debt = fetch_debt(&conn, "debt-2").await.unwrap();
        assert_eq!(debt.paid_cents, 6000);
        assert_eq!(debt.remaining_cents, -1000);
        assert!(debt.settled);
    }

    #[tokio::test]
    async fn deleting_debt_cascades_to_repayments_and_tags() {
        let conn = open_test_conn().await;
        conn.execute(
            "INSERT INTO debts (id, direction, counterparty, counterparty_key, principal_cents, due_date, note, created_at, updated_at, archived_at) \
             VALUES ('debt-3', 'lend_out', 'Carol', 'carol', 1000, NULL, '', '2026-07-01T00:00:00+08:00', '2026-07-01T00:00:00+08:00', NULL)",
            (),
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO repayments (id, debt_id, amount_cents, paid_on, note, created_at) \
             VALUES ('repay-3', 'debt-3', 500, '2026-07-05', '', '2026-07-05T00:00:00+08:00')",
            (),
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO debt_tags (debt_id, tag) VALUES ('debt-3', '亲戚')",
            (),
        )
        .await
        .unwrap();

        conn.execute("DELETE FROM debts WHERE id = 'debt-3'", ())
            .await
            .unwrap();

        let mut rows = conn
            .query(
                "SELECT count(*) FROM repayments WHERE debt_id = 'debt-3'",
                (),
            )
            .await
            .unwrap();
        let repayment_count: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
        let mut rows = conn
            .query(
                "SELECT count(*) FROM debt_tags WHERE debt_id = 'debt-3'",
                (),
            )
            .await
            .unwrap();
        let tag_count: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
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
    fn compose_created_at_keeps_reference_time_of_day() {
        let composed = compose_created_at("2026-03-05", Some("2026-07-25T21:43:07+08:00")).unwrap();
        let parsed = DateTime::parse_from_rfc3339(&composed).unwrap();
        // 日期换成手填的那天，时分秒沿用原记录，同天多笔的既有排序不被抹平。
        assert_eq!(parsed.date_naive(), NaiveDate::from_ymd_opt(2026, 3, 5).unwrap());
        assert_eq!(parsed.time().to_string(), "21:43:07");
    }

    #[test]
    fn compose_created_at_rejects_malformed_date() {
        assert!(compose_created_at("2026/03/05", None).is_err());
        assert!(compose_created_at("", None).is_err());
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
}
