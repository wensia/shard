//! 资料库（`notes/`）的命名与路径规则，以及新建笔记、数据集说明文档的落盘。
//!
//! App 与 CLI 共用一份：文件名长度、非法字符、重名加 `-2` 后缀、目录必须在 `notes/` 内。
//! 只落盘不提交，调用方负责持有 vault 写门（App）或进程锁（CLI）。

use crate::{
    dataset::{self, DatasetLimits, DatasetSnapshot},
    new_fragment_id, normalize_tags, write_fragment_file, FragmentFrontmatter, Vfs,
    LIBRARY_FILENAME_MAX_BYTES, TYPE_TAGS,
};
use chrono::Local;
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

pub const LIBRARY_NAME_MAX_LENGTH: usize = 64;

pub fn validate_library_name_characters(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err("名称不能为空。".to_string());
    }
    if name.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
    }) {
        return Err("名称包含不允许的路径字符。".to_string());
    }
    Ok(name)
}

pub fn validate_library_name_length(stem: &str, extension: &str) -> Result<(), String> {
    if stem.chars().count() > LIBRARY_NAME_MAX_LENGTH {
        return Err("名称最多 64 个字符（不含扩展名）。".to_string());
    }
    if stem.len() + extension.len() > LIBRARY_FILENAME_MAX_BYTES {
        return Err("名称占用空间过长，请减少部分字符。".to_string());
    }
    Ok(())
}

pub fn validate_library_name(name: &str) -> Result<&str, String> {
    let name = validate_library_name_characters(name)?;
    validate_library_name_length(name, "")?;
    Ok(name)
}

pub fn validate_library_file_name<'a>(name: &'a str, extension: &str) -> Result<&'a str, String> {
    let name = validate_library_name_characters(name)?;
    let stem = name.strip_suffix(extension).unwrap_or(name);
    validate_library_name_characters(stem)?;
    validate_library_name_length(stem, extension)?;
    Ok(name)
}

pub fn library_relative_path(rel_path: &str) -> Result<&Path, String> {
    let rel_path = rel_path.trim();
    let path = Path::new(rel_path);
    if rel_path.is_empty() || rel_path.contains('\\') || path.is_absolute() {
        return Err("资料库路径必须是 notes/ 下的相对路径。".to_string());
    }
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::Normal(value)) if value == "notes")
        || components.any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("资料库路径必须位于 notes/ 且不能包含 . 或 ..。".to_string());
    }
    Ok(path)
}

pub fn existing_library_path(vfs: &dyn Vfs, rel_path: &str) -> Result<PathBuf, String> {
    let vault = vfs.root();
    let path = vault.join(library_relative_path(rel_path)?);
    if !vfs.exists(&path) {
        return Err(format!("找不到资料库条目 {rel_path}"));
    }
    if vfs
        .symlink_metadata(&path)
        .map_err(|error| error.to_string())?
        .is_symlink()
    {
        return Err("资料库操作不允许符号链接。".to_string());
    }
    let notes = vfs
        .canonicalize(&vault.join("notes"))
        .map_err(|error| error.to_string())?;
    let canonical = vfs.canonicalize(&path).map_err(|error| error.to_string())?;
    if !canonical.starts_with(&notes) || canonical == notes {
        return Err("不能操作资料库根目录或 vault 外路径。".to_string());
    }
    Ok(path)
}

pub fn existing_library_directory(
    vfs: &dyn Vfs,
    rel_path: Option<&str>,
) -> Result<PathBuf, String> {
    let path = match rel_path.map(str::trim).filter(|path| !path.is_empty()) {
        Some("notes") | None => vfs.root().join("notes"),
        Some(path) => existing_library_path(vfs, path)?,
    };
    if !vfs.is_dir(&path) {
        return Err("目标必须是资料库目录。".to_string());
    }
    Ok(path)
}

