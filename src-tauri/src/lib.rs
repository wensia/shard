use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const DEFAULT_WINDOW_WIDTH: f64 = 1180.0;
const DEFAULT_WINDOW_HEIGHT: f64 = 820.0;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Fragment {
    id: String,
    content: String,
    created_at: String,
    updated_at: String,
    tags: Vec<String>,
    category: Option<String>,
    path: String,
    git_status: String,
    error: Option<String>,
    ai_status: String,
    archived: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultState {
    vault_path: String,
    fragments: Vec<Fragment>,
    git: GitInfo,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    vault_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitInfo {
    branch: String,
    short_commit: String,
    has_remote: bool,
    status: String,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GithubCliInfo {
    installed: bool,
    authenticated: bool,
    login: Option<String>,
    protocol: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexAgentStatus {
    installed: bool,
    version: Option<String>,
    path: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum CodexReviewTask {
    Insight,
    Walk,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexReviewFragment {
    id: String,
    content: String,
    created_at: String,
    tags: Vec<String>,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexReviewTaskRequest {
    task: CodexReviewTask,
    fragments: Vec<CodexReviewFragment>,
    vault_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexReviewTaskResult {
    text: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct FragmentFrontmatter {
    id: String,
    created_at: String,
    updated_at: String,
    tags: Vec<String>,
    category: Option<String>,
    ai_status: Option<String>,
    source: String,
}

async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("后台任务失败：{error}"))?
}

#[tauri::command]
async fn list_fragments(app: tauri::AppHandle) -> Result<VaultState, String> {
    run_blocking(move || {
        let vault = ensure_vault_dirs(&app)?;
        list_fragments_in_vault(&vault)
    })
    .await
}

#[tauri::command]
async fn set_vault_path(
    app: tauri::AppHandle,
    path: String,
    initialize_git: bool,
) -> Result<VaultState, String> {
    run_blocking(move || {
        let vault = PathBuf::from(path.trim());
        if vault.as_os_str().is_empty() {
            return Err("Vault 目录不能为空".to_string());
        }
        if vault.exists() && !vault.is_dir() {
            return Err("请选择一个文件夹，而不是文件。".to_string());
        }

        fs::create_dir_all(&vault).map_err(|error| error.to_string())?;
        ensure_vault_layout(&vault)?;
        if initialize_git {
            ensure_git_repo(&vault)?;
        }
        write_app_config(
            &app,
            &AppConfig {
                vault_path: Some(vault.display().to_string()),
            },
        )?;

        list_fragments_in_vault(&vault)
    })
    .await
}

#[tauri::command]
async fn initialize_vault_git(app: tauri::AppHandle) -> Result<VaultState, String> {
    run_blocking(move || {
        let vault = ensure_vault_dirs(&app)?;
        ensure_git_repo(&vault)?;
        list_fragments_in_vault(&vault)
    })
    .await
}

#[tauri::command]
async fn set_vault_remote(app: tauri::AppHandle, remote_url: String) -> Result<VaultState, String> {
    run_blocking(move || {
        let remote_url = remote_url.trim().to_string();
        if remote_url.is_empty() {
            return Err("Git remote URL 不能为空".to_string());
        }

        let vault = ensure_vault_dirs(&app)?;
        ensure_git_repo(&vault)?;

        let remotes = git_remotes(&vault);
        if remotes.iter().any(|remote| remote == "origin") {
            run_git(&vault, &["remote", "set-url", "origin", &remote_url])?;
        } else {
            run_git(&vault, &["remote", "add", "origin", &remote_url])?;
        }

        list_fragments_in_vault(&vault)
    })
    .await
}

#[tauri::command]
async fn github_cli_status() -> GithubCliInfo {
    tauri::async_runtime::spawn_blocking(read_github_cli_status)
        .await
        .unwrap_or_else(|error| GithubCliInfo {
            installed: false,
            authenticated: false,
            login: None,
            protocol: None,
            error: Some(format!("无法读取 GitHub CLI 登录状态：{error}")),
        })
}

#[tauri::command]
async fn codex_agent_status() -> CodexAgentStatus {
    tauri::async_runtime::spawn_blocking(read_codex_agent_status)
        .await
        .unwrap_or_else(|error| CodexAgentStatus {
            installed: false,
            version: None,
            path: None,
            error: Some(format!("无法读取 Codex CLI 状态：{error}")),
        })
}

#[tauri::command]
async fn run_codex_review_task(
    request: CodexReviewTaskRequest,
) -> Result<CodexReviewTaskResult, String> {
    run_blocking(move || run_codex_review_task_blocking(request)).await
}

fn read_github_cli_status() -> GithubCliInfo {
    let Ok(gh) = gh_path() else {
        return GithubCliInfo {
            installed: false,
            authenticated: false,
            login: None,
            protocol: None,
            error: Some("未检测到 GitHub CLI。".to_string()),
        };
    };

    let auth = Command::new(&gh)
        .args(["auth", "status", "--hostname", "github.com"])
        .output();
    let Ok(auth) = auth else {
        return GithubCliInfo {
            installed: true,
            authenticated: false,
            login: None,
            protocol: None,
            error: Some("无法读取 GitHub CLI 登录状态。".to_string()),
        };
    };

    let authenticated = auth.status.success();
    let auth_output = format!(
        "{}\n{}",
        String::from_utf8_lossy(&auth.stdout),
        String::from_utf8_lossy(&auth.stderr)
    );
    let protocol = run_gh_with_path(
        &gh,
        &["config", "get", "git_protocol", "--host", "github.com"],
    )
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty());

    GithubCliInfo {
        installed: true,
        authenticated,
        login: parse_gh_login(&auth_output),
        protocol,
        error: if authenticated {
            None
        } else {
            Some("gh 尚未登录 GitHub。请先运行 gh auth login。".to_string())
        },
    }
}

fn read_codex_agent_status() -> CodexAgentStatus {
    let Ok(codex) = codex_path() else {
        return CodexAgentStatus {
            installed: false,
            version: None,
            path: None,
            error: Some("未检测到 Codex CLI。".to_string()),
        };
    };

    let version = run_command(Command::new(&codex).arg("--version"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    CodexAgentStatus {
        installed: true,
        version,
        path: Some(codex.display().to_string()),
        error: None,
    }
}

fn run_codex_review_task_blocking(
    request: CodexReviewTaskRequest,
) -> Result<CodexReviewTaskResult, String> {
    if request.fragments.is_empty() {
        return Err("没有可供 Codex 分析的片段。".to_string());
    }

    let vault = PathBuf::from(request.vault_path.trim());
    if vault.as_os_str().is_empty() || !vault.is_dir() {
        return Err("Codex 需要一个有效的 Shard vault 目录。".to_string());
    }

    let prompt = codex_review_prompt(&request);
    let text = run_codex_exec(&vault, &prompt)?;
    Ok(CodexReviewTaskResult { text })
}

#[tauri::command]
async fn create_github_vault_repo(
    app: tauri::AppHandle,
    repo_name: String,
) -> Result<VaultState, String> {
    run_blocking(move || {
        let repo_name = sanitize_repo_name(&repo_name)?;
        let vault = ensure_vault_dirs(&app)?;
        ensure_git_repo(&vault)?;

        if default_remote(&vault).is_some() {
            return Err("当前 Vault 已经配置 Git remote。".to_string());
        }

        run_gh_in(
            &vault,
            &[
                "repo",
                "create",
                &repo_name,
                "--private",
                "--source",
                ".",
                "--remote",
                "origin",
            ],
        )?;

        if run_git(&vault, &["rev-parse", "--verify", "HEAD"]).is_ok() {
            push_vault(&vault)?;
        }

        list_fragments_in_vault(&vault)
    })
    .await
}

fn list_fragments_in_vault(vault: &Path) -> Result<VaultState, String> {
    let mut files = Vec::new();
    collect_markdown_files(&vault.join("fragments"), &mut files)?;
    collect_markdown_files(&vault.join("archive"), &mut files)?;

    let dirty_paths = dirty_paths(&vault);
    let mut fragments = files
        .iter()
        .filter_map(|path| read_fragment(path, &vault, &dirty_paths, None).ok())
        .collect::<Vec<_>>();

    fragments.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(VaultState {
        vault_path: vault.display().to_string(),
        fragments,
        git: git_info(&vault),
    })
}

#[tauri::command]
async fn create_fragment(
    app: tauri::AppHandle,
    content: String,
    tags: Option<Vec<String>>,
) -> Result<Fragment, String> {
    run_blocking(move || {
        let content = content.trim().to_string();
        if content.is_empty() {
            return Err("片段内容不能为空".to_string());
        }

        let vault = ensure_vault_dirs(&app)?;
        let now = Local::now();
        let suffix = unique_suffix();
        let id = format!("{}-{}", now.format("%Y%m%d-%H%M%S"), suffix);
        let created_at = now.to_rfc3339();
        let dir = vault
            .join("fragments")
            .join(now.format("%Y").to_string())
            .join(now.format("%m").to_string());
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

        let file_name = format!("{}-{}.md", now.format("%Y-%m-%d-%H%M%S"), suffix);
        let path = dir.join(file_name);
        let frontmatter = FragmentFrontmatter {
            id: id.clone(),
            created_at: created_at.clone(),
            updated_at: created_at,
            tags: normalize_tags(tags.unwrap_or_default(), true),
            category: None,
            ai_status: Some("none".to_string()),
            source: "desktop".to_string(),
        };

        write_fragment_file(&path, &frontmatter, &content)?;

        let rel_path = relative_path(&vault, &path)?;
        let commit_result = commit_path_if_git(
            &vault,
            &rel_path,
            &format!("create fragment {}", now.format("%Y-%m-%d %H:%M:%S")),
        );

        let dirty = dirty_paths(&vault);
        let override_status = match commit_result {
            Ok(Some(_)) => Some(("committed".to_string(), None)),
            Ok(None) => Some(("saved".to_string(), None)),
            Err(error) => Some(("commit_failed".to_string(), Some(error))),
        };

        read_fragment(&path, &vault, &dirty, override_status)
    })
    .await
}

#[tauri::command]
async fn update_fragment_tags(
    app: tauri::AppHandle,
    id: String,
    tags: Vec<String>,
) -> Result<Fragment, String> {
    run_blocking(move || {
        let vault = ensure_vault_dirs(&app)?;
        let path = find_fragment_path(&vault, &id)?.ok_or_else(|| format!("找不到片段 {}", id))?;
        let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let (mut frontmatter, body) = parse_fragment_text(&text)?;

        let mut next_tags = normalize_tags(tags, false);
        if next_tags.is_empty() {
            next_tags.push("inbox".to_string());
        }

        frontmatter.tags = next_tags;
        frontmatter.updated_at = Local::now().to_rfc3339();
        write_fragment_file(&path, &frontmatter, body.trim_start_matches('\n'))?;

        let rel_path = relative_path(&vault, &path)?;
        let commit_result = commit_path_if_git(
            &vault,
            &rel_path,
            &format!("update fragment tags {}", frontmatter.id),
        );

        let dirty = dirty_paths(&vault);
        let override_status = match commit_result {
            Ok(Some(_)) => Some(("committed".to_string(), None)),
            Ok(None) => Some(("saved".to_string(), None)),
            Err(error) => Some(("commit_failed".to_string(), Some(error))),
        };

        read_fragment(&path, &vault, &dirty, override_status)
    })
    .await
}

#[tauri::command]
async fn update_fragment(
    app: tauri::AppHandle,
    id: String,
    content: String,
    tags: Option<Vec<String>>,
) -> Result<Fragment, String> {
    run_blocking(move || {
        if content.trim().is_empty() {
            return Err("片段内容不能为空".to_string());
        }

        let vault = ensure_vault_dirs(&app)?;
        let path = find_fragment_path(&vault, &id)?.ok_or_else(|| format!("找不到片段 {}", id))?;
        let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let (mut frontmatter, _) = parse_fragment_text(&text)?;

        let mut next_tags = normalize_tags(tags.unwrap_or_default(), false);
        if next_tags.is_empty() {
            next_tags.push("inbox".to_string());
        }

        frontmatter.tags = next_tags;
        frontmatter.updated_at = Local::now().to_rfc3339();
        write_fragment_file(&path, &frontmatter, &content)?;

        let dirty = dirty_paths(&vault);
        let override_status = if vault.join(".git").exists() {
            Some(("sync_pending".to_string(), None))
        } else {
            Some(("saved".to_string(), None))
        };

        read_fragment(&path, &vault, &dirty, override_status)
    })
    .await
}

#[tauri::command]
async fn archive_fragment(app: tauri::AppHandle, id: String) -> Result<Fragment, String> {
    run_blocking(move || {
        let vault = ensure_vault_dirs(&app)?;
        let path = find_fragment_path(&vault, &id)?.ok_or_else(|| format!("找不到片段 {}", id))?;
        let rel_path = relative_path(&vault, &path)?;

        if rel_path.starts_with("archive/") {
            let dirty = dirty_paths(&vault);
            return read_fragment(&path, &vault, &dirty, None);
        }

        let active_root = vault.join("fragments");
        let archived_root = vault.join("archive");
        let active_rel = path
            .strip_prefix(&active_root)
            .map_err(|error| error.to_string())?;
        let archived_path = archived_root.join(active_rel);

        if let Some(parent) = archived_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }

        fs::rename(&path, &archived_path)
            .or_else(|_| {
                fs::copy(&path, &archived_path)
                    .map(|_| ())
                    .and_then(|_| fs::remove_file(&path))
            })
            .map_err(|error| error.to_string())?;

        let commit_result = commit_all_if_git(&vault, &format!("archive fragment {}", id));

        let dirty = dirty_paths(&vault);
        let override_status = match commit_result {
            Ok(Some(_)) => Some(("committed".to_string(), None)),
            Ok(None) => Some(("saved".to_string(), None)),
            Err(error) => Some(("commit_failed".to_string(), Some(error))),
        };

        read_fragment(&archived_path, &vault, &dirty, override_status)
    })
    .await
}

#[tauri::command]
async fn save_fragment_image(
    app: tauri::AppHandle,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    run_blocking(move || {
        if bytes.is_empty() {
            return Err("图片内容为空".to_string());
        }

        let vault = ensure_vault_dirs(&app)?;
        let now = Local::now();
        let dir = vault
            .join("assets")
            .join(now.format("%Y").to_string())
            .join(now.format("%m").to_string());
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

        let safe_name = sanitize_file_name(&file_name);
        let path = dir.join(format!(
            "{}-{}-{}",
            now.format("%Y-%m-%d-%H%M%S"),
            unique_suffix(),
            safe_name
        ));

        fs::write(&path, bytes).map_err(|error| error.to_string())?;
        relative_path(&vault, &path)
    })
    .await
}

#[tauri::command]
async fn read_fragment_image(app: tauri::AppHandle, path: String) -> Result<String, String> {
    run_blocking(move || {
        let vault = ensure_vault_dirs(&app)?;
        let image_path = resolve_vault_asset_path(&vault, &path)?;
        let mime_type = image_mime_type(&image_path)?;
        let bytes = fs::read(&image_path).map_err(|error| error.to_string())?;
        let encoded = BASE64_STANDARD.encode(bytes);

        Ok(format!("data:{mime_type};base64,{encoded}"))
    })
    .await
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn set_window_controls_hidden(window: tauri::Window, hidden: bool) -> Result<(), String> {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    let ns_window = window.ns_window().map_err(|error| error.to_string())?;
    let ns_window = unsafe { &*ns_window.cast::<NSWindow>() };

    for button in [
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::CloseButton,
        NSWindowButton::ZoomButton,
    ] {
        if let Some(control) = ns_window.standardWindowButton(button) {
            control.setHidden(hidden);
        }
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn set_window_controls_hidden(_window: tauri::Window, _hidden: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn restore_window_frame(window: tauri::WebviewWindow) -> Result<(), String> {
    restore_default_window_frame(&window)
}

fn restore_default_window_frame(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.is_fullscreen().map_err(|error| error.to_string())? {
        window
            .set_fullscreen(false)
            .map_err(|error| error.to_string())?;
    }
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())?;
    }

    window
        .set_size(tauri::LogicalSize::new(
            DEFAULT_WINDOW_WIDTH,
            DEFAULT_WINDOW_HEIGHT,
        ))
        .map_err(|error| error.to_string())?;

    if let Some(monitor) = window
        .current_monitor()
        .map_err(|error| error.to_string())?
    {
        let work_area = monitor.work_area();
        let scale_factor = monitor.scale_factor();
        let target_width = (DEFAULT_WINDOW_WIDTH * scale_factor).round() as i32;
        let target_height = (DEFAULT_WINDOW_HEIGHT * scale_factor).round() as i32;
        let x = work_area.position.x + (work_area.size.width as i32 - target_width) / 2;
        let y = work_area.position.y + (work_area.size.height as i32 - target_height) / 2;

        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|error| error.to_string())
    } else {
        window.center().map_err(|error| error.to_string())
    }
}

#[tauri::command]
async fn sync_vault(app: tauri::AppHandle) -> Result<GitInfo, String> {
    run_blocking(move || {
        let vault = ensure_vault_dirs(&app)?;

        if !vault.join(".git").exists() {
            return Err("Git 未初始化。请先在 Vault 设置中初始化 Git。".to_string());
        }

        push_vault(&vault)?;
        Ok(git_info(&vault))
    })
    .await
}

fn push_vault(vault: &Path) -> Result<(), String> {
    let Some(remote) = default_remote(vault) else {
        return Err("Git remote 未配置。请先在 ShardVault 中设置远端。".to_string());
    };

    ensure_no_unfinished_git_operation(vault)?;
    commit_all_if_dirty(vault, "sync local vault changes")?;

    let branch = current_branch(vault);
    let has_upstream = run_git(
        vault,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .is_ok();

    if has_upstream {
        pull_rebase_autostash(vault, None)?;
        run_git(vault, &["push"])?;
    } else {
        let remote_branch =
            run_git(vault, &["ls-remote", "--heads", &remote, &branch]).unwrap_or_default();
        if !remote_branch.trim().is_empty() {
            pull_rebase_autostash(vault, Some((&remote, &branch)))?;
        }
        run_git(vault, &["push", "-u", &remote, &branch])?;
    }
    Ok(())
}

fn pull_rebase_autostash(vault: &Path, target: Option<(&str, &str)>) -> Result<(), String> {
    let mut args = vec!["pull", "--rebase", "--autostash"];
    if let Some((remote, branch)) = target {
        args.push(remote);
        args.push(branch);
    }

    match run_git(vault, &args) {
        Ok(_) => {
            if has_rebase_in_progress(vault) {
                return Err("Git rebase 未完成。请先在 Vault 中解决冲突后再同步。".to_string());
            }
            Ok(())
        }
        Err(error) => {
            let abort_error = if has_rebase_in_progress(vault) {
                run_git(vault, &["rebase", "--abort"]).err()
            } else {
                None
            };
            let mut message = format_git_sync_error(&error);
            if let Some(abort_error) = abort_error {
                message.push_str(&format!("\n\n自动中止 rebase 失败：{abort_error}"));
            }
            Err(message)
        }
    }
}

fn ensure_vault_dirs(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let vault = configured_vault_path(app)?;
    ensure_vault_layout(&vault)?;
    Ok(vault)
}

fn ensure_vault_layout(vault: &Path) -> Result<(), String> {
    fs::create_dir_all(vault.join("fragments")).map_err(|error| error.to_string())?;
    fs::create_dir_all(vault.join("archive")).map_err(|error| error.to_string())?;
    fs::create_dir_all(vault.join("assets")).map_err(|error| error.to_string())?;
    Ok(())
}

fn configured_vault_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = read_app_config(app)?.vault_path {
        return Ok(PathBuf::from(path));
    }

    let default = default_vault_path()?;
    if default.exists() {
        return Ok(default);
    }

    Err("vault_not_configured".to_string())
}

fn app_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("settings.json"))
}

fn read_app_config(app: &tauri::AppHandle) -> Result<AppConfig, String> {
    let path = app_config_path(app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }

    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

fn write_app_config(app: &tauri::AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = app_config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(path, text).map_err(|error| error.to_string())
}

fn default_vault_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "无法找到用户 home 目录".to_string())?;
    Ok(PathBuf::from(home).join("Documents").join("ShardVault"))
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{:04x}", nanos & 0xffff)
}

fn collect_markdown_files(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_markdown_files(&path, files)?;
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            files.push(path);
        }
    }

    Ok(())
}

fn read_fragment(
    path: &Path,
    vault: &Path,
    dirty_paths: &HashSet<String>,
    override_status: Option<(String, Option<String>)>,
) -> Result<Fragment, String> {
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let (frontmatter, body) = parse_fragment_text(&text)?;
    let rel_path = relative_path(vault, path)?;
    let (git_status, error) = override_status.unwrap_or_else(|| {
        if !vault.join(".git").exists() {
            ("saved".to_string(), None)
        } else if dirty_paths.contains(&rel_path) {
            ("sync_pending".to_string(), None)
        } else {
            ("committed".to_string(), None)
        }
    });
    let archived = rel_path.starts_with("archive/");

    Ok(Fragment {
        id: frontmatter.id,
        content: body.trim_start_matches('\n').to_string(),
        created_at: frontmatter.created_at,
        updated_at: frontmatter.updated_at,
        tags: if frontmatter.tags.is_empty() {
            vec!["inbox".to_string()]
        } else {
            frontmatter.tags
        },
        category: frontmatter.category,
        path: rel_path,
        git_status,
        error,
        ai_status: frontmatter.ai_status.unwrap_or_else(|| "none".to_string()),
        archived,
    })
}

fn parse_fragment_text(text: &str) -> Result<(FragmentFrontmatter, &str), String> {
    let rest = text
        .strip_prefix("---\n")
        .ok_or_else(|| "片段缺少 frontmatter".to_string())?;
    let boundary = rest
        .find("\n---")
        .ok_or_else(|| "片段 frontmatter 未闭合".to_string())?;
    let yaml = &rest[..boundary];
    let body = &rest[(boundary + 4)..];
    let frontmatter =
        serde_yaml::from_str::<FragmentFrontmatter>(yaml).map_err(|error| error.to_string())?;
    Ok((frontmatter, body))
}

fn write_fragment_file(
    path: &Path,
    frontmatter: &FragmentFrontmatter,
    body: &str,
) -> Result<(), String> {
    let yaml = serde_yaml::to_string(frontmatter).map_err(|error| error.to_string())?;
    let yaml = yaml.strip_prefix("---\n").unwrap_or(&yaml);
    let text = format!("---\n{}---\n\n{}\n", yaml, body.trim_end());
    fs::write(path, text).map_err(|error| error.to_string())
}

fn find_fragment_path(vault: &Path, id: &str) -> Result<Option<PathBuf>, String> {
    let mut files = Vec::new();
    collect_markdown_files(&vault.join("fragments"), &mut files)?;
    collect_markdown_files(&vault.join("archive"), &mut files)?;
    for path in files {
        let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        if let Ok((frontmatter, _)) = parse_fragment_text(&text) {
            if frontmatter.id == id {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

fn normalize_tag(tag: &str) -> Option<String> {
    let tag = tag.trim().trim_start_matches('#').trim_matches(|char| {
        matches!(
            char,
            ',' | '.'
                | '?'
                | '!'
                | ';'
                | ':'
                | '，'
                | '。'
                | '？'
                | '！'
                | '；'
                | '：'
                | '、'
                | ')'
                | ']'
                | '}'
                | '"'
                | '\''
                | '”'
                | '’'
        )
    });
    let tag = tag.split_whitespace().collect::<Vec<_>>().join(" ");
    if tag.is_empty() {
        None
    } else {
        Some(tag)
    }
}

fn normalize_tags(tags: Vec<String>, include_inbox: bool) -> Vec<String> {
    let mut next_tags = tags
        .iter()
        .filter_map(|tag| normalize_tag(tag))
        .collect::<Vec<_>>();
    if include_inbox {
        next_tags.push("inbox".to_string());
    }
    next_tags.sort();
    next_tags.dedup();
    next_tags
}

fn sanitize_file_name(file_name: &str) -> String {
    let normalized = file_name
        .trim()
        .trim_start_matches('.')
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else if character.is_whitespace() {
                '-'
            } else {
                '_'
            }
        })
        .collect::<String>();

    let normalized = normalized.trim_matches(['-', '_', '.']).to_string();
    if normalized.is_empty() {
        "image.png".to_string()
    } else {
        normalized.chars().take(80).collect()
    }
}

fn resolve_vault_asset_path(vault: &Path, raw_path: &str) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("图片路径为空".to_string());
    }
    if trimmed.contains("://") || trimmed.starts_with("//") {
        return Err("不支持读取外部图片地址".to_string());
    }

    let requested_path = PathBuf::from(trimmed);
    let candidate = if requested_path.is_absolute() {
        requested_path
    } else {
        vault.join(requested_path)
    };

    let asset_root = vault
        .join("assets")
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let image_path = candidate.canonicalize().map_err(|error| error.to_string())?;

    if !image_path.starts_with(&asset_root) {
        return Err("只能读取 vault assets 目录中的图片".to_string());
    }
    if !image_path.is_file() {
        return Err("图片文件不存在".to_string());
    }

    Ok(image_path)
}

fn image_mime_type(path: &Path) -> Result<&'static str, String> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .unwrap_or_default();

    match extension.as_str() {
        "gif" => Ok("image/gif"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "png" => Ok("image/png"),
        "svg" => Ok("image/svg+xml"),
        "webp" => Ok("image/webp"),
        _ => Err("不支持的图片格式".to_string()),
    }
}

fn ensure_git_repo(vault: &Path) -> Result<(), String> {
    if vault.join(".git").exists() {
        return ensure_git_identity(vault);
    }
    run_git(vault, &["init"])?;
    ensure_git_identity(vault)
}

fn commit_path(vault: &Path, rel_path: &str, message: &str) -> Result<(), String> {
    ensure_git_identity(vault)?;
    run_git(vault, &["add", rel_path])?;
    run_git(vault, &["commit", "-m", message]).map(|_| ())
}

fn commit_path_if_git(vault: &Path, rel_path: &str, message: &str) -> Result<Option<()>, String> {
    if !vault.join(".git").exists() {
        return Ok(None);
    }

    commit_path(vault, rel_path, message).map(Some)
}

fn commit_all(vault: &Path, message: &str) -> Result<(), String> {
    ensure_git_identity(vault)?;
    run_git(vault, &["add", "-A"])?;
    run_git(vault, &["commit", "-m", message]).map(|_| ())
}

fn commit_all_if_dirty(vault: &Path, message: &str) -> Result<(), String> {
    let status = run_git(vault, &["status", "--porcelain"])?;

    if status.trim().is_empty() {
        return Ok(());
    }

    commit_all(vault, message)
}

fn ensure_git_identity(vault: &Path) -> Result<(), String> {
    if run_git(vault, &["config", "user.name"])
        .ok()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        run_git(vault, &["config", "user.name", "Shard"])?;
    }

    if run_git(vault, &["config", "user.email"])
        .ok()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        run_git(vault, &["config", "user.email", "shard@local"])?;
    }

    Ok(())
}

fn commit_all_if_git(vault: &Path, message: &str) -> Result<Option<()>, String> {
    if !vault.join(".git").exists() {
        return Ok(None);
    }

    commit_all(vault, message).map(Some)
}

fn dirty_paths(vault: &Path) -> HashSet<String> {
    let mut paths = HashSet::new();
    if !vault.join(".git").exists() {
        return paths;
    }

    let Ok(output) = run_git(
        vault,
        &[
            "status",
            "--porcelain",
            "--",
            "fragments",
            "archive",
            "assets",
        ],
    ) else {
        return paths;
    };

    for line in output.lines() {
        if line.len() >= 4 {
            paths.insert(line[3..].trim().to_string());
        }
    }

    paths
}

fn git_info(vault: &Path) -> GitInfo {
    if !vault.join(".git").exists() {
        return GitInfo {
            branch: "main".to_string(),
            short_commit: "no git".to_string(),
            has_remote: false,
            status: "no_git".to_string(),
            error: None,
        };
    }

    let branch = current_branch(vault);
    let short_commit = run_git(vault, &["rev-parse", "--short", "HEAD"])
        .unwrap_or_else(|_| "no commit".to_string())
        .trim()
        .to_string();
    let has_remote = !git_remotes(vault).is_empty();

    match run_git(vault, &["status", "--porcelain"]) {
        Ok(status) if status.trim().is_empty() => GitInfo {
            branch: if branch.is_empty() {
                "main".to_string()
            } else {
                branch
            },
            short_commit,
            has_remote,
            status: "ready".to_string(),
            error: None,
        },
        Ok(_) => GitInfo {
            branch: if branch.is_empty() {
                "main".to_string()
            } else {
                branch
            },
            short_commit,
            has_remote,
            status: "dirty".to_string(),
            error: None,
        },
        Err(error) => GitInfo {
            branch: if branch.is_empty() {
                "main".to_string()
            } else {
                branch
            },
            short_commit,
            has_remote,
            status: "error".to_string(),
            error: Some(error),
        },
    }
}

fn current_branch(vault: &Path) -> String {
    let branch = run_git(vault, &["branch", "--show-current"])
        .or_else(|_| run_git(vault, &["symbolic-ref", "--short", "HEAD"]))
        .unwrap_or_else(|_| "main".to_string())
        .trim()
        .to_string();

    if branch.is_empty() {
        "main".to_string()
    } else {
        branch
    }
}

fn git_remotes(vault: &Path) -> Vec<String> {
    run_git(vault, &["remote"])
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|remote| !remote.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn default_remote(vault: &Path) -> Option<String> {
    let remotes = git_remotes(vault);
    remotes
        .iter()
        .find(|remote| remote.as_str() == "origin")
        .cloned()
        .or_else(|| remotes.into_iter().next())
}

fn ensure_no_unfinished_git_operation(vault: &Path) -> Result<(), String> {
    if has_rebase_in_progress(vault) {
        return Err("Vault 中有未完成的 Git rebase。请先解决冲突或在 Vault 里执行 git rebase --abort 后再同步。".to_string());
    }

    if git_internal_path_exists(vault, "MERGE_HEAD") {
        return Err("Vault 中有未完成的 Git merge。请先解决冲突或在 Vault 里执行 git merge --abort 后再同步。".to_string());
    }

    Ok(())
}

fn has_rebase_in_progress(vault: &Path) -> bool {
    git_internal_path_exists(vault, "rebase-merge")
        || git_internal_path_exists(vault, "rebase-apply")
}

fn git_internal_path_exists(vault: &Path, name: &str) -> bool {
    let Ok(path) = run_git(vault, &["rev-parse", "--git-path", name]) else {
        return false;
    };

    let path = PathBuf::from(path.trim());
    let path = if path.is_absolute() {
        path
    } else {
        vault.join(path)
    };

    path.exists()
}

fn format_git_sync_error(error: &str) -> String {
    let lower = error.to_lowercase();
    if lower.contains("conflict")
        || lower.contains("could not apply")
        || lower.contains("resolve all conflicts")
    {
        return format!(
            "同步遇到 Git 冲突。Shard 已保留本地提交并停止自动同步，请在 Vault 中解决冲突后再同步。\n\n{error}"
        );
    }

    if lower.contains("authentication failed")
        || lower.contains("permission denied")
        || lower.contains("could not read username")
        || lower.contains("terminal prompts disabled")
    {
        return format!(
            "Git 认证失败。请先在终端确认当前 Vault 可以执行 git fetch 和 git push，再回到 Shard 同步。\n\n{error}"
        );
    }

    if lower.contains("cannot pull with rebase") {
        return format!(
            "Git 仍检测到未提交变更，无法 rebase。Shard 会先提交 vault 变更并使用 autostash；如果问题持续，请检查 Vault 中是否有未完成的 Git 操作。\n\n{error}"
        );
    }

    error.to_string()
}

fn gh_path() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    if let Some(paths) = env::var_os("PATH") {
        candidates.extend(env::split_paths(&paths).map(|path| path.join("gh")));
    }

    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/gh"),
        PathBuf::from("/usr/local/bin/gh"),
        PathBuf::from("/usr/bin/gh"),
    ]);

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "未检测到 GitHub CLI。".to_string())
}

