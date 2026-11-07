//! Durable automatic-tagging bookkeeping. Content remains in nodes; jobs contain hashes only.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use shard_core::{auto_tagging::metadata_is_public, Vfs};

use super::{SqliteVfs, Store, StoreError};

// Both scanning and claiming check the derived projection. Domain code checks the original
// frontmatter/body again before sending anything to a model and before applying its result.
const PUBLIC_DOCUMENT: &str = "n.kind = 'file' AND n.purged_at IS NULL
    AND d.doc_ns = 'fragment' AND d.lookup_scope = 1
    AND (n.path GLOB 'fragments/*' OR n.path GLOB 'notes/*')
    AND instr('/' || n.path, '/.') = 0 AND n.sha IS NOT NULL
    AND n.size <= 131072";
const NO_TOPIC: &str = "NOT EXISTS (
    SELECT 1 FROM doc_tags t WHERE t.node_id = n.node_id
    AND lower(t.tag) NOT IN ('inbox','note','outline','flowchart','document')
)";
const VOCABULARY_DOCUMENTS: usize = 512;
const FRONTMATTER_PREFIX_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoTaggingCandidate {
    pub node_id: i64,
    pub path: String,
    pub file_sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoTaggingJob {
    pub candidate: AutoTaggingCandidate,
    pub body_sha: String,
    pub prompt_version: String,
    /// Includes the currently claimed attempt.
    pub attempts: u32,
    /// Independent of retry count: stale/configuration retries may refund an attempt.
    pub claim_id: String,
}

/// 任务计数：排队（含进行中）、已处理（含「无需新增标签」）、已放弃。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoTaggingCounts {
    pub pending: u64,
    pub done: u64,
    pub failed: u64,
}

#[derive(Debug, Clone, Copy)]
pub enum AutoTaggingResult {
    Done,
    Failed,
    Retry {
        at: i64,
    },
    /// A metadata/content race is not a failed model attempt.
    Stale {
        at: i64,
    },
    /// Bad provider configuration pauses the worker, without exhausting the document.
    Configuration {
        at: i64,
    },
}

impl Store {
    /// A bounded page of unclassified files whose current version has not been examined.
    /// A seen row also records ineligible/empty files, so they cannot starve later candidates.
    pub fn auto_tagging_candidates(
        &self,
        prompt_version: &str,
        limit: usize,
    ) -> Result<Vec<AutoTaggingCandidate>, StoreError> {
        // 读快照即可：结果只是候选，入队前 record_scan 会在写事务里再核对 path 与 sha。
        // 不占写连接，扫描期间正常保存不用排队。
        self.read(|vfs| -> Result<Vec<AutoTaggingCandidate>, StoreError> {
            let mut statement = vfs.conn.prepare(&format!(
                "SELECT n.node_id, n.path, n.sha FROM nodes n
                 JOIN doc_index d USING (node_id)
                 LEFT JOIN auto_tagging_seen s ON s.node_id = n.node_id AND s.prompt_version = ?1
                 WHERE {PUBLIC_DOCUMENT} AND {NO_TOPIC}
                   AND (s.file_sha IS NULL OR s.file_sha <> n.sha)
                 ORDER BY n.node_id LIMIT ?2"
            ))?;
            let rows = statement.query_map(params![prompt_version, limit.min(256) as i64], |row| {
                Ok(AutoTaggingCandidate {
                    node_id: row.get(0)?,
                    path: row.get(1)?,
                    file_sha: row.get(2)?,
                })
            })?;
            Ok(rows.collect::<Result<_, _>>()?)
        })?
    }

