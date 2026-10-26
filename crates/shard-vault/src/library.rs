//! 资料库树与新建笔记 / 目录 / 数据集说明笔记。

use crate::prelude::*;

pub fn build_library_tree(cx: &VaultCtx<'_>) -> Result<LibraryTreeSnapshot, String> {
    let vfs = cx.vfs;
    let vault = cx.root();
    fn flatten_markdown(entry: LibraryTreeEntry, entries: &mut Vec<LibraryTreeEntry>) {
        if let Some(children) = entry.children {
            for child in children {
                flatten_markdown(child, entries);
            }
        } else if entry.kind == "markdown" {
            entries.push(entry);
        }
    }
    let mut fragment_entries = Vec::new();
    let fragments_root = vault.join("fragments");
    if vfs.exists(&fragments_root) {
        for entry in collect_library_entries(vfs, &fragments_root)? {
            flatten_markdown(entry, &mut fragment_entries);
        }
    }
    fragment_entries.sort_by(|left, right| {
        right
            .modified_at
            .cmp(&left.modified_at)
            .then_with(|| left.path.cmp(&right.path))
    });
    let trash_root = vault.join(".trash");
    let mut trash_entries = if vfs.exists(&trash_root) {
        collect_library_entries(vfs, &trash_root)?
    } else {
        Vec::new()
    };
    let mut fragment_trash_entries = Vec::new();
    if let Some(index) = trash_entries
        .iter()
        .position(|entry| entry.path == ".trash/fragments")
    {
        fn flatten(entry: LibraryTreeEntry, entries: &mut Vec<LibraryTreeEntry>) {
            if let Some(children) = entry.children {
                for child in children {
                    flatten(child, entries);
                }
            } else {
                entries.push(entry);
            }
        }
        flatten(trash_entries.remove(index), &mut fragment_trash_entries);
    }
    fragment_trash_entries.sort_by(|left, right| {
        right
            .modified_at
            .cmp(&left.modified_at)
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(LibraryTreeSnapshot {
        entries: collect_library_entries(vfs, &vault.join("notes"))?,
        fragment_entries,
        trash_entries,
        fragment_trash_entries,
        fragment_stream: summarize_fragment_stream(vfs)?,
        assets: collect_library_assets(cx),
    })
}

pub fn collect_library_entries(
    vfs: &dyn Vfs,
    directory: &Path,
) -> Result<Vec<LibraryTreeEntry>, String> {
    collect_library_entries_with_metadata(vfs, directory, &|path| vfs.metadata(path))
}

pub fn library_entry_metadata<F>(
    path: &Path,
    is_directory: bool,
    read_metadata: &F,
) -> (u64, String, Option<String>)
where
    F: Fn(&Path) -> std::io::Result<shard_core::VfsMetadata>,
{
    let Ok(metadata) = read_metadata(path) else {
        return (0, String::new(), None);
    };
    let modified_at = metadata
        .modified()
        .map(system_time_to_rfc3339)
        .unwrap_or_default();
    let size = if is_directory { 0 } else { metadata.len() };
    let created_at = metadata.created().ok().map(system_time_to_rfc3339);
    (size, modified_at, created_at)
}

pub fn valid_library_creation_time(value: String) -> Option<String> {
    DateTime::parse_from_rfc3339(&value).ok().map(|_| value)
}

pub fn library_document_created_at(vfs: &dyn Vfs, path: &Path, kind: &str) -> Option<String> {
    // Native documents store creation metadata before their body. Keep library scans
    // bounded even for large documents; externally reordered headers can use FS birthtime.
    const HEADER_BYTES: u64 = 64 * 1024;
    let header = vfs.read_head(path, HEADER_BYTES).ok()?;
    let reader = BufReader::new(header.as_slice());
    if kind == "markdown" {
        #[derive(Deserialize)]
        struct CreationHeader {
            created_at: Option<String>,
        }

        let mut lines = reader.lines();
        if lines.next()?.ok()?.trim_end() != "---" {
            return None;
        }
        let mut yaml = String::new();
        for line in lines {
            let line = line.ok()?;
            if line.trim_end() == "---" {
                return serde_yaml::from_str::<CreationHeader>(&yaml)
                    .ok()?
                    .created_at
                    .and_then(valid_library_creation_time);
            }
            yaml.push_str(&line);
            yaml.push('\n');
        }
        return None;
    }

    struct CreationHeaderVisitor<'a>(&'a mut Option<String>);
    impl<'de> serde::de::Visitor<'de> for CreationHeaderVisitor<'_> {
        type Value = ();

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a document object with top-level creation metadata")
        }

        fn visit_map<A>(self, mut map: A) -> Result<(), A::Error>
        where
            A: serde::de::MapAccess<'de>,
        {
            while let Some(key) = map.next_key::<String>()? {
                if key == "createdAt" {
                    *self.0 = map
                        .next_value::<Option<String>>()?
                        .and_then(valid_library_creation_time);
                    return Ok(());
                }
                map.next_value::<serde::de::IgnoredAny>()?;
            }
            Ok(())
        }
    }

    let mut created_at = None;
    let mut deserializer = serde_json::Deserializer::from_reader(reader);
    // Stop after the top-level field. Any trailing end-of-map error is irrelevant to
    // this header lookup; opening the document still performs full validation.
    let _ = serde::Deserializer::deserialize_map(
        &mut deserializer,
        CreationHeaderVisitor(&mut created_at),
    );
    created_at
}

