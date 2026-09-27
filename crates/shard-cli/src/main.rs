//! Shard 终端快捷创建。直接往资料库写一条碎片，App 不运行也能用；
//! 提交交给 App 的检查点，切回 App 窗口时碎片流会自动刷新。

mod parse;

use serde::Deserialize;
use shard_core::{
    create_public_fragment_in_vault,
    dataset::{read_dataset, write_dataset_ops, DatasetLimits, DatasetOp},
    default_vault_path,
    vault_lock::{app_settings_path, cli_lock_dir, VaultProcessLock},
    AppConfig,
};
use std::{
    collections::HashMap,
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
  shard [--vault <路径>] --append-dataset <vault 相对路径> < records.json

示例:
  shard 今天心情很好
  shard #备忘 /任务列表 买咖啡
  shard /待办 买咖啡            # 斜杠命令同编辑器，拼音缩写也可：/db
  pbpaste | shard #摘录         # 没有内容参数时从标准输入读取
  shard --append-dataset datasets/阅读记录.csv < records.json

块命令:
  /任务列表 /待办 /备忘   → - [ ] 任务项
  /无序列表 /列表         → - 列表项
  /有序列表 /编号         → 1. 列表项
  /引用                   → > 引用
  多行内容每个非空行各成一项；未识别的 /xxx 按正文保留。

选项:
  --vault <路径>   指定资料库（默认读 Shard 设置，或环境变量 SHARD_VAULT）
  --append-dataset <路径>  从标准输入读取 JSON，按主键幂等追加记录
  -h, --help       显示帮助
  -V, --version    显示版本

提示:
  bash 等把 # 当注释的 shell 里请给标签加引号：shard '#备忘' 买咖啡，
  或使用全角 ＃备忘。#密匣 只能在 App 中保存。";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("shard: {}", error.message);
            ExitCode::from(error.code)
        }
    }
}

struct CliError {
    code: u8,
    message: String,
}

impl From<String> for CliError {
    fn from(message: String) -> Self {
        Self { code: 1, message }
    }
}

impl From<&str> for CliError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppendInput {
    expected_header: Vec<String>,
    records: Vec<HashMap<String, String>>,
}

fn run() -> Result<(), CliError> {
    let mut args = env::args().skip(1).peekable();
    let mut vault_arg = None;
    let mut append_path = None;

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
            "--append-dataset" => {
                args.next();
                append_path = Some(args.next().ok_or("--append-dataset 需要 vault 相对路径")?);
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

    let content = args.collect::<Vec<_>>().join(" ");
    if let Some(path) = append_path {
        if !content.is_empty() {
            return Err("--append-dataset 不能与碎片内容同时使用".into());
        }
        return append_dataset(&path, vault_arg);
    }

    let mut capture = parse::parse_capture(&content);
    if capture.text.is_empty() && !io::stdin().is_terminal() {
        let mut input = String::new();
        io::stdin()
            .read_to_string(&mut input)
            .map_err(|error| format!("读取标准输入失败：{error}"))?;
        capture.text = input.trim().replace('＃', "#");
    }

    let (body, tags) = parse::compose(&capture)?;
    let vault = resolve_vault(vault_arg)?;
    let lock_dir = lock_dir()?;
    let timeout = lock_timeout()?;
    let _lock = VaultProcessLock::acquire(&lock_dir, &vault, Some(timeout))?;
    let path = create_public_fragment_in_vault(&vault, &body, tags, "cli")?;

    let shown = path.strip_prefix(&vault).unwrap_or(&path);
    println!("{}", shown.display());
    Ok(())
}

fn lock_dir() -> Result<PathBuf, CliError> {
    env::var_os("SHARD_LOCK_DIR")
        .map(PathBuf::from)
        .or_else(cli_lock_dir)
        .ok_or_else(|| "无法确定资料库锁目录".into())
}

fn lock_timeout() -> Result<Duration, CliError> {
    let millis = env::var("SHARD_LOCK_TIMEOUT_MS")
        .ok()
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| "SHARD_LOCK_TIMEOUT_MS 必须是非负整数")
        })
        .transpose()?
        .unwrap_or(30_000);
    Ok(Duration::from_millis(millis))
}

fn append_dataset(path: &str, vault_arg: Option<String>) -> Result<(), CliError> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("读取标准输入失败：{error}"))?;
    let request: AppendInput =
        serde_json::from_str(&input).map_err(|error| format!("追加记录 JSON 无效：{error}"))?;
    let vault = resolve_vault(vault_arg)?;
    let _lock = VaultProcessLock::acquire(&lock_dir()?, &vault, Some(lock_timeout()?))?;
    let limits = DatasetLimits::default();
    let current = read_dataset(&vault, path, &limits).map_err(|error| error.to_string())?;
    if current.table.header != request.expected_header {
        return Err(CliError {
            code: 2,
            message: "表头已变化".into(),
        });
    }
    if !current.editable {
        return Err(current
            .read_only_reason
            .unwrap_or_else(|| "数据集不可编辑".into())
            .into());
    }
    let key = current
        .schema
        .as_ref()
        .and_then(|schema| schema.primary_key.as_ref())
        .ok_or("数据集必须有主键")?;
    let key_column = current
        .table
        .header
        .iter()
        .position(|column| column == key)
        .ok_or("数据集主键列不存在")?;
    let mut known: HashMap<String, Vec<String>> = current
        .table
        .rows
        .iter()
        .map(|row| (row[key_column].clone(), row.clone()))
        .collect();
    let mut new_rows = Vec::new();
    let mut skipped = 0usize;
    for record in request.records {
        if record
            .keys()
            .any(|column| !current.table.header.contains(column))
        {
            return Err("记录含有表头之外的列".into());
        }
        let row: Vec<String> = current
            .table
            .header
            .iter()
            .map(|column| record.get(column).cloned().unwrap_or_default())
            .collect();
        let id = &row[key_column];
        if id.is_empty() {
            return Err("每条记录必须提供非空主键".into());
        }
        if let Some(existing) = known.get(id) {
            if existing != &row {
                return Err(CliError {
                    code: 3,
                    message: "主键冲突".into(),
                });
            }
            skipped += 1;
        } else {
            known.insert(id.clone(), row.clone());
            new_rows.push(row);
        }
    }
    let appended = new_rows.len();
    let sha = if appended == 0 {
        current.sha
    } else {
        write_dataset_ops(
            &vault,
            path,
            &current.sha,
            current.schema_sha.as_deref(),
            &[DatasetOp::InsertRows {
                at: current.table.rows.len(),
                rows: new_rows,
            }],
            &limits,
        )
        .map_err(|error| error.to_string())?
        .sha
    };
    println!(
        "{}",
        serde_json::json!({ "appended": appended, "skipped": skipped, "sha": sha })
    );
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
