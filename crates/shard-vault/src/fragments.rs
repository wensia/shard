//! 公开碎片：读取、更新、属性、关系、碎片⇄笔记转换。
//!
//! 密匣碎片不在这里：桌面命令层先用 [`find_lockbox_fragment_path`] 分流，公开目标才调这里。

use crate::prelude::*;

pub fn fragment_properties(raw: &str) -> Vec<FragmentProperty> {
    custom_property_entries(raw)
        .into_iter()
        .map(|entry| {
            let (value, value_editable) = match entry.value {
                Some(serde_yaml::Value::String(text)) => (PropertyValue::Text { text }, true),
                Some(serde_yaml::Value::Number(number)) => (
                    PropertyValue::Number {
                        text: number.to_string(),
                    },
                    true,
                ),
                Some(serde_yaml::Value::Bool(value)) => (PropertyValue::Bool { value }, true),
                Some(serde_yaml::Value::Null) => (PropertyValue::Null, true),
                Some(serde_yaml::Value::Sequence(values)) => {
                    let items = values
                        .iter()
                        .map(|value| match value {
                            serde_yaml::Value::String(value) => Some(value.clone()),
                            serde_yaml::Value::Number(value) => Some(value.to_string()),
                            serde_yaml::Value::Bool(value) => Some(value.to_string()),
                            _ => None,
                        })
                        .collect::<Option<Vec<_>>>();
                    match items {
                        Some(items) => (PropertyValue::List { items }, true),
                        None => (PropertyValue::Other { raw: entry.raw.clone() }, false),
                    }
                }
                _ => (PropertyValue::Other { raw: entry.raw.clone() }, false),
            };
            FragmentProperty {
                key: entry.key,
                value,
                editable: entry.editable && value_editable,
            }
        })
        .collect()
}

pub fn property_input_to_yaml(value: PropertyInputValue) -> Result<serde_yaml::Value, String> {
    use serde_yaml::Value;
    match value {
        PropertyInputValue::Text(None)
        | PropertyInputValue::Number(None)
        | PropertyInputValue::Date(None)
        | PropertyInputValue::Datetime(None)
        | PropertyInputValue::Checkbox(None)
        | PropertyInputValue::List(None)
        | PropertyInputValue::Link(None) => Ok(Value::Null),
        PropertyInputValue::Text(Some(value)) if value.is_empty() => Ok(Value::Null),
        PropertyInputValue::Text(Some(value)) => Ok(Value::String(value)),
        PropertyInputValue::Number(Some(value)) => parse_property_number(&value),
        PropertyInputValue::Date(Some(value)) => {
            if value.is_empty() {
                return Ok(Value::Null);
            }
            NaiveDate::parse_from_str(&value, "%Y-%m-%d")
                .map_err(|_| "日期格式无效，应为 YYYY-MM-DD。".to_string())?;
            Ok(Value::String(value))
        }
        PropertyInputValue::Datetime(Some(value)) => {
            if value.is_empty() {
                return Ok(Value::Null);
            }
            NaiveDateTime::parse_from_str(&value, "%Y-%m-%dT%H:%M")
                .map_err(|_| "日期时间格式无效，应为 YYYY-MM-DDTHH:mm。".to_string())?;
            Ok(Value::String(value))
        }
        PropertyInputValue::Checkbox(Some(value)) => Ok(Value::Bool(value)),
        PropertyInputValue::List(Some(items)) if items.is_empty() => Ok(Value::Null),
        PropertyInputValue::List(Some(items)) => {
            Ok(Value::Sequence(items.into_iter().map(Value::String).collect()))
        }
        PropertyInputValue::Link(Some(value)) => {
            let value = value.trim();
            if value.is_empty() {
                return Ok(Value::Null);
            }
            Ok(Value::String(if value.starts_with("[[") && value.ends_with("]]") {
                value.to_string()
            } else {
                format!("[[{value}]]")
            }))
        }
    }
}

pub fn parse_property_number(raw: &str) -> Result<serde_yaml::Value, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Ok(serde_yaml::Value::Null);
    }
    if let Ok(integer) = value.parse::<i64>() {
        return Ok(serde_yaml::Value::Number(integer.into()));
    }
    let unsigned = value.strip_prefix(['-', '+']).unwrap_or(value);
    let Some((integer, fraction)) = unsigned.split_once('.') else {
        return Err("数字格式无效，可改用文本类型。".to_string());
    };
    if fraction.is_empty()
        || !integer.chars().all(|character| character.is_ascii_digit())
        || !fraction.chars().all(|character| character.is_ascii_digit())
    {
        return Err("数字格式无效，可改用文本类型。".to_string());
    }
    let number = value.parse::<f64>()
        .map_err(|_| "数字格式无效，可改用文本类型。".to_string())?;
    if !number.is_finite() {
        return Err("数字格式无效，可改用文本类型。".to_string());
    }
    serde_yaml::to_value(number).map_err(|_| "数字格式无效，可改用文本类型。".to_string())
}

