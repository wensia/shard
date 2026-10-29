//! 远程模式的本机配置与设备令牌。
//!
//! - 服务器地址、设备 id 与设备名：`<状态目录>/<配置文件名>`（缺省 `remote.json`）。
//! - 设备令牌：[`TokenBackend::Keychain`] 存 macOS 登录钥匙串（通用密码，服务名由调用方给、账户为服务器地址）；
//!   [`TokenBackend::File`] 存 `<状态目录>/<前缀>-<sha256(服务器地址) 前 16 位>`（缺省前缀 `remote-token`），
//!   权限 0600、先写临时文件再改名。两种方式都按服务器区分：切换服务器时先存新令牌、再删旧服务器的，不会删错。
//!
//! 命令行与桌面各用自己的钥匙串服务名与状态目录，互不影响，也能分别吊销。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fmt, fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

/// 远程配置：登录成功后记下的服务器与设备。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    /// 规范化的站点地址（`https://shard.example.com`，无结尾斜杠）。
    pub server: String,
    pub device_id: String,
    /// 登录时服务器记下的设备名（网页「设置 → 设备」里显示的名字）。
    pub name: String,
}

/// 令牌存在哪里。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenBackend {
    /// macOS 登录钥匙串，`service` 是通用密码项的服务名（命令行 `dev.shard.cli`，桌面另用自己的）。
    /// 其他系统上没有钥匙串：存会报错，读、删、清空都当作没有。
    Keychain { service: String },
    /// 状态目录里按服务器分开的 0600 文件。
    File,
}

impl TokenBackend {
    /// macOS 用钥匙串，其他系统用文件。
    pub fn platform_default(service: impl Into<String>) -> Self {
        if cfg!(target_os = "macos") {
            Self::Keychain { service: service.into() }
        } else {
            Self::File
        }
    }
}

