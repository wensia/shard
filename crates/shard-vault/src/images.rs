//! 图片：内容寻址附件、资料库命名图片导入、引用查询、资料库图片宫格。

use crate::prelude::*;

/// 单张图片上限：GitHub 单文件 100 MB 硬上限之下留足余量，超限的图会让同步永久失败。
pub const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;

pub fn image_too_large_message() -> String {
    format!("图片超过 {} MiB，无法保存", MAX_IMAGE_BYTES / 1024 / 1024)
}

/// 笔记配图按内容寻址存进 `assets/<hh>/<sha256>.<ext>`：同一张图只存一份，名字与内容绑定。
/// 调用方持写门（原来在空内容、超限两项纯检查之后取门；挪到命令层后这两项检查也在门内，不触盘）。
pub fn store_image_attachment(cx: &VaultCtx<'_>, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(image_too_large_message());
    }
    let vault = cx.root();
    let mime_type = sniff_image_mime_type(bytes)?;
    let extension = shard_core::image::image_extension_for_mime_type(mime_type)
        .ok_or_else(|| "不支持的图片格式".to_string())?;
    let hash = hash_bytes(bytes);
    let dir = vault.join("assets").join(&hash[..2]);
    cx.vfs.create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(format!("{hash}.{extension}"));

    if !cx.vfs.exists(&path) {
        cx.vfs
            .write_atomic(&path, bytes)
            .map_err(|error| error.to_string())?;
    }
    relative_path(vault, &path)
}

/// 把图片按原文件名复制进资料库目录（缺省为 `notes/` 根）。`paths` 是来源标识（桌面是访达里的
/// 绝对路径，取文件名与扩展名），`read_source` 读出并校验来源字节（桌面读外部文件，拒绝密匣与超限）。
/// 逐个导入，单个失败（不是图片、超限、来自密匣）只记入 skipped，不影响其余文件。
/// 重名加 `-2` 后缀，绝不覆盖已有文件。调用方持有 vault 写门。
pub fn import_library_images_in_vault_with(
    cx: &VaultCtx<'_>,
    paths: &[String],
    directory: Option<&str>,
    read_source: &dyn Fn(&Path) -> Result<Vec<u8>, String>,
) -> Result<(Vec<String>, Vec<LibraryImportSkip>), String> {
    let vault = cx.root();
    let target = existing_library_directory(cx.vfs, directory)?;
    let mut imported = Vec::new();
    let mut skipped = Vec::new();
    for raw in paths {
        let source = Path::new(raw);
        let result = (|| {
            let bytes = read_source(source)?;
            let stem = source
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default();
            let extension = source
                .extension()
                .and_then(|extension| extension.to_str())
                .filter(|extension| shard_core::image::is_image_extension(extension))
                .map(str::to_string)
                .or_else(|| {
                    shard_core::image::sniff_image_mime_type(&bytes)
                        .and_then(shard_core::image::image_extension_for_mime_type)
                        .map(str::to_string)
                })
                .ok_or_else(|| "不支持的图片格式".to_string())?;
            let stem = if stem.trim().is_empty() { "图片" } else { stem };
            let destination =
                unique_titled_path(cx.vfs, &target, stem, &format!(".{extension}"));
            cx.vfs
                .write_atomic(&destination, &bytes)
                .map_err(|error| error.to_string())?;
            relative_path(vault, &destination)
        })();
        match result {
            Ok(rel_path) => imported.push(rel_path),
            Err(reason) => skipped.push(LibraryImportSkip {
                path: raw.clone(),
                reason,
            }),
        }
    }
    if !imported.is_empty() {
        cx.hooks
            .commit_paths_best_effort(&imported, "import library images");
    }
    Ok((imported, skipped))
}

