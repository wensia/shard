//! 进程级共享状态。

use std::{ops::Deref, sync::Arc};

use shard_store::{ChangeRecord, Store};
use tokio::sync::broadcast;
use webauthn_rs::{Webauthn, WebauthnBuilder};

use crate::{
    auth::{ceremony::Ceremonies, db::AuthDb, ratelimit::RateLimiter},
    config::Config,
    rpc::Registry,
};

/// 一次提交产生的变化，SSE 按它推送。
#[derive(Clone, Debug)]
pub struct CommitEvent {
    pub last_seq: i64,
    pub changes: Vec<ChangeRecord>,
}

pub struct Inner {
    pub config: Config,
    pub store: Arc<Store>,
    pub auth: AuthDb,
    pub webauthn: Webauthn,
    pub ceremonies: Ceremonies,
    pub limiter: RateLimiter,
    pub events: broadcast::Sender<Arc<CommitEvent>>,
    pub rpc: Registry,
    /// 前端 `vaultPath` 字段的值：`shard://<域名>/<vault_id>`，只作身份用。
    pub vault_identity: String,
}

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

impl Deref for AppState {
    type Target = Inner;

    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn open(config: Config, rpc: Registry) -> Result<Self, String> {
        std::fs::create_dir_all(&config.data_dir).map_err(|error| error.to_string())?;
        let store = Store::open(&config.data_dir).map_err(|error| error.to_string())?;
        let auth = AuthDb::open(&config.data_dir.join("auth.db")).map_err(|error| error.to_string())?;
        let webauthn = WebauthnBuilder::new(&config.rp_id, &config.origin)
            .and_then(|builder| builder.rp_name("Shard").build())
            .map_err(|error| format!("通行密钥配置无效：{error}"))?;
        let vault_id = store.meta("vault_id").map_err(|error| error.to_string())?.unwrap_or_default();
        let vault_identity = format!("shard://{}/{vault_id}", config.rp_id);
        let (events, _) = broadcast::channel(256);
        Ok(Self(Arc::new(Inner {
            config,
            store: Arc::new(store),
            auth,
            webauthn,
            ceremonies: Ceremonies::default(),
            limiter: RateLimiter::default(),
            events,
            rpc,
            vault_identity,
        })))
    }

    /// 写入成功后广播给 SSE 订阅者。没有订阅者时发送失败是正常的。
    pub fn publish(&self, changes: Vec<ChangeRecord>) {
        if let Some(last_seq) = changes.last().map(|change| change.seq) {
            let _ = self.events.send(Arc::new(CommitEvent { last_seq, changes }));
        }
    }
}
