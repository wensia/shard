//! Shard 终端快捷创建。直接往资料库写一条碎片，App 不运行也能用；
//! 提交交给 App 的检查点，运行中的 App 监听到文件变化后实时刷新。
//! 给 AI 助手的非交互读写在 `agent`，使用说明与 skill 安装在 `guide`。

mod agent;
mod edit;
mod find;
mod graph;
mod guide;
mod parse;
mod tui;

use serde::Deserialize;
use shard_core::{
    create_public_fragment_in_vault,
    frontmatter::parse_fragment,
    graph_model::content_sha256_hex,
    dataset::{read_dataset, write_dataset_ops, DatasetLimits, DatasetOp},
    default_vault_path,
    vault_lock::{app_settings_path, cli_lock_dir, VaultProcessLock},
    AppConfig, FsVfs,
};
use std::{
    collections::HashMap,
    env, fs,
    io::{self, IsTerminal, Read},
    path::{Path, PathBuf},
    process::ExitCode,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

const HELP: &str = "\
shard — 在终端里记一条 Shard 碎片

AI 助手与脚本：先运行 shard --agent-guide 查看完整说明（格式规则、JSON 输出、退出码）。

用法:
  shard [选项] [#标签…] [/块命令] 内容
  shard -s [关键词…]                搜索碎片；不带关键词时列出最近修改的
  shard -i [关键词…]                打开交互搜索与编辑界面
  shard -e [序号 | id | 关键词…]    在终端内编辑一条已有碎片
  shard -e --external [目标]        改用外部编辑器
  shard --read <目标>                读取全文；--json 时带 sha 等元数据
  shard --update <目标> --expect <sha> < 正文.md   改写全文（sha 不符即拒绝）
  shard --append <目标> [内容…]      追加到末尾，无内容参数时读标准输入
  shard --note <标题> [--folder <文件夹>] [内容…]   新建资料库笔记
  shard --tags                       列出标签及使用次数
  shard --ls [文件夹]                列出资料库目录与数据集
  shard --read-dataset <vault 相对路径>
  shard --create-dataset <名称> [--folder <文件夹>] < dataset.json
  shard [--vault <路径>] --append-dataset <vault 相对路径> < records.json
  shard [--vault <路径>] --graph-read <碎片id>
  shard [--vault <路径>] --graph-outline <碎片id>
  shard [--vault <路径>] --graph-write <碎片id> --expect <fileSha> < graph.json
  shard [--vault <路径>] --graph-set-text <碎片id> <节点id> <文字> --expect <fileSha>
  shard [--vault <路径>] --graph-add-child <碎片id> <父节点id> <文字> --expect <fileSha>
  shard [--vault <路径>] --graph-remove <碎片id> <节点id> --expect <fileSha>

示例:
  shard 今天心情很好
  shard #备忘 /复选框 买咖啡
  shard /待办 买咖啡            # 斜杠命令同编辑器，拼音缩写也可：/db
  pbpaste | shard #摘录         # 没有内容参数时从标准输入读取
  shard -s 银行 房贷            # 多个关键词须同时命中
  shard -i 银行 房贷            # 在交互界面搜索并编辑
  shard -e 2                    # 编辑上次搜索结果的第 2 条
  shard -e 81b8ea9d             # 按 id，或 id 中的一段
  shard -e                      # 编辑最近修改的一条
  shard --append-dataset datasets/阅读记录.csv < records.json
  shard --graph-read 20260928-graph | jq .graph
  shard --graph-outline 20260928-outline

块命令:
  /复选框 /待办 /备忘     → - [ ] 任务项
  /无序列表 /列表         → - 列表项
  /有序列表 /编号         → 1. 列表项
  /引用                   → > 引用
  多行内容每个非空行各成一项；未识别的 /xxx 按正文保留。

搜索与编辑:
  -s, --search [关键词…]  匹配与排序规则同 App 搜索；结果带序号并记住，供 -e 引用
  -i, --interactive [关键词…]  打开交互搜索与内置编辑器（须在终端中运行）
  -n, --limit <N>         搜索最多列出 N 条（默认 20）
      --json              搜索结果输出为 JSON
  -e, --edit [目标]       stdin 与 stdout 均为终端时使用内置编辑器；否则使用外部编辑器。
      --external          对 -e 强制使用 $VISUAL / $EDITOR（默认 vi）；图形编辑器
                          要带等待参数，如 EDITOR='code -w'。保存后按正文重算 #标签、刷新更新时间；
                          编辑期间碎片被 App 或同步改动时不覆盖（退出码 2）。
                          大纲、流程图用 --graph-* 命令；密匣碎片只能在 App 中编辑。
  内置编辑器：Ctrl+S 保存，Esc 返回，Ctrl+Z 撤销，Ctrl+Y 重做，Ctrl+Q 退出。
  鼠标捕获期间，用 Option（iTerm2）或 Fn（Terminal）拖动可原生选择复制。

选项:
  --vault <路径>   指定资料库（默认读 Shard 设置，或环境变量 SHARD_VAULT）
  --json           输出 JSON；出错时 stderr 输出带 code 的 JSON 错误
  --source <名称>  写入 frontmatter 的来源（默认 cli，或环境变量 SHARD_SOURCE）
  --agent-guide    打印给 AI 助手的使用说明
  --install-skill [claude|codex|<目录>]  把使用说明装成 Claude Code / Codex skill
  --append-dataset <路径>  从标准输入读取 JSON，按主键幂等追加记录
  --graph-read <id>        读取大纲或流程图 JSON
  --graph-outline <id>     把大纲导出为两空格缩进列表
  --graph-write <id>       从标准输入更新完整图 JSON（必须带 --expect）
  --graph-set-text …       按节点 id 修改大纲或流程图文字（必须带 --expect）
  --graph-add-child …      在大纲父节点末尾新增子节点（必须带 --expect）
  --graph-remove …         删除大纲节点及其子树（必须带 --expect）
  -h, --help       显示帮助
  -V, --version    显示版本

提示:
  bash 等把 # 当注释的 shell 里请给标签加引号：shard '#备忘' 买咖啡，
  或使用全角 ＃备忘。#密匣 只能在 App 中保存。";

/// 出现过 `--json` 时错误也输出 JSON，方便调用方按 code 分支。
static JSON_OUTPUT: AtomicBool = AtomicBool::new(false);

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            if JSON_OUTPUT.load(Ordering::Relaxed) {
                eprintln!(
                    "{}",
                    serde_json::json!({ "error": { "code": error.kind, "message": error.message } })
                );
            } else {
                eprintln!("shard: {}", error.message);
            }
            ExitCode::from(error.code)
        }
    }
}

