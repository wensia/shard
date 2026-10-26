//! `shard login [<服务器>]`、`shard logout`、`shard --whoami`。
//!
//! 登录走设备配对（RFC 8628 式）：`POST /api/device/start {name, kind:"cli"}` 拿到配对码，用户在浏览器
//! `<服务器>/pair` 输入并批准（需要通行密钥），CLI 轮询 `POST /api/device/token` 换到设备令牌。
//! 令牌只在这台机器上（钥匙串或 0600 文件），服务器只存它的哈希，可在网页「设置 → 设备」里单独吊销。
//!
//! 登录与退出会改变之后所有命令读写的去处，只能由用户本人在终端里运行：标准输入与输出都必须是终端，
//! 否则拒绝（防止被提示注入的 AI 一条命令就把读写转到别的服务器）；改登另一台服务器时还要输入 y 确认。

use super::{agent, normalize_server, post_json, store, Remote, RemoteConfig};
use crate::{agent::print_json, CliError};
use serde_json::{json, Value};
use std::{
    env,
    io::{self, BufRead, IsTerminal, Write},
    path::PathBuf,
    process::Command,
    thread,
    time::{Duration, Instant},
};

pub const USAGE: &str = "\
用法:
  shard login <服务器地址> [--name <设备名>]   与 Shard 服务器配对（在浏览器里用通行密钥批准）
  shard login --name <设备名> <服务器地址>
  shard login                                  重新登录当前的服务器
  shard logout                                 删除本机的登录令牌，回到本地模式

登录与退出只能由你本人在终端里运行。服务器地址形如 https://shard.example.com
（只写站点；明文 http 只允许本机地址）。要记一条以 login/logout 开头的碎片，写 shard -- login …";

/// 只给自动化测试用：允许在非终端里登录、退出。
const TEST_ALLOW_NONINTERACTIVE: &str = "SHARD_CLI_TEST_ALLOW_NONINTERACTIVE_LOGIN";

fn require_terminal(action: &str) -> Result<(), CliError> {
    if env::var(TEST_ALLOW_NONINTERACTIVE).as_deref() == Ok("1")
        || (io::stdin().is_terminal() && io::stdout().is_terminal())
    {
        return Ok(());
    }
    Err(CliError::new(
        "ERROR",
        format!(
            "shard {action} 会改变之后所有命令读写的服务器，只能由你本人在终端里运行。请打开终端手动执行 shard {action}。"
        ),
    ))
}

fn confirm(prompt: &str) -> Result<bool, CliError> {
    eprint!("{prompt}");
    io::stderr().flush().ok();
    let mut answer = String::new();
    io::stdin()
        .lock()
        .read_line(&mut answer)
        .map_err(|error| format!("读取输入失败：{error}"))?;
    Ok(matches!(answer.trim(), "y" | "Y" | "yes" | "YES" | "Yes"))
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
    let agent = agent();
    let unreachable = |message: String| {
        CliError::new("NETWORK", format!("连不上 Shard 服务器 {server}（{message}）。请检查地址与网络。"))
    };

    let (status, text) = post_json(
        &agent,
        &format!("{server}/api/device/start"),
        &[],
        &json!({ "name": name, "kind": "cli" }),
    )
    .map_err(unreachable)?;
    let start = response_json(status, &text, &server)?;
    let field = |key: &str| {
        start[key]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| CliError::from(format!("{server} 的配对响应缺少 {key}，它可能不是 Shard 服务器")))
    };
    let device_code = field("deviceCode")?;
    let user_code = field("userCode")?;
    let verification = field("verificationUri")?;
    let expires_in = start["expiresIn"].as_u64().unwrap_or(600);
    let mut interval = poll_interval(start["interval"].as_u64().unwrap_or(3));

    println!("在浏览器打开 {verification} 输入配对码 {user_code}");
    eprintln!(
        "等待在浏览器里批准（{} 分钟内有效，Ctrl+C 取消）…",
        expires_in.div_ceil(60).max(1)
    );

    let deadline = Instant::now() + Duration::from_secs(expires_in + 5);
    let mut failures = 0;
    let issued = loop {
        if Instant::now() >= deadline {
            return Err("配对已过期，请重新运行 shard login".into());
        }
        thread::sleep(interval);
        let polled = post_json(
            &agent,
            &format!("{server}/api/device/token"),
            &[],
            &json!({ "deviceCode": device_code }),
        );
        // 网络抖动或网关临时不可用（服务重启）：配对码还有效，退避后再试；一直不行就放弃。
        let (status, text) = match polled {
            Ok((status @ 502..=504, _)) => {
                failures += 1;
                if failures >= 10 {
                    return Err(unreachable(format!("服务器暂时不可用（HTTP {status}）")));
                }
                interval = (interval * 2).min(Duration::from_secs(30));
                continue;
            }
            Err(message) => {
                failures += 1;
                if failures >= 10 {
                    return Err(unreachable(message));
                }
                interval = (interval * 2).min(Duration::from_secs(30));
                continue;
            }
            Ok(response) => response,
        };
        failures = 0;
        match status {
            200 => break response_json(status, &text, &server)?,
            428 => continue,
            429 => interval += Duration::from_secs(2),
            410 => return Err("配对已过期或被拒绝，请重新运行 shard login".into()),
            _ => {
                response_json(status, &text, &server)?;
            }
        }
    };
    let token = issued["token"]
        .as_str()
        .filter(|token| !token.is_empty())
        .ok_or("服务器没有返回设备令牌")?;
    let config = RemoteConfig {
        server: server.clone(),
        device_id: issued["deviceId"].as_str().unwrap_or_default().to_string(),
        name: issued["name"].as_str().unwrap_or(&name).to_string(),
    };

    // 先存新令牌与配置，再删旧服务器的令牌：令牌按服务器区分存放，不会删到刚存的新令牌。
    store::save_token(&server, token)?;
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

fn response_json(status: u16, text: &str, server: &str) -> Result<Value, CliError> {
    let body = serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    if status == 200 {
        return if body.is_object() {
            Ok(body)
        } else {
            Err(format!("{server} 的响应不是 JSON，它可能不是 Shard 服务器").into())
        };
    }
    let message = body["message"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| format!("服务器返回 HTTP {status}"));
    Err(format!("配对失败：{message}").into())
}

/// 服务器建议的轮询间隔；`SHARD_LOGIN_POLL_MS` 只给测试缩短等待。
fn poll_interval(seconds: u64) -> Duration {
    env::var("SHARD_LOGIN_POLL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_secs(seconds.clamp(1, 30)))
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