/// 哪些公开文档、表格用到了这张图（不含回收站）；供图片查看器显示「引用处」与删除前提示。
pub fn image_references_in_vault(cx: &VaultCtx<'_>, target: &str) -> Result<Vec<String>, String> {
    let vault = cx.root();
    let target = shard_core::image_refs::normalize_reference(target);
    // 内容寻址附件也可能被写成 shard-attachment:<hash>。
    let attachment = Path::new(&target)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| target.starts_with("assets/") && stem.len() == 64)
        .map(|hash| format!("shard-attachment:{hash}"));
    let mut sources = Vec::new();
    collect_public_vault_markdown(cx.vfs, vault, &mut sources)?;
    collect_csv_files(cx.vfs, vault, &mut sources)?;
    let mut referencing = Vec::new();
    for source in sources {
        let Ok(relative) = relative_path(vault, &source) else {
            continue;
        };
        if relative.starts_with(".trash/") {
            continue;
        }
        let Ok(bytes) = cx.vfs.read(&source) else {
            continue;
        };
        let references =
            extract_library_image_references(Path::new(&relative), &String::from_utf8_lossy(&bytes));
        if references
            .iter()
            .any(|reference| *reference == target || Some(reference) == attachment.as_ref())
        {
            referencing.push(relative);
        }
    }
    referencing.sort();
    referencing.dedup();
    Ok(referencing)
}

/// 表格单元格里的图片引用哪些真的指向 vault 里的图片：只有存在的才画成缩略图，
/// 写错的路径照常显示文字。一次批量查，避免逐格 IPC。
pub fn existing_vault_images_in(vfs: &dyn Vfs, paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .take(20_000)
        .filter(|path| {
            shard_core::image_refs::is_local_image_reference(path)
                && resolve_vault_asset_path(vfs, path).is_ok()
        })
        .collect()
}

/// 资料库「图片」只收资料库内容用到的附件：`notes/` 下的文档、导图、画布与 CSV，
/// 以及 `datasets/` 下的数据集（由资料库「新建数据集」创建）。碎片、回收站、密匣不算。
pub fn is_library_reference_source(path: &Path) -> bool {
    let mut parts = path.components();
    let root = match parts.next() {
        Some(Component::Normal(root)) if root == "notes" => "notes",
        Some(Component::Normal(root)) if root == "datasets" => "datasets",
        _ => return false,
    };
    let mut has_child = false;
    for part in parts {
        let Component::Normal(name) = part else { return false };
        if name.to_string_lossy().starts_with('.') {
            return false;
        }
        has_child = true;
    }
    let is_csv = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("csv"));
    if root == "datasets" {
        return has_child && is_csv;
    }
    has_child && (is_csv
        || matches!(path.extension().and_then(|extension| extension.to_str()), Some("md"))
        || is_mind_map_file(path)
        || canvas::is_canvas(path)
        || canvas::is_flow(path))
}

/// 一份资料库来源里的图片引用：旧的 `assets/`、`shard-attachment:` 子串扫描兜底（导图、
/// 画布 JSON 也靠它），Markdown 再按链接目标解析（带空格、括号的命名图片），CSV 按单元格。
pub fn extract_library_image_references(relative: &Path, text: &str) -> Vec<String> {
    let mut references: Vec<String> = extract_asset_references(text);
    let extension = relative
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    let structured = match extension.as_deref() {
        Some("md") => shard_core::image_refs::markdown_image_references(text),
        Some("csv") => shard_core::image_refs::csv_image_references(text),
        _ => Vec::new(),
    };
    for reference in structured {
        if !references.contains(&reference) {
            references.push(reference);
        }
    }
    references
}

pub fn extract_asset_references(text: &str) -> Vec<String> {
    let mut references = HashSet::new();
    for line in text.lines() {
        let line = line.replace("\\/", "/");
        for marker in ["assets/", "shard-attachment:"] {
            let mut remaining = line.as_str();
            while let Some(start) = remaining.find(marker) {
                let is_local_reference = remaining[..start]
                    .chars()
                    .next_back()
                    .map(|character| {
                        character.is_whitespace()
                            || matches!(character, '(' | '[' | '<' | '"' | '\'' | '=')
                    })
                    .unwrap_or(true);
                let candidate = &remaining[start..];
                let end = candidate
                    .find(|character: char| {
                        character.is_whitespace()
                            || matches!(character, '"' | '\'' | ')' | ']' | '>' | '<' | '`' | '\\' | ',')
                    })
                    .unwrap_or(candidate.len());
                if is_local_reference && end > marker.len() {
                    references.insert(candidate[..end].to_string());
                }
                remaining = &candidate[marker.len()..];
            }
        }
    }
    references.into_iter().collect()
}