    /// Record a read snapshot and, when eligible, enqueue its semantic version atomically.
    /// A changed file must be scanned again; a repeated semantic version retains its outcome.
    pub fn auto_tagging_record_scan(
        &self,
        candidate: &AutoTaggingCandidate,
        prompt_version: &str,
        body_sha: Option<&str>,
        now: i64,
    ) -> Result<bool, StoreError> {
        let conn = self.writer.lock().expect("写连接锁中毒");
        let tx = conn.unchecked_transaction()?;
        let current: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM nodes WHERE node_id = ?1 AND path = ?2 AND sha = ?3)",
            params![candidate.node_id, candidate.path, candidate.file_sha],
            |row| row.get(0),
        )?;
        if !current {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO auto_tagging_seen(node_id,prompt_version,file_sha,body_sha) VALUES (?1,?2,?3,?4)
             ON CONFLICT(node_id,prompt_version) DO UPDATE SET file_sha=excluded.file_sha,body_sha=excluded.body_sha",
            params![candidate.node_id, prompt_version, candidate.file_sha, body_sha],
        )?;
        // 旧正文还在排队的任务已经过时（结果也会被 CAS 拒绝）：删掉，免得 claim 每轮都要跳过它们。
        tx.execute(
            "DELETE FROM auto_tagging_jobs WHERE node_id=?1 AND prompt_version=?2 AND status='pending'
             AND (?3 IS NULL OR body_sha<>?3)",
            params![candidate.node_id, prompt_version, body_sha],
        )?;
        if let Some(body_sha) = body_sha {
            tx.execute(
                "INSERT OR IGNORE INTO auto_tagging_jobs(node_id,body_sha,prompt_version,status,next_attempt_at)
                 VALUES (?1,?2,?3,'pending',?4)",
                params![candidate.node_id, body_sha, prompt_version, now],
            )?;
        }
        tx.commit()?;
        Ok(true)
    }

    /// Recover the sole worker's interrupted requests at process startup. Attempts remain
    /// bounded even if the process repeatedly crashes during the same request.
    pub fn auto_tagging_recover(
        &self,
        prompt_version: &str,
        now: i64,
        max_attempts: u32,
    ) -> Result<(), StoreError> {
        let conn = self.writer.lock().expect("写连接锁中毒");
        conn.execute(
            "UPDATE auto_tagging_jobs SET status=CASE WHEN attempts >= ?3 THEN 'failed' ELSE 'pending' END,
             next_attempt_at=?2,last_error='interrupted' WHERE prompt_version=?1 AND status='running'",
            params![prompt_version, now, max_attempts],
        )?;
        Ok(())
    }

    /// Claim one current, eligible job. The lease also permits recovery by process_once
    /// callers that do not run the spawn startup hook.
    pub fn auto_tagging_claim(
        &self,
        prompt_version: &str,
        now: i64,
        max_attempts: u32,
    ) -> Result<Option<AutoTaggingJob>, StoreError> {
        let conn = self.writer.lock().expect("写连接锁中毒");
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE auto_tagging_jobs SET status='failed',last_error='retry_limit'
             WHERE prompt_version=?1 AND status IN ('pending','running') AND attempts >= ?2 AND next_attempt_at <= ?3",
            params![prompt_version, max_attempts, now],
        )?;
        let job = tx.query_row(
            &format!("SELECT n.node_id,n.path,n.sha,j.body_sha,j.prompt_version,j.attempts
                FROM auto_tagging_jobs j JOIN nodes n USING(node_id) JOIN doc_index d USING(node_id)
                JOIN auto_tagging_seen s ON s.node_id=j.node_id AND s.prompt_version=j.prompt_version
                    AND s.body_sha=j.body_sha AND s.file_sha=n.sha
                WHERE j.prompt_version=?1 AND j.status IN ('pending','running')
                    AND j.next_attempt_at<=?2 AND j.attempts<?3 AND {PUBLIC_DOCUMENT} AND {NO_TOPIC}
                ORDER BY j.next_attempt_at,j.node_id LIMIT 1"),
            params![prompt_version, now, max_attempts],
            |row| Ok(AutoTaggingJob {
                candidate: AutoTaggingCandidate { node_id: row.get(0)?, path: row.get(1)?, file_sha: row.get(2)? },
                body_sha: row.get(3)?, prompt_version: row.get(4)?, attempts: row.get::<_, u32>(5)? + 1,
                claim_id: super::random_hex(16),
            }),
        ).optional()?;
        if let Some(job) = &job {
            tx.execute(
                "UPDATE auto_tagging_jobs SET status='running',attempts=?4,next_attempt_at=?5,claim_id=?6
                 WHERE node_id=?1 AND body_sha=?2 AND prompt_version=?3",
                params![
                    job.candidate.node_id,
                    job.body_sha,
                    job.prompt_version,
                    job.attempts,
                    now + 120,
                    job.claim_id,
                ],
            )?;
        }
        tx.commit()?;
        Ok(job)
    }

    pub fn auto_tagging_finish(
        &self,
        job: &AutoTaggingJob,
        result: AutoTaggingResult,
    ) -> Result<(), StoreError> {
        let conn = self.writer.lock().expect("写连接锁中毒");
        finish(&conn, job, result)
    }

    /// 设置页显示的进度：当前 Prompt 版本各状态的任务数（读快照，不占写连接）。
    pub fn auto_tagging_counts(&self, prompt_version: &str) -> Result<AutoTaggingCounts, StoreError> {
        self.read(|vfs| -> Result<AutoTaggingCounts, StoreError> {
            let mut counts = AutoTaggingCounts::default();
            let mut statement = vfs.conn.prepare(
                "SELECT status, COUNT(*) FROM auto_tagging_jobs WHERE prompt_version=?1 GROUP BY status",
            )?;
            let rows = statement.query_map([prompt_version], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?.max(0) as u64))
            })?;
            for row in rows {
                let (status, count) = row?;
                match status.as_str() {
                    "pending" | "running" => counts.pending += count,
                    "done" => counts.done += count,
                    "failed" => counts.failed += count,
                    _ => {}
                }
            }
            Ok(counts)
        })?
    }

    /// Popular topics in a bounded sample of recently changed documents. A reader snapshot
    /// verifies at most 512 frontmatter prefixes (16 KiB each), never holding the writer lock.
    /// Incomplete/oversized/invalid/private metadata is excluded before counting any tags.
    pub fn auto_tagging_existing_tags(&self, limit: usize) -> Result<Vec<String>, StoreError> {
        self.read(|vfs| -> Result<Vec<String>, StoreError> {
            let mut statement = vfs.conn.prepare(&format!(
                "SELECT n.node_id,n.path FROM nodes n JOIN doc_index d USING(node_id)
                 WHERE {PUBLIC_DOCUMENT}
                   AND EXISTS(SELECT 1 FROM doc_tags t WHERE t.node_id=n.node_id
                     AND lower(t.tag) NOT IN ('inbox','note','outline','flowchart','document','密匣'))
                   AND NOT EXISTS(SELECT 1 FROM doc_tags private WHERE private.node_id=n.node_id AND private.tag='密匣')
                 ORDER BY n.seq DESC,n.node_id DESC LIMIT ?1"
            ))?;
            let nodes = statement.query_map([VOCABULARY_DOCUMENTS as i64], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?.collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            let mut counts = HashMap::<String, usize>::new();
            let mut tags = vfs.conn.prepare(
                "SELECT tag FROM doc_tags WHERE node_id=?1
                 AND lower(tag) NOT IN ('inbox','note','outline','flowchart','document','密匣')"
            )?;
            for (node_id, path) in nodes {
                let prefix = vfs.read_head(&self.root.join(path), FRONTMATTER_PREFIX_BYTES)?;
                if !frontmatter_prefix(&prefix).is_some_and(metadata_is_public) { continue }
                for tag in tags.query_map([node_id], |row| row.get::<_, String>(0))? {
                    *counts.entry(tag?).or_default() += 1;
                }
            }
            let mut ranked = counts.into_iter().collect::<Vec<_>>();
            ranked.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
            Ok(ranked.into_iter().take(limit.min(1000)).map(|(tag, _)| tag).collect())
        })?
    }
}

