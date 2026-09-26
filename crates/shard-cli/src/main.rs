//! Shard 终端快捷创建。直接往资料库写一条碎片，App 不运行也能用；
//! 提交交给 App 的检查点，切回 App 窗口时碎片流会自动刷新。

mod parse;

use shard_core::{
    create_public_fragment_in_vault, default_vault_path,
    vault_lock::{app_settings_path, cli_lock_dir, VaultProcessLock},
    AppConfig,
};
use std::{
    env, fs,
    io::{self, IsTerminal, Read},
    path::{Path, PathBuf},
    process::ExitCode,
    time::Duration,
};

const HELP: &str = "\
shard — 在终端里记一条 Shard 碎片

用法:
  shard [选项] [#标签…] [/块命令] 内容

示例:
  shard 今天心情很好
  shard #备忘 /任务列表 买咖啡
  shard /待办 买咖啡            # 斜杠命令同编辑器，拼音缩写也可：/db
  pbpaste | shard #摘录         # 没有内容参数时从标准输入读取

块命令:
  /任务列表 /待办 /备忘   → - [ ] 任务项
  /无序列表 /列表         → - 列表项
  /有序列表 /编号         → 1. 列表项
  /引用                   → > 引用
  多行内容每个非空行各成一项；未识别的 /xxx 按正文保留。

选项:
  --vault <路径>   指定资料库（默认读 Shard 设置，或环境变量 SHARD_VAULT）
  -h, --help       显示帮助
  -V, --version    显示版本

提示:
  bash 等把 # 当注释的 shell 里请给标签加引号：shard '#备忘' 买咖啡，
  或使用全角 ＃备忘。#密匣 只能在 App 中保存。";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("shard: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1).peekable();
    let mut vault_arg = None;

    // 选项只认内容之前的部分，正文里的 `--xxx` 原样保留。
    while let Some(arg) = args.peek() {
        match arg.as_str() {
            "-h" | "--help" => {
                println!("{HELP}");
                return Ok(());
            }
            "-V" | "--version" => {
                println!("shard {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            "--vault" => {
                args.next();
                vault_arg = Some(args.next().ok_or("--vault 需要一个路径")?);
            }
            "--" => {
                args.next();
                break;
            }
            other if other.starts_with("--vault=") => {
                vault_arg = Some(other["--vault=".len()..].to_string());
                args.next();
            }
            _ => break,
        }
    }

    let mut capture = parse::parse_capture(&args.collect::<Vec<_>>().join(" "));
    if capture.text.is_empty() && !io::stdin().is_terminal() {
        let mut input = String::new();
        io::stdin()
            .read_to_string(&mut input)
            .map_err(|error| format!("读取标准输入失败：{error}"))?;
        capture.text = input.trim().replace('＃', "#");
    }

    let (body, tags) = parse::compose(&capture)?;
    let vault = resolve_vault(vault_arg)?;
    let lock_dir = env::var_os("SHARD_LOCK_DIR")
        .map(PathBuf::from)
        .or_else(cli_lock_dir)
        .ok_or("无法确定资料库锁目录")?;
    let timeout = env::var("SHARD_LOCK_TIMEOUT_MS")
        .ok()
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| "SHARD_LOCK_TIMEOUT_MS 必须是非负整数")
        })
        .transpose()?
        .unwrap_or(30_000);
    let _lock = VaultProcessLock::acquire(&lock_dir, &vault, Some(Duration::from_millis(timeout)))?;
    let path = create_public_fragment_in_vault(&vault, &body, tags, "cli")?;

    let shown = path.strip_prefix(&vault).unwrap_or(&path);
    println!("{}", shown.display());
    Ok(())
}

/// 依次：`--vault` → `SHARD_VAULT` → App 设置里的 `vaultPath` → `~/Documents/ShardVault`。
/// 与 App 的 `configured_vault_path` 同序，只是多了前两个显式覆盖。
fn resolve_vault(explicit: Option<String>) -> Result<PathBuf, String> {
    let candidate = match explicit.or_else(|| env::var("SHARD_VAULT").ok()) {
        Some(path) if !path.trim().is_empty() => PathBuf::from(expand_home(path.trim())),
        _ => match configured_vault_path()? {
            Some(path) => path,
            None => {
                let default = default_vault_path()?;
                if !default.is_dir() {
                    return Err(
                        "未找到资料库。请先在 Shard 中配置资料库，或用 --vault 指定。".to_string(),
                    );
                }
                default
            }
        },
    };

    if !candidate.is_dir() {
        return Err(format!("资料库目录不存在：{}", candidate.display()));
    }
    Ok(candidate)
}

fn configured_vault_path() -> Result<Option<PathBuf>, String> {
    let Some(settings) = app_settings_path() else {
        return Ok(None);
    };
    if !settings.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&settings)
        .map_err(|error| format!("读取 {} 失败：{error}", settings.display()))?;
    let config: AppConfig = serde_json::from_str(&text)
        .map_err(|error| format!("解析 {} 失败：{error}", settings.display()))?;
    Ok(config.vault_path.map(PathBuf::from))
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => Path::new(path).to_path_buf(),
    }
}
