//! `auth.db`：认证数据。独立于内容库，从备份恢复内容时**不回滚**，
//! 否则已吊销的会话与设备令牌会随旧库复活。所有令牌只存 sha256。

// SQL 行按列读成元组、紧接着就地解构，命名结构体反而更绕。
#![allow(clippy::type_complexity)]

use std::{path::Path, sync::Mutex};

use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};

use super::tokens::{hash_token, now_text, parse_time};

const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_handle BLOB NOT NULL,
  auth_epoch TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE passkeys (
  cred_id BLOB PRIMARY KEY,
  passkey_json TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE TABLE sessions (
  id_hash BLOB PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  step_up_at TEXT,
  user_agent TEXT,
  ip TEXT,
  revoked_at TEXT
) WITHOUT ROWID;
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('desktop','cli')),
  token_hash BLOB NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_ip TEXT,
  revoked_at TEXT
);
CREATE TABLE pairing_requests (
  device_code_hash BLOB PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  client_name TEXT,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  approved_at TEXT,
  consumed_at TEXT
);
CREATE TABLE setup_tokens (
  token_hash BLOB PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('first_passkey','recover')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  detail TEXT
);
"#,
// 2：登录从通行密钥改为邮箱 + 密码，设备从配对码改为直接登录。通行密钥与配对请求整表删除；
// 所有者改存邮箱与 argon2id 哈希（没有所有者行即需要首次设置）；setup 令牌的用途改为 setup / reset。
// 会话与设备令牌不动。
r#"
DROP TABLE passkeys;
DROP TABLE pairing_requests;
DROP TABLE setup_tokens;
DROP TABLE owner;
CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE setup_tokens (
  token_hash BLOB PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('setup','reset')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
"#];

/// 会话闲置多久过期。
pub const SESSION_IDLE: Duration = Duration::days(14);
/// 会话最长有效期，到期必须重新登录。
pub const SESSION_ABSOLUTE: Duration = Duration::days(90);
/// 敏感操作要求最近这么久内输过密码。
pub const STEP_UP_WINDOW: Duration = Duration::minutes(10);
/// setup / reset 链接的有效期。链接由管理员在服务器上生成、只能用一次，给足一天免得来不及打开。
pub const SETUP_TOKEN_TTL: Duration = Duration::hours(24);

#[derive(Clone, Debug)]
pub struct SessionRow {
    pub id_hash: Vec<u8>,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub step_up_at: Option<DateTime<Utc>>,
    pub user_agent: Option<String>,
    pub ip: Option<String>,
}

#[derive(Clone, Debug)]
pub struct DeviceRow {
    pub device_id: String,
    pub name: String,
    pub kind: String,
    pub scopes: String,
    pub created_at: String,
    pub last_seen_at: Option<String>,
    pub last_ip: Option<String>,
}

#[derive(Clone, Debug)]
pub struct OwnerRow {
    pub email: String,
    pub password_hash: String,
    pub password_changed_at: String,
}

/// 用 setup / reset 链接设置邮箱密码的结果。
pub enum SetupOutcome {
    /// 设置好了，附链接的用途（`setup` 或 `reset`）。
    Done(String),
    /// 链接无效、过期、已用，或首次设置链接遇到已经有账号。
    InvalidToken,
}

pub struct AuthDb {
    conn: Mutex<Connection>,
}

impl AuthDb {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )?;
        let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(sql)?;
            tx.execute_batch(&format!("PRAGMA user_version = {}", index + 1))?;
            tx.commit()?;
        }
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("认证库连接锁中毒")
    }

    /// 一致快照（备份用）。
    pub fn snapshot_into(&self, target: &Path) -> rusqlite::Result<()> {
        self.conn().execute("VACUUM INTO ?1", params![target.to_string_lossy()])?;
        Ok(())
    }

    pub fn integrity(&self) -> rusqlite::Result<String> {
        self.conn().query_row("PRAGMA integrity_check", [], |row| row.get(0))
    }

    // ---------- 所有者 ----------

    pub fn owner(&self) -> rusqlite::Result<Option<OwnerRow>> {
        self.conn()
            .query_row("SELECT email, password_hash, password_changed_at FROM owner WHERE id = 1", [], |row| {
                Ok(OwnerRow { email: row.get(0)?, password_hash: row.get(1)?, password_changed_at: row.get(2)? })
            })
            .optional()
    }

    pub fn has_owner(&self) -> rusqlite::Result<bool> {
        Ok(self.owner()?.is_some())
    }

    /// 改邮箱与密码哈希（设置里改密码、改邮箱）。只改邮箱时传原来的哈希，`password_changed_at` 不变。
    pub fn update_owner(&self, email: &str, password_hash: &str) -> rusqlite::Result<()> {
        self.conn().execute(
            "UPDATE owner SET email = ?1,
                password_changed_at = CASE WHEN password_hash = ?2 THEN password_changed_at ELSE ?3 END,
                password_hash = ?2
             WHERE id = 1",
            params![email, password_hash, now_text()],
        )?;
        Ok(())
    }

    // ---------- setup / reset 令牌 ----------

    pub fn create_setup_token(&self, token: &str, purpose: &str) -> rusqlite::Result<()> {
        let now = Utc::now();
        self.conn().execute(
            "INSERT INTO setup_tokens (token_hash, purpose, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
            params![hash_token(token), purpose, now_text(), (now + SETUP_TOKEN_TTL).to_rfc3339()],
        )?;
        Ok(())
    }

    /// 令牌有效（未用、未过期）时返回它的用途。
    pub fn peek_setup_token(&self, token: &str) -> rusqlite::Result<Option<String>> {
        let row: Option<(String, String, Option<String>)> = self
            .conn()
            .query_row(
                "SELECT purpose, expires_at, used_at FROM setup_tokens WHERE token_hash = ?1",
                params![hash_token(token)],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        Ok(row.and_then(|(purpose, expires_at, used_at)| {
            (used_at.is_none() && parse_time(&expires_at) > Utc::now()).then_some(purpose)
        }))
    }

    /// 一个事务里：用掉令牌、写邮箱与密码哈希。首次设置的链接只在还没有账号时有效；
    /// 重置链接还会让全部浏览器会话退出（密码可能已经泄露）。设备令牌不动，要吊销在生成链接时加 `--revoke-all`。
    pub fn complete_setup(&self, token: &str, email: &str, password_hash: &str) -> rusqlite::Result<SetupOutcome> {
        let conn = self.conn();
        let tx = conn.unchecked_transaction()?;
        let now = now_text();
        let purpose: Option<String> = tx
            .query_row(
                "UPDATE setup_tokens SET used_at = ?1
                 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?3
                 RETURNING purpose",
                params![now, hash_token(token), Utc::now().to_rfc3339()],
                |row| row.get(0),
            )
            .optional()?;
        let Some(purpose) = purpose else {
            return Ok(SetupOutcome::InvalidToken);
        };
        let has_owner: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM owner WHERE id = 1)", [], |row| row.get(0))?;
        if purpose == "setup" && has_owner {
            return Ok(SetupOutcome::InvalidToken);
        }
        tx.execute(
            "INSERT INTO owner (id, email, password_hash, password_changed_at, created_at) VALUES (1, ?1, ?2, ?3, ?3)
             ON CONFLICT (id) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash,
                                            password_changed_at = excluded.password_changed_at",
            params![email, password_hash, now],
        )?;
        if purpose == "reset" {
            tx.execute("UPDATE sessions SET revoked_at = ?1 WHERE revoked_at IS NULL", params![now])?;
        }
        tx.commit()?;
        Ok(SetupOutcome::Done(purpose))
    }

    // ---------- 会话 ----------

    pub fn create_session(&self, token: &str, ip: Option<&str>, user_agent: Option<&str>) -> rusqlite::Result<()> {
        let now = Utc::now();
        self.conn().execute(
            "INSERT INTO sessions (id_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at,
                                   step_up_at, user_agent, ip)
             VALUES (?1, ?2, ?2, ?3, ?4, ?2, ?5, ?6)",
            params![
                hash_token(token),
                now.to_rfc3339(),
                (now + SESSION_IDLE).to_rfc3339(),
                (now + SESSION_ABSOLUTE).to_rfc3339(),
                user_agent,
                ip
            ],
        )?;
        Ok(())
    }

    /// 查有效会话，并顺延闲置期限（每小时最多写一次，避免每个请求都写库）。
    pub fn touch_session(&self, token: &str) -> rusqlite::Result<Option<SessionRow>> {
        let id_hash = hash_token(token);
        let conn = self.conn();
        let row: Option<(String, String, String, String, Option<String>, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT created_at, last_seen_at, idle_expires_at, absolute_expires_at, step_up_at, user_agent, ip
                 FROM sessions WHERE id_hash = ?1 AND revoked_at IS NULL",
                params![id_hash],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((created_at, last_seen_at, idle_expires_at, absolute_expires_at, step_up_at, user_agent, ip)) = row
        else {
            return Ok(None);
        };
        let now = Utc::now();
        if parse_time(&idle_expires_at) <= now || parse_time(&absolute_expires_at) <= now {
            return Ok(None);
        }
        let mut last_seen = parse_time(&last_seen_at);
        if now - last_seen > Duration::hours(1) {
            conn.execute(
                "UPDATE sessions SET last_seen_at = ?1, idle_expires_at = ?2 WHERE id_hash = ?3",
                params![now.to_rfc3339(), (now + SESSION_IDLE).to_rfc3339(), id_hash],
            )?;
            last_seen = now;
        }
        Ok(Some(SessionRow {
            id_hash,
            created_at: parse_time(&created_at),
            last_seen_at: last_seen,
            step_up_at: step_up_at.as_deref().map(parse_time),
            user_agent,
            ip,
        }))
    }

    pub fn mark_step_up(&self, id_hash: &[u8]) -> rusqlite::Result<()> {
        self.conn().execute(
            "UPDATE sessions SET step_up_at = ?1 WHERE id_hash = ?2",
            params![now_text(), id_hash],
        )?;
        Ok(())
    }

    /// 仅端到端测试：让会话的验证过期（登录本身算一次验证）。
    #[cfg(feature = "test-auth")]
    pub fn expire_step_up(&self, id_hash: &[u8]) -> rusqlite::Result<()> {
        self.conn().execute("UPDATE sessions SET step_up_at = NULL WHERE id_hash = ?1", params![id_hash])?;
        Ok(())
    }

    pub fn revoke_session(&self, id_hash: &[u8]) -> rusqlite::Result<bool> {
        let changed = self.conn().execute(
            "UPDATE sessions SET revoked_at = ?1 WHERE id_hash = ?2 AND revoked_at IS NULL",
            params![now_text(), id_hash],
        )?;
        Ok(changed == 1)
    }

    pub fn active_sessions(&self) -> rusqlite::Result<Vec<SessionRow>> {
        let conn = self.conn();
        let now = Utc::now().to_rfc3339();
        let mut statement = conn.prepare(
            "SELECT id_hash, created_at, last_seen_at, step_up_at, user_agent, ip FROM sessions
             WHERE revoked_at IS NULL AND idle_expires_at > ?1 AND absolute_expires_at > ?1
             ORDER BY last_seen_at DESC",
        )?;
        let rows = statement
            .query_map(params![now], |row| {
                Ok(SessionRow {
                    id_hash: row.get(0)?,
                    created_at: parse_time(&row.get::<_, String>(1)?),
                    last_seen_at: parse_time(&row.get::<_, String>(2)?),
                    step_up_at: row.get::<_, Option<String>>(3)?.as_deref().map(parse_time),
                    user_agent: row.get(4)?,
                    ip: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 改密码后让其他浏览器会话退出，只留下当前这个。
    pub fn revoke_other_sessions(&self, keep: &[u8]) -> rusqlite::Result<usize> {
        self.conn().execute(
            "UPDATE sessions SET revoked_at = ?1 WHERE revoked_at IS NULL AND id_hash != ?2",
            params![now_text(), keep],
        )
    }

    pub fn revoke_all_credentials(&self) -> rusqlite::Result<()> {
        let conn = self.conn();
        let now = now_text();
        conn.execute("UPDATE sessions SET revoked_at = ?1 WHERE revoked_at IS NULL", params![now])?;
        conn.execute("UPDATE devices SET revoked_at = ?1 WHERE revoked_at IS NULL", params![now])?;
        Ok(())
    }

    // ---------- 设备令牌 ----------

    pub fn create_device(&self, device_id: &str, name: &str, kind: &str, token: &str, scopes: &str) -> rusqlite::Result<()> {
        self.conn().execute(
            "INSERT INTO devices (device_id, name, kind, token_hash, scopes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![device_id, name, kind, hash_token(token), scopes, now_text()],
        )?;
        Ok(())
    }

    pub fn device_by_token(&self, token: &str, ip: Option<&str>) -> rusqlite::Result<Option<DeviceRow>> {
        let conn = self.conn();
        let token_hash = hash_token(token);
        let row = conn
            .query_row(
                "SELECT device_id, name, kind, scopes, created_at, last_seen_at, last_ip FROM devices
                 WHERE token_hash = ?1 AND revoked_at IS NULL",
                params![token_hash],
                map_device,
            )
            .optional()?;
        if let Some(device) = &row {
            let stale = device
                .last_seen_at
                .as_deref()
                .map(|value| Utc::now() - parse_time(value) > Duration::minutes(10))
                .unwrap_or(true);
            if stale {
                conn.execute(
                    "UPDATE devices SET last_seen_at = ?1, last_ip = ?2 WHERE device_id = ?3",
                    params![now_text(), ip, device.device_id],
                )?;
            }
        }
        Ok(row)
    }

    pub fn active_devices(&self) -> rusqlite::Result<Vec<DeviceRow>> {
        let conn = self.conn();
        let mut statement = conn.prepare(
            "SELECT device_id, name, kind, scopes, created_at, last_seen_at, last_ip FROM devices
             WHERE revoked_at IS NULL ORDER BY created_at",
        )?;
        let rows = statement.query_map([], map_device)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn revoke_device(&self, device_id: &str) -> rusqlite::Result<bool> {
        let changed = self.conn().execute(
            "UPDATE devices SET revoked_at = ?1 WHERE device_id = ?2 AND revoked_at IS NULL",
            params![now_text(), device_id],
        )?;
        Ok(changed == 1)
    }

    // ---------- 审计 ----------

    pub fn audit(&self, actor: &str, event: &str, ip: Option<&str>, user_agent: Option<&str>, detail: Option<&str>) {
        let result = self.conn().execute(
            "INSERT INTO audit_log (at, actor, event, ip, user_agent, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![now_text(), actor, event, ip, user_agent, detail],
        );
        if let Err(error) = result {
            tracing::error!(%error, event, "审计日志写入失败");
        }
    }

    pub fn recent_audit(&self, limit: i64) -> rusqlite::Result<Vec<(String, String, String, Option<String>, Option<String>)>> {
        let conn = self.conn();
        let mut statement =
            conn.prepare("SELECT at, actor, event, ip, detail FROM audit_log ORDER BY id DESC LIMIT ?1")?;
        let rows = statement
            .query_map(params![limit], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

fn map_device(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeviceRow> {
    Ok(DeviceRow {
        device_id: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        scopes: row.get(3)?,
        created_at: row.get(4)?,
        last_seen_at: row.get(5)?,
        last_ip: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 已部署的服务器上 auth.db 停在迁移 1（通行密钥时代）：升级后要求重新设置账号，会话与设备令牌保留。
    #[test]
    fn upgrading_from_passkeys_keeps_sessions_and_devices_and_asks_for_setup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATIONS[0]).unwrap();
            conn.execute_batch(
                "PRAGMA user_version = 1;
                 INSERT INTO owner VALUES (1, x'01', 'epoch', '2026-10-28T00:00:00Z');
                 INSERT INTO passkeys (cred_id, passkey_json, created_at) VALUES (x'02', '{}', '2026-10-28T00:00:00Z');
                 INSERT INTO setup_tokens VALUES (x'03', 'first_passkey', '2026-10-28T00:00:00Z', '2099-01-01T00:00:00Z', NULL);",
            )
            .unwrap();
            let now = Utc::now();
            conn.execute(
                "INSERT INTO sessions (id_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
                 VALUES (?1, ?2, ?2, ?3, ?3)",
                params![hash_token("old-session"), now.to_rfc3339(), (now + Duration::days(1)).to_rfc3339()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO devices (device_id, name, kind, token_hash, scopes, created_at)
                 VALUES ('dev_1', '我的 Mac', 'desktop', ?1, 'vault', ?2)",
                params![hash_token("shd_dev_x"), now.to_rfc3339()],
            )
            .unwrap();
        }
        let auth = AuthDb::open(&path).unwrap();
        assert!(!auth.has_owner().unwrap(), "通行密钥作废，要重新设置账号");
        assert!(auth.touch_session("old-session").unwrap().is_some());
        assert!(auth.device_by_token("shd_dev_x", None).unwrap().is_some());

        auth.create_setup_token("t", "setup").unwrap();
        assert!(matches!(auth.complete_setup("t", "me@example.com", "hash").unwrap(), SetupOutcome::Done(purpose) if purpose == "setup"));
        assert_eq!(auth.owner().unwrap().unwrap().email, "me@example.com");
        assert!(auth.create_setup_token("u", "recover").is_err(), "旧用途不再接受");
        drop(auth);
        // 再次打开不会重复迁移。
        let reopened = AuthDb::open(&path).unwrap();
        assert!(reopened.has_owner().unwrap());
    }
}