#[derive(Debug)]
pub struct CliError {
    /// 退出码：2 = 内容已被改过（CONFLICT/HEADER_CHANGED），3 = 数据集主键冲突，其余 1。
    code: u8,
    /// 机器可读的错误码，`--json` 时输出。
    kind: &'static str,
    message: String,
}

impl CliError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        let code = match kind {
            "CONFLICT" | "HEADER_CHANGED" => 2,
            "KEY_CONFLICT" => 3,
            _ => 1,
        };
        Self {
            code,
            kind,
            message: message.into(),
        }
    }
}

impl From<String> for CliError {
    fn from(message: String) -> Self {
        Self::new("ERROR", message)
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
    let mut graph_command = None;
    let mut find_mode = None;
    let mut external = false;
    let mut json = false;
    let mut source_arg = None;

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
            "--json" => {
                args.next();
                json = true;
                JSON_OUTPUT.store(true, Ordering::Relaxed);
            }
            "--source" => {
                args.next();
                source_arg = Some(args.next().ok_or("--source 需要一个名称")?);
            }
            other if other.starts_with("--source=") => {
                source_arg = Some(other["--source=".len()..].to_string());
                args.next();
            }
            "--agent-guide" => {
                print!("{}", guide::AGENT_GUIDE);
                return Ok(());
            }
            "--install-skill" => {
                args.next();
                let mut force = false;
                let targets = args
                    .by_ref()
                    .filter(|arg| {
                        let is_force = arg == "--force";
                        force |= is_force;
                        !is_force
                    })
                    .collect::<Vec<_>>();
                return guide::install_skill(&targets, force);
            }
            command if AGENT_COMMANDS.contains(&command) => {
                let command = args.next().expect("peeked argument must exist");
                let parsed = parse_agent_command(&command, args.by_ref().collect())?;
                if append_path.is_some() {
                    return Err(format!("{command} 不能与 --append-dataset 同时使用").into());
                }
                let context = agent::Context {
                    vault: resolve_vault(parsed.vault.or(vault_arg))?,
                    lock_dir: lock_dir()?,
                    timeout: lock_timeout()?,
                    json: json || parsed.json,
                    source: resolve_source(parsed.source.or(source_arg))?,
                };
                return agent::run(parsed.command, &context);
            }
            "--external" => {
                external = true;
                args.next();
            }
            "-s" | "--search" | "-e" | "--edit" | "-i" | "--interactive" => {
                let edit = matches!(arg.as_str(), "-e" | "--edit");
                let interactive = matches!(arg.as_str(), "-i" | "--interactive");
                args.next();
                find_mode = Some(if interactive {
                    FindMode::Interactive
                } else if edit {
                    FindMode::Edit
                } else {
                    FindMode::Search
                });
                break;
            }
            command if command.starts_with("--graph-") => {
                let command = args.next().expect("peeked argument must exist");
                graph_command = Some(parse_graph_command(&command, args.by_ref().collect())?);
                break;
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

    if let Some(mode) = find_mode {
        if append_path.is_some() {
            return Err("搜索与编辑不能与 --append-dataset 同时使用".into());
        }
        return run_find(mode, args.collect(), vault_arg, external, json);
    }
    if external {
        return Err("--external 只能与 -e 一起使用".into());
    }

    let content = args.collect::<Vec<_>>().join(" ");
    if let Some(command) = graph_command {
        if append_path.is_some() || !content.is_empty() {
            return Err("图命令不能与碎片内容或 --append-dataset 同时使用".into());
        }
        return run_graph(command, vault_arg);
    }
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
    agent::ensure_plain_markdown(&body)?;
    let source = resolve_source(source_arg)?;
    let vault = resolve_vault(vault_arg)?;
    let lock_dir = lock_dir()?;
    let timeout = lock_timeout()?;
    let lock = VaultProcessLock::acquire(&lock_dir, &vault, Some(timeout)).map_err(agent::lock_error)?;
    let path = create_public_fragment_in_vault(&FsVfs::new(&vault), &body, tags, &source)?;
    drop(lock);

    let shown = path.strip_prefix(&vault).unwrap_or(&path);
    if json {
        let raw = fs::read_to_string(&path).map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
        let parsed = parse_fragment(&raw)?;
        agent::print_json(&serde_json::json!({
            "id": parsed.frontmatter.id,
            "path": shown.display().to_string(),
            "sha": content_sha256_hex(&raw),
            "tags": parsed.frontmatter.tags,
        }));
    } else {
        println!("{}", shown.display());
    }
    Ok(())
}

const AGENT_COMMANDS: &[&str] = &[
    "--read",
    "--update",
    "--append",
    "--note",
    "--tags",
    "--ls",
    "--read-dataset",
    "--create-dataset",
];

struct ParsedAgentCommand {
    command: agent::Command,
    json: bool,
    vault: Option<String>,
    source: Option<String>,
}

/// 命令之后的参数：`--json`、`--vault`、`--source`、`--expect`、`--folder` 可以写在任意位置，
/// `--` 之后全部按位置参数处理（正文里要出现这些字样时用它）。
fn parse_agent_command(command: &str, args: Vec<String>) -> Result<ParsedAgentCommand, CliError> {
    let mut positional = Vec::new();
    let mut json = false;
    let mut vault = None;
    let mut source = None;
    let mut expect = None;
    let mut folder = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let mut value = |name: &str| {
            args.next()
                .ok_or_else(|| CliError::from(format!("{name} 需要一个值")))
        };
        match arg.as_str() {
            "--" => {
                positional.extend(args.by_ref());
                break;
            }
            "--json" => {
                json = true;
                JSON_OUTPUT.store(true, Ordering::Relaxed);
            }
            "--vault" => vault = Some(value("--vault")?),
            "--source" => source = Some(value("--source")?),
            "--expect" => expect = Some(value("--expect")?),
            "--folder" => folder = Some(value("--folder")?),
            other if other.starts_with("--vault=") => vault = Some(other["--vault=".len()..].to_string()),
            other if other.starts_with("--source=") => source = Some(other["--source=".len()..].to_string()),
            other if other.starts_with("--expect=") => expect = Some(other["--expect=".len()..].to_string()),
            other if other.starts_with("--folder=") => folder = Some(other["--folder=".len()..].to_string()),
            _ => positional.push(arg),
        }
    }

    let mut positional = positional.into_iter();
    let mut first = |name: &str| {
        positional
            .next()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| CliError::from(format!("{command} 缺少{name}")))
    };
    let reject = |option: Option<&String>, name: &str| match option {
        Some(_) => Err(CliError::from(format!("{command} 不接受 {name}"))),
        None => Ok(()),
    };
    let command = match command {
        "--read" => {
            reject(expect.as_ref(), "--expect")?;
            reject(folder.as_ref(), "--folder")?;
            agent::Command::Read { target: first("目标")? }
        }
        "--update" => {
            reject(folder.as_ref(), "--folder")?;
            let target = first("目标")?;
            let expect = expect.ok_or_else(|| CliError::from("--update 必须带 --expect <sha>（先用 --read --json 读取）"))?;
            agent::Command::Update { target, expect }
        }
        "--append" => {
            reject(folder.as_ref(), "--folder")?;
            agent::Command::Append {
                target: first("目标")?,
                expect,
                content: positional.by_ref().collect(),
            }
        }
        "--note" => {
            reject(expect.as_ref(), "--expect")?;
            agent::Command::Note {
                title: first("标题")?,
                folder,
                content: positional.by_ref().collect(),
            }
        }
        "--tags" => {
            reject(expect.as_ref(), "--expect")?;
            reject(folder.as_ref(), "--folder")?;
            agent::Command::Tags
        }
        "--ls" => {
            reject(expect.as_ref(), "--expect")?;
            reject(folder.as_ref(), "--folder")?;
            agent::Command::List { folder: positional.next() }
        }
        "--read-dataset" => {
            reject(expect.as_ref(), "--expect")?;
            reject(folder.as_ref(), "--folder")?;
            agent::Command::ReadDataset { path: first("数据集路径")? }
        }
        "--create-dataset" => {
            reject(expect.as_ref(), "--expect")?;
            agent::Command::CreateDataset {
                title: first("名称")?,
                folder,
            }
        }
        _ => unreachable!("AGENT_COMMANDS 已限定命令"),
    };
    if !matches!(command, agent::Command::Append { .. } | agent::Command::Note { .. }) {
        if let Some(extra) = positional.next() {
            return Err(format!("{command_name} 多出参数：{extra}", command_name = command_label(&command)).into());
        }
    }
    Ok(ParsedAgentCommand {
        command,
        json,
        vault,
        source,
    })
}

