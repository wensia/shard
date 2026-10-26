//! 远程模式的本机配置。
//!
//! - 服务器地址、设备 id 与设备名：`<状态目录>/remote.json`（状态目录 = `SHARD_CLI_STATE_DIR`，
//!   缺省 `<App 配置目录>/cli`，与「上次搜索」同一个目录）。
//! - 设备令牌：macOS 存登录钥匙串（通用密码，服务 `dev.shard.cli`、账户为服务器地址）；其他系统
//!   或设置 `SHARD_TOKEN_STORE=file`（测试用）时存 `<状态目录>/remote-token-<sha256(服务器地址) 前 16 位>`，
//!   权限 0600。两种方式都按服务器区分：切换服务器时先存新令牌、再删旧服务器的，不会删错。

use serde::{Deserialize, Serialize};
use shard_core::vault_lock::app_config_dir;
use std::{
    env, fs,
    io::{self, Write},
    path::PathBuf,
};

const CONFIG_FILE: &str = "remote.json";
const TOKEN_FILE_PREFIX: &str = "remote-token";
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "dev.shard.cli";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    /// 规范化的站点地址（`https://shard.example.com`，无结尾斜杠）。
    pub server: String,
    pub device_id: String,
    /// 配对时服务器记下的设备名（网页「设置 → 设备」里显示的名字）。
    pub name: String,
}

pub fn state_dir() -> Option<PathBuf> {
    env::var_os("SHARD_CLI_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| app_config_dir().map(|dir| dir.join("cli")))
}

fn config_path() -> Result<PathBuf, String> {
    state_dir()
        .map(|dir| dir.join(CONFIG_FILE))
        .ok_or_else(|| "无法确定 shard 的配置目录".to_string())
}

pub fn config_location() -> Option<PathBuf> {
    config_path().ok()
}

pub fn load_config() -> Result<Option<RemoteConfig>, String> {
    let path = config_path()?;
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取 {} 失败：{error}", path.display())),
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| format!("{} 无法解析：{error}。可以运行 shard logout 后重新登录", path.display()))
}

pub fn save_config(config: &RemoteConfig) -> Result<(), String> {
    let path = config_path()?;
    let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    write_private(&path, text.as_bytes())
}

fn use_keychain() -> bool {
    cfg!(target_os = "macos") && env::var("SHARD_TOKEN_STORE").as_deref() != Ok("file")
}

/// 令牌存放位置的说明（`shard --whoami` 显示）。
pub fn token_location(server: &str) -> String {
    if use_keychain() {
        "macOS 钥匙串".to_string()
    } else {
        token_path(server)
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| token_file_name(server))
    }
}

/// 文件后备的令牌文件名：按服务器地址区分。
pub fn token_file_name(server: &str) -> String {
    format!("{TOKEN_FILE_PREFIX}-{}", &shard_core::sha256_hex(server.as_bytes())[..16])
}

fn token_path(server: &str) -> Result<PathBuf, String> {
    state_dir()
        .map(|dir| dir.join(token_file_name(server)))
        .ok_or_else(|| "无法确定 shard 的配置目录".to_string())
}

pub fn save_token(server: &str, token: &str) -> Result<(), String> {
    if use_keychain() {
        return keychain::save(server, token);
    }
    write_private(&token_path(server)?, token.as_bytes())
}

pub fn load_token(server: &str) -> Result<Option<String>, String> {
    if use_keychain() {
        return keychain::load(server);
    }
    let path = token_path(server)?;
    match fs::read_to_string(&path) {
        Ok(token) => Ok(Some(token.trim().to_string()).filter(|token| !token.is_empty())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取 {} 失败：{error}", path.display())),
    }
}

pub fn delete_token(server: &str) -> Result<(), String> {
    if use_keychain() {
        return keychain::delete(server);
    }
    remove_if_exists(&token_path(server)?)
}

/// 不知道服务器地址时（`remote.json` 损坏）尽量删掉本机的全部 shard 令牌：
/// 文件后备删状态目录里所有 `remote-token*`；钥匙串删服务 `dev.shard.cli` 下的全部条目。
pub fn wipe_tokens() -> Result<usize, String> {
    if use_keychain() {
        return keychain::wipe();
    }
    let Some(dir) = state_dir() else {
        return Ok(0);
    };
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("读取 {} 失败：{error}", dir.display())),
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(TOKEN_FILE_PREFIX) {
            remove_if_exists(&entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// 删掉配置文件（不解析内容，损坏时也能删）。
pub fn remove_config_file() -> Result<(), String> {
    remove_if_exists(&config_path()?)
}

fn remove_if_exists(path: &PathBuf) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除 {} 失败：{error}", path.display())),
    }
}

/// 只有本人可读写（0600）：先写同目录临时文件再改名，不会留下半截或权限过宽的文件。
fn write_private(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("配置路径无效")?;
    fs::create_dir_all(parent).map_err(|error| format!("创建 {} 失败：{error}", parent.display()))?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|name| name.to_str()).unwrap_or("shard"),
        std::process::id()
    ));
    let written = (|| -> io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    written.map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("写入 {} 失败：{error}", path.display())
    })
}

#[cfg(target_os = "macos")]
mod keychain {
    use super::KEYCHAIN_SERVICE;
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    /// errSecItemNotFound
    const NOT_FOUND: i32 = -25300;

    pub fn save(server: &str, token: &str) -> Result<(), String> {
        set_generic_password(KEYCHAIN_SERVICE, server, token.as_bytes())
            .map_err(|error| format!("把令牌存进钥匙串失败：{error}"))
    }

    pub fn load(server: &str) -> Result<Option<String>, String> {
        match get_generic_password(KEYCHAIN_SERVICE, server) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "钥匙串里的 shard 令牌已损坏，请重新运行 shard login".to_string()),
            Err(error) if error.code() == NOT_FOUND => Ok(None),
            Err(error) => Err(format!("从钥匙串读取令牌失败：{error}")),
        }
    }

    pub fn delete(server: &str) -> Result<(), String> {
        match delete_generic_password(KEYCHAIN_SERVICE, server) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == NOT_FOUND => Ok(()),
            Err(error) => Err(format!("从钥匙串删除令牌失败：{error}")),
        }
    }

    /// 删掉服务 `dev.shard.cli` 下的全部条目（按账户逐个删）。
    pub fn wipe() -> Result<usize, String> {
        use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
        let found = ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(KEYCHAIN_SERVICE)
            .load_attributes(true)
            .limit(Limit::All)
            .search();
        let results = match found {
            Ok(results) => results,
            Err(error) if error.code() == NOT_FOUND => return Ok(0),
            Err(error) => return Err(format!("查找钥匙串里的 shard 令牌失败：{error}")),
        };
        let mut removed = 0;
        for account in results.iter().filter_map(|result| result.simplify_dict()?.get("acct").cloned()) {
            delete(&account)?;
            removed += 1;
        }
        Ok(removed)
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    pub fn save(_server: &str, _token: &str) -> Result<(), String> {
        Err("这个系统没有钥匙串".to_string())
    }

    pub fn load(_server: &str) -> Result<Option<String>, String> {
        Ok(None)
    }

    pub fn delete(_server: &str) -> Result<(), String> {
        Ok(())
    }

    pub fn wipe() -> Result<usize, String> {
        Ok(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn private_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested/remote-token");
        write_private(&path, b"shd_dev_x").unwrap();
        write_private(&path, b"shd_dev_y").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "shd_dev_y");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1, "不留临时文件");
    }
}
