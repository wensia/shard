//! `shard login [<服务器>]`、`shard logout`、`shard --whoami`。
//!
//! 登录：在终端里输入邮箱与密码（密码不回显），`POST /api/device/login {email, password, name, kind:"cli"}`
//! 换到设备令牌。密码只用这一次，不保存；令牌只在这台机器上（钥匙串或 0600 文件），服务器只存它的哈希，
//! 可在网页「设置 → 设备」里单独吊销。
//!
//! 登录与退出会改变之后所有命令读写的去处，只能由用户本人在终端里运行：标准输入与输出都必须是终端，
//! 否则拒绝（防止被提示注入的 AI 一条命令就把读写转到别的服务器）；改登另一台服务器时还要输入 y 确认。

use super::{normalize_server, server_address_message, store, user_agent, Remote, RemoteConfig};
use crate::{agent::print_json, CliError};
use serde_json::{json, Value};
use shard_remote::{login_device, LoginError, LoginRequest};
use std::{
    env,
    io::{self, BufRead, IsTerminal, Write},
    path::PathBuf,
    process::Command,
};

pub const USAGE: &str = "\
用法:
  shard login <服务器地址> [--name <设备名>]   用邮箱和密码登录 Shard 服务器
  shard login --name <设备名> <服务器地址>
  shard login                                  重新登录当前的服务器
  shard logout                                 删除本机的登录令牌，回到本地模式

登录与退出只能由你本人在终端里运行。服务器地址形如 https://shard.example.com
（只写站点；明文 http 只允许本机地址）。要记一条以 login/logout 开头的碎片，写 shard -- login …";

/// 只给自动化测试用：允许在非终端里登录、退出（密码改从标准输入读一行）。
const TEST_ALLOW_NONINTERACTIVE: &str = "SHARD_CLI_TEST_ALLOW_NONINTERACTIVE_LOGIN";

fn testing() -> bool {
    env::var(TEST_ALLOW_NONINTERACTIVE).as_deref() == Ok("1")
}

fn require_terminal(action: &str) -> Result<(), CliError> {
    if testing() || (io::stdin().is_terminal() && io::stdout().is_terminal()) {
        return Ok(());
    }
    Err(CliError::new(
        "ERROR",
        format!(
            "shard {action} 会改变之后所有命令读写的服务器，只能由你本人在终端里运行。请打开终端手动执行 shard {action}。"
        ),
    ))
}

fn ask(prompt: &str) -> Result<String, CliError> {
    eprint!("{prompt}");
    io::stderr().flush().ok();
    let mut answer = String::new();
    io::stdin()
        .lock()
        .read_line(&mut answer)
        .map_err(|error| format!("读取输入失败：{error}"))?;
    Ok(answer.trim().to_string())
}

fn confirm(prompt: &str) -> Result<bool, CliError> {
    Ok(matches!(ask(prompt)?.as_str(), "y" | "Y" | "yes" | "YES" | "Yes"))
}

/// 密码不回显，直接从终端读；测试里从标准输入读一行。
fn ask_password() -> Result<String, CliError> {
    let password = if testing() {
        let mut line = String::new();
        io::stdin().lock().read_line(&mut line).map_err(|error| format!("读取输入失败：{error}"))?;
        line.trim_end_matches(['\r', '\n']).to_string()
    } else {
        rpassword::prompt_password("密码：").map_err(|error| format!("读取密码失败：{error}"))?
    };
    if password.is_empty() {
        return Err("没有输入密码，已取消。".into());
    }
    Ok(password)
}

/// `server` 为 `None` 时重新登录当前配置的服务器。
pub fn login(server: Option<&str>, name: Option<String>) -> Result<(), CliError> {
    require_terminal("login")?;
    // 配置损坏时当作没有：登录成功会覆盖它。
    let previous = store::load_config().ok().flatten();
    let server = match (server, &previous) {
        (Some(server), _) => normalize_server(server)?,
        (None, Some(previous)) => normalize_server(&previous.server)?,
        (None, None) => return Err(format!("还没有登录过服务器。\n{USAGE}").into()),
    };
    if let Some(previous) = previous.as_ref().filter(|previous| previous.server != server) {
        let question = format!(
            "当前登录的是 {}。\n要改为登录 {server} 吗？之后所有 shard 命令都会读写这台新服务器。输入 y 确认：",
            previous.server
        );
        if !confirm(&question)? {
            return Err(format!("已取消，仍使用 {}", previous.server).into());
        }
    }
    let name = name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(default_device_name);
    let email = ask("邮箱：")?;
    if email.is_empty() {
        return Err("没有输入邮箱，已取消。".into());
    }
    let password = ask_password()?;
    let request = LoginRequest { email: &email, password: &password, name: &name, kind: "cli" };
    let issued = login_device(&server, request, &user_agent()).map_err(|error| login_error(error, &server))?;
    let token = issued.token;
    let config = RemoteConfig { server: server.clone(), device_id: issued.device_id, name: issued.name };

    // 先存新令牌与配置，再删旧服务器的令牌：令牌按服务器区分存放，不会删到刚存的新令牌。
    store::save_token(&server, &token)?;
    store::save_config(&config)?;
    match previous {
        Some(previous) if previous.server != server => {
            let _ = store::delete_token(&previous.server);
            eprintln!(
                "已切换服务器。之前在 {} 上的设备「{}」（{}）仍然有效，不再使用的话请到那边的网页 设置 → 设备 吊销。",
                previous.server, previous.name, previous.device_id
            );
        }
        Some(previous) if previous.device_id != config.device_id => eprintln!(
            "这台电脑之前在 {server} 上的设备「{}」（{}）仍然有效，不再使用的话请到网页 设置 → 设备 吊销。",
            previous.name, previous.device_id
        ),
        _ => {}
    }
    println!(
        "已登录 {server}，设备名「{}」。之后的 shard 命令都直接读写这台服务器；\
         需要临时使用本地资料库时加 --vault 或设置 SHARD_VAULT。",
        config.name
    );
    Ok(())
}