pub fn collect_library_entries_with_metadata<F>(
    vfs: &dyn Vfs,
    directory: &Path,
    read_metadata: &F,
) -> Result<Vec<LibraryTreeEntry>, String>
where
    F: Fn(&Path) -> std::io::Result<shard_core::VfsMetadata>,
{
    let vault = vfs.root();
    let mut entries = Vec::new();
    for entry in vfs.read_dir(directory).map_err(|error| error.to_string())? {
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_dir() {
            let (size, modified_at, created_at) =
                library_entry_metadata(&path, true, read_metadata);
            entries.push(LibraryTreeEntry {
                name,
                path: relative_path(vault, &path)?,
                kind: "directory".to_string(),
                size,
                modified_at,
                created_at,
                mind_map_id: None,
                children: Some(collect_library_entries_with_metadata(
                    vfs,
                    &path,
                    read_metadata,
                )?),
            });
        } else if file_type.is_file() {
            let is_mind_map = is_mind_map_file(&path);
            let kind = if canvas::is_flow(&path) {
                "flowchart"
            } else if canvas::is_canvas(&path) {
                "canvas"
            } else if is_mind_map {
                "mindmap"
            } else {
                match path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .map(|extension| extension.to_ascii_lowercase())
                    .as_deref()
                {
                    Some("md") => "markdown",
                    Some("csv") => "csv",
                    // 资料库里的命名图片（营业执照.jpg、IMG_1234.heic）与文档平级上树。
                    Some(extension)
                        if shard_core::image::is_image_extension(extension)
                            && !name.starts_with('.') =>
                    {
                        "image"
                    }
                    _ if directory.starts_with(vault.join(".trash")) => "file",
                    _ => continue,
                }
            };
            let (size, modified_at, filesystem_created_at) =
                library_entry_metadata(&path, false, read_metadata);
            let mind_map = is_mind_map
                .then(|| read_mind_map_summary(vfs, &path).ok())
                .flatten();
            let created_at = if is_mind_map {
                mind_map
                    .as_ref()
                    .and_then(|summary| valid_library_creation_time(summary.created_at.clone()))
            } else if matches!(kind, "markdown" | "flowchart" | "canvas") {
                library_document_created_at(vfs, &path, kind)
            } else {
                None
            }
            .or(filesystem_created_at);
            entries.push(LibraryTreeEntry {
                name,
                path: relative_path(vault, &path)?,
                kind: kind.to_string(),
                size,
                modified_at,
                created_at,
                mind_map_id: mind_map.map(|summary| summary.id),
                children: None,
            });
        }
    }
    entries.sort_by(|left, right| {
        let left_rank = if left.kind == "directory" { 0 } else { 1 };
        let right_rank = if right.kind == "directory" { 0 } else { 1 };
        left_rank
            .cmp(&right_rank)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

pub fn summarize_fragment_stream(vfs: &dyn Vfs) -> Result<FragmentStreamSummary, String> {
    let fragments_root = vfs.root().join("fragments");
    let mut by_year = BTreeMap::<String, BTreeMap<String, usize>>::new();
    if vfs.exists(&fragments_root) {
        for year_entry in vfs.read_dir(&fragments_root).map_err(|error| error.to_string())? {
            if year_entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_symlink()
                || !vfs.is_dir(&year_entry.path())
            {
                continue;
            }
            let year = year_entry.file_name().to_string_lossy().to_string();
            if year.len() != 4 || !year.bytes().all(|byte| byte.is_ascii_digit()) {
                continue;
            }
            for month_entry in vfs
                .read_dir(&year_entry.path())
                .map_err(|error| error.to_string())?
            {
                if month_entry
                    .file_type()
                    .map_err(|error| error.to_string())?
                    .is_symlink()
                    || !vfs.is_dir(&month_entry.path())
                {
                    continue;
                }
                let month = month_entry.file_name().to_string_lossy().to_string();
                if month.len() != 2
                    || !month.bytes().all(|byte| byte.is_ascii_digit())
                    || !("01"..="12").contains(&month.as_str())
                {
                    continue;
                }
                let count = vfs
                    .read_dir(&month_entry.path())
                    .map_err(|error| error.to_string())?
                    .into_iter()
                    .filter(|entry| {
                        entry
                            .file_type()
                            .map(|kind| kind.is_file())
                            .unwrap_or(false)
                            && entry
                                .path()
                                .extension()
                                .and_then(|extension| extension.to_str())
                                == Some("md")
                    })
                    .count();
                if count > 0 {
                    by_year
                        .entry(year.clone())
                        .or_default()
                        .insert(month, count);
                }
            }
        }
    }
    let mut years = by_year
        .into_iter()
        .map(|(year, months)| {
            let months = months
                .into_iter()
                .map(|(month, count)| FragmentMonthSummary { month, count })
                .collect::<Vec<_>>();
            FragmentYearSummary {
                year,
                total_count: months.iter().map(|month| month.count).sum(),
                months,
            }
        })
        .collect::<Vec<_>>();
    years.sort_by(|left, right| right.year.cmp(&left.year));
    for year in &mut years {
        year.months
            .sort_by(|left, right| right.month.cmp(&left.month));
    }
    Ok(FragmentStreamSummary {
        total_count: years.iter().map(|year| year.total_count).sum(),
        years,
    })
}

pub fn library_mutation_result(
    cx: &VaultCtx<'_>,
    fragment: Option<Fragment>,
    updated_links: usize,
) -> Result<LibraryMutationResult, String> {
    Ok(LibraryMutationResult {
        tree: build_library_tree(cx)?,
        fragment,
        updated_links,
        updated_image_refs: 0,
    })
}

pub fn create_library_note_in_vault(
    cx: &VaultCtx<'_>,
    title: &str,
    directory: Option<&str>,
) -> Result<Fragment, String> {
    create_library_note_with_body(cx, title, directory, &format!("# {}", title.trim()))
}

pub fn create_library_note_with_body(
    cx: &VaultCtx<'_>,
    title: &str,
    directory: Option<&str>,
    body: &str,
) -> Result<Fragment, String> {
    let path = create_library_note_file(cx.vfs, title, directory, body, Vec::new(), "desktop")?;
    read_fragment(
        cx,
        &path,
        &cx.hooks.dirty_paths(),
        None,
    )
}

/// Creates `datasets/<title>.csv` plus a note in the library that embeds it. Caller holds the
/// vault gate. A failed note removes the new CSV and schema so no orphan dataset remains.
pub fn create_library_dataset_in_vault(
    cx: &VaultCtx<'_>,
    title: &str,
    header: Vec<String>,
    rows: Vec<Vec<String>>,
    primary_key: Option<String>,
    directory: Option<&str>,
) -> Result<(DatasetSnapshot, Fragment), String> {
    let (dataset, note) = create_library_dataset_files(
        cx.vfs,
        title,
        header,
        rows,
        primary_key,
        directory,
        "desktop",
    )?;
    let fragment = read_fragment(cx, &note, &cx.hooks.dirty_paths(), None)?;
    Ok((dataset, fragment))
}

pub fn create_library_directory_in_vault(
    cx: &VaultCtx<'_>,
    name: &str,
    parent: Option<&str>,
) -> Result<(), String> {
    let name = validate_library_name(name)?;
    let parent = existing_library_directory(cx.vfs, parent)?;
    let path = parent.join(name);
    if cx.vfs.exists(&path) {
        return Err(format!("资料库条目已存在：{name}"));
    }
    cx.vfs.create_dir(&path).map_err(|error| error.to_string())
}

pub fn collect_public_vault_markdown(
    vfs: &dyn Vfs,
    directory: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let vault = vfs.root();
    for entry in vfs.read_dir(directory).map_err(|error| error.to_string())? {
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == ".git" || name == ".shard" || name.eq_ignore_ascii_case("lockbox") {
                continue;
            }
            collect_public_vault_markdown(vfs, &path, files)?;
        } else if file_type.is_file()
            && path.extension().and_then(|extension| extension.to_str()) == Some("md")
            && path.starts_with(vault)
        {
            files.push(path);
        }
    }
    Ok(())
}

pub fn list_csv_files_in_vault(cx: &VaultCtx<'_>) -> Result<Vec<CsvFileSummary>, String> {
    let vault = cx.root();
    let mut paths = Vec::new();
    collect_csv_files(cx.vfs, vault, &mut paths)?;
    let mut files = paths
        .into_iter()
        .filter_map(|path| {
            let relative = relative_path(vault, &path).ok()?;
            let name = path.file_name()?.to_str()?.to_string();
            Some(CsvFileSummary { name, path: relative })
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

pub fn collect_csv_files(vfs: &dyn Vfs, directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if !vfs.exists(directory) {
        return Ok(());
    }
    for entry in vfs.read_dir(directory).map_err(|error| error.to_string())? {
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == ".git"
                || name == ".shard"
                || name.eq_ignore_ascii_case("lockbox")
            {
                continue;
            }
            collect_csv_files(vfs, &path, files)?;
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| extension.eq_ignore_ascii_case("csv"))
                .unwrap_or(false)
        {
            files.push(path);
        }
    }
    Ok(())
}
