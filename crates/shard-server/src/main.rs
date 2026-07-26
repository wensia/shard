//! 服务端入口。

use std::sync::Arc;

use shard_server::{db, router, AppState, Config};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "shard_server=info,tower_http=info".into()),
        )
        .init();

    // 配置有问题就**不要启动**。一个缺认证或指错数据目录的实例悄悄跑起来，
    // 比起不来危险得多。
    let config = Config::from_env().map_err(|reason| {
        tracing::error!("{reason}");
        reason
    })?;

    let store = db::Store::open(&config).await?;
    let bind = config.bind.clone();
    let data_dir = config.data_dir.clone();

    let state = AppState {
        config: Arc::new(config),
        store: Arc::new(store),
    };

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(%bind, data_dir = %data_dir.display(), "shard-server 已启动");

    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

/// 收到 Ctrl-C 或 SIGTERM 后停止接受新连接，等在途请求做完再退出。
/// systemd 重启服务时走的就是 SIGTERM——不处理的话，正在写库的请求会被硬砍。
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.ok();
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }

    tracing::info!("收到停止信号，正在优雅关闭");
}