pub fn logout() -> Result<(), CliError> {
    require_terminal("logout")?;
    match store::load_config() {
        Ok(None) => {
            println!("当前没有登录服务器（本地模式）。");
            Ok(())
        }
        Ok(Some(config)) => {
            store::delete_token(&config.server)?;
            store::remove_config_file()?;
            println!(
                "已退出 {}，本机的登录令牌已删除。\n请到网页「设置 → 设备」里吊销设备「{}」（{}），令牌在服务器上才会失效。",
                config.server, config.name, config.device_id
            );
            Ok(())
        }
        // 配置损坏：不知道是哪台服务器。照样删掉配置，并尽量删掉本机全部 shard 令牌。
        Err(message) => {
            store::remove_config_file()?;
            let tokens = match store::wipe_tokens() {
                Ok(count) => format!("已删除本机 {count} 个 shard 登录令牌。"),
                Err(error) => format!("删除登录令牌时出错：{error}。"),
            };
            println!(
                "远程配置已损坏（{message}），已删除，回到本地模式。{tokens}\n请到网页「设置 → 设备」里吊销这台电脑的设备。"
            );
            Ok(())
        }
    }
}

/// 当前是远程还是本地模式。远程模式顺带用 `server_status` 核对连接与令牌；核对失败时退出码非 0。
pub fn whoami(explicit_local: bool, local_vault: impl FnOnce() -> Result<PathBuf, String>, json: bool) -> Result<(), CliError> {
    let config = if explicit_local { None } else { store::load_config()? };
    let Some(config) = config else {
        let vault = local_vault();
        if json {
            print_json(&json!({
                "mode": "local",
                "vault": vault.as_ref().ok().map(|path| path.display().to_string()),
            }));
        } else {
            println!("本地模式");
            match &vault {
                Ok(path) => println!("资料库：{}", path.display()),
                Err(message) => println!("资料库：{message}"),
            }
            if !explicit_local {
                println!("（没有登录服务器；登录用 shard login <服务器地址>）");
            }
        }
        return vault.map(|_| ()).map_err(Into::into);
    };

    let checked: Result<Value, CliError> = Remote::load()
        .and_then(|remote| remote.ok_or_else(|| CliError::from("远程配置已失效")))
        .and_then(|remote| remote.read("server_status", json!({})).map_err(Into::into));
    if json {
        print_json(&json!({
            "mode": "remote",
            "server": config.server,
            "deviceId": config.device_id,
            "name": config.name,
            "tokenStore": store::token_location(&config.server),
            "connected": checked.is_ok(),
        }));
    } else {
        println!("远程模式");
        println!("服务器：{}", config.server);
        println!("设备：{}（{}）", config.name, config.device_id);
        println!("令牌：{}", store::token_location(&config.server));
        if let Some(path) = store::config_location() {
            println!("配置：{}", path.display());
        }
        println!("连接：{}", if checked.is_ok() { "正常" } else { "失败" });
    }
    checked.map(|_| ())
}

/// 登录失败 → 命令行的错误码与提示（带上服务器地址）。
fn login_error(error: LoginError, server: &str) -> CliError {
    match error {
        LoginError::InvalidServer(error) => server_address_message(error).into(),
        LoginError::Unreachable(message) => {
            CliError::new("NETWORK", format!("连不上 Shard 服务器 {server}（{message}）。请检查地址与网络。"))
        }
        LoginError::NotJson => format!("{server} 的响应不是 JSON，它可能不是 Shard 服务器").into(),
        LoginError::WrongCredentials(message) => format!("登录失败：{message}").into(),
        LoginError::SetupRequired(message) => {
            format!("{message}请先在服务器上运行 shard-server setup，用浏览器打开它给出的链接设置邮箱和密码。").into()
        }
        LoginError::RateLimited(message) => message.into(),
        LoginError::Rejected(message) => format!("登录失败：{message}").into(),
        LoginError::MissingToken => "服务器没有返回设备令牌".into(),
    }
}

/// 网页「设置 → 设备」里显示的名字：`shard 命令行 · <电脑名>`。
fn default_device_name() -> String {
    let host = if cfg!(target_os = "macos") {
        command_output("scutil", &["--get", "ComputerName"])
    } else {
        None
    }
    .or_else(|| command_output("hostname", &[]))
    .or_else(|| env::var("HOSTNAME").ok())
    .map(|host| host.trim().to_string())
    .filter(|host| !host.is_empty());
    match host {
        Some(host) => format!("shard 命令行 · {host}"),
        None => "shard 命令行".to_string(),
    }
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).to_string())
}