fn command_label(command: &agent::Command) -> &'static str {
    match command {
        agent::Command::Read { .. } => "--read",
        agent::Command::Update { .. } => "--update",
        agent::Command::Append { .. } => "--append",
        agent::Command::Note { .. } => "--note",
        agent::Command::Tags => "--tags",
        agent::Command::List { .. } => "--ls",
        agent::Command::ReadDataset { .. } => "--read-dataset",
        agent::Command::CreateDataset { .. } => "--create-dataset",
    }
}

/// `--source` → `SHARD_SOURCE` → `cli`。只是 frontmatter 里的来源标记，限制成单行短名称。
fn resolve_source(explicit: Option<String>) -> Result<String, CliError> {
    let Some(source) = explicit.or_else(|| env::var("SHARD_SOURCE").ok()) else {
        return Ok("cli".to_string());
    };
    let source = source.trim();
    if source.is_empty() {
        return Ok("cli".to_string());
    }
    if source.chars().count() > 40 || source.chars().any(char::is_control) {
        return Err("--source 必须是不超过 40 个字符的单行名称".into());
    }
    Ok(source.to_string())
}

fn parse_graph_command(command: &str, args: Vec<String>) -> Result<graph::GraphCommand, CliError> {
    use graph::GraphCommand;
    let positional = |index: usize, name: &str| {
        args.get(index)
            .cloned()
            .ok_or_else(|| CliError::from(format!("{command} 缺少{name}")))
    };
    let expect = |index: usize| -> Result<String, CliError> {
        if args.get(index).map(String::as_str) != Some("--expect") {
            return Err(format!("{command} 必须带 --expect <fileSha>").into());
        }
        args.get(index + 1)
            .cloned()
            .ok_or_else(|| CliError::from("--expect 需要 fileSha"))
    };
    let ensure_len = |length: usize| {
        if args.len() == length {
            Ok(())
        } else {
            Err(CliError::from(format!("{command} 参数数量不正确")))
        }
    };

    match command {
        "--graph-read" => {
            ensure_len(1)?;
            Ok(GraphCommand::Read {
                fragment_id: positional(0, "碎片 id")?,
            })
        }
        "--graph-outline" => {
            ensure_len(1)?;
            Ok(GraphCommand::Outline {
                fragment_id: positional(0, "碎片 id")?,
            })
        }
        "--graph-write" => {
            let expect = expect(1)?;
            ensure_len(3)?;
            Ok(GraphCommand::Write {
                fragment_id: positional(0, "碎片 id")?,
                expect,
            })
        }
        "--graph-set-text" => {
            let expect = expect(3)?;
            ensure_len(5)?;
            Ok(GraphCommand::SetText {
                fragment_id: positional(0, "碎片 id")?,
                node_id: positional(1, "节点 id")?,
                text: positional(2, "文字")?,
                expect,
            })
        }
        "--graph-add-child" => {
            let expect = expect(3)?;
            ensure_len(5)?;
            Ok(GraphCommand::AddChild {
                fragment_id: positional(0, "碎片 id")?,
                parent_id: positional(1, "父节点 id")?,
                text: positional(2, "文字")?,
                expect,
            })
        }
        "--graph-remove" => {
            let expect = expect(2)?;
            ensure_len(4)?;
            Ok(GraphCommand::Remove {
                fragment_id: positional(0, "碎片 id")?,
                node_id: positional(1, "节点 id")?,
                expect,
            })
        }
        _ => Err(format!("未知图命令：{command}").into()),
    }
}