pub fn property_registry_path(vault: &Path) -> PathBuf {
    vault.join(".shard").join("properties.json")
}

pub fn read_property_registry_in_vault(
    cx: &VaultCtx<'_>,
) -> Result<PropertyRegistryReadResult, String> {
    let path = property_registry_path(cx.root());
    let text = match cx.vfs.read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PropertyRegistryReadResult {
                registry: PropertyRegistry::default(),
                sha: content_sha256_hex(""),
            });
        }
        Err(error) => return Err(error.to_string()),
    };
    let registry = serde_json::from_str::<PropertyRegistry>(&text)
        .map_err(|error| format!("属性类型登记表损坏：{error}"))?;
    if registry.version != 1 {
        return Err(format!("不支持的属性类型登记表版本：{}", registry.version));
    }
    Ok(PropertyRegistryReadResult { registry, sha: content_sha256_hex(&text) })
}

pub fn register_property_type_in_vault(
    cx: &VaultCtx<'_>,
    key: &str,
    property_type: PropertyType,
    expected_sha: &str,
) -> Result<PropertyRegistryReadResult, String> {
    validate_property_key(key)?;
    let current = read_property_registry_in_vault(cx)?;
    if current.sha != expected_sha {
        return Err("属性类型登记表已被外部修改，请刷新后重试。".to_string());
    }
    let mut registry = current.registry;
    registry.properties.insert(key.to_string(), PropertyRegistryEntry { property_type });
    let mut text = serde_json::to_string_pretty(&registry).map_err(|error| error.to_string())?;
    text.push('\n');
    cx.vfs
        .write_atomic(&property_registry_path(cx.root()), text.as_bytes())
        .map_err(|error| error.to_string())?;
    Ok(PropertyRegistryReadResult { registry, sha: content_sha256_hex(&text) })
}

pub fn collect_markdown_files(
    vfs: &dyn Vfs,
    dir: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if !vfs.exists(dir) {
        return Ok(());
    }

    for entry in vfs.read_dir(dir).map_err(|error| error.to_string())? {
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_markdown_files(vfs, &path, files)?;
        } else if file_type.is_file()
            && path.extension().and_then(|ext| ext.to_str()) == Some("md")
        {
            files.push(path);
        }
    }

    Ok(())
}

pub fn convert_fragment_to_note_in_vault(
    cx: &VaultCtx<'_>,
    id: &str,
    directory: Option<&str>,
    title: Option<&str>,
) -> Result<(Fragment, usize), String> {
    let source = find_fragment_path(cx.vfs, id)?.ok_or_else(|| format!("找不到碎片 {id}"))?;
    let source_rel = relative_path(cx.root(), &source)?;
    if source_rel.starts_with("notes/") {
        return Err("该内容已经是文档。".to_string());
    }
    if !source_rel.starts_with("fragments/") {
        return Err("只有碎片流中的公开碎片可以转为文档。".to_string());
    }
    let text = cx.vfs.read_to_string(&source).map_err(|error| error.to_string())?;
    let (mut frontmatter, body) = parse_fragment_text(&text)?;
    if !frontmatter.tags.iter().any(|tag| tag == "note") {
        frontmatter.tags.push("note".to_string());
        frontmatter.tags.sort();
        frontmatter.tags.dedup();
    }
    frontmatter.updated_at = cx.now().to_rfc3339();
    let directory = existing_library_directory(cx.vfs, directory)?;
    let inferred_title = note_title(body);
    let title = title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or(&inferred_title);
    let destination = unique_note_path(cx.vfs, &directory, title);
    let old_target = source
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let new_target = destination
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    convert_public_fragment_file(
        cx,
        &source,
        &destination,
        &frontmatter,
        body,
        &[(old_target, new_target)],
        &format!("convert fragment to note {id}"),
    )
}

