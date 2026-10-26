//! 远程模式的本机配置（存取实现在 `shard_remote::CredentialStore`，这里只定位置与提示文案）。
//!
//! - 服务器地址、设备 id 与设备名：`<状态目录>/remote.json`（状态目录 = `SHARD_CLI_STATE_DIR`，
//!   缺省 `<App 配置目录>/cli`，与「上次搜索」同一个目录）。
//! - 设备令牌：macOS 存登录钥匙串（通用密码，服务 `dev.shard.cli`、账户为服务器地址）；其他系统
//!   或设置 `SHARD_TOKEN_STORE=file`（测试用）时存 `<状态目录>/remote-token-<sha256(服务器地址) 前 16 位>`，
//!   权限 0600。两种方式都按服务器区分：切换服务器时先存新令牌、再删旧服务器的，不会删错。

use shard_core::vault_lock::app_config_dir;
use shard_remote::{CredentialStore, RemoteConfig, StoreError, TokenBackend};
use std::{env, path::PathBuf};

/// 命令行的钥匙串服务名（桌面用自己的，互不影响）。
const KEYCHAIN_SERVICE: &str = "dev.shard.cli";

pub fn state_dir() -> Option<PathBuf> {
    env::var_os("SHARD_CLI_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| app_config_dir().map(|dir| dir.join("cli")))
}

fn credentials() -> CredentialStore {
    layout(state_dir(), env::var("SHARD_TOKEN_STORE").as_deref() == Ok("file"))
}

/// `remote.json` 与 `remote-token-*` 放在状态目录；令牌在 macOS 上进钥匙串，除非强制用文件。
fn layout(state_dir: Option<PathBuf>, force_file: bool) -> CredentialStore {
    let tokens = if force_file { TokenBackend::File } else { TokenBackend::platform_default(KEYCHAIN_SERVICE) };
    CredentialStore::new(state_dir, tokens)
}

/// 存取错误 → 提示（损坏时告诉用户用哪条命令恢复）。
fn message(error: StoreError) -> String {
    match &error {
        StoreError::ConfigCorrupt { .. } => format!("{error}。可以运行 shard logout 后重新登录"),
        StoreError::KeychainTokenCorrupt => "钥匙串里的 shard 令牌已损坏，请重新运行 shard login".to_string(),
        _ => error.to_string(),
    }
}

pub fn config_location() -> Option<PathBuf> {
    credentials().config_location()
}

pub fn load_config() -> Result<Option<RemoteConfig>, String> {
    credentials().load_config().map_err(message)
}

pub fn save_config(config: &RemoteConfig) -> Result<(), String> {
    credentials().save_config(config).map_err(message)
}

/// 令牌存放位置的说明（`shard --whoami` 显示）。
pub fn token_location(server: &str) -> String {
    credentials().token_location(server)
}

pub fn save_token(server: &str, token: &str) -> Result<(), String> {
    credentials().save_token(server, token).map_err(message)
}

pub fn load_token(server: &str) -> Result<Option<String>, String> {
    credentials().load_token(server).map_err(message)
}

pub fn delete_token(server: &str) -> Result<(), String> {
    credentials().delete_token(server).map_err(message)
}

/// 不知道服务器地址时（`remote.json` 损坏）尽量删掉本机的全部 shard 令牌：
/// 文件后备删状态目录里所有 `remote-token*`；钥匙串删服务 `dev.shard.cli` 下的全部条目。
pub fn wipe_tokens() -> Result<usize, String> {
    credentials().wipe_tokens().map_err(message)
}

/// 删掉配置文件（不解析内容，损坏时也能删）。
pub fn remove_config_file() -> Result<(), String> {
    credentials().remove_config_file().map_err(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(unix)]
    #[test]
    fn private_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let state = directory.path().join("nested");
        let store = layout(Some(state.clone()), true);
        store.save_token("https://shard.example.com", "shd_dev_x").unwrap();
        store.save_token("https://shard.example.com", "shd_dev_y").unwrap();
        // 已有用户的令牌文件名不变：remote-token-<sha256(服务器地址) 前 16 位>。
        let path = state.join(format!(
            "remote-token-{}",
            &shard_core::sha256_hex(b"https://shard.example.com")[..16]
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), "shd_dev_y");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read_dir(&state).unwrap().count(), 1, "不留临时文件");
        assert_eq!(store.config_location(), Some(state.join("remote.json")));
        if cfg!(target_os = "macos") {
            assert_eq!(*layout(None, false).tokens(), TokenBackend::Keychain { service: "dev.shard.cli".into() });
        }
        assert_eq!(
            message(StoreError::KeychainTokenCorrupt),
            "钥匙串里的 shard 令牌已损坏，请重新运行 shard login"
        );
    }
}
