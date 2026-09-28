use serde::Serialize;
use std::{
    env, fs,
    fs::OpenOptions,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const PATH_START_MARKER: &str = "__SHARD_PATH__";
const PATH_END_MARKER: &str = "__SHARD_END__";
const PATH_PROBE_COMMAND: &str = "printf \"__SHARD_PATH__%s__SHARD_END__\" \"$PATH\"";
/// 探测在后台运行，不阻塞界面；rc 较重的 zsh 冷启动常需 2–3 秒，
/// 超时会回退到 GUI 的精简 PATH 并误判为需要改 shell 配置，所以留足余量。
const PATH_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const PLACEHOLDER_MESSAGE: &str = "开发构建未包含 shard CLI";
const POSIX_SHELL_BLOCK: &str =
    "# >>> shard cli >>>\nexport PATH=\"$HOME/.local/bin:$PATH\"\n# <<< shard cli <<<";
const FISH_SHELL_BLOCK: &str =
    "# >>> shard cli >>>\nfish_add_path ~/.local/bin\n# <<< shard cli <<<";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CliInstallState {
    Installed,
    NotInstalled,
    NeedsShellConfig,
    Conflict,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CliInstallStatus {
    pub(crate) state: CliInstallState,
    pub(crate) link_path: Option<String>,
    pub(crate) shell_config_path: Option<String>,
    pub(crate) message: Option<String>,
    pub(crate) declined: bool,
}

impl CliInstallStatus {
    fn new(state: CliInstallState, declined: bool) -> Self {
        Self {
            state,
            link_path: None,
            shell_config_path: None,
            message: None,
            declined,
        }
    }

    fn with_link(mut self, path: &Path) -> Self {
        self.link_path = Some(path.display().to_string());
        self
    }

    fn with_shell_config(mut self, path: Option<&Path>) -> Self {
        self.shell_config_path = path.map(|path| path.display().to_string());
        self
    }

    fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CliInstallEnvironment {
    pub(crate) home: PathBuf,
    pub(crate) path_dirs: Vec<PathBuf>,
    pub(crate) sidecar: Option<PathBuf>,
    pub(crate) shell: PathBuf,
    pub(crate) candidates: Vec<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinkOwnership {
    Missing,
    Current,
    StaleShard,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellKind {
    Zsh,
    Bash,
    Fish,
}

pub(crate) fn system_environment() -> Result<CliInstallEnvironment, String> {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "无法找到用户 home 目录".to_string())?;
    let shell = env::var_os("SHELL")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/bin/zsh"));
    let fallback_path = env::var_os("PATH").unwrap_or_default();
    let path_dirs = probe_shell_path(&shell)
        .unwrap_or_else(|_| env::split_paths(&fallback_path).collect::<Vec<_>>());
    let sidecar = env::current_exe()
        .ok()
        .and_then(|current_exe| bundled_sidecar_path(&current_exe));
    let candidates = default_candidates(&home);

    Ok(CliInstallEnvironment {
        home,
        path_dirs,
        sidecar,
        shell,
        candidates,
    })
}

pub(crate) fn default_candidates(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".local/bin"),
        home.join("bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]
}

fn bundled_sidecar_path(current_exe: &Path) -> Option<PathBuf> {
    let macos = current_exe.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    if macos.file_name()? != "MacOS"
        || contents.file_name()? != "Contents"
        || app.extension()? != "app"
    {
        return None;
    }

    let sidecar = macos.join("shard-cli");
    if !sidecar.is_file() || is_placeholder_sidecar(&sidecar) {
        return None;
    }
    Some(sidecar)
}

fn is_placeholder_sidecar(sidecar: &Path) -> bool {
    let Ok(file) = fs::File::open(sidecar) else {
        return false;
    };
    let mut bytes = Vec::with_capacity(512);
    if file.take(512).read_to_end(&mut bytes).is_err() {
        return false;
    }
    String::from_utf8_lossy(&bytes).contains(PLACEHOLDER_MESSAGE)
}

fn probe_shell_path(shell: &Path) -> Result<Vec<PathBuf>, String> {
    let mut child = Command::new(shell)
        .args(["-ilc", PATH_PROBE_COMMAND])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("启动 shell 失败：{error}"))?;
    let deadline = Instant::now() + PATH_PROBE_TIMEOUT;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut output = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    stdout
                        .read_to_string(&mut output)
                        .map_err(|error| format!("读取 shell PATH 失败：{error}"))?;
                }
                if !status.success() {
                    return Err("shell PATH 探测失败".to_string());
                }
                let path = parse_marked_path(&output)
                    .ok_or_else(|| "shell PATH 输出缺少 Shard 标记".to_string())?;
                return Ok(env::split_paths(path).collect());
            }
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("shell PATH 探测超时".to_string());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("等待 shell PATH 探测失败：{error}"));
            }
        }
    }
}