pub fn convert_note_to_fragment_in_vault(
    cx: &VaultCtx<'_>,
    id: &str,
) -> Result<(Fragment, usize), String> {
    let source = find_fragment_path(cx.vfs, id)?.ok_or_else(|| format!("找不到文档 {id}"))?;
    let source_rel = relative_path(cx.root(), &source)?;
    if !source_rel.starts_with("notes/") {
        return Err("只有资料库中的文档可以转回碎片。".to_string());
    }
    let text = cx.vfs.read_to_string(&source).map_err(|error| error.to_string())?;
    let (mut frontmatter, body) = parse_fragment_text(&text)?;
    let old_stem = source
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let old_title = note_title(body);
    frontmatter.tags.retain(|tag| tag != "note");
    if frontmatter.tags.is_empty() {
        frontmatter.tags.push("inbox".to_string());
    }
    frontmatter.updated_at = cx.now().to_rfc3339();
    // Restoring the original date also keeps the physical fragment stream and
    // its month summaries aligned with the content's record date.
    let recorded_at = DateTime::parse_from_rfc3339(&frontmatter.created_at)
        .map_err(|error| format!("文档的原记录时间无效，已保留文档：{error}"))?;
    let directory = cx
        .root()
        .join("fragments")
        .join(recorded_at.format("%Y").to_string())
        .join(recorded_at.format("%m").to_string());
    cx.vfs.create_dir_all(&directory).map_err(|error| error.to_string())?;
    let destination = directory.join(format!("{}.md", frontmatter.id));
    if cx.vfs.exists(&destination) {
        return Err("原记录月份中已存在同 ID 碎片。".to_string());
    }
    let mut replacements = vec![(old_stem, frontmatter.id.as_str())];
    if old_title != old_stem {
        replacements.push((old_title.as_str(), frontmatter.id.as_str()));
    }
    convert_public_fragment_file(
        cx,
        &source,
        &destination,
        &frontmatter,
        body,
        &replacements,
        &format!("convert note to fragment {id}"),
    )
}

pub fn convert_public_fragment_file(
    cx: &VaultCtx<'_>,
    source: &Path,
    destination: &Path,
    frontmatter: &FragmentFrontmatter,
    body: &str,
    replacements: &[(&str, &str)],
    commit_message: &str,
) -> Result<(Fragment, usize), String> {
    convert_public_fragment_file_with_writer(
        cx,
        source,
        destination,
        frontmatter,
        body,
        replacements,
        commit_message,
        &|path: &Path, text: &str| {
            cx.vfs
                .write_atomic(path, text.as_bytes())
                .map_err(|error| error.to_string())
        },
    )
}

pub fn convert_public_fragment_file_with_writer<F>(
    cx: &VaultCtx<'_>,
    source: &Path,
    destination: &Path,
    frontmatter: &FragmentFrontmatter,
    body: &str,
    replacements: &[(&str, &str)],
    commit_message: &str,
    write: &F,
) -> Result<(Fragment, usize), String>
where
    F: Fn(&Path, &str) -> Result<(), String>,
{
    let vault = cx.root();
    let source_rel = relative_path(vault, source)?;
    let destination_rel = relative_path(vault, destination)?;
    let source_text = cx.vfs.read_to_string(source).map_err(|error| error.to_string())?;
    let source_fragment = parse_fragment(&source_text)?;
    let rewrite = |text: &str| {
        let mut next = text.to_string();
        let mut count = 0;
        for (old, new) in replacements {
            if old == new {
                continue;
            }
            let (replaced, updated) = replace_wikilink_targets(&next, old, new);
            next = replaced;
            count += updated;
        }
        (next, count)
    };
    // Plan every read before changing the object. A damaged reference file must
    // not report conversion failure after the source has already disappeared.
    let mut files = Vec::new();
    collect_public_vault_markdown(cx.vfs, vault, &mut files)?;
    let mut updates = Vec::new();
    let mut changed_paths = vec![source_rel, destination_rel];
    for path in files {
        if path == source {
            continue;
        }
        let original = cx.vfs.read_to_string(&path).map_err(|error| error.to_string())?;
        let (next, count) = rewrite(&original);
        if count > 0 {
            append_unique_paths(&mut changed_paths, vec![relative_path(vault, &path)?]);
            updates.push((path, original, next, count));
        }
    }
    // Keep the exact body boundary, whitespace and content. The chosen document
    // title names its file and never inserts or replaces a Markdown heading.
    let raw = apply_frontmatter(&source_fragment.raw, frontmatter)?;
    let (destination_text, self_link_count) = rewrite(&format!("---\n{raw}\n---{body}"));
    let mut written = Vec::new();
    let mut destination_written = false;
    let result: Result<(Fragment, usize), String> = (|| {
        write(destination, &destination_text)?;
        destination_written = true;
        let mut updated_links = self_link_count;
        for (path, original, next, count) in &updates {
            write(path, next)?;
            written.push((path, original));
            updated_links += count;
        }
        let fragment = read_fragment(cx, destination, &cx.hooks.dirty_paths(), None)?;
        // The source is the last fallible mutation. Until now rollback only
        // restores references and removes the new destination.
        cx.vfs.remove_file(source).map_err(|error| error.to_string())?;
        Ok((fragment, updated_links))
    })();
    match result {
        Ok((mut fragment, updated_links)) => {
            cx.hooks.commit_paths_best_effort(&changed_paths, commit_message);
            fragment.git_status = if !cx.hooks.has_vcs() {
                "saved"
            } else if cx.hooks.dirty_paths().contains(&fragment.path) {
                "sync_pending"
            } else {
                "committed"
            }
            .to_string();
            Ok((fragment, updated_links))
        }
        Err(error) => {
            let mut rollback_errors = Vec::new();
            for (path, original) in written.into_iter().rev() {
                if let Err(rollback_error) = cx.vfs.write_atomic(path, original.as_bytes()) {
                    rollback_errors.push(rollback_error.to_string());
                }
            }
            if destination_written {
                if let Err(rollback_error) = cx.vfs.remove_file(destination) {
                    rollback_errors.push(rollback_error.to_string());
                }
            }
            if rollback_errors.is_empty() {
                Err(format!("转换失败，原内容已保留：{error}"))
            } else {
                Err(format!(
                    "转换失败：{error}；部分恢复失败，请核对内容后重试：{}",
                    rollback_errors.join("；")
                ))
            }
        }
    }
}