fn codex_path() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    candidates.push(PathBuf::from("/opt/homebrew/bin/codex"));

    if let Some(paths) = env::var_os("PATH") {
        candidates.extend(env::split_paths(&paths).map(|path| path.join("codex")));
    }

    candidates.extend([
        PathBuf::from("/usr/local/bin/codex"),
        PathBuf::from("/usr/bin/codex"),
    ]);

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "未检测到 Codex CLI。".to_string())
}

fn codex_review_prompt(request: &CodexReviewTaskRequest) -> String {
    let task_prompt = match request.task {
        CodexReviewTask::Insight => {
            "请只基于下面这些 Shard 片段做 AI 洞察。输出中文 Markdown，固定包含三个二级标题：核心主题、可能盲点、继续追问。每个标题下给 2-4 条短要点。不要虚构片段之外的事实，不要建议修改文件。"
        }
        CodexReviewTask::Walk => {
            "请只基于下面这些 Shard 片段生成一次随机漫步。输出中文 Markdown，固定包含两个二级标题：漫步路径、意外连接。漫步路径用有序列表说明相邻片段之间的连接理由。不要虚构片段之外的事实，不要建议修改文件。"
        }
    };

    format!(
        "{}\n\n运行约束：你正在只读 Shard vault；不要执行写入、删除、格式化、git、网络或外部副作用命令。\n\n片段：\n{}",
        task_prompt,
        codex_fragment_context(&request.fragments)
    )
}

