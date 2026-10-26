//! Markdown 方言版本与一次性迁移。
//!
//! 方言 v2：源码一行显示一行，空一行显示一行空白（v1 里段落之间的一个空行不显示）。
//! 改写规则在前端 `src/editor-rich/markdown/migrate.ts`，与编辑器用同一个 Lezer 解析器；
//! 这里只负责列出待迁移的原文、核对 sha 后整批写回、记下版本。
//!
//! - 公开内容按整个资料库记一个版本（`.shard/format.json`）。
//! - 密匣上锁时也能用公钥写入新碎片，不能按整库判断，所以每条载荷自带 `markdown_dialect`；
//!   没有这个字段的是 v1 旧载荷，解锁后迁移。
//!
//! v1 → v2 的改写不是幂等的，版本标记保证同一份内容只迁移一次。

use serde::{Deserialize, Serialize};
use shard_core::FsVfs;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use crate::{
    checkpoint_before_structural_locked, collect_markdown_files, commit_paths_if_git,
    content_sha256_hex, relative_path, write_text_atomically, LockboxReadKeys, LocalVault,
};
// 方言版本、提交信息与路径校验和密匣迁移共用一份：密匣部分在 shard-vault::lockbox。
use shard_core::MARKDOWN_DIALECT;
use shard_vault::{
    dialect_migration_path as safe_relative,
    MARKDOWN_DIALECT_MIGRATION_COMMIT_MESSAGE as MIGRATION_COMMIT_MESSAGE,
};
pub(crate) use shard_vault::lockbox::{
    LockboxDialectSource as LockboxSource, MigratedLockboxDialectSource as MigratedLockboxSource,
};
#[cfg(test)]
use shard_vault::lockbox::lockbox_dialect_target as lockbox_target;