pub fn sanitized_note_stem(title: &str) -> String {
    let mut stem = title
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .map(|character| {
            if matches!(
                character,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    stem = stem.split_whitespace().collect::<Vec<_>>().join(" ");
    stem = stem
        .trim_matches(|character| character == '.' || character == ' ')
        .to_string();
    if stem.is_empty() {
        "未命名笔记".to_string()
    } else {
        stem
    }
}

// Filename limits apply to new names, never to the content/title of an existing document.
// Generated names reserve both character and byte space for the collision suffix.
pub fn bounded_library_filename(stem: &str, collision_suffix: &str, extension: &str) -> String {
    let max_chars = LIBRARY_NAME_MAX_LENGTH.saturating_sub(collision_suffix.chars().count());
    let max_bytes =
        LIBRARY_FILENAME_MAX_BYTES.saturating_sub(collision_suffix.len() + extension.len());
    let mut bytes = 0;
    let stem: String = stem
        .chars()
        .take(max_chars)
        .take_while(|character| {
            bytes += character.len_utf8();
            bytes <= max_bytes
        })
        .collect();
    format!("{stem}{collision_suffix}{extension}")
}

pub fn unique_titled_path(
    vfs: &dyn Vfs,
    directory: &Path,
    title: &str,
    extension: &str,
) -> PathBuf {
    let stem = sanitized_note_stem(title);
    let first = directory.join(bounded_library_filename(&stem, "", extension));
    if !vfs.exists(&first) {
        return first;
    }
    let mut collision_index = 2;
    loop {
        let candidate = directory.join(bounded_library_filename(
            &stem,
            &format!("-{collision_index}"),
            extension,
        ));
        if !vfs.exists(&candidate) {
            return candidate;
        }
        collision_index += 1;
    }
}

pub fn unique_note_path(vfs: &dyn Vfs, directory: &Path, title: &str) -> PathBuf {
    unique_titled_path(vfs, directory, title, ".md")
}

pub fn unique_mind_map_path(vfs: &dyn Vfs, directory: &Path, title: &str) -> PathBuf {
    unique_titled_path(vfs, directory, title, ".shardmap.json")
}

pub fn note_title(body: &str) -> String {
    body.lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("# ")
                .map(str::trim)
                .filter(|line| !line.is_empty())
        })
        .or_else(|| body.lines().map(str::trim).find(|line| !line.is_empty()))
        .unwrap_or("未命名笔记")
        .to_string()
}

/// 在资料库目录（缺省为 `notes/` 根）新建一篇笔记，返回文件路径。
///
/// 文件名取自标题（非法字符换成空格、重名加 `-2`）；`tags` 之外总会带上 `note` 类型标签，
/// 其他 type 标签让位给它。`source` 记录写入方（App 为 `desktop`，CLI 为 `cli` 或调用方
/// 声明的来源）。
pub fn create_library_note_file(
    vfs: &dyn Vfs,
    title: &str,
    directory: Option<&str>,
    body: &str,
    tags: Vec<String>,
    source: &str,
) -> Result<PathBuf, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("笔记标题不能为空。".to_string());
    }
    validate_library_name_length(title, ".md")?;
    let directory = existing_library_directory(vfs, directory)?;
    let path = unique_note_path(vfs, &directory, title);
    let now = Local::now();
    let created_at = now.to_rfc3339();
    let frontmatter = FragmentFrontmatter {
        id: new_fragment_id(&now),
        created_at: created_at.clone(),
        updated_at: created_at,
        tags: note_tags(tags),
        category: None,
        ai_status: Some("none".to_string()),
        pinned: false,
        source: source.to_string(),
        conflict_of: None,
        related: Vec::new(),
    };
    write_fragment_file(vfs, &path, &frontmatter, body)?;
    Ok(path)
}

fn note_tags(tags: Vec<String>) -> Vec<String> {
    let mut tags = normalize_tags(tags, false);
    tags.retain(|tag| !TYPE_TAGS.contains(&tag.as_str()));
    tags.push("note".to_string());
    tags.sort();
    tags
}

/// 新建 `datasets/<title>.csv` 及资料库里嵌入它的说明笔记，返回数据集快照与笔记路径。
/// 笔记建不出来时删掉刚写的 CSV 与 schema，不留孤儿数据集。
pub fn create_library_dataset_files(
    vfs: &dyn Vfs,
    title: &str,
    header: Vec<String>,
    rows: Vec<Vec<String>>,
    primary_key: Option<String>,
    directory: Option<&str>,
    source: &str,
) -> Result<(DatasetSnapshot, PathBuf), String> {
    #[derive(Serialize)]
    struct DatatableSource<'a> {
        title: &'a str,
        src: &'a str,
    }
    let title = title.trim();
    if title.is_empty() {
        return Err("数据集名称不能为空。".to_string());
    }
    validate_library_name_length(title, ".md")?;
    existing_library_directory(vfs, directory)?;
    let dataset = dataset::create_dataset(
        vfs,
        title,
        header,
        rows,
        primary_key,
        &DatasetLimits::default(),
    )
    .map_err(|error| error.to_string())?;
    let created = (|| {
        let block = serde_json::to_string_pretty(&DatatableSource {
            title,
            src: &dataset.path,
        })
        .map_err(|error| error.to_string())?;
        let body = format!("# {title}\n\n```datatable\n{block}\n```\n");
        create_library_note_file(vfs, title, directory, &body, Vec::new(), source)
    })();
    match created {
        Ok(note) => Ok((dataset, note)),
        Err(error) => {
            let csv = vfs.root().join(&dataset.path);
            if let Some(name) = csv.file_name().and_then(|name| name.to_str()) {
                let _ = vfs.remove_file(&csv.with_file_name(format!("{name}.schema.json")));
            }
            let _ = vfs.remove_file(&csv);
            Err(error)
        }
    }
}

/// 确保资料库目录存在并返回它；`rel_path` 必须在 `notes/` 下，缺的各级目录按资料库命名规则创建。
pub fn ensure_library_directory(vfs: &dyn Vfs, rel_path: &str) -> Result<PathBuf, String> {
    let vault = vfs.root();
    let relative = library_relative_path(rel_path)?;
    let mut current = vault.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("资料库路径必须位于 notes/ 且不能包含 . 或 ..。".to_string());
        };
        let name = name.to_string_lossy();
        if current != vault {
            validate_library_name(&name)?;
        }
        current.push(name.as_ref());
        match vfs.symlink_metadata(&current) {
            Ok(metadata) if metadata.is_symlink() => {
                return Err("资料库操作不允许符号链接。".to_string());
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(format!("{} 不是目录。", rel_path.trim()));
            }
            Ok(_) => {}
            Err(_) => vfs
                .create_dir(&current)
                .map_err(|error| error.to_string())?,
        }
    }
    existing_library_directory(vfs, Some(rel_path))
}