fn codex_fragment_context(fragments: &[CodexReviewFragment]) -> String {
    fragments
        .iter()
        .enumerate()
        .map(|(index, fragment)| {
            format!(
                "### {}\n- id: {}\n- created_at: {}\n- path: {}\n- tags: {}\n\n{}\n",
                index + 1,
                fragment.id,
                fragment.created_at,
                fragment.path,
                if fragment.tags.is_empty() {
                    "none".to_string()
                } else {
                    fragment.tags.join(", ")
                },
                fragment.content.trim()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn run_codex_exec(vault: &Path, prompt: &str) -> Result<String, String> {
    let codex = codex_path()?;
    let mut child = Command::new(codex)
        .args([
            "-s",
            "read-only",
            "-a",
            "never",
            "-C",
            &vault.display().to_string(),
            "exec",
            "--json",
            "--ephemeral",
            "-",
        ])
        .current_dir(vault)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 Codex CLI：{error}"))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|error| format!("无法写入 Codex prompt：{error}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("Codex CLI 执行失败：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        let message = stderr.trim();
        if message.is_empty() {
            return Err(stdout.trim().to_string());
        }
        return Err(message.to_string());
    }

    extract_codex_agent_message(&stdout)
}

fn extract_codex_agent_message(output: &str) -> Result<String, String> {
    let mut final_text = None;

    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('{'))
    {
        let Ok(json) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if json["type"].as_str() != Some("item.completed") {
            continue;
        }
        if json["item"]["type"].as_str() != Some("agent_message") {
            continue;
        }
        if let Some(text) = json["item"]["text"]
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            final_text = Some(text.to_string());
        }
    }

    final_text.ok_or_else(|| "Codex 没有返回可展示的文本。".to_string())
}

fn run_gh_in(vault: &Path, args: &[&str]) -> Result<String, String> {
    let gh = gh_path()?;
    run_command(Command::new(gh).args(args).current_dir(vault))
}

fn run_gh_with_path(gh: &Path, args: &[&str]) -> Result<String, String> {
    run_command(Command::new(gh).args(args))
}

fn parse_gh_login(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let (_, login) = line.split_once("account ")?;
        login
            .split_whitespace()
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
}

fn sanitize_repo_name(repo_name: &str) -> Result<String, String> {
    let repo_name = repo_name.trim().trim_matches('/').to_string();
    if repo_name.is_empty() {
        return Err("GitHub 仓库名不能为空".to_string());
    }

    let parts = repo_name.split('/').collect::<Vec<_>>();
    if parts.len() > 2 || parts.iter().any(|part| part.is_empty()) {
        return Err("仓库名应为 repo 或 owner/repo。".to_string());
    }

    let is_valid = repo_name.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/')
    });
    if !is_valid {
        return Err("仓库名只能包含字母、数字、横线、下划线、点和一个斜杠。".to_string());
    }

    Ok(repo_name)
}