/// 存取失败。`Display` 是给人看的一句话（通用文案，不提具体命令）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// 没有状态目录（例如没有 HOME）。
    NoStateDir,
    /// 配置文件存在但无法解析：可以 [`CredentialStore::remove_config_file`] 后重新登录。
    ConfigCorrupt { path: PathBuf, detail: String },
    /// 钥匙串里的令牌不是 UTF-8：需要重新登录。
    KeychainTokenCorrupt,
    /// 其他读写失败，附给人看的说明（含路径与系统错误）。
    Failed(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoStateDir => f.write_str("无法确定 shard 的配置目录"),
            Self::ConfigCorrupt { path, detail } => write!(f, "{} 无法解析：{detail}", path.display()),
            Self::KeychainTokenCorrupt => f.write_str("钥匙串里的 shard 令牌已损坏"),
            Self::Failed(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for StoreError {}

/// 一组配置与令牌的存放位置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialStore {
    state_dir: Option<PathBuf>,
    config_file: String,
    token_file_prefix: String,
    tokens: TokenBackend,
}

impl CredentialStore {
    pub const DEFAULT_CONFIG_FILE: &'static str = "remote.json";
    pub const DEFAULT_TOKEN_FILE_PREFIX: &'static str = "remote-token";

    /// `state_dir` 为 `None` 表示确定不了（没有 HOME 等）：要用目录的操作报 [`StoreError::NoStateDir`]，
    /// 钥匙串里的令牌照常存取。
    pub fn new(state_dir: Option<PathBuf>, tokens: TokenBackend) -> Self {
        Self {
            state_dir,
            config_file: Self::DEFAULT_CONFIG_FILE.to_string(),
            token_file_prefix: Self::DEFAULT_TOKEN_FILE_PREFIX.to_string(),
            tokens,
        }
    }

    /// 改配置文件名（缺省 `remote.json`）。
    pub fn with_config_file(mut self, name: impl Into<String>) -> Self {
        self.config_file = name.into();
        self
    }

    /// 改令牌文件前缀（缺省 `remote-token`）。[`Self::wipe_tokens`] 删状态目录里所有以它开头的文件，
    /// 所以两个调用方共用一个状态目录时前缀不能互为前缀。
    pub fn with_token_file_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.token_file_prefix = prefix.into();
        self
    }

    pub fn state_dir(&self) -> Option<&Path> {
        self.state_dir.as_deref()
    }

    pub fn tokens(&self) -> &TokenBackend {
        &self.tokens
    }

    pub fn config_path(&self) -> Result<PathBuf, StoreError> {
        self.state_dir
            .as_ref()
            .map(|dir| dir.join(&self.config_file))
            .ok_or(StoreError::NoStateDir)
    }

    /// 配置文件路径（给人看；确定不了时为 `None`）。
    pub fn config_location(&self) -> Option<PathBuf> {
        self.config_path().ok()
    }

    /// 没有配置文件返回 `None`。
    pub fn load_config(&self) -> Result<Option<RemoteConfig>, StoreError> {
        let path = self.config_path()?;
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(StoreError::Failed(format!("读取 {} 失败：{error}", path.display()))),
        };
        serde_json::from_str(&text)
            .map(Some)
            .map_err(|error| StoreError::ConfigCorrupt { path, detail: error.to_string() })
    }

    pub fn save_config(&self, config: &RemoteConfig) -> Result<(), StoreError> {
        let path = self.config_path()?;
        let text = serde_json::to_string_pretty(config).map_err(|error| StoreError::Failed(error.to_string()))?;
        write_private(&path, text.as_bytes())
    }

    /// 删掉配置文件（不解析内容，损坏时也能删；本来就没有不算错）。
    pub fn remove_config_file(&self) -> Result<(), StoreError> {
        remove_if_exists(&self.config_path()?)
    }

    /// 令牌存放位置的说明（给人看）。
    pub fn token_location(&self, server: &str) -> String {
        match &self.tokens {
            TokenBackend::Keychain { .. } => "macOS 钥匙串".to_string(),
            TokenBackend::File => self
                .token_path(server)
                .map(|path| path.display().to_string())
                .unwrap_or_else(|_| self.token_file_name(server)),
        }
    }

    /// 文件后备的令牌文件名：按服务器地址区分。
    pub fn token_file_name(&self, server: &str) -> String {
        format!("{}-{}", self.token_file_prefix, &sha256_hex(server.as_bytes())[..16])
    }

    fn token_path(&self, server: &str) -> Result<PathBuf, StoreError> {
        self.state_dir
            .as_ref()
            .map(|dir| dir.join(self.token_file_name(server)))
            .ok_or(StoreError::NoStateDir)
    }

    pub fn save_token(&self, server: &str, token: &str) -> Result<(), StoreError> {
        match &self.tokens {
            TokenBackend::Keychain { service } => keychain::save(service, server, token),
            TokenBackend::File => write_private(&self.token_path(server)?, token.as_bytes()),
        }
    }

    /// 没有这台服务器的令牌返回 `None`（文件里只有空白也算没有）。
    pub fn load_token(&self, server: &str) -> Result<Option<String>, StoreError> {
        if let TokenBackend::Keychain { service } = &self.tokens {
            return keychain::load(service, server);
        }
        let path = self.token_path(server)?;
        match fs::read_to_string(&path) {
            Ok(token) => Ok(Some(token.trim().to_string()).filter(|token| !token.is_empty())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(StoreError::Failed(format!("读取 {} 失败：{error}", path.display()))),
        }
    }

    /// 删掉这台服务器的令牌（本来就没有不算错）。
    pub fn delete_token(&self, server: &str) -> Result<(), StoreError> {
        match &self.tokens {
            TokenBackend::Keychain { service } => keychain::delete(service, server),
            TokenBackend::File => remove_if_exists(&self.token_path(server)?),
        }
    }

    /// 不知道服务器地址时（配置损坏）尽量删掉这组的全部令牌，返回删掉的个数：
    /// 文件后备删状态目录里所有以令牌前缀开头的文件；钥匙串删这个服务名下的全部条目。
    pub fn wipe_tokens(&self) -> Result<usize, StoreError> {
        if let TokenBackend::Keychain { service } = &self.tokens {
            return keychain::wipe(service);
        }
        let Some(dir) = &self.state_dir else {
            return Ok(0);
        };
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(StoreError::Failed(format!("读取 {} 失败：{error}", dir.display()))),
        };
        let mut removed = 0;
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&self.token_file_prefix) {
                remove_if_exists(&entry.path())?;
                removed += 1;
            }
        }
        Ok(removed)
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn remove_if_exists(path: &Path) -> Result<(), StoreError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(StoreError::Failed(format!("删除 {} 失败：{error}", path.display()))),
    }
}

/// 只有本人可读写（0600）：先写同目录临时文件再改名，不会留下半截或权限过宽的文件。
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    let parent = path.parent().ok_or_else(|| StoreError::Failed("配置路径无效".to_string()))?;
    fs::create_dir_all(parent)
        .map_err(|error| StoreError::Failed(format!("创建 {} 失败：{error}", parent.display())))?;
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
        StoreError::Failed(format!("写入 {} 失败：{error}", path.display()))
    })
}

#[cfg(target_os = "macos")]
mod keychain {
    use super::StoreError;
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    /// errSecItemNotFound
    const NOT_FOUND: i32 = -25300;