pub fn library_asset_references_full_scan(vfs: &dyn Vfs) -> HashSet<String> {
    // Shared attachments remain on disk. Public library references establish
    // visibility; fragments, trash, lockbox and unknown provenance never do.
    fn collect(vfs: &dyn Vfs, directory: &Path, references: &mut HashSet<String>) {
        let vault = vfs.root();
        let Ok(entries) = vfs.read_dir(directory) else {
            return;
        };
        for entry in entries {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() || entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                collect(vfs, &path, references);
            } else if file_type.is_file() {
                let Ok(relative) = path.strip_prefix(vault) else { continue };
                if !is_library_reference_source(relative) {
                    continue;
                }
                let Ok(bytes) = vfs.read(&path) else { continue };
                let text = String::from_utf8_lossy(&bytes);
                references.extend(extract_library_image_references(relative, &text));
            }
        }
    }
    let vault = vfs.root();
    let mut references = HashSet::new();
    collect(vfs, &vault.join("notes"), &mut references);
    collect(vfs, &vault.join("datasets"), &mut references);
    references
}

/// 资料库图片宫格：被公开资料库内容引用的附件（引用集合经 [`VaultHooks::library_asset_references`]），
/// 加上 `notes/` 里显式导入的命名图片。
pub fn collect_library_assets(cx: &VaultCtx<'_>) -> Vec<LibraryAssetEntry> {
    fn collect(
        vfs: &dyn Vfs,
        directory: &Path,
        references: &HashSet<String>,
        assets: &mut Vec<LibraryAssetEntry>,
    ) {
        let vault = vfs.root();
        let Ok(entries) = vfs.read_dir(directory) else {
            return;
        };

        for entry in entries {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }

            let path = entry.path();
            if file_type.is_dir() {
                if entry
                    .file_name()
                    .to_str()
                    .map(|name| name.starts_with('.'))
                    .unwrap_or(false)
                {
                    continue;
                }
                collect(vfs, &path, references, assets);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            let Ok(relative) = relative_path(vault, &path) else {
                continue;
            };
            let is_referenced = references.contains(&relative)
                || path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .map(|hash| references.contains(&format!("shard-attachment:{hash}")))
                    .unwrap_or(false);
            if !is_referenced {
                continue;
            }
            let Some(asset) = (|| {
                let mime_type = sniff_library_asset_mime_type(vfs, &path)?;
                let metadata = entry.metadata().ok()?;
                let modified_at = metadata.modified().ok()?;
                Some(LibraryAssetEntry {
                    path: relative_path(vault, &path).ok()?,
                    size: metadata.len(),
                    modified_at: system_time_to_rfc3339(modified_at),
                    mime_type: mime_type.to_string(),
                })
            })() else {
                continue;
            };
            assets.push(asset);
        }
    }

    let vfs = cx.vfs;
    let vault = vfs.root();
    let mut assets = Vec::new();
    let references = cx.hooks.library_asset_references(vfs);
    if !references.is_empty() {
        collect(vfs, &vault.join("assets"), &references, &mut assets);
    }
    collect_named_library_images(vfs, &vault.join("notes"), &mut assets);
    assets.sort_by(|left, right| {
        right
            .modified_at
            .cmp(&left.modified_at)
            .then_with(|| left.path.cmp(&right.path))
    });
    assets
}

