//! `GET /api/events`：SSE 推送内容变化，取代桌面端的 `vault-changed` 文件监听事件。
//!
//! 先订阅广播、再从库里补发 `Last-Event-ID`（或 `?since=`）之后的变化，最后转发实时事件并跳过已补发过的 seq，
//! 保证断线重连不漏不重。客户端游标落后于保留下限、或广播缓冲溢出时推 `resync`，客户端改走全量对账。

use std::{convert::Infallible, time::Duration};

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::sse::{Event, KeepAlive, Sse},
    routing::get,
    Router,
};
use futures_util::Stream;
use serde::Deserialize;
use serde_json::json;
use shard_store::ChangeRecord;
use tokio::sync::{broadcast::error::RecvError, mpsc};
use tokio_stream::wrappers::ReceiverStream;

use crate::{auth::principal::Caller, error::ApiError, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/events", get(events))
}

#[derive(Deserialize)]
struct EventsQuery {
    since: Option<i64>,
}

fn change_event(vault: &str, changes: &[ChangeRecord]) -> Option<Event> {
    let last = changes.last()?.seq;
    let payload = json!({
        "vault": vault,
        "changes": changes
            .iter()
            .map(|change| json!({ "path": change.path, "exists": change.exists, "sha": change.sha, "kind": change.kind }))
            .collect::<Vec<_>>(),
    });
    Some(Event::default().event("vault-changed").id(last.to_string()).data(payload.to_string()))
}

fn resync_event(head: i64) -> Event {
    Event::default().event("resync").id(head.to_string()).data("{}")
}

async fn events(
    State(state): State<AppState>,
    _caller: Caller,
    headers: HeaderMap,
    Query(query): Query<EventsQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let last_event_id = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok());
    let mut live = state.events.subscribe();
    let head = state.store.head_seq()?;
    // 没给游标就从现在开始；给了就补发之后的。
    let mut cursor = last_event_id.or(query.since).unwrap_or(head);

    let (sender, receiver) = mpsc::channel::<Result<Event, Infallible>>(32);
    tokio::spawn(async move {
        // Node 一类的代理（Vite 开发代理）要等第一块正文才转发响应头：先发一行注释，
        // 否则客户端要到第一次心跳（20 秒后）才知道已经连上。
        if sender.send(Ok(Event::default().comment("connected"))).await.is_err() {
            return;
        }
        // 补发。
        loop {
            let store = state.store.clone();
            let since = cursor;
            let page = match tokio::task::spawn_blocking(move || store.changes_since(since, 500)).await {
                Ok(Ok(page)) => page,
                _ => return,
            };
            if since < page.floor_seq {
                let _ = sender.send(Ok(resync_event(page.head_seq))).await;
                cursor = page.head_seq;
                break;
            }
            if let Some(event) = change_event(&state.vault_identity, &page.changes) {
                cursor = page.changes.last().map(|change| change.seq).unwrap_or(cursor);
                if sender.send(Ok(event)).await.is_err() {
                    return;
                }
            }
            if !page.more {
                break;
            }
        }
        // 实时。
        loop {
            match live.recv().await {
                Ok(commit) => {
                    let fresh: Vec<ChangeRecord> =
                        commit.changes.iter().filter(|change| change.seq > cursor).cloned().collect();
                    if let Some(event) = change_event(&state.vault_identity, &fresh) {
                        cursor = commit.last_seq;
                        if sender.send(Ok(event)).await.is_err() {
                            return;
                        }
                    }
                    // 不带 id：密匣变化不推进公开内容的游标；断线重连后客户端本来就会重取密匣快照。
                    // data 带这次的 seq：客户端已提交到这个 seq 就是自己写入的回声，不必重取。
                    let data = match commit.lockbox_seq {
                        Some(seq) => json!({ "seq": seq }).to_string(),
                        None => "{}".to_string(),
                    };
                    if commit.lockbox && sender.send(Ok(Event::default().event("lockbox-changed").data(data))).await.is_err() {
                        return;
                    }
                }
                Err(RecvError::Lagged(_)) => {
                    let head = state.store.head_seq().unwrap_or(cursor);
                    if sender.send(Ok(resync_event(head))).await.is_err() {
                        return;
                    }
                    cursor = head;
                }
                Err(RecvError::Closed) => return,
            }
        }
    });

    Ok(Sse::new(ReceiverStream::new(receiver))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(20)).text("keep-alive")))
}