const FORMAT_FILE: &str = ".shard/format.json";
/// 迁移扫描的公开目录；密匣单独处理。
const PUBLIC_MARKDOWN_ROOTS: &[&str] = &["fragments", "notes", ".trash", "maps", "datasets", "assets"];

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultFormat {
    #[serde(default)]
    markdown_dialect: u32,
    /// 以后加的其他格式键原样保留。
    #[serde(flatten)]
    other: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicMigrationPlan {
    dialect: u32,
    sources: Vec<PublicSource>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicSource {
    path: String,
    content: String,
    sha: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigratedPublicSource {
    path: String,
    expected_sha: String,
    content: String,
}

/// 资料库公开内容的方言版本；没有标记的是 v1。
pub(crate) fn vault_markdown_dialect(vault: &Path) -> Result<u32, String> {
    Ok(read_vault_format(vault)?.markdown_dialect.max(1))
}

fn read_vault_format(vault: &Path) -> Result<VaultFormat, String> {
    let path = vault.join(FORMAT_FILE);
    if !path.exists() {
        return Ok(VaultFormat::default());
    }
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| format!("{FORMAT_FILE} 无法解析：{error}"))
}

pub(crate) fn mark_vault_markdown_dialect(vault: &Path) -> Result<(), String> {
    let mut format = read_vault_format(vault)?;
    format.markdown_dialect = MARKDOWN_DIALECT;
    let mut text = serde_json::to_string_pretty(&format).map_err(|error| error.to_string())?;
    text.push('\n');
    let path = vault.join(FORMAT_FILE);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    write_text_atomically(&path, &text)
}

/// 从没被 Shard 打开过的文件夹：里面的 Markdown 本来就按标准写法理解，直接记为 v2，不迁移。
pub(crate) fn is_fresh_vault(vault: &Path) -> bool {
    [".shard", "fragments", "notes"]
        .iter()
        .all(|directory| !vault.join(directory).exists())
}

pub(crate) fn list_public_sources(vault: &Path) -> Result<PublicMigrationPlan, String> {
    let dialect = vault_markdown_dialect(vault)?;
    if dialect >= MARKDOWN_DIALECT {
        return Ok(PublicMigrationPlan { dialect, sources: Vec::new() });
    }

    let mut files = Vec::new();
    for root in PUBLIC_MARKDOWN_ROOTS {
        collect_markdown_files(&FsVfs::new(vault), &vault.join(root), &mut files)?;
    }
    files.sort();

    let mut sources = Vec::with_capacity(files.len());
    for path in files {
        // 读不成 UTF-8 的文件 Shard 本来也显示不了，跳过，不挡住整批迁移。
        let Ok(content) = fs::read_to_string(&path) else {
            eprintln!("[shard] 方言迁移跳过无法读取的文件：{}", path.display());
            continue;
        };
        sources.push(PublicSource {
            path: relative_path(vault, &path)?,
            sha: content_sha256_hex(&content),
            content,
        });
    }
    Ok(PublicMigrationPlan { dialect, sources })
}

/// 调用方持有写门。先逐个核对 sha，全部通过才写；写完记版本并提交，提交前留检查点。
pub(crate) fn apply_public_migration(
    vault: &Path,
    files: Vec<MigratedPublicSource>,
) -> Result<usize, String> {
    if vault_markdown_dialect(vault)? >= MARKDOWN_DIALECT {
        return Err("资料库已经是新格式，不能重复迁移。".to_string());
    }
    checkpoint_before_structural_locked(vault);

    let mut writes: Vec<(PathBuf, String, String)> = Vec::new();
    for file in files {
        let target = public_target(vault, &file.path)?;
        let current = fs::read_to_string(&target).map_err(|error| error.to_string())?;
        if content_sha256_hex(&current) != file.expected_sha {
            return Err(format!("{} 在迁移期间被改动，已中止，请重启 Shard 再试。", file.path));
        }
        if current != file.content {
            writes.push((target, file.path, file.content));
        }
    }

    for (target, _, content) in &writes {
        write_text_atomically(target, content)?;
    }
    mark_vault_markdown_dialect(vault)?;

    let mut paths: Vec<String> = writes.iter().map(|(_, path, _)| path.clone()).collect();
    paths.push(FORMAT_FILE.to_string());
    if let Err(error) = commit_paths_if_git(vault, &paths, MIGRATION_COMMIT_MESSAGE) {
        eprintln!("[shard] 方言迁移提交失败（文件已写入）：{error}");
    }
    Ok(writes.len())
}

/// 解锁后列出还是方言 v1 的密匣正文（领域逻辑在 shard-vault::lockbox）。
pub(crate) fn list_lockbox_sources(
    vault: &Path,
    read_keys: &LockboxReadKeys,
) -> Result<Vec<LockboxSource>, String> {
    shard_vault::lockbox::list_lockbox_dialect_sources(&LocalVault::new(vault).cx(), read_keys)
}

/// 调用方持有写门。只改 v1 载荷的正文并标上 v2；核对 sha 全部通过才写（领域逻辑在 shard-vault::lockbox）。
pub(crate) fn apply_lockbox_migration(
    vault: &Path,
    read_keys: &LockboxReadKeys,
    files: Vec<MigratedLockboxSource>,
) -> Result<usize, String> {
    shard_vault::lockbox::apply_lockbox_dialect_migration(&LocalVault::new(vault).cx(), read_keys, files)
}

fn public_target(vault: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let target = safe_relative(vault, rel_path)?;
    let root = Path::new(rel_path).components().next();
    let allowed = matches!(root, Some(Component::Normal(name)) if PUBLIC_MARKDOWN_ROOTS.iter().any(|root| name == *root));
    if !allowed || !rel_path.ends_with(".md") {
        return Err(format!("不允许迁移这个路径：{rel_path}"));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shard-dialect-{name}-{}", crate::unique_suffix()));
        fs::create_dir_all(dir.join("fragments")).unwrap();
        fs::create_dir_all(dir.join(".shard")).unwrap();
        dir
    }

    #[test]
    fn unmarked_vault_is_v1_and_marking_keeps_other_keys() {
        let vault = temp_vault("mark");
        assert_eq!(vault_markdown_dialect(&vault).unwrap(), 1);
        fs::write(vault.join(FORMAT_FILE), "{\"future\":true}\n").unwrap();
        mark_vault_markdown_dialect(&vault).unwrap();
        assert_eq!(vault_markdown_dialect(&vault).unwrap(), 2);
        let text = fs::read_to_string(vault.join(FORMAT_FILE)).unwrap();
        assert!(text.contains("\"future\": true"));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn public_migration_checks_sha_writes_once_and_refuses_to_repeat() {
        let vault = temp_vault("public");
        let file = vault.join("fragments/a.md");
        fs::write(&file, "甲\n\n乙\n").unwrap();
        let plan = list_public_sources(&vault).unwrap();
        assert_eq!(plan.dialect, 1);
        assert_eq!(plan.sources.len(), 1);
        let source = &plan.sources[0];

        let stale = apply_public_migration(
            &vault,
            vec![MigratedPublicSource {
                path: source.path.clone(),
                expected_sha: "0".repeat(64),
                content: "甲\n乙\n".to_string(),
            }],
        );
        assert!(stale.is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "甲\n\n乙\n");
        assert_eq!(vault_markdown_dialect(&vault).unwrap(), 1);

        let written = apply_public_migration(
            &vault,
            vec![MigratedPublicSource {
                path: source.path.clone(),
                expected_sha: source.sha.clone(),
                content: "甲\n乙\n".to_string(),
            }],
        )
        .unwrap();
        assert_eq!(written, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "甲\n乙\n");
        assert_eq!(vault_markdown_dialect(&vault).unwrap(), 2);
        assert!(list_public_sources(&vault).unwrap().sources.is_empty());
        assert!(apply_public_migration(&vault, Vec::new()).is_err());
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn migration_rejects_paths_outside_public_markdown() {
        let vault = temp_vault("paths");
        for path in ["../x.md", "/etc/x.md", "lockbox/a.md", ".git/x.md", "fragments/a.txt", "fragments/../../x.md"] {
            assert!(public_target(&vault, path).is_err(), "{path}");
        }
        assert!(public_target(&vault, "notes/项目/周报.md").is_ok());
        assert!(lockbox_target(&vault, "lockbox/fragments/a.shard").is_ok());
        assert!(lockbox_target(&vault, "fragments/a.shard").is_err());
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn fresh_folder_detection() {
        let dir = std::env::temp_dir().join(format!("shard-dialect-fresh-{}", crate::unique_suffix()));
        fs::create_dir_all(&dir).unwrap();
        assert!(is_fresh_vault(&dir));
        fs::create_dir_all(dir.join("notes")).unwrap();
        assert!(!is_fresh_vault(&dir));
        fs::remove_dir_all(dir).unwrap();
    }
}