fn run_graph(command: graph::GraphCommand, vault_arg: Option<String>) -> Result<(), CliError> {
    let vault = resolve_vault(vault_arg)?;
    let lock_dir = lock_dir()?;
    let timeout = lock_timeout()?;
    run_graph_in(command, &vault, &lock_dir, timeout).map_err(|message| match message.as_str() {
        graph::STALE_MESSAGE => CliError::new("CONFLICT", message),
        "Shard 正在写入资料库，请稍后重试" => CliError::new("LOCKED", message),
        _ => message.into(),
    })
}

fn run_graph_in(
    command: graph::GraphCommand,
    vault: &Path,
    lock_dir: &Path,
    timeout: Duration,
) -> Result<(), String> {
    use graph::GraphCommand;
    let vault = vault.to_path_buf();
    match command {
        GraphCommand::Read { fragment_id } => graph::run_read(&vault, &fragment_id)?,
        GraphCommand::Outline { fragment_id } => graph::run_outline(&vault, &fragment_id)?,
        GraphCommand::Write {
            fragment_id,
            expect,
        } => {
            let value = graph::read_stdin_json()?;
            graph::run_write(
                &vault,
                &fragment_id,
                &expect,
                value,
                lock_dir,
                timeout,
            )?;
        }
        GraphCommand::SetText {
            fragment_id,
            node_id,
            text,
            expect,
        } => graph::run_set_text(
            &vault,
            &fragment_id,
            &node_id,
            text,
            &expect,
            lock_dir,
            timeout,
        )?,
        GraphCommand::AddChild {
            fragment_id,
            parent_id,
            text,
            expect,
        } => graph::run_add_child(
            &vault,
            &fragment_id,
            &parent_id,
            text,
            &expect,
            lock_dir,
            timeout,
        )?,
        GraphCommand::Remove {
            fragment_id,
            node_id,
            expect,
        } => graph::run_remove(
            &vault,
            &fragment_id,
            &node_id,
            &expect,
            lock_dir,
            timeout,
        )?,
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FindMode {
    Search,
    Edit,
    Interactive,
}

struct FindArgs {
    terms: Vec<String>,
    limit: usize,
    json: bool,
    vault: Option<String>,
    external: bool,
}

/// `-s` / `-e` 之后的参数：选项可以写在关键词前后，`--` 之后全部按关键词处理。
fn parse_find_args(mode: FindMode, args: Vec<String>) -> Result<FindArgs, CliError> {
    let mut parsed = FindArgs {
        terms: Vec::new(),
        limit: find::DEFAULT_LIMIT,
        json: false,
        vault: None,
        external: false,
    };
    let mut args = args.into_iter();
    let search_only = |name: &str| -> Result<(), CliError> {
        if mode == FindMode::Search {
            Ok(())
        } else {
            Err(format!("{name} 只能用于搜索").into())
        }
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--" => {
                parsed.terms.extend(args.by_ref());
                break;
            }
            "-n" | "--limit" => {
                search_only(&arg)?;
                let value = args.next().ok_or("--limit 需要一个数字")?;
                parsed.limit = parse_limit(&value)?;
            }
            other if other.starts_with("--limit=") => {
                search_only("--limit")?;
                parsed.limit = parse_limit(&other["--limit=".len()..])?;
            }
            "--json" => {
                search_only("--json")?;
                parsed.json = true;
                JSON_OUTPUT.store(true, Ordering::Relaxed);
            }
            "--external" if mode == FindMode::Edit => parsed.external = true,
            "--external" => return Err("--external 只能与 -e 一起使用".into()),
            "--vault" => parsed.vault = Some(args.next().ok_or("--vault 需要一个路径")?),
            other if other.starts_with("--vault=") => {
                parsed.vault = Some(other["--vault=".len()..].to_string());
            }
            _ => parsed.terms.push(arg),
        }
    }
    Ok(parsed)
}

