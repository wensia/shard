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
"#];

/// 会话闲置多久过期。
pub const SESSION_IDLE: Duration = Duration::days(14);
/// 会话最长有效期，到期必须重新登录。
pub const SESSION_ABSOLUTE: Duration = Duration::days(90);
/// 敏感操作要求最近这么久内重新验证过通行密钥。
pub const STEP_UP_WINDOW: Duration = Duration::minutes(10);
/// 设备配对码的有效期与最多尝试次数。
pub const PAIRING_TTL: Duration = Duration::minutes(10);
pub const PAIRING_MAX_ATTEMPTS: i64 = 5;
/// setup / recover 链接的有效期。
pub const SETUP_TOKEN_TTL: Duration = Duration::minutes(15);

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
pub struct PasskeyRow {
    pub cred_id: Vec<u8>,
    pub passkey_json: String,
    pub label: Option<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

pub enum PairingPoll {
    Pending,
    Expired,
    Approved { client_name: String, kind: String },
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

    pub fn owner_handle(&self) -> rusqlite::Result<Option<Vec<u8>>> {
        self.conn()
            .query_row("SELECT user_handle FROM owner WHERE id = 1", [], |row| row.get(0))
            .optional()
    }

    pub fn ensure_owner(&self, user_handle: &[u8], epoch: &str) -> rusqlite::Result<Vec<u8>> {
        let conn = self.conn();
        conn.execute(
            "INSERT OR IGNORE INTO owner (id, user_handle, auth_epoch, created_at) VALUES (1, ?1, ?2, ?3)",
            params![user_handle, epoch, now_text()],
        )?;
        conn.query_row("SELECT user_handle FROM owner WHERE id = 1", [], |row| row.get(0))
    }

    // ---------- 通行密钥 ----------

    pub fn active_passkeys(&self) -> rusqlite::Result<Vec<PasskeyRow>> {
        let conn = self.conn();
        let mut statement = conn.prepare(
            "SELECT cred_id, passkey_json, label, created_at, last_used_at FROM passkeys
             WHERE revoked_at IS NULL ORDER BY created_at",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(PasskeyRow {
                    cred_id: row.get(0)?,
                    passkey_json: row.get(1)?,
                    label: row.get(2)?,
                    created_at: row.get(3)?,
                    last_used_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn has_active_passkey(&self) -> rusqlite::Result<bool> {
        Ok(!self.active_passkeys()?.is_empty())
    }

    pub fn insert_passkey(&self, cred_id: &[u8], passkey_json: &str, label: Option<&str>) -> rusqlite::Result<()> {
        self.conn().execute(
            "INSERT INTO passkeys (cred_id, passkey_json, label, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![cred_id, passkey_json, label, now_text()],
        )?;
        Ok(())
    }

    pub fn update_passkey_after_use(&self, cred_id: &[u8], passkey_json: &str) -> rusqlite::Result<()> {
        self.conn().execute(
            "UPDATE passkeys SET passkey_json = ?1, last_used_at = ?2 WHERE cred_id = ?3",
            params![passkey_json, now_text(), cred_id],
        )?;
        Ok(())
    }

    /// 吊销一把通行密钥；返回是否真的吊销了（最后一把不允许吊销，免得把自己锁在门外）。
    pub fn revoke_passkey(&self, cred_id: &[u8]) -> rusqlite::Result<bool> {
        let conn = self.conn();
        let active: i64 =
            conn.query_row("SELECT COUNT(*) FROM passkeys WHERE revoked_at IS NULL", [], |row| row.get(0))?;
        if active <= 1 {
            return Ok(false);
        }
        let changed = conn.execute(
            "UPDATE passkeys SET revoked_at = ?1 WHERE cred_id = ?2 AND revoked_at IS NULL",
            params![now_text(), cred_id],
        )?;
        Ok(changed == 1)
    }

    // ---------- setup / recover 令牌 ----------

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

    /// 一次性：只有第一次调用返回 true。
    pub fn consume_setup_token(&self, token: &str) -> rusqlite::Result<bool> {
        let changed = self.conn().execute(
            "UPDATE setup_tokens SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?3",
            params![now_text(), hash_token(token), Utc::now().to_rfc3339()],
        )?;
        Ok(changed == 1)
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

    /// 恢复时可选：吊销全部通行密钥，之后只能用恢复链接注册的新密钥登录。
    pub fn revoke_all_passkeys(&self) -> rusqlite::Result<()> {
        self.conn()
            .execute("UPDATE passkeys SET revoked_at = ?1 WHERE revoked_at IS NULL", params![now_text()])?;
        Ok(())
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

    // ---------- 设备配对 ----------

    pub fn create_pairing(&self, device_code: &str, user_code: &str, client_name: &str, kind: &str) -> rusqlite::Result<()> {
        let now = Utc::now();
        self.conn().execute(
            "INSERT INTO pairing_requests (device_code_hash, user_code, client_name, kind, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![hash_token(device_code), user_code, client_name, kind, now.to_rfc3339(), (now + PAIRING_TTL).to_rfc3339()],
        )?;
        Ok(())
    }

    /// 用户在浏览器里输入配对码后批准。返回批准的客户端名字；码错误、过期或已用返回 None。
    pub fn approve_pairing(&self, user_code: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn();
        let row: Option<(Vec<u8>, String, String, i64, Option<String>)> = conn
            .query_row(
                "SELECT device_code_hash, client_name, expires_at, attempts, approved_at FROM pairing_requests
                 WHERE user_code = ?1 AND consumed_at IS NULL",
                params![user_code],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()?;
        let Some((hash, client_name, expires_at, attempts, approved_at)) = row else {
            return Ok(None);
        };
        if parse_time(&expires_at) <= Utc::now() || attempts >= PAIRING_MAX_ATTEMPTS || approved_at.is_some() {
            return Ok(None);
        }
        conn.execute(
            "UPDATE pairing_requests SET approved_at = ?1 WHERE device_code_hash = ?2",
            params![now_text(), hash],
        )?;
        Ok(Some(client_name))
    }

    /// 客户端轮询。批准后只能换一次令牌。
    pub fn poll_pairing(&self, device_code: &str) -> rusqlite::Result<Option<PairingPoll>> {
        let conn = self.conn();
        let hash = hash_token(device_code);
        let row: Option<(String, String, String, Option<String>, Option<String>, i64)> = conn
            .query_row(
                "SELECT client_name, kind, expires_at, approved_at, consumed_at, attempts FROM pairing_requests
                 WHERE device_code_hash = ?1",
                params![hash],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .optional()?;
        let Some((client_name, kind, expires_at, approved_at, consumed_at, attempts)) = row else {
            return Ok(None);
        };
        if consumed_at.is_some() || parse_time(&expires_at) <= Utc::now() || attempts >= PAIRING_MAX_ATTEMPTS {
            return Ok(Some(PairingPoll::Expired));
        }
        if approved_at.is_none() {
            return Ok(Some(PairingPoll::Pending));
        }
        conn.execute(
            "UPDATE pairing_requests SET consumed_at = ?1 WHERE device_code_hash = ?2",
            params![now_text(), hash],
        )?;
        Ok(Some(PairingPoll::Approved { client_name, kind }))
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