fn parse_marked_path(output: &str) -> Option<&str> {
    let start = output.rfind(PATH_START_MARKER)? + PATH_START_MARKER.len();
    let end = output[start..].find(PATH_END_MARKER)? + start;
    Some(&output[start..end])
}

pub(crate) fn install_status(
    environment: &CliInstallEnvironment,
    declined: bool,
) -> CliInstallStatus {
    let Some(sidecar) = environment.sidecar.as_deref() else {
        return CliInstallStatus::new(CliInstallState::Unavailable, declined)
            .with_message("当前构建未包含可安装的 shard 终端命令");
    };

    // 按 PATH 的真实顺序判断实际会命中的 shard，避免把后面的正确链接误报为已安装。
    for directory in &environment.path_dirs {
        if !environment
            .candidates
            .iter()
            .any(|candidate| candidate == directory)
        {
            continue;
        }
        let link = directory.join("shard");
        match link_ownership(&link, sidecar) {
            LinkOwnership::Current => {
                return CliInstallStatus::new(CliInstallState::Installed, declined)
                    .with_link(&link);
            }
            LinkOwnership::StaleShard => {
                return CliInstallStatus::new(CliInstallState::NotInstalled, declined)
                    .with_link(&link)
                    .with_message("检测到 Shard 旧位置的链接，可自动刷新");
            }
            LinkOwnership::Conflict => return conflict_status(&link, declined),
            LinkOwnership::Missing => {}
        }
    }

    if let Some(directory) = select_install_directory(environment) {
        let link = directory.join("shard");
        return match link_ownership(&link, sidecar) {
            LinkOwnership::Current => {
                CliInstallStatus::new(CliInstallState::Installed, declined).with_link(&link)
            }
            LinkOwnership::Conflict => conflict_status(&link, declined),
            LinkOwnership::Missing | LinkOwnership::StaleShard => {
                CliInstallStatus::new(CliInstallState::NotInstalled, declined)
            }
        };
    }

    let link = environment.home.join(".local/bin/shard");
    if link_ownership(&link, sidecar) == LinkOwnership::Conflict {
        return conflict_status(&link, declined);
    }
    let shell_config = shell_config_path(&environment.home, &environment.shell).ok();
    let mut status = CliInstallStatus::new(CliInstallState::NeedsShellConfig, declined)
        .with_link(&link)
        .with_shell_config(shell_config.as_deref());
    if shell_config.is_none() {
        status = status.with_message("当前 shell 不受支持，无法自动配置 PATH");
    }
    status
}

