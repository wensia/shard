//! One server-side worker for all server-backed clients. No model request holds a DB lock.

use std::{future::Future, path::Path, time::Duration};

use shard_core::auto_tagging::{validate_topic_tag, TagSuggestion, TaggingItem};
use shard_store::{
    sha256_hex, AutoTaggingCandidate, AutoTaggingJob, AutoTaggingResult, Store, Vfs, WriteCtx,
};
use shard_vault::{
    auto_tagging::{apply_auto_tags, read_tagging_item},
    NoHooks, VaultCtx,
};
use tokio::task::JoinHandle;

use crate::{
    state::AppState,
    tagging_model::{ModelClient, ModelError, PROMPT_VERSION},
};

const SCAN_PAGE: usize = 32;
const MAX_ATTEMPTS: u32 = 3;
const POLL_SECONDS: u64 = 5;
const MAX_VOCABULARY: usize = 200;
const MAX_VOCABULARY_CHARACTERS: usize = 8_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessOutcome {
    Idle,
    /// Examined a page, but it contained no currently runnable jobs.
    Progress,
    Applied,
    /// The model deliberately supplied no tags; do not repeatedly ask about this body.
    Completed,
    RetryScheduled,
    Failed,
    Stale,
    /// The worker stops until service restart; other documents are not consumed.
    ConfigurationPaused,
}

pub fn spawn(state: AppState, client: ModelClient) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut shutdown = state.shutdown.subscribe();
        if *shutdown.borrow() {
            return;
        }
        let store = state.store.clone();
        if tokio::task::spawn_blocking(move || {
            store.auto_tagging_recover(PROMPT_VERSION, now(), MAX_ATTEMPTS)
        })
        .await
        .map_err(|_| ())
        .and_then(|result| result.map_err(|_| ()))
        .is_err()
        {
            tracing::error!("自动标签任务恢复失败，等待服务重启");
            return;
        }
        let mut ticks = tokio::time::interval(Duration::from_secs(POLL_SECONDS));
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                biased;
                _ = shutdown.wait_for(|stopping| *stopping) => return,
                _ = ticks.tick() => {}
            }
            let result = tokio::select! {
                biased;
                _ = shutdown.wait_for(|stopping| *stopping) => return,
                result = process_once(&state, &client) => result,
            };
            match result {
                Ok(ProcessOutcome::ConfigurationPaused) => {
                    tracing::warn!("自动标签已暂停：检查模型配置后重启服务");
                    return;
                }
                Ok(ProcessOutcome::Applied) => tracing::info!("自动标签已应用"),
                Ok(ProcessOutcome::Completed) => tracing::info!("自动标签处理完成，无需新增标签"),
                Ok(ProcessOutcome::RetryScheduled) => {
                    tracing::warn!("自动标签暂时失败，已安排重试")
                }
                Ok(ProcessOutcome::Failed) => {
                    tracing::warn!("自动标签处理失败，已停止重试该正文版本")
                }
                Ok(ProcessOutcome::Stale) => tracing::debug!("自动标签输入已变化，已跳过过时结果"),
                // Never log model messages, requests, responses, document paths or content.
                Err(_) => tracing::error!("自动标签处理失败，稍后重试"),
                _ => {}
            }
        }
    })
}

/// Scan at most one bounded page and classify at most one item. Calls are sequential in
/// spawn; durable claims also prevent concurrent callers from processing the same lease.
pub async fn process_once(
    state: &AppState,
    client: &ModelClient,
) -> Result<ProcessOutcome, String> {
    process_with(state, |item, tags| async move {
        client.classify(&[item], &tags).await
    })
    .await
}