fn parse_limit(value: &str) -> Result<usize, CliError> {
    value
        .parse::<usize>()
        .ok()
        .filter(|limit| *limit > 0)
        .ok_or_else(|| "--limit 必须是正整数".into())
}

fn run_find(
    mode: FindMode,
    args: Vec<String>,
    vault_arg: Option<String>,
    external: bool,
    json: bool,
) -> Result<(), CliError> {
    let mut args = parse_find_args(mode, args)?;
    if json {
        if mode != FindMode::Search {
            return Err("--json 只能用于搜索".into());
        }
        args.json = true;
    }
    if external && mode != FindMode::Edit {
        return Err("--external 只能与 -e 一起使用".into());
    }
    if mode == FindMode::Interactive && !(io::stdin().is_terminal() && io::stdout().is_terminal()) {
        return Err("交互界面需要在终端中运行".into());
    }
    let vault = resolve_vault(args.vault.or(vault_arg))?;
    let query = args.terms.join(" ");
    if mode == FindMode::Interactive {
        return tui::run(&vault, Some(&query), None, &lock_dir()?, lock_timeout()?)
            .map_err(Into::into);
    }
    let entries = find::load_entries(&vault)?;

    if mode == FindMode::Search {
        let outcome = find::search(&entries, &query, args.limit)?;
        if args.json {
            println!("{}", find::hits_json(&outcome.hits, &vault));
            return Ok(());
        }
        if outcome.hits.is_empty() {
            return Err(if query.trim().is_empty() {
                "资料库里还没有碎片".into()
            } else {
                format!("没有找到包含「{}」的碎片", query.trim()).into()
            });
        }
        find::remember_search(&vault, &query, &outcome.hits);
        let terminal = io::stdout().is_terminal();
        println!(
            "{}",
            find::format_hits(&outcome.hits, &find::Style::for_stream(terminal))
        );
        if terminal {
            let shown = outcome.hits.len();
            let summary = if outcome.total > shown {
                format!("共 {} 条，列出前 {shown} 条（-n 调整）", outcome.total)
            } else {
                format!("共 {shown} 条")
            };
            eprintln!("{summary} · shard -e <序号> 编辑");
        }
        return Ok(());
    }

    if !external && !args.external && io::stdin().is_terminal() && io::stdout().is_terminal() {
        let entry = match find::select(&entries, &vault, &args.terms, false)? {
            find::Selection::Found(entry) => entry,
            find::Selection::Ambiguous(_) => {
                return tui::run(&vault, Some(&query), None, &lock_dir()?, lock_timeout()?)
                    .map_err(Into::into);
            }
        };
        return tui::run(&vault, None, Some(&entry.id), &lock_dir()?, lock_timeout()?)
            .map_err(Into::into);
    }

    let has_editor = ["VISUAL", "EDITOR"]
        .iter()
        .any(|name| env::var(name).is_ok_and(|value| !value.trim().is_empty()));
    let interactive = io::stdin().is_terminal() && io::stdout().is_terminal();
    if !has_editor && !interactive {
        return Err("非交互环境没有可用的编辑器。脚本与 AI 助手请用 shard --read / --update / --append（见 shard --agent-guide）".into());
    }
    let entry = match find::select(&entries, &vault, &args.terms, true)? {
        find::Selection::Found(entry) => entry,
        find::Selection::Ambiguous(total) => {
            return Err(format!("匹配到 {total} 条，用 shard -e <序号> 选择其中一条").into())
        }
    };
    eprintln!("编辑 {}  {}", find::short_id(&entry.id), entry.title);
    match edit::edit_fragment(&vault, entry, &lock_dir()?, lock_timeout()?) {
        Ok(edit::EditOutcome::Saved) => {
            println!("已保存：{}", entry.relative_path(&vault));
            Ok(())
        }
        Ok(edit::EditOutcome::Unchanged) => {
            println!("没有改动");
            Ok(())
        }
        Err(failure) => Err(CliError::new(
            if failure.code == 2 { "CONFLICT" } else { "ERROR" },
            failure.message,
        )),
    }
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
    let _lock = VaultProcessLock::acquire(&lock_dir()?, &vault, Some(lock_timeout()?))
        .map_err(agent::lock_error)?;
    let limits = DatasetLimits::default();
    let current =
        read_dataset(&FsVfs::new(&vault), path, &limits).map_err(|error| error.to_string())?;
    if current.table.header != request.expected_header {
        return Err(CliError::new("HEADER_CHANGED", "表头已变化"));
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
                return Err(CliError::new("KEY_CONFLICT", "主键冲突"));
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
            &FsVfs::new(&vault),
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

#[cfg(test)]
mod tui_entry_tests {
    use super::*;

    #[test]
    fn external_flag_is_only_for_edit() {
        let edit = parse_find_args(FindMode::Edit, vec!["--external".into(), "目标".into()])
            .ok()
            .unwrap();
        assert!(edit.external);
        assert_eq!(edit.terms, vec!["目标"]);
        assert!(parse_find_args(FindMode::Search, vec!["--external".into()]).is_err());
        assert!(parse_find_args(FindMode::Interactive, vec!["--external".into()]).is_err());
    }
}