pub(crate) fn install(
    environment: &CliInstallEnvironment,
    allow_shell_config: bool,
    declined: bool,
) -> Result<CliInstallStatus, String> {
    let initial = install_status(environment, declined);
    if matches!(
        initial.state,
        CliInstallState::Installed | CliInstallState::Conflict | CliInstallState::Unavailable
    ) {
        return Ok(initial);
    }
    let sidecar = environment
        .sidecar
        .as_deref()
        .ok_or_else(|| "当前构建未包含可安装的 shard 终端命令".to_string())?;

    // 旧 App 链接优先原位刷新，避免候选顺序把首次安装目录排在旧链接之前。
    if let Some(link) = stale_link_in_path(environment, sidecar) {
        if link.parent().is_some_and(directory_is_writable) {
            atomic_install_link(sidecar, &link)?;
            return Ok(CliInstallStatus::new(CliInstallState::Installed, declined).with_link(&link));
        }
    }

    if let Some(directory) = select_install_directory(environment) {
        let link = directory.join("shard");
        if link_ownership(&link, sidecar) == LinkOwnership::Conflict {
            return Ok(conflict_status(&link, declined));
        }
        atomic_install_link(sidecar, &link)?;
        return Ok(CliInstallStatus::new(CliInstallState::Installed, declined).with_link(&link));
    }

    if !allow_shell_config {
        return Ok(initial);
    }

    let config_path = shell_config_path(&environment.home, &environment.shell)?;
    let link_dir = environment.home.join(".local/bin");
    let link = link_dir.join("shard");
    let previous_ownership = link_ownership(&link, sidecar);
    if previous_ownership == LinkOwnership::Conflict {
        return Ok(conflict_status(&link, declined));
    }

    fs::create_dir_all(&link_dir)
        .map_err(|error| format!("创建终端命令目录 {} 失败：{error}", link_dir.display()))?;
    if previous_ownership != LinkOwnership::Current {
        atomic_install_link(sidecar, &link)?;
    }
    if let Err(error) = append_shell_config(&config_path, shell_kind(&environment.shell)?) {
        if previous_ownership != LinkOwnership::Current
            && link_ownership(&link, sidecar) == LinkOwnership::Current
        {
            let _ = fs::remove_file(&link);
        }
        return Err(error);
    }

    Ok(CliInstallStatus::new(CliInstallState::Installed, declined)
        .with_link(&link)
        .with_shell_config(Some(&config_path)))
}

pub(crate) fn uninstall(
    environment: &CliInstallEnvironment,
    declined: bool,
) -> Result<CliInstallStatus, String> {
    if let Some(sidecar) = environment.sidecar.as_deref() {
        for directory in &environment.candidates {
            let link = directory.join("shard");
            if matches!(
                link_ownership(&link, sidecar),
                LinkOwnership::Current | LinkOwnership::StaleShard
            ) {
                fs::remove_file(&link)
                    .map_err(|error| format!("删除终端命令 {} 失败：{error}", link.display()))?;
            }
        }
    }

    remove_posix_shell_block(&environment.home.join(".zshrc"))?;
    remove_posix_shell_block(&environment.home.join(".bash_profile"))?;
    remove_fish_shell_file(&environment.home.join(".config/fish/conf.d/shard.fish"))?;

    Ok(install_status(environment, declined))
}

fn conflict_status(link: &Path, declined: bool) -> CliInstallStatus {
    CliInstallStatus::new(CliInstallState::Conflict, declined)
        .with_link(link)
        .with_message("已存在非 Shard 的 shard 命令，不会覆盖")
}

fn select_install_directory(environment: &CliInstallEnvironment) -> Option<PathBuf> {
    select_install_directory_with(environment, directory_is_writable)
}

fn stale_link_in_path(environment: &CliInstallEnvironment, sidecar: &Path) -> Option<PathBuf> {
    environment.path_dirs.iter().find_map(|directory| {
        if !environment
            .candidates
            .iter()
            .any(|candidate| candidate == directory)
        {
            return None;
        }
        let link = directory.join("shard");
        (link_ownership(&link, sidecar) == LinkOwnership::StaleShard).then_some(link)
    })
}

fn select_install_directory_with<F>(
    environment: &CliInstallEnvironment,
    mut writable: F,
) -> Option<PathBuf>
where
    F: FnMut(&Path) -> bool,
{
    environment
        .candidates
        .iter()
        .find(|candidate| {
            environment.path_dirs.iter().any(|path| path == *candidate)
                && candidate.is_dir()
                && writable(candidate)
        })
        .cloned()
}

fn directory_is_writable(directory: &Path) -> bool {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let probe = directory.join(format!(".shard-write-test-{}-{suffix}", std::process::id()));
    match OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(_) => fs::remove_file(probe).is_ok(),
        Err(_) => false,
    }
}

