//! Shard 终端快捷创建与读写。两种模式：
//! - 本地模式：直接读写资料库目录，App 不运行也能用；提交交给 App 的检查点，运行中的 App
//!   监听到文件变化后实时刷新。显式 `--vault` / `SHARD_VAULT`，或没有登录服务器时使用。
//! - 远程模式：`shard login <服务器>` 配对之后，所有读写调服务器的 RPC（`remote`），本机不碰 vault 文件。
//!
//! 给 AI 助手的非交互读写在 `agent`（本地）与 `remote::ops`（远程），使用说明与 skill 安装在 `guide`。

mod agent;
mod edit;
mod find;
mod graph;
mod guide;
mod parse;
mod remote;
mod tui;

use serde::Deserialize;
use shard_core::{
    create_public_fragment_in_vault,
    default_vault_path,
    frontmatter::parse_fragment,
    graph_model::content_sha256_hex,
    vault_lock::{app_settings_path, cli_lock_dir, VaultProcessLock},
    AppConfig, FsVfs,
};
use shard_vault::cli::{append_dataset_records, DatasetAppendError};
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
  shard login <服务器地址> [--name <设备名>]   与 Shard 服务器配对，之后的命令都读写服务器
  shard logout                       删除本机登录令牌（回到本地模式）
  shard --whoami [--json]            显示当前是远程还是本地模式
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

远程模式:
  登录服务器后，上面所有命令不变，读写都发往服务器；本机不再需要资料库目录。
  显式给出 --vault 或 SHARD_VAULT 时临时改用本地资料库。
  login / logout 只能由你本人在终端里运行；要记一条以 login/logout 开头的碎片，写成 shard -- login …

选项:
  --vault <路径>   使用本地资料库（默认：已登录服务器时用服务器，否则读 Shard 设置，或 SHARD_VAULT）
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
pub struct AppendInput {
    pub expected_header: Vec<String>,
    pub records: Vec<HashMap<String, String>>,
}