pub fn collect_lockbox_files(
    vfs: &dyn Vfs,
    dir: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if !vfs.exists(dir) {
        return Ok(());
    }

    for entry in vfs.read_dir(dir).map_err(|error| error.to_string())? {
        let path = entry.path();
        if vfs.is_dir(&path) {
            collect_lockbox_files(vfs, &path, files)?;
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("shard") {
            files.push(path);
        }
    }

    Ok(())
}

pub fn ensure_public_fragment_id(vfs: &dyn Vfs, fragment_id: &str) -> Result<(), String> {
    if fragment_id.trim().is_empty() {
        return Err("片段链接目标不能为空。".to_string());
    }
    if is_lockbox_fragment_id(vfs, fragment_id)? {
        return Err("当前版本不允许明文导图链接密匣片段。".to_string());
    }
    if find_fragment_path(vfs, fragment_id)?.is_none() {
        return Err(format!("找不到公开片段 {}", fragment_id));
    }
    Ok(())
}

pub fn ensure_public_markdown_path(vfs: &dyn Vfs, rel_path: &str) -> Result<PathBuf, String> {
    let trimmed = rel_path.trim();
    if trimmed.is_empty() {
        return Err("Markdown 路径不能为空。".to_string());
    }
    if trimmed.contains('\\') {
        return Err("Markdown 路径必须使用 / 分隔。".to_string());
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err("Markdown 路径必须是 vault 内相对路径。".to_string());
    }

    for component in path.components() {
        match component {
            Component::Normal(value) => {
                if value.to_str() == Some("lockbox") {
                    return Err("当前版本不允许导图链接密匣路径。".to_string());
                }
            }
            _ => {
                return Err("Markdown 路径不能包含 . 或 ..。".to_string());
            }
        }
    }

    if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
        return Err("导图只能链接 Markdown 文件。".to_string());
    }

    let full_path = vfs.root().join(path);
    if !vfs.is_file(&full_path) {
        return Err(format!("找不到 Markdown 文件 {}", trimmed));
    }
    Ok(full_path)
}

pub fn read_fragment(
    cx: &VaultCtx<'_>,
    path: &Path,
    dirty_paths: &HashSet<String>,
    override_status: Option<(String, Option<String>)>,
) -> Result<Fragment, String> {
    let text = cx.vfs.read_to_string(path).map_err(|error| error.to_string())?;
    let file_sha = content_sha256_hex(&text);
    let parsed = parse_fragment(&text)?;
    let properties = fragment_properties(&parsed.raw);
    let frontmatter = parsed.frontmatter;
    let body = parsed.body;
    let rel_path = relative_path(cx.root(), path)?;
    let (git_status, error) = override_status.unwrap_or_else(|| {
        if !cx.hooks.has_vcs() {
            ("saved".to_string(), None)
        } else if dirty_paths.contains(&rel_path) {
            ("sync_pending".to_string(), None)
        } else {
            ("committed".to_string(), None)
        }
    });
    let archived = rel_path.starts_with(".trash/fragments/");

    Ok(Fragment {
        id: frontmatter.id,
        content: body.trim_start_matches('\n').to_string(),
        file_sha,
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
        lockbox: false,
        pinned: frontmatter.pinned,
        related: frontmatter.related,
        properties,
        conflict_of: frontmatter.conflict_of,
    })
}