    pub fn save(service: &str, server: &str, token: &str) -> Result<(), StoreError> {
        set_generic_password(service, server, token.as_bytes())
            .map_err(|error| StoreError::Failed(format!("把令牌存进钥匙串失败：{error}")))
    }

    pub fn load(service: &str, server: &str) -> Result<Option<String>, StoreError> {
        match get_generic_password(service, server) {
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| StoreError::KeychainTokenCorrupt),
            Err(error) if error.code() == NOT_FOUND => Ok(None),
            Err(error) => Err(StoreError::Failed(format!("从钥匙串读取令牌失败：{error}"))),
        }
    }

    pub fn delete(service: &str, server: &str) -> Result<(), StoreError> {
        match delete_generic_password(service, server) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == NOT_FOUND => Ok(()),
            Err(error) => Err(StoreError::Failed(format!("从钥匙串删除令牌失败：{error}"))),
        }
    }

    /// 删掉这个服务名下的全部条目（按账户逐个删）。
    pub fn wipe(service: &str) -> Result<usize, StoreError> {
        use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
        let found = ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(service)
            .load_attributes(true)
            .limit(Limit::All)
            .search();
        let results = match found {
            Ok(results) => results,
            Err(error) if error.code() == NOT_FOUND => return Ok(0),
            Err(error) => return Err(StoreError::Failed(format!("查找钥匙串里的 shard 令牌失败：{error}"))),
        };
        let mut removed = 0;
        for account in results.iter().filter_map(|result| result.simplify_dict()?.get("acct").cloned()) {
            delete(service, &account)?;
            removed += 1;
        }
        Ok(removed)
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    use super::StoreError;

    pub fn save(_service: &str, _server: &str, _token: &str) -> Result<(), StoreError> {
        Err(StoreError::Failed("这个系统没有钥匙串".to_string()))
    }

    pub fn load(_service: &str, _server: &str) -> Result<Option<String>, StoreError> {
        Ok(None)
    }

    pub fn delete(_service: &str, _server: &str) -> Result<(), StoreError> {
        Ok(())
    }

    pub fn wipe(_service: &str) -> Result<usize, StoreError> {
        Ok(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_store(dir: &Path) -> CredentialStore {
        CredentialStore::new(Some(dir.to_path_buf()), TokenBackend::File)
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    #[cfg(unix)]
    #[test]
    fn private_files_are_owner_only_and_atomic() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested/remote-token");
        write_private(&path, b"shd_dev_x").unwrap();
        write_private(&path, b"shd_dev_y").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "shd_dev_y");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1, "不留临时文件");
    }

    #[test]
    fn token_files_are_named_by_server_hash() {
        let store = file_store(Path::new("/state"));
        // sha256("https://shard.example.com") 的前 16 位十六进制。
        let expected = &sha256_hex(b"https://shard.example.com")[..16];
        assert_eq!(store.token_file_name("https://shard.example.com"), format!("remote-token-{expected}"));
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "与 shard_core::sha256_hex 一样是小写十六进制"
        );
        assert_eq!(
            store.token_location("https://shard.example.com"),
            format!("/state/remote-token-{expected}")
        );
        let custom = store.clone().with_token_file_prefix("desktop-token");
        assert!(custom.token_file_name("https://shard.example.com").starts_with("desktop-token-"));
        let keychain = CredentialStore::new(None, TokenBackend::Keychain { service: "dev.shard.desktop".into() });
        assert_eq!(keychain.token_location("https://x"), "macOS 钥匙串");
        let nowhere = CredentialStore::new(None, TokenBackend::File);
        assert_eq!(nowhere.token_location("https://x"), nowhere.token_file_name("https://x"));
    }

    #[test]
    fn tokens_are_stored_per_server_and_configs_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        let store = file_store(directory.path());
        assert_eq!(store.load_config().unwrap(), None);
        assert_eq!(store.load_token("https://a.example.com").unwrap(), None);

        let config = RemoteConfig { server: "https://a.example.com".into(), device_id: "dev_a".into(), name: "甲".into() };
        store.save_config(&config).unwrap();
        assert_eq!(store.load_config().unwrap(), Some(config.clone()));
        let text = fs::read_to_string(directory.path().join("remote.json")).unwrap();
        assert!(text.contains("\"deviceId\": \"dev_a\""), "camelCase：{text}");

        store.save_token("https://a.example.com", "shd_dev_a").unwrap();
        store.save_token("https://b.example.com", "shd_dev_b\n").unwrap();
        assert_eq!(store.load_token("https://a.example.com").unwrap().as_deref(), Some("shd_dev_a"));
        assert_eq!(store.load_token("https://b.example.com").unwrap().as_deref(), Some("shd_dev_b"), "去掉首尾空白");
        store.delete_token("https://a.example.com").unwrap();
        store.delete_token("https://a.example.com").unwrap();
        assert_eq!(store.load_token("https://a.example.com").unwrap(), None);
        assert_eq!(store.load_token("https://b.example.com").unwrap().as_deref(), Some("shd_dev_b"), "不删别的服务器");

        fs::write(directory.path().join(store.token_file_name("https://c.example.com")), "  \n").unwrap();
        assert_eq!(store.load_token("https://c.example.com").unwrap(), None, "只有空白算没有");
    }

    #[test]
    fn layouts_are_parameterized_and_wipes_stay_in_their_own_lane() {
        let directory = tempfile::tempdir().unwrap();
        let cli = file_store(directory.path());
        let desktop = file_store(directory.path()).with_config_file("desktop.json").with_token_file_prefix("desktop-token");
        let config = RemoteConfig { server: "https://a.example.com".into(), device_id: "dev".into(), name: "n".into() };
        cli.save_config(&config).unwrap();
        desktop.save_config(&RemoteConfig { device_id: "dev_desktop".into(), ..config.clone() }).unwrap();
        cli.save_token(&config.server, "shd_dev_cli").unwrap();
        desktop.save_token(&config.server, "shd_dev_desktop").unwrap();
        assert_eq!(cli.load_token(&config.server).unwrap().as_deref(), Some("shd_dev_cli"));
        assert_eq!(desktop.load_token(&config.server).unwrap().as_deref(), Some("shd_dev_desktop"));
        assert_eq!(desktop.load_config().unwrap().unwrap().device_id, "dev_desktop");
        assert_eq!(cli.load_config().unwrap().unwrap().device_id, "dev");

        assert_eq!(desktop.wipe_tokens().unwrap(), 1);
        assert_eq!(cli.load_token(&config.server).unwrap().as_deref(), Some("shd_dev_cli"), "只删自己前缀的");
        assert_eq!(names(directory.path()), ["desktop.json", cli.token_file_name(&config.server).as_str(), "remote.json"]);
        desktop.remove_config_file().unwrap();
        desktop.remove_config_file().unwrap();
        assert_eq!(cli.wipe_tokens().unwrap(), 1);
        assert_eq!(names(directory.path()), ["remote.json"]);
    }

    #[test]
    fn corrupt_configs_are_reported_and_can_still_be_removed() {
        let directory = tempfile::tempdir().unwrap();
        let store = file_store(directory.path());
        fs::write(directory.path().join("remote.json"), "{ 坏掉的").unwrap();
        fs::write(directory.path().join(store.token_file_name("https://a")), "x").unwrap();
        fs::write(directory.path().join(store.token_file_name("https://b")), "y").unwrap();
        let error = store.load_config().unwrap_err();
        assert!(matches!(&error, StoreError::ConfigCorrupt { path, .. } if path.ends_with("remote.json")), "{error:?}");
        assert!(error.to_string().contains("remote.json 无法解析："), "{error}");
        store.remove_config_file().unwrap();
        assert_eq!(store.wipe_tokens().unwrap(), 2);
        assert!(names(directory.path()).is_empty());
    }

    #[test]
    fn missing_state_dir_fails_only_where_a_directory_is_needed() {
        let store = CredentialStore::new(None, TokenBackend::File);
        assert_eq!(store.load_config().unwrap_err(), StoreError::NoStateDir);
        assert_eq!(store.save_token("https://a", "t").unwrap_err(), StoreError::NoStateDir);
        assert_eq!(store.remove_config_file().unwrap_err(), StoreError::NoStateDir);
        assert_eq!(store.config_location(), None);
        assert_eq!(store.wipe_tokens().unwrap(), 0);
        assert_eq!(StoreError::NoStateDir.to_string(), "无法确定 shard 的配置目录");
        let missing = tempfile::tempdir().unwrap().path().join("never-created");
        assert_eq!(file_store(&missing).wipe_tokens().unwrap(), 0, "目录不存在时什么也不删");
    }

    #[test]
    fn platform_default_uses_the_keychain_only_on_macos() {
        let backend = TokenBackend::platform_default("dev.shard.desktop");
        if cfg!(target_os = "macos") {
            assert_eq!(backend, TokenBackend::Keychain { service: "dev.shard.desktop".into() });
        } else {
            assert_eq!(backend, TokenBackend::File);
        }
    }
}