fn link_ownership(link: &Path, sidecar: &Path) -> LinkOwnership {
    let metadata = match fs::symlink_metadata(link) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return LinkOwnership::Missing;
        }
        Err(_) => return LinkOwnership::Conflict,
    };
    if !metadata.file_type().is_symlink() {
        return LinkOwnership::Conflict;
    }

    let Ok(target) = fs::read_link(link) else {
        return LinkOwnership::Conflict;
    };
    let resolved = if target.is_absolute() {
        target
    } else {
        link.parent().unwrap_or_else(|| Path::new("")).join(target)
    };
    if paths_refer_to_same_file(&resolved, sidecar) {
        LinkOwnership::Current
    } else if is_shard_app_sidecar(&resolved) {
        LinkOwnership::StaleShard
    } else {
        LinkOwnership::Conflict
    }
}

fn paths_refer_to_same_file(left: &Path, right: &Path) -> bool {
    left == right
        || left
            .canonicalize()
            .ok()
            .zip(right.canonicalize().ok())
            .is_some_and(|(left, right)| left == right)
}

fn is_shard_app_sidecar(path: &Path) -> bool {
    let path = path.to_string_lossy();
    path.ends_with("/Contents/MacOS/shard-cli") && path.contains(".app/")
}

fn atomic_install_link(sidecar: &Path, link: &Path) -> Result<(), String> {
    let parent = link
        .parent()
        .ok_or_else(|| "终端命令链接路径无效".to_string())?;
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let temporary = parent.join(format!(".shard-link-{}-{suffix}", std::process::id()));

    create_symlink(sidecar, &temporary)
        .map_err(|error| format!("创建临时终端命令链接 {} 失败：{error}", temporary.display()))?;
    if link_ownership(link, sidecar) == LinkOwnership::Conflict {
        let _ = fs::remove_file(&temporary);
        return Err(format!("已存在非 Shard 的 shard 命令：{}", link.display()));
    }
    fs::rename(&temporary, link).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("安装终端命令 {} 失败：{error}", link.display())
    })
}

#[cfg(unix)]
fn create_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}

fn shell_kind(shell: &Path) -> Result<ShellKind, String> {
    match shell.file_name().and_then(|name| name.to_str()) {
        Some("zsh") => Ok(ShellKind::Zsh),
        Some("bash") => Ok(ShellKind::Bash),
        Some("fish") => Ok(ShellKind::Fish),
        _ => Err(format!("暂不支持自动配置 shell：{}", shell.display())),
    }
}

fn shell_config_path(home: &Path, shell: &Path) -> Result<PathBuf, String> {
    match shell_kind(shell)? {
        ShellKind::Zsh => Ok(home.join(".zshrc")),
        ShellKind::Bash => Ok(home.join(".bash_profile")),
        ShellKind::Fish => Ok(home.join(".config/fish/conf.d/shard.fish")),
    }
}

fn append_shell_config(path: &Path, kind: ShellKind) -> Result<bool, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建 shell 配置目录 {} 失败：{error}", parent.display()))?;
    }
    let existing = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("读取 shell 配置 {} 失败：{error}", path.display())),
    };

    let block = match kind {
        ShellKind::Zsh | ShellKind::Bash => POSIX_SHELL_BLOCK,
        ShellKind::Fish => FISH_SHELL_BLOCK,
    };
    let has_start = existing.contains("# >>> shard cli >>>");
    let has_end = existing.contains("# <<< shard cli <<<");
    if has_start || has_end {
        if has_start && has_end && existing.contains(block) {
            return Ok(false);
        }
        return Err(format!(
            "shell 配置 {} 中的 Shard 标记不完整",
            path.display()
        ));
    }

    if kind == ShellKind::Fish && !existing.is_empty() {
        return Err(format!(
            "fish 配置 {} 已存在且不属于 Shard，不会覆盖",
            path.display()
        ));
    }
    let updated = if existing.is_empty() {
        format!("{block}\n")
    } else {
        format!("{existing}\n{block}\n")
    };
    fs::write(path, updated)
        .map_err(|error| format!("写入 shell 配置 {} 失败：{error}", path.display()))?;
    Ok(true)
}