pub fn parse_fragment_text(text: &str) -> Result<(FragmentFrontmatter, &str), String> {
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

pub fn mutate_public_fragment_property_in_vault(
    cx: &VaultCtx<'_>,
    path: &Path,
    key: &str,
    value: Option<&serde_yaml::Value>,
) -> Result<Fragment, String> {
    if relative_path(cx.root(), path)?.starts_with(".trash/") {
        return Err("回收站中的片段不能修改属性。".to_string());
    }
    let text = cx.vfs.read_to_string(path).map_err(|error| error.to_string())?;
    let parsed = parse_fragment(&text)?;
    let raw = match value {
        Some(value) => set_custom_property(&parsed.raw, key, value)?,
        None => remove_custom_property(&parsed.raw, key)?,
    };
    let mut frontmatter = parsed.frontmatter;
    frontmatter.updated_at = cx.now().to_rfc3339();
    let raw = apply_frontmatter(&raw, &frontmatter)?;
    cx.vfs
        .write_atomic(path, format!("---\n{raw}\n---{}", parsed.body).as_bytes())
        .map_err(|error| error.to_string())?;
    read_fragment(cx, path, &cx.hooks.dirty_paths(), None)
}

pub fn update_public_fragment_tags_in_vault(
    cx: &VaultCtx<'_>,
    path: &Path,
    tags: Vec<String>,
) -> Result<Fragment, String> {
    let text = cx.vfs.read_to_string(path).map_err(|error| error.to_string())?;
    let parsed = parse_fragment(&text)?;
    let mut frontmatter = parsed.frontmatter;
    let tags = normalize_updated_type_tags(&frontmatter.tags, tags);
    frontmatter.tags = if tags.is_empty() {
        vec!["inbox".to_string()]
    } else {
        tags
    };
    frontmatter.updated_at = cx.now().to_rfc3339();
    write_fragment_update(
        cx.vfs,
        path,
        &parsed.raw,
        &frontmatter,
        parsed.body.trim_start_matches('\n'),
    )?;
    read_fragment(cx, path, &cx.hooks.dirty_paths(), None)
}

pub fn update_public_fragment_in_vault(
    cx: &VaultCtx<'_>,
    path: &Path,
    content: &str,
    tags: Vec<String>,
    expected_file_sha: Option<&str>,
) -> Result<Fragment, String> {
    let text = cx.vfs.read_to_string(path).map_err(|error| error.to_string())?;
    let parsed = parse_fragment(&text)?;
    if let Some(kind) = match derive_type(&parsed.frontmatter.tags) {
        Some("outline") => Some(GraphRegionKind::Outline),
        Some("flowchart") => Some(GraphRegionKind::Flowchart),
        _ => None,
    } {
        match find_region(&parsed.body, kind) {
            Ok(_) => {
                return Err("大纲与流程图请在专用编辑器中保存。".to_string());
            }
            Err(error) if error == MISSING_REGION_ERROR => {}
            Err(_) => {
                return Err("大纲与流程图请在专用编辑器中保存。".to_string());
            }
        }
    }
    ensure_expected_file_sha(&text, expected_file_sha)?;
    let mut frontmatter = parsed.frontmatter;
    let tags = normalize_updated_type_tags(&frontmatter.tags, tags);
    frontmatter.tags = if tags.is_empty() {
        vec!["inbox".to_string()]
    } else {
        tags
    };
    frontmatter.updated_at = cx.now().to_rfc3339();
    write_fragment_update(cx.vfs, path, &parsed.raw, &frontmatter, content)?;
    read_fragment(cx, path, &cx.hooks.dirty_paths(), None)
}

pub fn link_fragments_in_vault(
    cx: &VaultCtx<'_>,
    source_id: &str,
    target_id: &str,
    origin: &str,
    note: Option<String>,
) -> Result<Fragment, String> {
    ensure_public_fragment_id(cx.vfs, source_id)?;
    ensure_public_fragment_id(cx.vfs, target_id)?;
    if source_id == target_id {
        return Err("片段不能关联自身。".to_string());
    }
    if !matches!(origin, "manual" | "walk" | "insight" | "tag" | "wikilink") {
        return Err(format!("不支持的片段关系来源：{origin}"));
    }

    let path = find_fragment_path(cx.vfs, source_id)?
        .ok_or_else(|| format!("找不到公开片段 {source_id}"))?;
    let text = cx.vfs.read_to_string(&path).map_err(|error| error.to_string())?;
    let parsed = parse_fragment(&text)?;
    let mut frontmatter = parsed.frontmatter;
    if frontmatter
        .related
        .iter()
        .any(|relation| relation.target_id == target_id)
    {
        let dirty = cx.hooks.dirty_paths();
        return read_fragment(cx, &path, &dirty, None);
    }

    let now = cx.now().to_rfc3339();
    frontmatter.related.push(FragmentRelation {
        target_id: target_id.to_string(),
        origin: origin.to_string(),
        created_at: now.clone(),
        note,
    });
    frontmatter.updated_at = now;
    write_fragment_update(
        cx.vfs,
        &path,
        &parsed.raw,
        &frontmatter,
        parsed.body.trim_start_matches('\n'),
    )?;

    let dirty = cx.hooks.dirty_paths();

    read_fragment(cx, &path, &dirty, None)
}

pub fn unlink_fragments_in_vault(
    cx: &VaultCtx<'_>,
    source_id: &str,
    target_id: &str,
) -> Result<Fragment, String> {
    ensure_public_fragment_id(cx.vfs, source_id)?;
    ensure_public_fragment_id(cx.vfs, target_id)?;
    if source_id == target_id {
        return Err("片段不能取消关联自身。".to_string());
    }

    let path = find_fragment_path(cx.vfs, source_id)?
        .ok_or_else(|| format!("找不到公开片段 {source_id}"))?;
    let text = cx.vfs.read_to_string(&path).map_err(|error| error.to_string())?;
    let parsed = parse_fragment(&text)?;
    let mut frontmatter = parsed.frontmatter;
    let previous_len = frontmatter.related.len();
    frontmatter
        .related
        .retain(|relation| relation.target_id != target_id);
    if frontmatter.related.len() == previous_len {
        let dirty = cx.hooks.dirty_paths();
        return read_fragment(cx, &path, &dirty, None);
    }

    frontmatter.updated_at = cx.now().to_rfc3339();
    write_fragment_update(
        cx.vfs,
        &path,
        &parsed.raw,
        &frontmatter,
        parsed.body.trim_start_matches('\n'),
    )?;

    let dirty = cx.hooks.dirty_paths();

    read_fragment(cx, &path, &dirty, None)
}

pub fn set_public_fragment_pinned_in_vault(
    cx: &VaultCtx<'_>,
    path: &Path,
    pinned: bool,
) -> Result<Fragment, String> {
    let rel_path = relative_path(cx.root(), path)?;
    if rel_path.starts_with(".trash/fragments/") && pinned {
        return Err("回收站中的片段不能置顶。".to_string());
    }

    let text = cx.vfs.read_to_string(path).map_err(|error| error.to_string())?;
    let parsed = parse_fragment(&text)?;
    let mut frontmatter = parsed.frontmatter;
    frontmatter.pinned = pinned;
    frontmatter.updated_at = cx.now().to_rfc3339();
    write_fragment_update(
        cx.vfs,
        path,
        &parsed.raw,
        &frontmatter,
        parsed.body.trim_start_matches('\n'),
    )?;

    let dirty = cx.hooks.dirty_paths();
    // 内容保存只落盘，提交由聚合检查点接管（docs/design/commit-coalescing-plan.md §7 A2）
    let override_status = None;

    read_fragment(cx, path, &dirty, override_status)
}

/// 密匣信封里认 id 要的字段：与桌面 `LockboxEncryptedFragment` 的必填字段与类型逐一相同，
/// 两者接受同一批信封；这里只读 id，不碰密文。
#[derive(Deserialize)]
#[allow(dead_code)] // 其余字段只为与桌面信封结构的解析规则保持一致。
struct LockboxEnvelopeIdentity {
    version: u32,
    id: String,
    nonce: String,
    ciphertext: String,
    #[serde(default)]
    key_algorithm: Option<String>,
    #[serde(default)]
    key_ciphertext: Option<String>,
}

/// 按 id 找本地资料库 `lockbox/` 下的密匣信封（只解析信封头，不解密）。
/// 桌面命令层用它判断目标是不是密匣；SqliteVfs 拒绝 `lockbox/` 路径，这里总是 `Ok(None)`。
pub fn find_lockbox_fragment_path(vfs: &dyn Vfs, id: &str) -> Result<Option<PathBuf>, String> {
    let vault = vfs.root();
    let mut files = Vec::new();
    collect_lockbox_files(vfs, &vault.join("lockbox").join("fragments"), &mut files)?;
    collect_lockbox_files(vfs, &vault.join("lockbox").join("archive"), &mut files)?;
    collect_lockbox_files(vfs, &vault.join("lockbox").join("notes"), &mut files)?;

    for path in files {
        let text = vfs.read_to_string(&path).map_err(|error| error.to_string())?;
        if let Ok(encrypted) = serde_json::from_str::<LockboxEnvelopeIdentity>(&text) {
            if encrypted.id == id {
                return Ok(Some(path));
            }
        }
    }

    Ok(None)
}

/// 这个 id 是不是密匣条目。先问存储有没有单独登记密匣（服务端内容库的 `lockbox_items`），
/// 没有（本地目录）就按旧办法扫描 `lockbox/` 信封，与迁移前的 `find_lockbox_fragment_path(..).is_some()` 一致。
pub fn is_lockbox_fragment_id(vfs: &dyn Vfs, id: &str) -> Result<bool, String> {
    if let Some(ids) = vfs.lockbox_item_ids().map_err(|error| error.to_string())? {
        return Ok(ids.iter().any(|candidate| candidate == id));
    }
    Ok(find_lockbox_fragment_path(vfs, id)?.is_some())
}

pub fn find_fragment_path(vfs: &dyn Vfs, id: &str) -> Result<Option<PathBuf>, String> {
    shard_core::graph_model::find_fragment_path(vfs, id)
}

// ---- 公开碎片的命令级入口 ----
//
// 桌面命令层先按 id 分流密匣（`find_lockbox_fragment_path`），不是密匣才调这些函数；服务端直接调用。
// 每个函数对应原来某个 Tauri 命令里的公开分支，顺序与报错原样保留。调用方持写门。

/// 公开碎片与笔记（`fragments/`、`.trash/fragments/`、`notes/`），读不出来的跳过，未排序。
/// `dirty_paths` 由调用方取一次，桌面与密匣部分共用。
pub fn list_public_fragments(
    cx: &VaultCtx<'_>,
    dirty_paths: &HashSet<String>,
) -> Result<Vec<Fragment>, String> {
    let vault = cx.root();
    let mut files = Vec::new();
    collect_markdown_files(cx.vfs, &vault.join("fragments"), &mut files)?;
    collect_markdown_files(cx.vfs, &vault.join(".trash").join("fragments"), &mut files)?;
    collect_markdown_files(cx.vfs, &vault.join("notes"), &mut files)?;
    Ok(files
        .iter()
        .filter_map(|path| read_fragment(cx, path, dirty_paths, None).ok())
        .collect())
}

/// 碎片列表的显示顺序：置顶在前，再按创建时间从新到旧（稳定排序）。
pub fn sort_fragment_list(fragments: &mut [Fragment]) {
    fragments.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.created_at.cmp(&a.created_at))
    });
}

