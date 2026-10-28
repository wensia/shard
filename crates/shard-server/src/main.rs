//! `shard-server` 命令行：
//! - `serve`：启动服务（只监听本机，或在 docker 里只暴露给 Caddy 所在的网络；由 Caddy 反代并终止 TLS）。
//! - `setup`：打印首次注册通行密钥的一次性链接。
//! - `recover`：通行密钥全部丢失时打印恢复链接，可同时吊销全部旧凭据。
//! - `rotate-epoch`：从备份恢复内容库后执行，客户端发现后走全量对账。

use std::{net::SocketAddr, path::PathBuf};

use clap::{Parser, Subcommand};
use shard_server::{
    app,
    auth::{db::AuthDb, tokens::random_token},
    commands,
    config::Config,
    rpc,
    state::AppState,
};

#[derive(Parser)]
#[command(name = "shard-server", about = "Shard 服务端")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Serve {
        #[arg(long)]
        data_dir: PathBuf,
        /// 浏览器访问的站点，例如 https://shard.example.com
        #[arg(long)]
        origin: String,
        #[arg(long, default_value = "127.0.0.1:8787")]
        listen: SocketAddr,
        /// 网页构建产物目录（dist/）。
        #[arg(long)]
        static_dir: Option<PathBuf>,
        /// 前面有 Caddy 反代时打开：信任本机回环连接带来的 X-Forwarded-For。
        #[arg(long)]
        trust_proxy: bool,
        /// Caddy 跑在 docker 里时，填它所在 docker 网络的网段（例如 172.18.0.0/16）：
        /// 信任从这里转发来的 X-Forwarded-For，限流与审计才按真实客户端 IP 算。可写多次。
        #[arg(long = "proxy-network")]
        proxy_networks: Vec<ipnet::IpNet>,
    },
    Setup {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        origin: String,
    },
    Recover {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        origin: String,
        /// 同时吊销全部通行密钥、会话与设备令牌（怀疑凭据泄露时用）。
        #[arg(long)]
        revoke_all: bool,
    },
    RotateEpoch {
        #[arg(long)]
        data_dir: PathBuf,
    },
    /// 把旧 vault 目录只读导入内容库（一个事务；前置检查不过就拒绝）。
    Import {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        vault: PathBuf,
    },
    /// 把内容库导出成 vault 目录（与原 vault 逐字节一致，旧版 App 可直接打开）。
    Export {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        out: PathBuf,
    },
    /// 一致快照：把三个库写进一个空目录（服务运行中也可以执行）。备份脚本再打包加密上传。
    Snapshot {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        out_dir: PathBuf,
    },
    /// 完整性检查：恢复演练与例行巡检用，不通过时退出码非 0。
    Verify {
        #[arg(long)]
        data_dir: PathBuf,
    },
}

fn issue_link(data_dir: &PathBuf, origin: &str, purpose: &str) -> Result<String, String> {
    let config = Config::new(data_dir.clone(), origin, None, false)?;
    std::fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let auth = AuthDb::open(&data_dir.join("auth.db")).map_err(|error| error.to_string())?;
    if purpose == "first_passkey" && auth.has_active_passkey().map_err(|error| error.to_string())? {
        return Err("已经设置过通行密钥。丢失了请改用 `shard-server recover`。".to_string());
    }
    let token = random_token();
    auth.create_setup_token(&token, purpose).map_err(|error| error.to_string())?;
    auth.audit("admin", &format!("{purpose}.link_issued"), None, None, None);
    // 令牌放在 # 后面：不会出现在 Caddy 访问日志里。
    Ok(format!("{}/setup#token={token}", config.origin_text))
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Serve { data_dir, origin, listen, static_dir, trust_proxy, proxy_networks } => {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
                )
                .init();
            serve(data_dir, &origin, listen, static_dir, trust_proxy, proxy_networks).await
        }
        Command::Setup { data_dir, origin } => issue_link(&data_dir, &origin, "first_passkey").map(|link| {
            println!("在 15 分钟内用浏览器打开下面的链接，注册第一把通行密钥：\n{link}");
        }),
        Command::Recover { data_dir, origin, revoke_all } => {
            let revoked = if revoke_all {
                AuthDb::open(&data_dir.join("auth.db"))
                    .and_then(|auth| {
                        auth.revoke_all_passkeys()?;
                        auth.revoke_all_credentials()?;
                        auth.audit("admin", "recover.revoked_all", None, None, None);
                        Ok(())
                    })
                    .map_err(|error| error.to_string())
            } else {
                Ok(())
            };
            revoked.and_then(|_| issue_link(&data_dir, &origin, "recover")).map(|link| {
                println!("在 15 分钟内用浏览器打开下面的链接，注册新的通行密钥：\n{link}");
            })
        }
        Command::RotateEpoch { data_dir } => shard_store::Store::open(&data_dir)
            .and_then(|store| store.rotate_epoch())
            .map(|epoch| println!("已轮换 epoch：{epoch}"))
            .map_err(|error| error.to_string()),
        Command::Import { data_dir, vault } => import(&data_dir, &vault),
        Command::Export { data_dir, out } => shard_store::Store::open(&data_dir)
            .and_then(|store| shard_store::transfer::export_vault(&store, &out))
            .map(|report| {
                println!("已导出 {} 个文件、{} 个目录、{} 条密匣信封到 {}", report.files, report.dirs, report.lockbox_items, out.display())
            })
            .map_err(|error| error.to_string()),
        Command::Snapshot { data_dir, out_dir } => snapshot(&data_dir, &out_dir),
        Command::Verify { data_dir } => verify(&data_dir),
    };
    if let Err(error) = result {
        eprintln!("错误：{error}");
        std::process::exit(1);
    }
}

