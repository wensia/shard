//! 把一条本地写记进 outbox，按方案 §5 合并同一目标上的连续操作。
//!
//! 只与「同一目标上最新的一条、还没发出过（pending 且 attempts = 0）」合并：发出过的可能已经在服务器上
//! 提交了，再改它的请求体会让补交变成另一次修改。合并后的请求体变了，换新的 op_id（服务器上同一个键配
//! 不同的请求体会返回 422）。
//!
//! | 前一条 | 这一条 | 合并结果 |
//! |---|---|---|
//! | create_fragment | update_fragment / update_fragment_tags | 折进 create：正文与标签取本地执行后的结果 |
//! | update_fragment | update_fragment | 后一条的正文与标签，前一条的基线 sha |
//! | update_fragment | update_fragment_tags | 前一条的正文与基线，后一条的标签 |
//! | update_fragment_tags | update_fragment | 后一条的正文与标签，前一条操作前的 sha 作基线 |
//! | update_fragment_tags | update_fragment_tags | 后写覆盖先写 |
//! | set_fragment_pinned | set_fragment_pinned | 后写覆盖先写 |
//! | set / remove_fragment_property（同一个键） | set / remove_fragment_property | 后写覆盖先写 |
//! | save_fragment_image（同一张图还没补交完） | save_fragment_image | 不再记（内容寻址，结果相同） |

use rusqlite::{params, Connection};
use serde_json::{json, Value};
use shard_store::path_key::path_key;

use crate::{
    db::{self, OutboxRow},
    engine::PreparedOp,
    ids,
    local::WritePlan,
    overlay::Touched,
};

fn merged_args(last: &OutboxRow, command: &str, args: &Value, result: &Value) -> Option<(&'static str, Value)> {
    match (last.command.as_str(), command) {
        ("create_fragment", "update_fragment" | "update_fragment_tags") => {
            let mut merged = last.args.clone();
            merged["content"] = result.get("content").cloned().unwrap_or(Value::Null);
            merged["tags"] = result.get("tags").cloned().unwrap_or_else(|| json!([]));
            Some(("create_fragment", merged))
        }
        ("update_fragment", "update_fragment") => {
            let mut merged = args.clone();
            merged["expectedFileSha"] = last.args.get("expectedFileSha").cloned().unwrap_or(Value::Null);
            Some(("update_fragment", merged))
        }
        ("update_fragment", "update_fragment_tags") => {
            let mut merged = last.args.clone();
            merged["tags"] = args.get("tags").cloned().unwrap_or_else(|| json!([]));
            Some(("update_fragment", merged))
        }
        ("update_fragment_tags", "update_fragment") => {
            let mut merged = args.clone();
            merged["expectedFileSha"] = json!(last.base_sha);
            Some(("update_fragment", merged))
        }
        ("update_fragment_tags", "update_fragment_tags") => Some(("update_fragment_tags", args.clone())),
        ("set_fragment_pinned", "set_fragment_pinned") => Some(("set_fragment_pinned", args.clone())),
        ("set_fragment_property" | "remove_fragment_property", "set_fragment_property" | "remove_fragment_property")
            if last.args.get("key") == args.get("key") =>
        {
            let command = if command == "set_fragment_property" { "set_fragment_property" } else { "remove_fragment_property" };
            Some((command, args.clone()))
        }
        _ => None,
    }
}

fn mark_overlay(tx: &Connection, touched: &Touched, op_seq: i64) -> rusqlite::Result<()> {
    for key in touched.keys() {
        tx.execute(
            "UPDATE overlay SET op_seq_max = MAX(op_seq_max, ?2) WHERE key = ?1",
            params![key, op_seq],
        )?;
    }
    Ok(())
}

/// 记进 outbox；返回这条（或合并进的那条）的 op_seq。本地什么也没写（结果与现状相同）时不记，返回 `None`。
pub(crate) fn enqueue(
    tx: &Connection,
    op: &PreparedOp,
    result: &Value,
    plan: &WritePlan,
    touched: &Touched,
    merge: bool,
) -> rusqlite::Result<Option<i64>> {
    if touched.is_empty() {
        return Ok(None);
    }
    let initial = plan
        .target_path
        .as_deref()
        .and_then(|path| touched.get(&path_key(path)))
        .map(|(_, initial)| initial.clone());
    let base_sha = initial.as_ref().and_then(|initial| initial.sha.clone());
    let chained = initial.as_ref().is_some_and(|initial| initial.in_overlay);
    let mut args = op.args.clone();
    // 补交一律带 CAS 基线：服务器上这条在离线期间被改过就另存冲突副本，绝不覆盖。
    if op.command == "update_fragment" {
        if let Some(sha) = &base_sha {
            args["expectedFileSha"] = json!(sha);
        }
    }

    if merge {
        if let Some(last) = db::last_for_target(tx, &plan.target)? {
            if op.command == "save_fragment_image" && db::has_unsettled_for(tx, &plan.target)? {
                mark_overlay(tx, touched, last.op_seq)?;
                return Ok(Some(last.op_seq));
            }
            if last.state == "pending" && last.attempts == 0 {
                if let Some((command, merged)) = merged_args(&last, &op.command, &args, result) {
                    tx.execute(
                        "UPDATE outbox SET op_id = ?2, command = ?3, args_json = ?4 WHERE op_seq = ?1",
                        params![last.op_seq, ids::uuid_v7(), command, merged.to_string()],
                    )?;
                    mark_overlay(tx, touched, last.op_seq)?;
                    return Ok(Some(last.op_seq));
                }
            }
        }
    }

    tx.execute(
        "INSERT INTO outbox (op_id, command, args_json, target, target_path, base_sha, chained, blob_deps, utc_offset,
                             state, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10)",
        params![
            op.op_id,
            op.command,
            args.to_string(),
            plan.target,
            plan.target_path,
            base_sha,
            chained as i64,
            plan.blob_dep,
            op.utc_offset,
            op.created_at.to_rfc3339()
        ],
    )?;
    let op_seq = tx.last_insert_rowid();
    mark_overlay(tx, touched, op_seq)?;
    Ok(Some(op_seq))
}