/// 新建碎片的输入规范化：正文去首尾空白、不能为空；标签补 `inbox` 并规范类型标签。
/// 结果里带密匣标签（[`contains_lockbox_tag`]）时由调用方走密匣，否则交给 [`create_public_fragment`]。
pub fn normalize_new_fragment(
    content: &str,
    tags: Option<Vec<String>>,
) -> Result<(String, Vec<String>), String> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("片段内容不能为空".to_string());
    }
    Ok((content, normalize_type_tags(normalize_tags(tags.unwrap_or_default(), true))))
}

/// 新建一条公开碎片并读回（`create_fragment` 命令的公开分支）。
pub fn create_public_fragment(
    cx: &VaultCtx<'_>,
    content: &str,
    tags: Vec<String>,
) -> Result<Fragment, String> {
    let path = create_public_fragment_at(cx.vfs, content, tags, cx.source, &cx.now())?;

    let dirty = cx.hooks.dirty_paths();
    // 内容保存只落盘，提交由聚合检查点接管（docs/design/commit-coalescing-plan.md §7 A2）
    let override_status = None;

    read_fragment(cx, &path, &dirty, override_status)
}

/// 按客户端给的 id 与创建时间新建公开碎片（离线新建补交、冲突副本）。id 已存在（公开或密匣）时报错，
/// 不覆盖任何东西。
pub fn create_public_fragment_as(
    cx: &VaultCtx<'_>,
    content: &str,
    tags: Vec<String>,
    id: &str,
    created_at: &chrono::DateTime<chrono::FixedOffset>,
    conflict_of: Option<&str>,
) -> Result<Fragment, String> {
    if !shard_core::is_valid_fragment_id(id) {
        return Err(format!("片段 id 无效：{id}"));
    }
    if find_fragment_path(cx.vfs, id)?.is_some() || is_lockbox_fragment_id(cx.vfs, id)? {
        return Err(format!("片段 {id} 已存在。"));
    }
    let path = shard_core::create_public_fragment_full(cx.vfs, content, tags, cx.source, created_at, id, conflict_of)?;
    read_fragment(cx, &path, &cx.hooks.dirty_paths(), None)
}