/// 资料库目录里显式导入的命名图片：位置本身就说明它属于资料库，不需要被引用。
/// 类型按扩展名定，建宫格时不逐个打开文件。
pub fn collect_named_library_images(
    vfs: &dyn Vfs,
    directory: &Path,
    assets: &mut Vec<LibraryAssetEntry>,
) {
    let vault = vfs.root();
    let Ok(entries) = vfs.read_dir(directory) else {
        return;
    };
    for entry in entries {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_named_library_images(vfs, &path, assets);
            continue;
        }
        let Some(mime_type) = path
            .extension()
            .and_then(|extension| extension.to_str())
            .and_then(shard_core::image::image_mime_type_from_extension)
        else {
            continue;
        };
        let Some(asset) = (|| {
            let metadata = entry.metadata().ok()?;
            Some(LibraryAssetEntry {
                path: relative_path(vault, &path).ok()?,
                size: metadata.len(),
                modified_at: system_time_to_rfc3339(metadata.modified().ok()?),
                mime_type: mime_type.to_string(),
            })
        })() else {
            continue;
        };
        assets.push(asset);
    }
}

pub fn sniff_library_asset_mime_type(vfs: &dyn Vfs, path: &Path) -> Option<&'static str> {
    // 先看前 4 KiB 的魔数；只有扩展名是 svg 时才在前 64 KiB 里找 `<svg`，不整张读图片。
    let header = vfs.read_head(path, 4 * 1024).ok()?;
    if let Ok(mime_type) = sniff_image_mime_type(&header) {
        return Some(mime_type);
    }
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("svg"))
    {
        return None;
    }
    if header.windows(4).any(|window| window == b"<svg") {
        return Some("image/svg+xml");
    }
    if header.len() < 4 * 1024 {
        return None;
    }
    let header = vfs.read_head(path, 64 * 1024).ok()?;
    if header.windows(4).any(|window| window == b"<svg") {
        return Some("image/svg+xml");
    }
    None
}

/// 正文/表格里的图片引用 → vault 内的规范路径。
///
/// 引用是 vault 相对路径（`assets/…`、`notes/证件/营业执照.jpg`）或旧格式
/// `shard-attachment:<sha256>`；旧调用方传的绝对路径只要落在 vault 内也折算回来。
/// 能读到哪里由 `ensure_public_vault_file_path` 一处决定：密匣与内部目录一律拒绝。
pub fn resolve_vault_asset_path(vfs: &dyn Vfs, raw_path: &str) -> Result<PathBuf, String> {
    let vault = vfs.root();
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("图片路径为空".to_string());
    }
    if trimmed.contains("://") || trimmed.starts_with("//") {
        return Err("不支持读取外部图片地址".to_string());
    }

    let relative = if let Some(hash) = trimmed.strip_prefix("shard-attachment:") {
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("附件引用无效".to_string());
        }
        shard_core::image::IMAGE_EXTENSIONS
            .iter()
            .map(|extension| format!("assets/{}/{hash}.{extension}", &hash[..2]))
            .find(|candidate| vfs.is_file(&vault.join(candidate)))
            .ok_or_else(|| "图片文件不存在".to_string())?
    } else if Path::new(trimmed).is_absolute() {
        let canonical_vault = vfs.canonicalize(vault).map_err(|error| error.to_string())?;
        let canonical = vfs
            .canonicalize(Path::new(trimmed))
            .map_err(|_| "图片文件不存在".to_string())?;
        canonical
            .strip_prefix(&canonical_vault)
            .map_err(|_| "只能读取 vault 内的图片".to_string())?
            .to_string_lossy()
            .replace('\\', "/")
    } else {
        // `./notes/a.png` 与 `notes/a.png` 是同一个引用。
        trimmed.strip_prefix("./").unwrap_or(trimmed).to_string()
    };

    shard_core::ensure_public_vault_file_path(vfs, &relative)
}

pub fn image_mime_type(path: &Path, bytes: &[u8]) -> Result<&'static str, String> {
    shard_core::image::image_mime_type(path, bytes).ok_or_else(|| "不支持的图片格式".to_string())
}

pub fn sniff_image_mime_type(bytes: &[u8]) -> Result<&'static str, String> {
    shard_core::image::sniff_image_mime_type(bytes).ok_or_else(|| "不支持的图片格式".to_string())
}