async fn process_with<F, Fut>(state: &AppState, classify: F) -> Result<ProcessOutcome, String>
where
    F: FnOnce(TaggingItem, Vec<String>) -> Fut,
    Fut: Future<Output = Result<Vec<TagSuggestion>, ModelError>>,
{
    let store = state.store.clone();
    let prepared = tokio::task::spawn_blocking(move || prepare(&store))
        .await
        .map_err(|_| "自动标签准备任务异常")??;
    let Some((job, item, vocabulary)) = prepared.job else {
        return Ok(if prepared.scanned {
            ProcessOutcome::Progress
        } else {
            ProcessOutcome::Idle
        });
    };

    // Only owned, bounded public data crosses the network await. No VFS/DB snapshot survives.
    let result = classify(item.clone(), vocabulary).await;
    match result {
        Err(error) => {
            let (result, outcome) = if error.configuration {
                (
                    AutoTaggingResult::Configuration { at: now() },
                    ProcessOutcome::ConfigurationPaused,
                )
            } else if error.retryable && job.attempts < MAX_ATTEMPTS {
                let delay = 30_i64 * (1_i64 << job.attempts.saturating_sub(1));
                (
                    AutoTaggingResult::Retry { at: now() + delay },
                    ProcessOutcome::RetryScheduled,
                )
            } else {
                (AutoTaggingResult::Failed, ProcessOutcome::Failed)
            };
            finish(state, job, result).await?;
            Ok(outcome)
        }
        Ok(mut suggestions) => {
            // ModelClient validates the contract too; keep the write boundary defensive.
            if suggestions.len() != 1 || suggestions[0].id != item.id {
                finish(state, job, AutoTaggingResult::Failed).await?;
                return Ok(ProcessOutcome::Failed);
            }
            let tags = suggestions.remove(0).tags;
            if tags.is_empty() {
                finish(state, job, AutoTaggingResult::Done).await?;
                return Ok(ProcessOutcome::Completed);
            }
            let store = state.store.clone();
            let (applied, committed) = tokio::task::spawn_blocking(move || {
                let ctx = WriteCtx::new("auto_tag_fragments", "system:auto-tagging")
                    .with_device("auto-tagging");
                store.write(&ctx, |vfs| -> Result<bool, String> {
                    let cx = VaultCtx::local(vfs, &NoHooks);
                    let applied = vfs
                        .auto_tagging_job_is_current(&job)
                        .map_err(|error| error.to_string())?
                        && apply_auto_tags(
                            &cx,
                            Path::new(&job.candidate.path),
                            &job.candidate.file_sha,
                            tags,
                        )?;
                    // This marker commits/rolls back with the content, including across crashes.
                    let result = if applied {
                        AutoTaggingResult::Done
                    } else {
                        AutoTaggingResult::Stale {
                            at: now() + POLL_SECONDS as i64,
                        }
                    };
                    vfs.finish_auto_tagging_job(&job, result)
                        .map_err(|error| error.to_string())?;
                    Ok(applied)
                })
            })
            .await
            .map_err(|_| "自动标签写入任务异常")??;
            state.publish(
                committed.changes,
                committed.lockbox_changed,
                committed.last_seq.filter(|_| committed.lockbox_changed),
            );
            Ok(if applied {
                ProcessOutcome::Applied
            } else {
                ProcessOutcome::Stale
            })
        }
    }
}

struct Prepared {
    scanned: bool,
    job: Option<(AutoTaggingJob, TaggingItem, Vec<String>)>,
}

fn prepare(store: &Store) -> Result<Prepared, String> {
    let candidates = store.auto_tagging_candidates(PROMPT_VERSION, SCAN_PAGE)?;
    let scanned = !candidates.is_empty();
    for candidate in candidates {
        // A malformed or unsupported file is remembered by SHA instead of starving the page.
        let body_sha = read_candidate(store, &candidate)?.map(|item| semantic_sha(&item));
        store.auto_tagging_record_scan(&candidate, PROMPT_VERSION, body_sha.as_deref(), now())?;
    }
    let Some(job) = store.auto_tagging_claim(PROMPT_VERSION, now(), MAX_ATTEMPTS)? else {
        return Ok(Prepared { scanned, job: None });
    };
    let item = match read_candidate(store, &job.candidate)? {
        Some(item) if semantic_sha(&item) == job.body_sha => item,
        _ => {
            store.auto_tagging_finish(
                &job,
                AutoTaggingResult::Stale {
                    at: now() + POLL_SECONDS as i64,
                },
            )?;
            return Ok(Prepared {
                scanned: true,
                job: None,
            });
        }
    };
    let mut total = 0;
    let vocabulary = store
        .auto_tagging_existing_tags(MAX_VOCABULARY)?
        .into_iter()
        .filter(|tag| validate_topic_tag(tag).is_ok())
        .take_while(|tag| {
            total += tag.chars().count();
            total <= MAX_VOCABULARY_CHARACTERS
        })
        .collect();
    Ok(Prepared {
        scanned,
        job: Some((job, item, vocabulary)),
    })
}