fn run() -> Result<(), CliError> {
    let raw = env::args().skip(1).collect::<Vec<_>>();
    if let Some(result) = account_command(&raw) {
        return result;
    }
    let mut args = raw.into_iter().peekable();
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
            "--whoami" => {
                args.next();
                for arg in args.by_ref() {
                    match arg.as_str() {
                        "--json" => {
                            json = true;
                            JSON_OUTPUT.store(true, Ordering::Relaxed);
                        }
                        other => return Err(format!("--whoami 不接受参数：{other}").into()),
                    }
                }
                let local = explicit_local(vault_arg.as_ref());
                return remote::login::whoami(local, || resolve_vault(vault_arg), json);
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
                let json = json || parsed.json;
                let source = parsed.source.or(source_arg);
                return match backend(parsed.vault.or(vault_arg))? {
                    Backend::Local(vault) => {
                        let context = agent::Context {
                            vault,
                            lock_dir: lock_dir()?,
                            timeout: lock_timeout()?,
                            json,
                            source: resolve_source(source)?,
                        };
                        agent::run(parsed.command, &context)
                    }
                    Backend::Remote(remote) => {
                        remote::ops::run_agent(parsed.command, &remote, json, explicit_source(source)?)
                    }
                };
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
        return match backend(vault_arg)? {
            Backend::Local(vault) => run_graph(command, vault),
            Backend::Remote(remote) => remote::ops::run_graph(command, &remote),
        };
    }
    if let Some(path) = append_path {
        if !content.is_empty() {
            return Err("--append-dataset 不能与碎片内容同时使用".into());
        }
        let request = read_append_input()?;
        return match backend(vault_arg)? {
            Backend::Local(vault) => append_dataset(&path, request, &vault),
            Backend::Remote(remote) => remote::ops::append_dataset(&remote, &path, request),
        };
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
    let source = explicit_source(source_arg)?;
    let vault = match backend(vault_arg)? {
        Backend::Local(vault) => vault,
        Backend::Remote(remote) => return remote::ops::create_fragment(&remote, &body, tags, source, json),
    };
    let source = source.unwrap_or_else(|| "cli".to_string());
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
    Ok(explicit_source(explicit)?.unwrap_or_else(|| "cli".to_string()))
}

/// 显式给出的来源（`--source` 或 `SHARD_SOURCE`），校验后返回；没给返回 `None`。
/// 远程模式下没给就不传，由服务器按设备种类记为 cli。
fn explicit_source(explicit: Option<String>) -> Result<Option<String>, CliError> {
    let Some(source) = explicit.or_else(|| env::var("SHARD_SOURCE").ok()) else {
        return Ok(None);
    };
    let source = source.trim();
    if source.is_empty() {
        return Ok(None);
    }
    if !shard_vault::cli::valid_source(source) {
        return Err("--source 必须是不超过 40 个字符的单行名称".into());
    }
    Ok(Some(source.to_string()))
}

/// 读写的去处：本地资料库目录，或登录过的服务器。
enum Backend {
    Local(PathBuf),
    Remote(remote::Remote),
}

impl Backend {
    /// 「上次搜索」属于哪个资料库：本地是 vault 路径，远程是服务器地址。
    fn scope(&self) -> String {
        match self {
            Self::Local(vault) => find::local_scope(vault),
            Self::Remote(remote) => remote::ops::scope(remote),
        }
    }

    fn entries(&self) -> Result<Vec<find::FragmentEntry>, CliError> {
        match self {
            Self::Local(vault) => Ok(find::load_entries(vault)?),
            Self::Remote(remote) => remote::ops::load_entries(remote),
        }
    }

    fn store(&self) -> Result<Box<dyn tui::app::Store>, CliError> {
        Ok(match self {
            Self::Local(vault) => Box::new(tui::store::VaultStore::new(vault, &lock_dir()?, lock_timeout()?)),
            Self::Remote(remote) => Box::new(remote::ops::RemoteStore::new(remote.clone())),
        })
    }
}

/// 显式指定了本地资料库：`--vault` 或非空的 `SHARD_VAULT`（迁移与测试用）。
fn explicit_local(vault_arg: Option<&String>) -> bool {
    vault_arg.is_some() || env::var("SHARD_VAULT").is_ok_and(|value| !value.trim().is_empty())
}

/// 显式指定本地资料库时用本地；否则登录过服务器就用服务器；都没有时退回本地（读 App 设置）。
fn backend(vault_arg: Option<String>) -> Result<Backend, CliError> {
    if !explicit_local(vault_arg.as_ref()) {
        if let Some(remote) = remote::Remote::load()? {
            return Ok(Backend::Remote(remote));
        }
    }
    Ok(Backend::Local(resolve_vault(vault_arg)?))
}

/// 账号命令只认这几种确切的形状：`login`、`login <地址>`、`login <地址> --name 名`、`login --name 名 <地址>`、
/// `login --help`、`logout`、`logout --help`。首词是 login / logout 且带了 `--name` / `--help` / `-h`
/// 但形状不对，或 `logout` 后面只跟一个词时，报用法错误（不落成碎片）；其余照常是碎片内容
/// （例如 login 后面跟几个普通词）。要记一条以 login / logout 开头的碎片，写 `shard -- login …`。
fn account_command(raw: &[String]) -> Option<Result<(), CliError>> {
    Some(match parse_account(raw)? {
        Account::Login { server, name } => remote::login::login(server.as_deref(), name),
        Account::Logout => remote::login::logout(),
        Account::Help => {
            println!("{}", remote::login::USAGE);
            Ok(())
        }
        Account::Usage(command) => Err(format!("shard {command} 的参数不对。\n{}", remote::login::USAGE).into()),
    })
}

#[derive(Debug, PartialEq, Eq)]
enum Account {
    Login { server: Option<String>, name: Option<String> },
    Logout,
    Help,
    Usage(&'static str),
}

/// 只解析形状（不执行）；`None` 表示这是碎片内容。
fn parse_account(raw: &[String]) -> Option<Account> {
    let (first, rest) = raw.split_first()?;
    let command = match first.as_str() {
        "login" => "login",
        "logout" => "logout",
        _ => return None,
    };
    let is_help = |arg: &str| arg == "--help" || arg == "-h";
    let has_flag = rest
        .iter()
        .any(|arg| is_help(arg) || arg == "--name" || arg.starts_with("--name="));
    if let [only] = rest {
        if is_help(only) {
            return Some(Account::Help);
        }
    }
    if command == "logout" {
        return match rest {
            [] => Some(Account::Logout),
            [_] => Some(Account::Usage(command)),
            _ if has_flag => Some(Account::Usage(command)),
            _ => None,
        };
    }
    if rest.is_empty() {
        return Some(Account::Login { server: None, name: None });
    }
    let mut name = None;
    let mut positional = Vec::new();
    let mut args = rest.iter();
    while let Some(arg) = args.next() {
        if arg == "--name" {
            match args.next() {
                Some(value) if name.is_none() => name = Some(value.clone()),
                _ => return Some(Account::Usage(command)),
            }
        } else if let Some(value) = arg.strip_prefix("--name=") {
            if name.is_some() {
                return Some(Account::Usage(command));
            }
            name = Some(value.to_string());
        } else if is_help(arg) {
            return Some(Account::Usage(command));
        } else {
            positional.push(arg.as_str());
        }
    }
    match positional.as_slice() {
        [server] if looks_like_server(server) => Some(Account::Login { server: Some(server.to_string()), name }),
        _ if has_flag => Some(Account::Usage(command)),
        _ => None,
    }
}

/// 像不像服务器地址：ASCII、无空白，是 `http(s)://主机[:端口][/…]` 或 `主机[:端口]`，
/// 主机是 localhost、IP，或含点且每段都是合法域名标签。
fn looks_like_server(value: &str) -> bool {
    if !value.is_ascii() || value.is_empty() || value.contains(char::is_whitespace) {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    let authority = if let Some(rest) = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")) {
        rest.split(['/', '?', '#']).next().unwrap_or_default().to_string()
    } else {
        lower
    };
    valid_authority(&authority)
}

fn valid_authority(authority: &str) -> bool {
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let Some((inside, after)) = rest.split_once(']') else {
            return false;
        };
        if inside.parse::<std::net::Ipv6Addr>().is_err() {
            return false;
        }
        match after {
            "" => return true,
            _ => match after.strip_prefix(':') {
                Some(port) => (None, Some(port)),
                None => return false,
            },
        }
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => (Some(host), Some(port)),
            None => (Some(authority), None),
        }
    };
    if let Some(port) = port {
        if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) || port.parse::<u16>().map_or(true, |port| port == 0) {
            return false;
        }
    }
    let Some(host) = host else {
        return true;
    };
    if host == "localhost" || host.parse::<std::net::Ipv4Addr>().is_ok() {
        return true;
    }
    host.contains('.')
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
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