impl SqliteVfs<'_> {
    /// Bind the response to the original database node AND current claim, not merely a
    /// path/hash pair that a replacement document could reuse. Call inside the write tx.
    pub fn auto_tagging_job_is_current(&self, job: &AutoTaggingJob) -> Result<bool, StoreError> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM nodes n JOIN auto_tagging_jobs j USING(node_id)
             WHERE n.node_id=?1 AND n.path=?2 AND n.sha=?3
               AND j.body_sha=?4 AND j.prompt_version=?5 AND j.status='running'
               AND j.attempts=?6 AND j.claim_id=?7)",
            params![
                job.candidate.node_id,
                job.candidate.path,
                job.candidate.file_sha,
                job.body_sha,
                job.prompt_version,
                job.attempts,
                job.claim_id
            ],
            |row| row.get(0),
        )?)
    }

    /// Complete the job in the SAME transaction as the content write. Otherwise a crash
    /// after adding tags but before marking done could re-add tags after a manual removal.
    pub fn finish_auto_tagging_job(
        &self,
        job: &AutoTaggingJob,
        result: AutoTaggingResult,
    ) -> Result<(), StoreError> {
        self.ensure_writable()?;
        finish(self.conn, job, result)
    }
}

fn finish(
    conn: &Connection,
    job: &AutoTaggingJob,
    result: AutoTaggingResult,
) -> Result<(), StoreError> {
    let (status, at, attempts, error) = match result {
        AutoTaggingResult::Done => ("done", 0, job.attempts, None),
        AutoTaggingResult::Failed => ("failed", 0, job.attempts, Some("model_failure")),
        AutoTaggingResult::Retry { at } => ("pending", at, job.attempts, Some("retryable_failure")),
        AutoTaggingResult::Stale { at } => {
            ("pending", at, job.attempts.saturating_sub(1), Some("stale"))
        }
        AutoTaggingResult::Configuration { at } => (
            "pending",
            at,
            job.attempts.saturating_sub(1),
            Some("configuration"),
        ),
    };
    let changed = conn.execute(
        "UPDATE auto_tagging_jobs SET status=?5,next_attempt_at=?6,attempts=?7,last_error=?8
         WHERE node_id=?1 AND body_sha=?2 AND prompt_version=?3 AND status='running' AND attempts=?4 AND claim_id=?9",
        params![job.candidate.node_id,job.body_sha,job.prompt_version,job.attempts,status,at,attempts,error,job.claim_id],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid("自动标签任务已被其他处理取代".into()));
    }
    Ok(())
}