/// 公开碎片保存的结果。新标签里带密匣标签时，公开文件要整体移进密匣：那由桌面的密匣实现完成，
/// 这里做完前置校验（类型保护、保存基线）后把要移动的内容交回调用方，不改任何文件。
#[derive(Debug)]
pub enum PublicFragmentUpdate {
    Saved(Box<Fragment>),
    MoveToLockbox {
        path: PathBuf,
        content: String,
        tags: Vec<String>,
    },
}

/// 按 id 保存公开碎片的正文与标签（`update_fragment` 命令的公开分支）。
pub fn update_public_fragment_by_id(
    cx: &VaultCtx<'_>,
    id: &str,
    content: &str,
    tags: Vec<String>,
    expected_file_sha: Option<&str>,
) -> Result<PublicFragmentUpdate, String> {
    if content.trim().is_empty() {
        return Err("片段内容不能为空".to_string());
    }
    let path = find_fragment_path(cx.vfs, id)?.ok_or_else(|| format!("找不到片段 {}", id))?;
    let text = cx.vfs.read_to_string(&path).map_err(|error| error.to_string())?;
    let parsed = parse_fragment(&text)?;
    let normalized_tags = normalize_updated_type_tags(&parsed.frontmatter.tags, tags);
    if contains_lockbox_tag(&normalized_tags) {
        if is_protected_type(&parsed.frontmatter.tags) {
            return Err(LOCKBOX_TYPE_ERROR.to_string());
        }
        ensure_expected_file_sha(&text, expected_file_sha)?;
        return Ok(PublicFragmentUpdate::MoveToLockbox {
            path,
            content: content.trim().to_string(),
            tags: normalized_tags,
        });
    }

    update_public_fragment_in_vault(cx, &path, content, normalized_tags, expected_file_sha)
        .map(|fragment| PublicFragmentUpdate::Saved(Box::new(fragment)))
}