async fn serve(
    data_dir: PathBuf,
    origin: &str,
    listen: SocketAddr,
    static_dir: Option<PathBuf>,
    trust_proxy: bool,
    proxy_networks: Vec<ipnet::IpNet>,
) -> Result<(), String> {
    // docker 里只能监听容器网卡（端口不映射到宿主），这时给了 Caddy 的网段，不算误配。
    if !listen.ip().is_loopback() && proxy_networks.is_empty() {
        tracing::warn!(%listen, "服务没有只监听本机：公网访问应当经过 Caddy 终止 TLS");
    }
    let config = Config::new(data_dir, origin, static_dir, trust_proxy)?.with_proxy_networks(proxy_networks);
    let mut registry = rpc::base_registry();
    commands::register(&mut registry);
    shard_server::search::register(&mut registry);
    shard_server::history::register(&mut registry);
    shard_server::lockbox::register(&mut registry);
    let state = AppState::open(config, registry)?;
    commands::ensure_layout(&state.store)?;
    spawn_maintenance(state.store.clone());
    let router = app::build(state.clone());
    let listener = tokio::net::TcpListener::bind(listen).await.map_err(|error| error.to_string())?;
    tracing::info!(%listen, "shard-server 已启动");
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async move {
            stop_requested().await;
            tracing::info!("收到停止信号：不再接新连接，等在途请求结束");
            state.begin_shutdown();
        })
        .await
        .map_err(|error| error.to_string())
}

/// Ctrl-C，或 systemd / `docker stop` 发的 SIGTERM。容器里服务是 1 号进程，SIGTERM 没有处理函数会被内核直接忽略。
async fn stop_requested() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut terminate) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

/// 例行维护，启动后先跑一次，之后每 6 小时一次：彻底删除满 30 天的历史到期抹除；
/// 90 天前的修订每天留一条；未引用满 35 天的 blob 回收。
fn spawn_maintenance(store: std::sync::Arc<shard_store::Store>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(6 * 3600));
        loop {
            interval.tick().await;
            let store = store.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                let now = chrono::Utc::now();
                let expired = store.expire_purged_history(now)?;
                let compacted = store.compact_revisions(now)?;
                let collected = store.collect_blobs(now)?;
                Ok::<_, shard_store::StoreError>((expired, compacted, collected))
            })
            .await;
            match outcome {
                Ok(Ok((expired, compacted, collected))) => {
                    if expired.nodes > 0
                        || compacted.revisions_dropped + compacted.lockbox_revisions_dropped > 0
                        || collected.blobs_marked + collected.blobs_deleted > 0
                    {
                        tracing::info!(
                            purged_nodes = expired.nodes,
                            revisions_dropped = compacted.revisions_dropped,
                            lockbox_revisions_dropped = compacted.lockbox_revisions_dropped,
                            blobs_marked = collected.blobs_marked,
                            blobs_deleted = collected.blobs_deleted,
                            "例行维护完成"
                        );
                    }
                }
                Ok(Err(error)) => tracing::error!(%error, "例行维护失败"),
                Err(error) => tracing::error!(%error, "维护任务异常"),
            }
        }
    });
}

fn snapshot(data_dir: &std::path::Path, out_dir: &std::path::Path) -> Result<(), String> {
    let store = shard_store::Store::open(data_dir).map_err(|error| error.to_string())?;
    store.snapshot_into(out_dir).map_err(|error| error.to_string())?;
    let auth_target = out_dir.join("auth.db");
    if auth_target.exists() {
        return Err("快照目录里已有 auth.db，请换一个空目录。".to_string());
    }
    AuthDb::open(&data_dir.join("auth.db"))
        .and_then(|auth| auth.snapshot_into(&auth_target))
        .map_err(|error| error.to_string())?;
    println!("快照已写入 {}", out_dir.display());
    Ok(())
}

fn verify(data_dir: &std::path::Path) -> Result<(), String> {
    let store = shard_store::Store::open(data_dir).map_err(|error| error.to_string())?;
    let report = store.verify().map_err(|error| error.to_string())?;
    let auth = AuthDb::open(&data_dir.join("auth.db"))
        .and_then(|auth| auth.integrity())
        .map_err(|error| error.to_string())?;
    println!(
        "内容库：integrity={}，外键错误 {}，文件 {} 个，缺失 blob {} 个；认证库：integrity={auth}",
        report.integrity,
        report.foreign_key_errors,
        report.files,
        report.missing_blobs.len()
    );
    if report.is_ok() && auth == "ok" {
        Ok(())
    } else {
        Err("校验没有通过。".to_string())
    }
}

fn import(data_dir: &std::path::Path, vault: &std::path::Path) -> Result<(), String> {
    let store = shard_store::Store::open(data_dir).map_err(|error| error.to_string())?;
    let report = shard_store::transfer::import_vault(&store, vault).map_err(|error| error.to_string())?;
    println!(
        "已导入 {} 个文件（{} 字节）、{} 个目录、{} 条密匣信封{}。",
        report.files,
        report.bytes,
        report.dirs,
        report.lockbox_items,
        if report.lockbox_manifest { "、密匣 manifest" } else { "" }
    );
    if !report.skipped.is_empty() {
        println!("没有导入的（按排除清单）：");
        for (path, reason) in &report.skipped {
            println!("  {path} —— {reason}");
        }
    }
    AuthDb::open(&data_dir.join("auth.db"))
        .map(|auth| auth.audit("admin", "vault.imported", None, None, Some(&vault.display().to_string())))
        .map_err(|error| error.to_string())
}