fn read_candidate(
    store: &Store,
    candidate: &AutoTaggingCandidate,
) -> Result<Option<TaggingItem>, String> {
    store.read(|vfs| {
        let path = store.root().join(&candidate.path);
        let raw = match vfs.read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if sha256_hex(raw.as_bytes()) != candidate.file_sha {
            return Ok(None);
        }
        // The domain returns None only for stable parse/eligibility failures. I/O errors
        // remain errors and never mark the candidate examined.
        let mut item = read_tagging_item(&VaultCtx::local(vfs, &NoHooks), &path)?;
        if let Some(item) = &mut item {
            // A pathological first heading must not duplicate the entire body in the prompt.
            item.title = item.title.chars().take(200).collect();
        }
        Ok(item)
    })?
}

fn semantic_sha(item: &TaggingItem) -> String {
    // Metadata-only edits and deleting previously applied AI tags do not re-run inference.
    sha256_hex(item.body.replace("\r\n", "\n").trim().as_bytes())
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

async fn finish(
    state: &AppState,
    job: AutoTaggingJob,
    result: AutoTaggingResult,
) -> Result<(), String> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.auto_tagging_finish(&job, result))
        .await
        .map_err(|_| "自动标签状态任务异常")?
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, rpc};

    fn state() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let config = Config::new(dir.path().into(), "http://localhost:8787", None, false).unwrap();
        let state = AppState::open(config, rpc::base_registry()).unwrap();
        (dir, state)
    }

    fn write(state: &AppState, name: &str, tags: &[&str], body: &str) {
        let tags = tags
            .iter()
            .map(|tag| format!("- {tag}\n"))
            .collect::<String>();
        let text = format!("---\nid: {name}\ncreated_at: 2026-11-01T10:00:00Z\nupdated_at: 2026-11-01T10:00:00Z\ntags:\n{tags}source: test\n---\n{body}");
        state
            .store
            .write(
                &WriteCtx::new("test", "test"),
                |vfs| -> Result<(), String> {
                    let path = state.store.root().join(format!("notes/{name}.md"));
                    vfs.create_dir_all(path.parent().unwrap())
                        .map_err(|error| error.to_string())?;
                    vfs.write(&path, text.as_bytes())
                        .map_err(|error| error.to_string())
                },
            )
            .unwrap();
    }

    fn raw(state: &AppState, name: &str) -> String {
        state
            .store
            .read(|vfs| vfs.read_to_string(&state.store.root().join(format!("notes/{name}.md"))))
            .unwrap()
            .unwrap()
    }

    fn suggestion(item: TaggingItem) -> Result<Vec<TagSuggestion>, ModelError> {
        Ok(vec![TagSuggestion {
            id: item.id,
            tags: vec!["读书".into(), "笔记方法".into()],
        }])
    }

    #[tokio::test]
    async fn backfills_history_preserves_body_publishes_and_does_not_readd_removed_tags() {
        let (_dir, state) = state();
        let body = "\n# 阅读摘录\n\n保留空行和原文。\n";
        write(&state, "history", &["inbox"], body);
        write(&state, "vocabulary", &["note", "读书"], "existing");
        let mut events = state.events.subscribe();
        let result = process_with(&state, |item, tags| async move {
            assert_eq!(tags, vec!["读书"]);
            assert!(item.body.ends_with(body));
            suggestion(item)
        })
        .await
        .unwrap();
        assert_eq!(result, ProcessOutcome::Applied);
        let event = events.try_recv().unwrap();
        assert!(event
            .changes
            .iter()
            .any(|change| change.path == "notes/history.md"));
        assert!(raw(&state, "history").ends_with(body));
        write(&state, "history", &["inbox"], body);
        let result = process_with(&state, |_, _| async {
            panic!("manual deletion must not re-run inference")
        })
        .await
        .unwrap();
        assert!(matches!(
            result,
            ProcessOutcome::Idle | ProcessOutcome::Progress
        ));
        write(&state, "history", &["inbox"], "内容现在改变了");
        assert_eq!(
            process_with(&state, |item, _| async { suggestion(item) })
                .await
                .unwrap(),
            ProcessOutcome::Applied
        );
    }

    #[tokio::test]
    async fn empty_suggestions_and_permanent_failure_do_not_starve_later_items() {
        let (_dir, state) = state();
        for name in ["one", "two", "three"] {
            write(&state, name, &["inbox"], name)
        }
        assert_eq!(
            process_with(&state, |item, _| async move {
                Ok(vec![TagSuggestion {
                    id: item.id,
                    tags: vec![],
                }])
            })
            .await
            .unwrap(),
            ProcessOutcome::Completed
        );
        assert_eq!(
            process_with(&state, |_, _| async {
                Err(ModelError {
                    retryable: false,
                    configuration: false,
                    message: "invalid JSON".into(),
                })
            })
            .await
            .unwrap(),
            ProcessOutcome::Failed
        );
        assert_eq!(
            process_with(&state, |item, _| async { suggestion(item) })
                .await
                .unwrap(),
            ProcessOutcome::Applied
        );
        assert_eq!(
            process_with(&state, |_, _| async {
                panic!("finished jobs must not rerun")
            })
            .await
            .unwrap(),
            ProcessOutcome::Idle
        );
    }

    #[tokio::test]
    async fn slow_model_holds_no_write_lock_and_cas_preserves_manual_tags() {
        let (_dir, state) = state();
        write(&state, "one", &["inbox"], "body");
        let concurrent = state.clone();
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            process_with(&state, |item, _| async move {
                tokio::task::spawn_blocking(move || {
                    write(&concurrent, "one", &["inbox", "人工分类"], "body")
                })
                .await
                .unwrap();
                suggestion(item)
            }),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result, ProcessOutcome::Stale);
        assert!(raw(&state, "one").contains("人工分类"));
        assert!(!raw(&state, "one").contains("笔记方法"));
    }

    #[tokio::test]
    async fn configuration_failure_pauses_without_burning_candidates() {
        let (_dir, state) = state();
        write(&state, "one", &["inbox"], "body");
        let result = process_with(&state, |_, _| async {
            Err(ModelError {
                retryable: false,
                configuration: true,
                message: "configuration".into(),
            })
        })
        .await
        .unwrap();
        assert_eq!(result, ProcessOutcome::ConfigurationPaused);
        assert_eq!(
            process_with(&state, |item, _| async { suggestion(item) })
                .await
                .unwrap(),
            ProcessOutcome::Applied
        );
    }

    #[tokio::test]
    async fn same_path_and_bytes_replacement_is_not_written_by_the_original_job() {
        let (dir, state) = state();
        write(&state, "one", &["inbox"], "body");
        let original_node = state
            .store
            .auto_tagging_candidates(PROMPT_VERSION, 1)
            .unwrap()[0]
            .node_id;
        let concurrent = state.clone();
        let outcome = process_with(&state, |item, _| async move {
            tokio::task::spawn_blocking(move || {
                concurrent
                    .store
                    .write(
                        &WriteCtx::new("test_replace", "test"),
                        |vfs| -> Result<(), String> {
                            let source = concurrent.store.root().join("notes/one.md");
                            let destination =
                                concurrent.store.root().join(".trash/fragments/original.md");
                            let bytes = vfs.read(&source).map_err(|error| error.to_string())?;
                            vfs.create_dir_all(destination.parent().unwrap())
                                .map_err(|error| error.to_string())?;
                            vfs.rename(&source, &destination)
                                .map_err(|error| error.to_string())?;
                            vfs.write(&source, &bytes)
                                .map_err(|error| error.to_string())
                        },
                    )
                    .unwrap();
            })
            .await
            .unwrap();
            suggestion(item)
        })
        .await
        .unwrap();
        assert_eq!(outcome, ProcessOutcome::Stale);
        assert!(!raw(&state, "one").contains("读书"));
        let replacement_node = state
            .store
            .auto_tagging_candidates(PROMPT_VERSION, 1)
            .unwrap()[0]
            .node_id;
        assert_ne!(original_node, replacement_node);
        assert_eq!(
            process_with(&state, |item, _| async { suggestion(item) })
                .await
                .unwrap(),
            ProcessOutcome::Applied
        );
        let conn = rusqlite::Connection::open(dir.path().join("shard.db")).unwrap();
        let status = |node| {
            conn.query_row(
                "SELECT status FROM auto_tagging_jobs WHERE node_id=?1",
                [node],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
        };
        assert_eq!(status(original_node), "pending");
        assert_eq!(status(replacement_node), "done");
        write(&state, "one", &["inbox"], "body");
        assert!(matches!(
            process_with(&state, |_, _| async {
                panic!("replacement already has its own receipt")
            })
            .await
            .unwrap(),
            ProcessOutcome::Idle | ProcessOutcome::Progress
        ));
    }
}