fn frontmatter_prefix(bytes: &[u8]) -> Option<&str> {
    let rest = bytes.strip_prefix(b"---\n")?;
    let boundary = rest.windows(4).position(|part| part == b"\n---")?;
    std::str::from_utf8(&rest[..boundary]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Vfs, WriteCtx};

    fn write(store: &Store, path: &str, tags: &[&str], body: &str) {
        let tags = tags.iter().map(|t| format!("- {t}\n")).collect::<String>();
        let text = format!("---\nid: 20261101-100000-test\ncreated_at: 2026-11-01T10:00:00Z\nupdated_at: 2026-11-01T10:00:00Z\ntags:\n{tags}source: test\n---\n{body}");
        store
            .write(&WriteCtx::new("test", "test"), |vfs| {
                let target = store.root().join(path);
                vfs.create_dir_all(target.parent().unwrap())?;
                vfs.write(&target, text.as_bytes())
                    .map_err(StoreError::from)
            })
            .unwrap();
    }

    fn open() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        (dir, store)
    }

    fn enqueue(store: &Store) -> AutoTaggingCandidate {
        let candidate = store.auto_tagging_candidates("1", 1).unwrap().remove(0);
        store
            .auto_tagging_record_scan(&candidate, "1", Some("body-1"), 0)
            .unwrap();
        candidate
    }

    #[test]
    fn uppercase_roots_are_not_candidates_and_new_bodies_supersede_pending_jobs() {
        let (_dir, store) = open();
        // 测试夹具共用一个 id：先写小写的那篇，让它拿到 id（另一篇的范围判断才是被测对象）。
        write(&store, "notes/lower.md", &["inbox"], "lower");
        // 路径按大小写不敏感解析：已有 notes/ 时写 Notes/ 会落进同一目录，所以用另一个根来造大写路径。
        write(&store, "Fragments/upper.md", &["inbox"], "upper");
        let candidates = store.auto_tagging_candidates("1", 10).unwrap();
        assert_eq!(candidates.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), ["notes/lower.md"]);

        let candidate = candidates[0].clone();
        store.auto_tagging_record_scan(&candidate, "1", Some("body-1"), 0).unwrap();
        write(&store, "notes/lower.md", &["inbox"], "lower, edited");
        let edited = store.auto_tagging_candidates("1", 10).unwrap().remove(0);
        store.auto_tagging_record_scan(&edited, "1", Some("body-2"), 0).unwrap();
        let conn = store.writer.lock().unwrap();
        let bodies: Vec<String> = conn
            .prepare("SELECT body_sha FROM auto_tagging_jobs ORDER BY body_sha")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(bodies, ["body-2"]);
        drop(conn);
        assert_eq!(store.auto_tagging_counts("1").unwrap(), AutoTaggingCounts { pending: 1, done: 0, failed: 0 });
    }

    #[test]
    fn bounded_scan_skips_examined_empty_files_and_private_paths() {
        let (_dir, store) = open();
        write(&store, "notes/empty.md", &["inbox"], "");
        write(&store, "notes/later.md", &["inbox"], "later");
        write(&store, ".trash/fragments/trash.md", &["inbox"], "trash");
        write(&store, "notes/.hidden/a.md", &["inbox"], "hidden");
        write(&store, "notes/private.md", &["密匣"], "private");
        let first = store.auto_tagging_candidates("1", 1).unwrap().remove(0);
        assert_eq!(first.path, "notes/empty.md");
        store
            .auto_tagging_record_scan(&first, "1", None, 0)
            .unwrap();
        let rest = store.auto_tagging_candidates("1", 32).unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].path, "notes/later.md");
    }

    #[test]
    fn semantic_dedupe_survives_manual_tag_removal_but_new_body_requeues() {
        let (_dir, store) = open();
        write(&store, "notes/a.md", &["inbox"], "body");
        enqueue(&store);
        let job = store.auto_tagging_claim("1", 0, 3).unwrap().unwrap();
        store
            .auto_tagging_finish(&job, AutoTaggingResult::Done)
            .unwrap();
        write(&store, "notes/a.md", &["inbox", "读书"], "body");
        write(&store, "notes/a.md", &["inbox"], "body");
        // Exact original bytes can return to the old SHA: still no repeat.
        assert!(store.auto_tagging_claim("1", 1, 3).unwrap().is_none());
        write(&store, "notes/a.md", &["inbox"], "body changed");
        let candidate = store.auto_tagging_candidates("1", 1).unwrap().remove(0);
        store
            .auto_tagging_record_scan(&candidate, "1", Some("body-2"), 2)
            .unwrap();
        assert_eq!(
            store
                .auto_tagging_claim("1", 2, 3)
                .unwrap()
                .unwrap()
                .body_sha,
            "body-2"
        );
    }

    #[test]
    fn retries_do_not_starve_other_jobs_and_recover_after_reopen() {
        let (dir, store) = open();
        write(&store, "notes/a.md", &["inbox"], "a");
        write(&store, "notes/b.md", &["inbox"], "b");
        enqueue(&store);
        enqueue(&store);
        let first = store.auto_tagging_claim("1", 0, 3).unwrap().unwrap();
        store
            .auto_tagging_finish(&first, AutoTaggingResult::Retry { at: 30 })
            .unwrap();
        let second = store.auto_tagging_claim("1", 1, 3).unwrap().unwrap();
        assert_ne!(first.candidate.node_id, second.candidate.node_id);
        drop(store);
        let store = Store::open(dir.path()).unwrap();
        store.auto_tagging_recover("1", 2, 3).unwrap();
        let recovered = store.auto_tagging_claim("1", 2, 3).unwrap().unwrap();
        assert_eq!(recovered.candidate.node_id, second.candidate.node_id);
        assert_eq!(recovered.attempts, 2);
        store
            .auto_tagging_finish(&recovered, AutoTaggingResult::Retry { at: 3 })
            .unwrap();
        let last = store.auto_tagging_claim("1", 3, 3).unwrap().unwrap();
        store
            .auto_tagging_finish(&last, AutoTaggingResult::Retry { at: 4 })
            .unwrap();
        assert!(store.auto_tagging_claim("1", 4, 3).unwrap().is_none());
        assert_eq!(
            store
                .auto_tagging_claim("1", 30, 3)
                .unwrap()
                .unwrap()
                .candidate
                .node_id,
            first.candidate.node_id
        );
    }

    #[test]
    fn file_changes_between_scan_and_enqueue_are_not_marked_seen() {
        let (_dir, store) = open();
        write(&store, "notes/a.md", &["inbox"], "before");
        let candidate = store.auto_tagging_candidates("1", 1).unwrap().remove(0);
        write(&store, "notes/a.md", &["inbox"], "after");
        assert!(!store
            .auto_tagging_record_scan(&candidate, "1", Some("old"), 0)
            .unwrap());
        assert_eq!(store.auto_tagging_candidates("1", 1).unwrap().len(), 1);
    }

    #[test]
    fn job_completion_rolls_back_with_content_and_rejects_read_snapshots() {
        let (_dir, store) = open();
        write(&store, "notes/a.md", &["inbox"], "body");
        enqueue(&store);
        let job = store.auto_tagging_claim("1", 0, 3).unwrap().unwrap();
        let result: Result<(_, _), StoreError> =
            store.write(&WriteCtx::new("auto_tagging", "system"), |vfs| {
                vfs.write(&store.root().join("notes/a.md"), b"changed")?;
                vfs.finish_auto_tagging_job(&job, AutoTaggingResult::Done)?;
                Err::<(), _>(StoreError::Invalid("rollback".into()))
            });
        assert!(result.is_err());
        let original = store
            .read(|vfs| vfs.read_to_string(&store.root().join("notes/a.md")))
            .unwrap()
            .unwrap();
        assert!(original.ends_with("body"));
        assert!(store
            .read(|vfs| vfs.finish_auto_tagging_job(&job, AutoTaggingResult::Done))
            .unwrap()
            .is_err());
        store
            .auto_tagging_finish(&job, AutoTaggingResult::Done)
            .unwrap();
    }

    #[test]
    fn configuration_failure_returns_attempt_and_vocabulary_is_public_and_bounded() {
        let (_dir, store) = open();
        write(&store, "notes/a.md", &["inbox"], "body");
        enqueue(&store);
        let job = store.auto_tagging_claim("1", 0, 3).unwrap().unwrap();
        store
            .auto_tagging_finish(&job, AutoTaggingResult::Configuration { at: 10 })
            .unwrap();
        assert_eq!(
            store
                .auto_tagging_claim("1", 10, 3)
                .unwrap()
                .unwrap()
                .attempts,
            1
        );
        write(&store, "notes/b.md", &["note", "读书"], "b");
        write(&store, "notes/c.md", &["inbox", "读书", "生活"], "c");
        write(&store, "notes/private.md", &["密匣", "秘密"], "p");
        write(&store, ".trash/notes/deleted.md", &["回收标签"], "d");
        assert_eq!(store.auto_tagging_existing_tags(1).unwrap(), vec!["读书"]);
        assert!(!store
            .auto_tagging_existing_tags(200)
            .unwrap()
            .iter()
            .any(|tag| tag == "秘密" || tag == "回收标签"));
    }

    #[test]
    fn private_frontmatter_topics_never_enter_the_vocabulary() {
        let (_dir, store) = open();
        write(&store, "notes/public.md", &["inbox", "公开主题"], "public");
        for (name, metadata) in [
            ("hidden", "hidden: true".to_string()),
            ("archived", "archived: true".to_string()),
            ("lockbox", "lockbox: true".to_string()),
            ("invalid", "hidden: maybe".to_string()),
            (
                "oversized",
                format!("padding: {}\nlockbox: true", "x".repeat(17 * 1024)),
            ),
        ] {
            let path = format!("notes/{name}.md");
            write(&store, &path, &["inbox", name], "private");
            store
                .write(
                    &WriteCtx::new("test", "test"),
                    |vfs| -> Result<(), StoreError> {
                        let path = store.root().join(&path);
                        let text = vfs.read_to_string(&path)?.replacen(
                            "source: test",
                            &format!("{metadata}\nsource: test"),
                            1,
                        );
                        vfs.write(&path, text.as_bytes())?;
                        Ok(())
                    },
                )
                .unwrap();
        }
        assert_eq!(
            store.auto_tagging_existing_tags(200).unwrap(),
            vec!["公开主题"]
        );
    }

    #[test]
    fn refunded_attempt_still_has_a_new_claim_identity() {
        let (_dir, store) = open();
        write(&store, "notes/a.md", &["inbox"], "body");
        enqueue(&store);
        let old = store.auto_tagging_claim("1", 0, 3).unwrap().unwrap();
        store
            .auto_tagging_finish(&old, AutoTaggingResult::Configuration { at: 0 })
            .unwrap();
        let current = store.auto_tagging_claim("1", 0, 3).unwrap().unwrap();
        assert_eq!(old.attempts, current.attempts);
        assert_ne!(old.claim_id, current.claim_id);
        assert!(!store
            .read(|vfs| vfs.auto_tagging_job_is_current(&old))
            .unwrap()
            .unwrap());
        assert!(store
            .auto_tagging_finish(&old, AutoTaggingResult::Done)
            .is_err());
        assert!(store
            .read(|vfs| vfs.auto_tagging_job_is_current(&current))
            .unwrap()
            .unwrap());
        store
            .auto_tagging_finish(&current, AutoTaggingResult::Done)
            .unwrap();
    }
}
