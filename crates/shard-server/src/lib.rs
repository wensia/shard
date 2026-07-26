//! Shard 的自建同步服务端。
//!
//! # 定位
//!
//! 数据的最终归属。客户端是带本地库的壳：离线照常读写，联网后把 outbox 里的
//! 改动推上来、把别处的改动拉下去。
//!
//! # 同步在应用层，不在数据库层
//!
//! libSQL 自带的帧同步是物理 WAL 复制，没有行级合并语义，双端离线写之后会
//! 永久分叉。所以这里就是一个普通的 SQLite：并发控制靠每行的 `revision` 做
//! CAS，增量靠全局单调的 `seq`。
//!
//! # 服务端看不到密匣内容
//!
//! 密匣条目以信封密文的形式存取，服务端既不解密也没有任何解密材料。被拖库
//! 也读不到密匣里的东西。

use std::path::PathBuf;
use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;

pub mod auth;
pub mod config;
pub mod db;
pub mod repo;
pub mod routes;

pub use config::Config;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub store: Arc<db::Store>,
}

impl AppState {
    /// 附件字节在磁盘上的位置。按 hash 前两位分桶，避免单目录塞进上万个文件。
    ///
    /// 调用前 `hash` 必须已通过校验——这里直接用它拼路径。
    pub fn attachment_path(&self, hash: &str) -> PathBuf {
        self.config
            .attachments_dir()
            .join(&hash[..2])
            .join(hash)
    }
}

pub fn router(state: AppState) -> Router {
    // 认证只包住 /v1：/healthz 要能被反向代理和监控无凭据探活。
    let protected = Router::new()
        .route("/v1/sync/changes", get(routes::changes))
        .route("/v1/sync/push", post(routes::push))
        .route(
            "/v1/attachments/{hash}",
            get(routes::get_attachment)
                .head(routes::head_attachment)
                .put(routes::put_attachment),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_token,
        ));

    Router::new()
        .route("/healthz", get(routes::healthz))
        .merge(protected)
        .layer(tower_http::limit::RequestBodyLimitLayer::new(
            state.config.max_attachment_bytes,
        ))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}