fn run_git(vault: &Path, args: &[&str]) -> Result<String, String> {
    run_command(
        Command::new("git")
            .args(args)
            .current_dir(vault)
            .env("GIT_TERMINAL_PROMPT", "0"),
    )
}

fn run_command(command: &mut Command) -> Result<String, String> {
    let output = command.output().map_err(|error| error.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stderr.is_empty() {
            Err(stdout)
        } else {
            Err(stderr)
        }
    }
}

fn relative_path(vault: &Path, path: &Path) -> Result<String, String> {
    let rel = path
        .strip_prefix(vault)
        .map_err(|error| error.to_string())?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            for window in app.webview_windows().values() {
                restore_default_window_frame(window)?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_fragments,
            set_vault_path,
            initialize_vault_git,
            set_vault_remote,
            github_cli_status,
            codex_agent_status,
            run_codex_review_task,
            create_github_vault_repo,
            create_fragment,
            update_fragment,
            update_fragment_tags,
            archive_fragment,
            save_fragment_image,
            read_fragment_image,
            set_window_controls_hidden,
            restore_window_frame,
            sync_vault
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_last_codex_agent_message_from_jsonl() {
        let output = r#"
{"type":"thread.started","thread_id":"abc"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"first"}}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"final answer"}}
{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}
"#;

        assert_eq!(extract_codex_agent_message(output).unwrap(), "final answer");
    }

    #[test]
    fn ignores_non_json_warning_lines_in_codex_output() {
        let output = r#"
2026-06-06T16:44:26Z WARN noisy startup warning
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
"#;

        assert_eq!(extract_codex_agent_message(output).unwrap(), "OK");
    }

    #[test]
    fn returns_error_when_codex_has_no_message() {
        let output = r#"{"type":"turn.completed"}"#;

        assert!(extract_codex_agent_message(output).is_err());
    }
}
