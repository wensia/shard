use chrono::Local;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultState {
    vault_path: String,
    fragments: Vec<Fragment>,
    git: GitInfo,
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

#[tauri::command]
fn list_fragments() -> Result<VaultState, String> {
    let vault = ensure_vault_dirs()?;
    let mut files = Vec::new();
    collect_markdown_files(&vault.join("fragments"), &mut files)?;

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
fn create_fragment(content: String, tags: Option<Vec<String>>) -> Result<Fragment, String> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("片段内容不能为空".to_string());
    }

    let vault = ensure_vault_dirs()?;
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
    let commit_result = commit_path(
        &vault,
        &rel_path,
        &format!("create fragment {}", now.format("%Y-%m-%d %H:%M:%S")),
    );

    let dirty = dirty_paths(&vault);
    let override_status = match commit_result {
        Ok(_) => Some(("committed".to_string(), None)),
        Err(error) => Some(("commit_failed".to_string(), Some(error))),
    };

    read_fragment(&path, &vault, &dirty, override_status)
}

#[tauri::command]
fn update_fragment_tags(id: String, tags: Vec<String>) -> Result<Fragment, String> {
    let vault = ensure_vault_dirs()?;
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
    let commit_result = commit_path(
        &vault,
        &rel_path,
        &format!("update fragment tags {}", frontmatter.id),
    );

    let dirty = dirty_paths(&vault);
    let override_status = match commit_result {
        Ok(_) => Some(("committed".to_string(), None)),
        Err(error) => Some(("commit_failed".to_string(), Some(error))),
    };

    read_fragment(&path, &vault, &dirty, override_status)
}

#[tauri::command]
fn sync_vault() -> Result<GitInfo, String> {
    let vault = ensure_vault_dirs()?;
    ensure_git_repo(&vault)?;

    if run_git(&vault, &["remote"])
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        return Err("Git remote 未配置。请先在 ShardVault 中设置远端。".to_string());
    }

    run_git(&vault, &["pull", "--rebase"])?;
    run_git(&vault, &["push"])?;
    Ok(git_info(&vault))
}

fn ensure_vault_dirs() -> Result<PathBuf, String> {
    let vault = default_vault_path()?;
    fs::create_dir_all(vault.join("fragments")).map_err(|error| error.to_string())?;
    Ok(vault)
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
    let tag = tag
        .trim()
        .trim_start_matches('#')
        .trim_matches(|char| {
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
        })
        .replace(char::is_whitespace, "-");
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

fn ensure_git_repo(vault: &Path) -> Result<(), String> {
    if vault.join(".git").exists() {
        return Ok(());
    }
    run_git(vault, &["init"]).map(|_| ())
}

fn commit_path(vault: &Path, rel_path: &str, message: &str) -> Result<(), String> {
    ensure_git_repo(vault)?;
    run_git(vault, &["add", rel_path])?;
    run_git(vault, &["commit", "-m", message]).map(|_| ())
}

fn dirty_paths(vault: &Path) -> HashSet<String> {
    let mut paths = HashSet::new();
    if !vault.join(".git").exists() {
        return paths;
    }

    let Ok(output) = run_git(vault, &["status", "--porcelain", "--", "fragments"]) else {
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

    let branch = run_git(vault, &["branch", "--show-current"])
        .unwrap_or_else(|_| "main".to_string())
        .trim()
        .to_string();
    let short_commit = run_git(vault, &["rev-parse", "--short", "HEAD"])
        .unwrap_or_else(|_| "no commit".to_string())
        .trim()
        .to_string();
    let has_remote = !run_git(vault, &["remote"])
        .unwrap_or_default()
        .trim()
        .is_empty();

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

fn run_git(vault: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(vault)
        .output()
        .map_err(|error| error.to_string())?;

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
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_fragments,
            create_fragment,
            update_fragment_tags,
            sync_vault
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