fn remove_posix_shell_block(path: &Path) -> Result<bool, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("读取 shell 配置 {} 失败：{error}", path.display())),
    };
    let whole = format!("{POSIX_SHELL_BLOCK}\n");
    let updated = if text == POSIX_SHELL_BLOCK || text == whole {
        String::new()
    } else {
        let fragment = format!("\n{POSIX_SHELL_BLOCK}\n");
        let Some(start) = text.find(&fragment) else {
            return Ok(false);
        };
        let before = &text[..start];
        let after = &text[start + fragment.len()..];
        if after.is_empty() {
            before.to_string()
        } else if before.ends_with('\n') {
            format!("{before}{after}")
        } else {
            format!("{before}\n{after}")
        }
    };
    fs::write(path, updated)
        .map_err(|error| format!("更新 shell 配置 {} 失败：{error}", path.display()))?;
    Ok(true)
}

fn remove_fish_shell_file(path: &Path) -> Result<bool, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("读取 fish 配置 {} 失败：{error}", path.display())),
    };
    if text == FISH_SHELL_BLOCK || text == format!("{FISH_SHELL_BLOCK}\n") {
        fs::remove_file(path)
            .map_err(|error| format!("删除 fish 配置 {} 失败：{error}", path.display()))?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_environment(
        home: &Path,
        sidecar: &Path,
        path_dirs: Vec<PathBuf>,
        candidates: Vec<PathBuf>,
        shell: &str,
    ) -> CliInstallEnvironment {
        CliInstallEnvironment {
            home: home.to_path_buf(),
            path_dirs,
            sidecar: Some(sidecar.to_path_buf()),
            shell: PathBuf::from(shell),
            candidates,
        }
    }

    fn create_sidecar(root: &Path) -> PathBuf {
        let sidecar = root.join("Shard.app/Contents/MacOS/shard-cli");
        fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        fs::write(&sidecar, "real shard cli fixture").unwrap();
        sidecar
    }

    #[test]
    fn cli_install_selects_only_existing_writable_path_candidates() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let sidecar = create_sidecar(home);
        let local = home.join(".local/bin");
        let bin = home.join("bin");
        let missing = home.join("missing");
        fs::create_dir_all(&local).unwrap();
        fs::create_dir_all(&bin).unwrap();
        let environment = make_environment(
            home,
            &sidecar,
            vec![local.clone(), bin.clone(), missing.clone()],
            vec![local.clone(), bin.clone(), missing],
            "/bin/zsh",
        );

        let selected = select_install_directory_with(&environment, |path| path == bin);
        assert_eq!(selected, Some(bin));
        let status = install_status(&environment, false);
        assert_eq!(status.state, CliInstallState::NotInstalled);
        assert_eq!(status.link_path, None);

        let outside_path = make_environment(
            home,
            &sidecar,
            vec![home.join("other")],
            vec![local],
            "/bin/zsh",
        );
        assert_eq!(select_install_directory_with(&outside_path, |_| true), None);
    }

    #[cfg(unix)]
    #[test]
    fn cli_install_rejects_an_actually_unwritable_directory() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("readonly");
        fs::create_dir_all(&directory).unwrap();
        let mut permissions = fs::metadata(&directory).unwrap().permissions();
        permissions.set_mode(0o555);
        fs::set_permissions(&directory, permissions).unwrap();

        assert!(!directory_is_writable(&directory));

        let mut permissions = fs::metadata(&directory).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&directory, permissions).unwrap();
    }

    #[test]
    fn cli_install_conflict_is_reported_without_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let sidecar = create_sidecar(home);
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let link = bin.join("shard");
        fs::write(&link, "user command").unwrap();
        let environment =
            make_environment(home, &sidecar, vec![bin.clone()], vec![bin], "/bin/zsh");

        let result = install(&environment, false, false).unwrap();

        assert_eq!(result.state, CliInstallState::Conflict);
        assert_eq!(fs::read_to_string(link).unwrap(), "user command");
    }

    #[cfg(unix)]
    #[test]
    fn cli_install_foreign_symlink_is_a_conflict() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let sidecar = create_sidecar(home);
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let foreign = home.join("foreign-shard");
        fs::write(&foreign, "foreign command").unwrap();
        let link = bin.join("shard");
        create_symlink(&foreign, &link).unwrap();
        let environment =
            make_environment(home, &sidecar, vec![bin.clone()], vec![bin], "/bin/zsh");

        let result = install(&environment, false, false).unwrap();

        assert_eq!(result.state, CliInstallState::Conflict);
        assert_eq!(fs::read_link(link).unwrap(), foreign);
    }

    #[cfg(unix)]
    #[test]
    fn cli_install_refreshes_stale_app_link_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let sidecar = create_sidecar(home);
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let link = bin.join("shard");
        create_symlink(
            Path::new("/Applications/Old Shard.app/Contents/MacOS/shard-cli"),
            &link,
        )
        .unwrap();
        let environment = make_environment(
            home,
            &sidecar,
            vec![bin.clone()],
            vec![bin.clone()],
            "/bin/zsh",
        );

        assert_eq!(
            install_status(&environment, false).state,
            CliInstallState::NotInstalled
        );
        let result = install(&environment, false, false).unwrap();

        assert_eq!(result.state, CliInstallState::Installed);
        assert_eq!(fs::read_link(&link).unwrap(), sidecar);
        assert!(fs::read_dir(bin).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".shard-link-")));
    }

    #[cfg(unix)]
    #[test]
    fn cli_install_prefers_refreshing_stale_link_over_earlier_empty_candidate() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let sidecar = create_sidecar(home);
        let first = home.join(".local/bin");
        let stale_dir = home.join("bin");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&stale_dir).unwrap();
        let stale_link = stale_dir.join("shard");
        create_symlink(
            Path::new("/Applications/Old Shard.app/Contents/MacOS/shard-cli"),
            &stale_link,
        )
        .unwrap();
        let environment = make_environment(
            home,
            &sidecar,
            vec![first.clone(), stale_dir.clone()],
            vec![first.clone(), stale_dir],
            "/bin/zsh",
        );

        let initial = install_status(&environment, false);
        assert_eq!(initial.link_path.as_deref(), stale_link.to_str());
        let installed = install(&environment, false, false).unwrap();

        assert_eq!(installed.link_path.as_deref(), stale_link.to_str());
        assert_eq!(fs::read_link(stale_link).unwrap(), sidecar);
        assert!(!first.join("shard").exists());
    }

    #[test]
    fn cli_install_shell_path_parser_ignores_rc_output() {
        let output = "主题初始化\n__SHARD_PATH__/first:/second__SHARD_END__\n提示信息\n";
        assert_eq!(parse_marked_path(output), Some("/first:/second"));
        assert_eq!(parse_marked_path("no markers"), None);
    }

    #[test]
    fn cli_install_posix_shell_blocks_are_idempotent_and_precisely_removed() {
        let temp = tempfile::tempdir().unwrap();
        for (name, kind) in [
            (".zshrc", ShellKind::Zsh),
            (".bash_profile", ShellKind::Bash),
        ] {
            let path = temp.path().join(name);
            let original = "export EDITOR=vim\n";
            fs::write(&path, original).unwrap();

            assert!(append_shell_config(&path, kind).unwrap());
            assert!(!append_shell_config(&path, kind).unwrap());
            let installed = fs::read_to_string(&path).unwrap();
            assert_eq!(installed.matches("# >>> shard cli >>>").count(), 1);
            assert!(remove_posix_shell_block(&path).unwrap());
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
            assert!(!remove_posix_shell_block(&path).unwrap());
        }
    }

    #[test]
    fn cli_install_fish_shell_file_is_idempotent_and_owned() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(".config/fish/conf.d/shard.fish");

        assert!(append_shell_config(&path, ShellKind::Fish).unwrap());
        assert!(!append_shell_config(&path, ShellKind::Fish).unwrap());
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("fish_add_path ~/.local/bin"));
        assert!(remove_fish_shell_file(&path).unwrap());
        assert!(!path.exists());

        fs::write(&path, "set -gx USER_CONFIG yes\n").unwrap();
        assert!(append_shell_config(&path, ShellKind::Fish).is_err());
        assert!(!remove_fish_shell_file(&path).unwrap());
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "set -gx USER_CONFIG yes\n"
        );
    }

    #[test]
    fn cli_install_bundled_sidecar_rejects_development_and_placeholder_builds() {
        let temp = tempfile::tempdir().unwrap();
        let development = temp.path().join("target/debug/shard");
        fs::create_dir_all(development.parent().unwrap()).unwrap();
        fs::write(&development, "app").unwrap();
        assert_eq!(bundled_sidecar_path(&development), None);

        let app = temp.path().join("Shard.app/Contents/MacOS/shard");
        let sidecar = app.parent().unwrap().join("shard-cli");
        fs::create_dir_all(app.parent().unwrap()).unwrap();
        fs::write(&app, "app").unwrap();
        fs::write(
            &sidecar,
            format!("#!/bin/sh\necho '{PLACEHOLDER_MESSAGE}'\nexit 1\n"),
        )
        .unwrap();
        assert_eq!(bundled_sidecar_path(&app), None);
    }

    #[cfg(unix)]
    #[test]
    fn cli_install_uninstall_removes_all_owned_links_but_keeps_conflicts() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let sidecar = create_sidecar(home);
        let first = home.join("first");
        let second = home.join("second");
        let third = home.join("third");
        for directory in [&first, &second, &third] {
            fs::create_dir_all(directory).unwrap();
        }
        create_symlink(&sidecar, &first.join("shard")).unwrap();
        create_symlink(
            Path::new("/Applications/Old Shard.app/Contents/MacOS/shard-cli"),
            &second.join("shard"),
        )
        .unwrap();
        fs::write(third.join("shard"), "user command").unwrap();
        let environment = make_environment(
            home,
            &sidecar,
            vec![],
            vec![first.clone(), second.clone(), third.clone()],
            "/bin/zsh",
        );

        uninstall(&environment, true).unwrap();

        assert!(fs::symlink_metadata(first.join("shard")).is_err());
        assert!(fs::symlink_metadata(second.join("shard")).is_err());
        assert_eq!(
            fs::read_to_string(third.join("shard")).unwrap(),
            "user command"
        );
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "手工验证：仅在临时 HOME 与伪造 PATH 中执行完整安装/卸载流"]
    fn cli_install_manual_temp_home_flow() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let fake_path = temp.path().join("fake-path");
        let fake_shell = temp.path().join("tools/zsh");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&fake_path).unwrap();
        fs::create_dir_all(fake_shell.parent().unwrap()).unwrap();
        fs::write(
            &fake_shell,
            format!(
                "#!/bin/sh\nprintf 'rc noise\\n__SHARD_PATH__{}__SHARD_END__'\n",
                fake_path.display()
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&fake_shell).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_shell, permissions).unwrap();
        let path_dirs = probe_shell_path(&fake_shell).unwrap();
        let sidecar = create_sidecar(temp.path());
        let environment = make_environment(
            &home,
            &sidecar,
            path_dirs,
            vec![home.join(".local/bin")],
            fake_shell.to_str().unwrap(),
        );

        let pending = install(&environment, false, false).unwrap();
        assert_eq!(pending.state, CliInstallState::NeedsShellConfig);
        let installed = install(&environment, true, false).unwrap();
        assert_eq!(installed.state, CliInstallState::Installed);
        assert_eq!(
            fs::read_link(home.join(".local/bin/shard")).unwrap(),
            sidecar
        );
        assert!(home.join(".zshrc").is_file());

        uninstall(&environment, true).unwrap();
        assert!(!home.join(".local/bin/shard").exists());
        assert_eq!(fs::read_to_string(home.join(".zshrc")).unwrap(), "");
    }
}