/// 按 id 改公开碎片的标签（`update_fragment_tags` 命令的公开分支）。
pub fn update_public_fragment_tags_by_id(
    cx: &VaultCtx<'_>,
    id: &str,
    tags: Vec<String>,
) -> Result<PublicFragmentUpdate, String> {
    let path = find_fragment_path(cx.vfs, id)?.ok_or_else(|| format!("找不到片段 {}", id))?;
    let text = cx.vfs.read_to_string(&path).map_err(|error| error.to_string())?;
    let parsed = parse_fragment(&text)?;
    let normalized_tags = normalize_updated_type_tags(&parsed.frontmatter.tags, tags);
    if contains_lockbox_tag(&normalized_tags) {
        if is_protected_type(&parsed.frontmatter.tags) {
            return Err(LOCKBOX_TYPE_ERROR.to_string());
        }
        return Ok(PublicFragmentUpdate::MoveToLockbox {
            path,
            content: parsed.body.trim_start_matches('\n').to_string(),
            tags: normalized_tags,
        });
    }

    update_public_fragment_tags_in_vault(cx, &path, normalized_tags)
        .map(|fragment| PublicFragmentUpdate::Saved(Box::new(fragment)))
}

/// 按 id 把公开碎片移入回收站或恢复（`set_fragment_archived` 命令的公开分支）。
pub fn set_public_fragment_archived_by_id(
    cx: &VaultCtx<'_>,
    id: &str,
    archived: bool,
) -> Result<Fragment, String> {
    let path = find_fragment_path(cx.vfs, id)?.ok_or_else(|| format!("找不到片段 {}", id))?;
    let rel_path = relative_path(cx.root(), &path)?;
    let is_archived = rel_path.starts_with(".trash/fragments/");
    if is_archived == archived {
        let dirty = cx.hooks.dirty_paths();
        return read_fragment(cx, &path, &dirty, None);
    }

    cx.hooks.checkpoint_before_structural();
    let target_path = if archived {
        move_to_trash_in_vault(cx, &rel_path)?
    } else {
        restore_from_trash_in_vault(cx, &rel_path)?
    };

    let dirty = cx.hooks.dirty_paths();
    // 内容保存只落盘，提交由聚合检查点接管（docs/design/commit-coalescing-plan.md §7 A2）
    let override_status = None;

    read_fragment(cx, &target_path, &dirty, override_status)
}

/// 按 id 置顶 / 取消置顶公开碎片（`set_fragment_pinned` 命令的公开分支）。
pub fn set_public_fragment_pinned_by_id(
    cx: &VaultCtx<'_>,
    id: &str,
    pinned: bool,
) -> Result<Fragment, String> {
    let path = find_fragment_path(cx.vfs, id)?.ok_or_else(|| format!("找不到片段 {}", id))?;
    set_public_fragment_pinned_in_vault(cx, &path, pinned)
}

/// 按 id 设置公开碎片的自定义属性（`set_fragment_property` 命令的公开分支）。
pub fn set_public_fragment_property_in_vault(
    cx: &VaultCtx<'_>,
    id: &str,
    key: &str,
    value: &serde_yaml::Value,
) -> Result<Fragment, String> {
    validate_property_key(key)?;
    let path = find_fragment_path(cx.vfs, id)?.ok_or_else(|| format!("找不到片段 {id}"))?;
    mutate_public_fragment_property_in_vault(cx, &path, key, Some(value))
}

/// 按 id 删除公开碎片的自定义属性（`remove_fragment_property` 命令的公开分支）。
pub fn remove_public_fragment_property_in_vault(
    cx: &VaultCtx<'_>,
    id: &str,
    key: &str,
) -> Result<Fragment, String> {
    validate_property_key(key)?;
    let path = find_fragment_path(cx.vfs, id)?.ok_or_else(|| format!("找不到片段 {id}"))?;
    mutate_public_fragment_property_in_vault(cx, &path, key, None)
}