fn run_graph(command: graph::GraphCommand, vault: PathBuf) -> Result<(), CliError> {
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
    let terminal = io::stdin().is_terminal() && io::stdout().is_terminal();
    if mode == FindMode::Interactive && !terminal {
        return Err("交互界面需要在终端中运行".into());
    }
    let backend = backend(args.vault.take().or(vault_arg))?;
    let query = args.terms.join(" ");
    if mode == FindMode::Search {
        return match &backend {
            Backend::Local(vault) => search_local(vault, &query, args.limit, args.json),
            Backend::Remote(remote) => remote::ops::search(remote, &query, args.limit, args.json),
        };
    }
    if mode == FindMode::Interactive {
        return tui::run(backend.entries()?, backend.store()?, Some(&query), None).map_err(Into::into);
    }

    if !external && !args.external && terminal {
        let entries = backend.entries()?;
        let id = match find::select(&entries, &backend.scope(), &args.terms, false)? {
            find::Selection::Found(entry) => entry.id.clone(),
            find::Selection::Ambiguous(_) => {
                return tui::run(entries, backend.store()?, Some(&query), None).map_err(Into::into);
            }
        };
        return tui::run(entries, backend.store()?, None, Some(&id)).map_err(Into::into);
    }

    let has_editor = ["VISUAL", "EDITOR"]
        .iter()
        .any(|name| env::var(name).is_ok_and(|value| !value.trim().is_empty()));
    if !has_editor && !terminal {
        return Err("非交互环境没有可用的编辑器。脚本与 AI 助手请用 shard --read / --update / --append（见 shard --agent-guide）".into());
    }
    // 远程模式下目标确定（id、序号、最近一条）时只取这一篇，不先下载整个资料库。
    let quick = match &backend {
        Backend::Remote(remote) => remote::ops::quick_entry(remote, &args.terms)?,
        Backend::Local(_) => None,
    };
    let entries;
    let entry = match quick {
        Some(found) => {
            entries = vec![found];
            &entries[0]
        }
        None => {
            entries = backend.entries()?;
            match find::select(&entries, &backend.scope(), &args.terms, true)? {
                find::Selection::Found(entry) => entry,
                find::Selection::Ambiguous(total) => {
                    return Err(format!("匹配到 {total} 条，用 shard -e <序号> 选择其中一条").into())
                }
            }
        }
    };
    eprintln!("编辑 {}  {}", find::short_id(&entry.id), entry.title);
    let mut store = backend.store()?;
    match edit::edit_fragment(store.as_mut(), entry) {
        Ok(edit::EditOutcome::Saved) => {
            println!("已保存：{}", entry.path);
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

fn search_local(vault: &Path, query: &str, limit: usize, json: bool) -> Result<(), CliError> {
    let entries = find::load_entries(vault)?;
    let outcome = find::search(&entries, query, limit)?;
    if json {
        println!("{}", find::hits_json(&outcome.hits));
        return Ok(());
    }
    find::print_hits(&find::local_scope(vault), query, &outcome.hits, outcome.total)?;
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

/// `--append-dataset` 从标准输入读的 JSON：`{expectedHeader, records}`。
fn read_append_input() -> Result<AppendInput, CliError> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("读取标准输入失败：{error}"))?;
    serde_json::from_str(&input).map_err(|error| format!("追加记录 JSON 无效：{error}").into())
}

/// 按主键幂等追加：同主键同内容跳过，同主键不同内容整批拒绝。规则在 `shard_vault::cli`，
/// 服务端的 `append_dataset_records` 用同一份。
fn append_dataset(path: &str, request: AppendInput, vault: &Path) -> Result<(), CliError> {
    let _lock = VaultProcessLock::acquire(&lock_dir()?, vault, Some(lock_timeout()?))
        .map_err(agent::lock_error)?;
    let appended = append_dataset_records(
        &FsVfs::new(vault),
        path,
        &request.expected_header,
        request.records,
    )
    .map_err(dataset_append_error)?;
    println!(
        "{}",
        serde_json::json!({ "appended": appended.appended, "skipped": appended.skipped, "sha": appended.sha })
    );
    Ok(())
}

fn dataset_append_error(error: DatasetAppendError) -> CliError {
    let message = error.message();
    match error {
        DatasetAppendError::HeaderChanged => CliError::new("HEADER_CHANGED", message),
        DatasetAppendError::KeyConflict => CliError::new("KEY_CONFLICT", message),
        DatasetAppendError::Invalid(message) => message.into(),
    }
}

/// 依次：`--vault` → `SHARD_VAULT` → App 设置里的 `vaultPath` → `~/Documents/ShardVault`。
/// 与 App 的 `configured_vault_path` 同序，只是多了前两个显式覆盖。
fn resolve_vault(explicit: Option<String>) -> Result<PathBuf, String> {
    let candidate = match explicit.or_else(|| env::var("SHARD_VAULT").ok()) {
        Some(path) if !path.trim().is_empty() => expand_home(path.trim()),
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

    fn words(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    /// 只解析形状，不执行（单元测试里绝不能真的登录或退出用户的账号）。
    fn shape(values: &[&str]) -> Option<Account> {
        parse_account(&words(values))
    }

    fn login(server: Option<&str>, name: Option<&str>) -> Option<Account> {
        Some(Account::Login { server: server.map(str::to_string), name: name.map(str::to_string) })
    }

    #[test]
    fn only_exact_login_and_logout_shapes_are_account_commands() {
        assert_eq!(shape(&["login", "https://a.example.com"]), login(Some("https://a.example.com"), None));
        assert_eq!(
            shape(&["login", "a.example.com:8443", "--name", "工作电脑"]),
            login(Some("a.example.com:8443"), Some("工作电脑"))
        );
        assert_eq!(
            shape(&["login", "--name", "工作电脑", "https://a.example.com"]),
            login(Some("https://a.example.com"), Some("工作电脑"))
        );
        assert_eq!(shape(&["login", "--name=工作电脑", "localhost:8787"]), login(Some("localhost:8787"), Some("工作电脑")));
        assert_eq!(shape(&["login"]), login(None, None));
        assert_eq!(shape(&["logout"]), Some(Account::Logout));
        assert_eq!(shape(&["login", "--help"]), Some(Account::Help));
        assert_eq!(shape(&["logout", "-h"]), Some(Account::Help));
        // 带了参数标记但形状不对：用法错误，不落碎片。
        for wrong in [
            &["login", "--name", "工作电脑"][..],
            &["login", "https://a.example.com", "--name"],
            &["login", "https://a.example.com", "--help"],
            &["login", "--name", "甲", "今天", "登录了"],
            &["login", "--name", "甲", "--name", "乙", "a.example.com"],
            &["logout", "--name", "x"],
            &["logout", "now"],
        ] {
            assert!(matches!(shape(wrong), Some(Account::Usage(_))), "{wrong:?}");
        }
        // 其余是碎片。
        for fragment in [
            &["login", "今天", "登录了"][..],
            &["login", "github.com", "的二次验证坏了"],
            &["login", "失败"],
            &["logout", "了", "两次"],
            &["--", "login", "https://a.example.com"],
            &["记一下", "login"],
        ] {
            assert_eq!(shape(fragment), None, "{fragment:?}");
        }
    }

    #[test]
    fn server_like_arguments_are_strict() {
        for good in [
            "shard.example.com",
            "https://shard.example.com",
            "http://localhost:8787/",
            "localhost:8787",
            "127.0.0.1:9000",
            "[::1]:8787",
            "https://xn--fiq228c.example.com",
        ] {
            assert!(looks_like_server(good), "{good}");
        }
        for bad in [
            "一下",
            "v1.2 发布",
            "localhost:0",
            "example.com:99999",
            "-bad.example.com",
            "a..b",
            "noext",
            "github.com的",
            "https://",
            "example.com:",
            "",
        ] {
            assert!(!looks_like_server(bad), "{bad}");
        }
    }
}
