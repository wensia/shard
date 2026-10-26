//! 迁自 src-tauri/src/lib.rs 的领域测试：资料库树、新建笔记 / 目录 / 数据集、文件名规则。
//! 本地目录 + NoHooks（与未初始化 Git 的本地资料库等价），准备数据照旧直接写文件。

use super::*;

#[test]
fn lists_only_public_csv_files() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join("data")).unwrap();
    fs::create_dir_all(vault.join("lockbox").join("data")).unwrap();
    fs::write(vault.join("root.CSV"), "a,b\n1,2\n").unwrap();
    fs::write(vault.join("data").join("nested.csv"), "a\n1\n").unwrap();
    fs::write(vault.join("data").join("ignored.txt"), "not csv\n").unwrap();
    fs::write(vault.join("lockbox").join("data").join("secret.csv"), "secret\n").unwrap();
    fs::write(vault.join(".shard").join("internal.csv"), "internal\n").unwrap();

    let files = list_csv_files_in_vault(&LocalVault::new(vault).cx()).unwrap();
    assert_eq!(
        files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(),
        vec!["data/nested.csv", "root.CSV"]
    );
}

#[test]
fn validates_public_csv_paths() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join("data")).unwrap();
    fs::write(vault.join("data").join("ok.csv"), "a\n1\n").unwrap();

    assert!(ensure_public_csv_path(&FsVfs::new(vault), "data/ok.csv").is_ok());
    for invalid in [
        "",
        "/tmp/outside.csv",
        "../outside.csv",
        "./data/ok.csv",
        "data\\ok.csv",
        "data/ok.txt",
        "lockbox/secret.csv",
        ".shard/internal.csv",
        "data/missing.csv",
    ] {
        assert!(ensure_public_csv_path(&FsVfs::new(vault), invalid).is_err(), "{invalid}");
    }
}

#[cfg(unix)]
#[test]
fn rejects_csv_symlink_that_leaves_vault() {
    use std::os::unix::fs::symlink;

    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    ensure_vault_layout(&FsVfs::new(&vault)).unwrap();
    let outside = tempdir.path().join("outside.csv");
    fs::write(&outside, "secret\n").unwrap();
    symlink(&outside, vault.join("outside.csv")).unwrap();

    assert!(ensure_public_csv_path(&FsVfs::new(&vault), "outside.csv").is_err());
    assert!(list_csv_files_in_vault(&LocalVault::new(&vault).cx()).unwrap().is_empty());
}

#[test]
fn library_tree_only_lists_notes_markdown_csv_and_aggregates_fragments() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join("notes/项目")).unwrap();
    fs::create_dir_all(vault.join("fragments/2026/08")).unwrap();
    fs::create_dir_all(vault.join("assets")).unwrap();
    fs::write(vault.join("notes/项目/说明.md"), "note").unwrap();
    fs::write(vault.join("notes/项目/数据.csv"), "a,b").unwrap();
    fs::write(vault.join("notes/项目/忽略.txt"), "ignored").unwrap();
    fs::write(vault.join("assets/隐藏.md"), "hidden").unwrap();
    fs::write(vault.join("fragments/2026/08/a.md"), "a").unwrap();
    fs::write(vault.join("fragments/2026/08/b.md"), "b").unwrap();

    let tree = build_library_tree(&LocalVault::new(vault).cx()).unwrap();

    assert_eq!(tree.entries.len(), 1);
    assert_eq!(tree.entries[0].kind, "directory");
    let children = tree.entries[0].children.as_ref().unwrap();
    assert_eq!(children.len(), 2);
    assert!(children.iter().any(|entry| entry.kind == "markdown"));
    assert!(children.iter().any(|entry| entry.kind == "csv"));
    assert_eq!(tree.fragment_stream.total_count, 2);
    assert_eq!(tree.fragment_stream.years[0].year, "2026");
    assert_eq!(tree.fragment_stream.years[0].months[0].month, "08");
    assert_eq!(tree.fragment_stream.years[0].months[0].count, 2);
    assert!(tree.assets.is_empty());
}

#[test]
fn library_tree_fragment_entries_are_flat_public_markdown_metadata() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join("fragments/2026/08")).unwrap();
    fs::create_dir_all(vault.join(".trash/fragments/2026/08")).unwrap();
    fs::create_dir_all(vault.join("lockbox/fragments")).unwrap();
    write_t6_fragment(&vault.join("fragments/2026/08/a.md"), "a", vec!["inbox"], "body");
    fs::write(vault.join("fragments/b.MD"), "root fragment").unwrap();
    fs::write(vault.join("fragments/2026/08/ignored.csv"), "a,b").unwrap();
    fs::write(vault.join("notes/note.md"), "library").unwrap();
    fs::write(vault.join(".trash/fragments/2026/08/deleted.md"), "deleted").unwrap();
    fs::write(vault.join("lockbox/fragments/secret.md"), "secret").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(vault.join("lockbox/fragments"), vault.join("fragments/private"))
        .unwrap();

    let tree = build_library_tree(&LocalVault::new(vault).cx()).unwrap();

    assert_eq!(tree.fragment_entries.len(), 2);
    for entry in &tree.fragment_entries {
        assert_eq!(entry.kind, "markdown");
        assert!(entry.children.is_none());
        assert!(matches!(entry.path.as_str(), "fragments/2026/08/a.md" | "fragments/b.MD"));
        assert_eq!(entry.size, fs::metadata(vault.join(&entry.path)).unwrap().len());
        assert!(DateTime::parse_from_rfc3339(&entry.modified_at).is_ok());
    }
    let serialized = serde_json::to_value(&tree).unwrap();
    assert_eq!(serialized["fragmentEntries"].as_array().unwrap().len(), 2);
    assert_eq!(tree.entries.len(), 1);
    assert_eq!(tree.fragment_trash_entries.len(), 1);
}

#[test]
fn library_tree_entries_include_size_and_modified_at() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let contents = "note metadata";
    fs::write(vault.join("notes/说明.md"), contents).unwrap();

    let tree = build_library_tree(&LocalVault::new(vault).cx()).unwrap();

    assert_eq!(tree.entries.len(), 1);
    let entry = &tree.entries[0];
    assert_eq!(entry.size, contents.len() as u64);
    assert!(DateTime::parse_from_rfc3339(&entry.modified_at).is_ok());
    let serialized = serde_json::to_value(entry).unwrap();
    assert_eq!(serialized["size"], contents.len() as u64);
    assert_eq!(serialized["modifiedAt"], entry.modified_at);
    assert_eq!(
        entry.created_at,
        fs::metadata(vault.join("notes/说明.md"))
            .unwrap()
            .created()
            .ok()
            .map(system_time_to_rfc3339)
    );
    assert_eq!(serialized["createdAt"], serde_json::json!(entry.created_at));
}

#[test]
fn library_tree_directory_size_is_zero() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join("notes/项目")).unwrap();
    fs::write(vault.join("notes/项目/说明.md"), "nested note").unwrap();

    let tree = build_library_tree(&LocalVault::new(vault).cx()).unwrap();

    assert_eq!(tree.entries.len(), 1);
    let directory = &tree.entries[0];
    assert_eq!(directory.kind, "directory");
    assert_eq!(directory.size, 0);
    assert!(DateTime::parse_from_rfc3339(&directory.modified_at).is_ok());
    assert_eq!(
        directory.created_at,
        fs::metadata(vault.join("notes/项目"))
            .unwrap()
            .created()
            .ok()
            .map(system_time_to_rfc3339)
    );
}

#[test]
fn library_tree_keeps_file_when_metadata_read_fails() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let failed_path = vault.join("notes/metadata-error.md");
    fs::write(&failed_path, "still visible").unwrap();
    fs::write(vault.join("notes/healthy.md"), "healthy").unwrap();

    let entries = collect_library_entries_with_metadata(&FsVfs::new(vault), &vault.join("notes"), &|path| {
        if path == failed_path {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "simulated metadata failure",
            ))
        } else {
            FsVfs::new(vault).metadata(path)
        }
    })
    .unwrap();

    assert_eq!(entries.len(), 2);
    let failed = entries
        .iter()
        .find(|entry| entry.name == "metadata-error.md")
        .unwrap();
    assert_eq!(failed.size, 0);
    assert!(failed.modified_at.is_empty());
    assert!(failed.created_at.is_none());
    assert!(serde_json::to_value(failed).unwrap()["createdAt"].is_null());
    let healthy = entries
        .iter()
        .find(|entry| entry.name == "healthy.md")
        .unwrap();
    assert_eq!(healthy.size, "healthy".len() as u64);
    assert!(DateTime::parse_from_rfc3339(&healthy.modified_at).is_ok());
}

#[test]
fn library_tree_hides_retired_tables_but_keeps_them_restorable_from_trash() {
    fn flatten(entries: &[LibraryTreeEntry]) -> Vec<(String, String)> {
        entries
            .iter()
            .flat_map(|entry| {
                let mut items = vec![(entry.path.clone(), entry.kind.clone())];
                items.extend(flatten(entry.children.as_deref().unwrap_or_default()));
                items
            })
            .collect()
    }
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::write(vault.join("notes/旧表.shardtable.json"), "{}").unwrap();
    fs::write(vault.join("notes/说明.md"), "# 说明").unwrap();
    fs::create_dir_all(vault.join(".trash/notes")).unwrap();
    fs::write(vault.join(".trash/notes/已删表.shardtable.json"), "{}").unwrap();

    let tree = build_library_tree(&LocalVault::new(vault).cx()).unwrap();
    let entries = flatten(&tree.entries);
    assert_eq!(entries, vec![("notes/说明.md".to_string(), "markdown".to_string())]);
    let trash = flatten(&tree.trash_entries);
    assert!(trash.contains(&(
        ".trash/notes/已删表.shardtable.json".to_string(),
        "file".to_string()
    )));
    assert!(!trash.iter().any(|(_, kind)| kind == "table"));
}

#[test]
fn library_dataset_creates_csv_schema_and_embedding_note() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir(vault.join("notes/项目")).unwrap();
    let (dataset, note) = create_library_dataset_in_vault(
        &LocalVault::new(vault).cx(),
        " 读书清单 ",
        vec!["id".into(), "名称".into()],
        vec![vec!["r1".into(), "第一本".into()]],
        Some("id".into()),
        Some("notes/项目"),
    )
    .unwrap();
    assert_eq!(dataset.path, "datasets/读书清单.csv");
    assert!(vault.join("datasets/读书清单.csv").is_file());
    assert!(vault.join("datasets/读书清单.csv.schema.json").is_file());
    assert_eq!(note.path, "notes/项目/读书清单.md");
    assert!(note.tags.iter().any(|tag| tag == "note"));
    assert_eq!(
        note.content.trim(),
        "# 读书清单\n\n```datatable\n{\n  \"title\": \"读书清单\",\n  \"src\": \"datasets/读书清单.csv\"\n}\n```"
    );
}

#[test]
fn library_dataset_leaves_no_csv_when_the_note_cannot_be_created() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    for directory in [Some("notes/不存在"), Some("../outside")] {
        assert!(create_library_dataset_in_vault(
            &LocalVault::new(vault).cx(),
            "孤儿",
            vec!["名称".into()],
            Vec::new(),
            None,
            directory,
        )
        .is_err());
    }
    assert!(create_library_dataset_in_vault(&LocalVault::new(vault).cx(), "  ", vec!["名称".into()], Vec::new(), None, None)
        .is_err());
    let leftovers = fs::read_dir(vault.join("datasets"))
        .map(|entries| {
            entries
                .filter(|entry| {
                    entry.as_ref().is_ok_and(|entry| {
                        entry.file_name().to_string_lossy().contains(".csv")
                    })
                })
                .count()
        })
        .unwrap_or(0);
    assert_eq!(leftovers, 0);

    // A note write failure after the CSV exists rolls the dataset back.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let notes = vault.join("notes");
        fs::set_permissions(&notes, fs::Permissions::from_mode(0o555)).unwrap();
        let result = create_library_dataset_in_vault(
            &LocalVault::new(vault).cx(),
            "只读目录",
            vec!["名称".into()],
            Vec::new(),
            None,
            None,
        );
        fs::set_permissions(&notes, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.is_err());
        assert!(!vault.join("datasets/只读目录.csv").exists());
        assert!(!vault.join("datasets/只读目录.csv.schema.json").exists());
    }
}

#[test]
fn library_tree_preserves_document_creation_time_across_atomic_rewrites() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let created_at = "2025-03-04T05:06:07+08:00";
    let note_path = vault.join("notes/说明.md");
    let flow_path = vault.join("notes/数据.shardflow.json");

    for body in ["first version", "second version"] {
        write_text_atomically(
            &note_path,
            &format!("---\ncreated_at: '{created_at}'\n---\n{body}"),
        )
        .unwrap();
        write_text_atomically(
            &flow_path,
            &format!(r#"{{"createdAt":"{created_at}","body":"{body}"}}"#),
        )
        .unwrap();

        let tree = build_library_tree(&LocalVault::new(vault).cx()).unwrap();
        assert_eq!(tree.entries.len(), 2);
        for entry in &tree.entries {
            assert_eq!(entry.created_at.as_deref(), Some(created_at));
            assert_eq!(serde_json::to_value(entry).unwrap()["createdAt"], created_at);
        }
    }
}

#[test]
fn library_creation_header_only_uses_valid_top_level_time_with_bounded_reads() {
    let tempdir = tempfile::tempdir().unwrap();
    let path = tempdir.path().join("test.shardflow.json");
    let created_at = "2025-03-04T05:06:07Z";
    let nested = r#"{"createdAt":"2020-01-01T00:00:00Z"}"#;
    // A nested node timestamp must not be confused with the document timestamp.
    fs::write(
        &path,
        format!(
            r#"{{"node":{nested},"createdAt":"{created_at}","body":"{}"}}"#,
            "x".repeat(128 * 1024)
        ),
    )
    .unwrap();
    assert_eq!(
        library_document_created_at(&FsVfs::new(tempdir.path()), &path, "flowchart").as_deref(),
        Some(created_at)
    );

    for contents in [
        format!(r#"{{"node":{nested}}}"#),
        r#"{"createdAt":"not a timestamp"}"#.to_string(),
        r#"{"createdAt":123}"#.to_string(),
        format!(
            r#"{{"body":"{}","createdAt":"{created_at}"}}"#,
            "x".repeat(128 * 1024)
        ),
        "not json".to_string(),
    ] {
        fs::write(&path, contents).unwrap();
        assert!(library_document_created_at(&FsVfs::new(tempdir.path()), &path, "flowchart").is_none());
    }
    fs::remove_file(&path).unwrap();
    assert!(library_document_created_at(&FsVfs::new(tempdir.path()), &path, "flowchart").is_none());
}

#[test]
fn library_tree_creation_time_survives_metadata_failure_and_bad_headers_fall_back() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let created_at = "2025-03-04T05:06:07Z";
    fs::write(
        vault.join("notes/valid.md"),
        format!("---\ncreated_at: '{created_at}'\n---\nbody"),
    )
    .unwrap();
    let damaged = vault.join("notes/damaged.shardcanvas.json");
    fs::write(&damaged, "not json").unwrap();

    let entries = collect_library_entries_with_metadata(&FsVfs::new(vault), &vault.join("notes"), &|_| {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "metadata unavailable",
        ))
    })
    .unwrap();
    assert_eq!(entries.len(), 2);
    let note = entries
        .iter()
        .find(|entry| entry.kind == "markdown")
        .unwrap();
    assert_eq!(note.created_at.as_deref(), Some(created_at));
    let canvas = entries.iter().find(|entry| entry.kind == "canvas").unwrap();
    assert!(canvas.created_at.is_none());
    assert!(serde_json::to_value(canvas).unwrap()["createdAt"].is_null());

    let tree = build_library_tree(&LocalVault::new(vault).cx()).unwrap();
    let canvas = tree
        .entries
        .iter()
        .find(|entry| entry.kind == "canvas")
        .unwrap();
    assert_eq!(
        canvas.created_at,
        fs::metadata(&damaged)
            .unwrap()
            .created()
            .ok()
            .map(system_time_to_rfc3339)
    );
}

#[test]
fn library_tree_lists_image_assets_with_metadata_and_preserves_other_sections() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::write(vault.join("notes/说明.md"), "note").unwrap();
    create_mind_map_in_vault(&LocalVault::new(vault).cx(), "项目导图".to_string(), None).unwrap();
    let asset_dir = vault.join("assets/a3");
    fs::create_dir_all(&asset_dir).unwrap();
    let bytes = b"\x89PNG\r\n\x1a\nimage-data";
    fs::write(asset_dir.join("a3f5e8c9.png"), bytes).unwrap();
    fs::write(vault.join("notes/说明.md"), "![说明](assets/a3/a3f5e8c9.png)").unwrap();

    let tree = build_library_tree(&LocalVault::new(vault).cx()).unwrap();

    assert_eq!(tree.assets.len(), 1);
    let asset = &tree.assets[0];
    assert_eq!(asset.path, "assets/a3/a3f5e8c9.png");
    assert_eq!(asset.size, bytes.len() as u64);
    assert_eq!(asset.mime_type, "image/png");
    assert!(DateTime::parse_from_rfc3339(&asset.modified_at).is_ok());
    assert_eq!(tree.entries.len(), 2);
    assert!(tree.entries.iter().any(|entry| entry.name == "说明.md"));
    assert!(tree
        .entries
        .iter()
        .any(|entry| entry.name == "项目导图.shardmap.json"));

    let serialized = serde_json::to_value(&tree).unwrap();
    assert_eq!(serialized["assets"][0]["modifiedAt"], asset.modified_at);
    assert_eq!(serialized["assets"][0]["mimeType"], "image/png");
}

#[test]
fn library_tree_lists_mind_maps_in_notes_with_metadata() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::write(vault.join("notes/说明.md"), "note").unwrap();

    let valid =
        create_mind_map_in_vault(&LocalVault::new(vault).cx(), "项目导图".to_string(), None)
            .unwrap();

    let tree = build_library_tree(&LocalVault::new(vault).cx()).unwrap();

    assert_eq!(tree.entries.len(), 2);
    let map = tree
        .entries
        .iter()
        .find(|entry| entry.kind == "mindmap")
        .unwrap();
    assert_eq!(map.name, "项目导图.shardmap.json");
    assert_eq!(map.path, valid.path);
    assert_eq!(map.mind_map_id.as_deref(), Some(valid.file.id.as_str()));
    assert_eq!(map.created_at.as_deref(), Some(valid.file.created_at.as_str()));
    assert!(map.size > 0);
    assert!(DateTime::parse_from_rfc3339(&map.modified_at).is_ok());
    assert!(tree
        .entries
        .iter()
        .any(|entry| entry.name == "说明.md" && entry.kind == "markdown"));
}

#[test]
fn library_filename_explicit_creation_enforces_unicode_and_byte_limits() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let maximum = "字".repeat(64);
    let too_long = "字".repeat(65);
    let length_error = "名称最多 64 个字符（不含扩展名）。";
    create_library_directory_in_vault(&LocalVault::new(vault).cx(), &maximum, None).unwrap();
    let note = create_library_note_in_vault(&LocalVault::new(vault).cx(), &maximum, None).unwrap();
    assert_eq!(note.path, format!("notes/{maximum}.md"));
    let map =
        create_mind_map_in_vault(&LocalVault::new(vault).cx(), maximum.clone(), None).unwrap();
    assert_eq!(map.file.title, maximum);
    assert_eq!(
        create_library_directory_in_vault(&LocalVault::new(vault).cx(), &too_long, None).unwrap_err(),
        length_error
    );
    assert_eq!(
        create_library_note_in_vault(&LocalVault::new(vault).cx(), &too_long, None).unwrap_err(),
        length_error
    );
    assert_eq!(
        create_mind_map_in_vault(&LocalVault::new(vault).cx(), too_long, None).unwrap_err(),
        length_error
    );
    let maximum_bytes = "😀".repeat(63);
    create_library_note_in_vault(&LocalVault::new(vault).cx(), &maximum_bytes, None).unwrap();
    assert_eq!(
        create_mind_map_in_vault(&LocalVault::new(vault).cx(), maximum_bytes, None).unwrap_err(),
        "名称占用空间过长，请减少部分字符。"
    );
    let title = "中文/标题:示例";
    let sanitized =
        create_library_note_in_vault(&LocalVault::new(vault).cx(), title, None).unwrap();
    assert_eq!(sanitized.path, "notes/中文 标题 示例.md");
    assert_eq!(sanitized.content.trim(), format!("# {title}"));
}

#[test]
fn library_filename_rename_counts_visible_stem_for_every_supported_extension() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    for extension in [".md", ".CSV", ".shardmap.json", ".shardflow.json", ".shardcanvas.json"] {
        let source = format!("notes/source{extension}");
        fs::write(vault.join(&source), "fixture").unwrap();
        assert_eq!(
            rename_library_entry_in_vault(&LocalVault::new(vault).cx(), &source, &"字".repeat(65)).unwrap_err(),
            "名称最多 64 个字符（不含扩展名）。"
        );
        assert_eq!(
            rename_library_entry_in_vault(&LocalVault::new(vault).cx(), &source, &"😀".repeat(64)).unwrap_err(),
            "名称占用空间过长，请减少部分字符。"
        );
        let name = format!("{}{extension}", "字".repeat(64));
        rename_library_entry_in_vault(&LocalVault::new(vault).cx(), &source, &name).unwrap();
        assert!(vault.join("notes").join(name).is_file());
    }
}

#[test]
fn library_filename_generated_collision_suffixes_fit_characters_and_bytes() {
    let tempdir = tempfile::tempdir().unwrap();
    for title in ["字".repeat(80), "😀".repeat(80)] {
        for extension in [".md", ".shardmap.json", ".shardflow.json"] {
            for index in 1..=11 {
                let path = unique_titled_path(
                    &FsVfs::new(tempdir.path()),
                    tempdir.path(),
                    &title,
                    extension,
                );
                let name = path.file_name().unwrap().to_str().unwrap();
                let stem = name.strip_suffix(extension).unwrap();
                assert!(stem.chars().count() <= 64, "{name}");
                assert!(name.len() <= 255, "{name}");
                if index > 1 {
                    assert!(stem.ends_with(&format!("-{index}")), "{name}");
                }
                write_text_atomically(&path, "fixture").unwrap();
            }
        }
    }
}

#[test]
fn library_filename_trash_and_restore_collisions_preserve_boundary_files() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    for extension in [
        ".md", ".CSV", ".shardmap.json", ".shardtable.json",
        ".shardflow.json", ".shardcanvas.json",
    ] {
        let byte_budget = 255 - extension.len();
        let emoji_stem = format!(
            "{}{}",
            "😀".repeat(byte_budget / 4),
            "a".repeat((byte_budget % 4).min(64 - byte_budget / 4)),
        );
        for stem in ["字".repeat(64), emoji_stem] {
            let original = format!("notes/{stem}{extension}");
            let assert_name = |path: &Path| {
                let name = path.file_name().unwrap().to_str().unwrap();
                assert!(name.len() <= 255, "{name}");
                assert!(name.strip_suffix(extension).unwrap().chars().count() <= 64, "{name}");
            };
            fs::write(vault.join(&original), "older content").unwrap();
            let first = move_to_trash_in_vault(&LocalVault::new(vault).cx(), &original).unwrap();
            fs::write(vault.join(&original), "newer content").unwrap();
            let second = move_to_trash_in_vault(&LocalVault::new(vault).cx(), &original).unwrap();
            assert_ne!(first, second);
            assert_name(&first);
            assert_name(&second);
            assert_eq!(fs::read_to_string(&first).unwrap(), "older content");
            fs::write(vault.join(&original), "live content").unwrap();
            let restored_first = restore_from_trash_in_vault(
                &LocalVault::new(vault).cx(), &relative_path(vault, &first).unwrap(),
            ).unwrap();
            let restored_second = restore_from_trash_in_vault(
                &LocalVault::new(vault).cx(), &relative_path(vault, &second).unwrap(),
            ).unwrap();
            assert_name(&restored_first);
            assert_name(&restored_second);
            assert_eq!(fs::read_to_string(restored_first).unwrap(), "older content");
            assert_eq!(fs::read_to_string(restored_second).unwrap(), "newer content");
            assert_eq!(fs::read_to_string(vault.join(original)).unwrap(), "live content");
            assert!(!first.exists());
            assert!(!second.exists());
        }
    }
}

#[test]
fn library_filename_existing_long_note_and_map_remain_readable_and_writable() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let note_path = vault.join(format!("notes/{}.md", "a".repeat(252)));
    write_t6_fragment(&note_path, "existing-long-note", vec!["note"], "original");
    let text = fs::read_to_string(&note_path).unwrap();
    let (header, _) = parse_fragment_text(&text).unwrap();
    write_fragment_file(&FsVfs::new(vault), &note_path, &header, "updated body").unwrap();
    let note = read_fragment(
        &LocalVault::new(vault).cx(),
        &note_path,
        &dirty_paths(vault),
        None,
    )
    .unwrap();
    assert_eq!(note.content.trim(), "updated body");
    assert_eq!(note.path, format!("notes/{}.md", "a".repeat(252)));

    let created =
        create_mind_map_in_vault(&LocalVault::new(vault).cx(), "旧导图".into(), None).unwrap();
    let long_path = vault.join(format!("notes/{}.shardmap.json", "a".repeat(241)));
    fs::rename(vault.join(&created.path), &long_path).unwrap();
    let mut file = created.file;
    file.title = "长标题".repeat(30);
    let saved = write_mind_map_in_vault(
        &LocalVault::new(vault).cx(), &file.id.clone(), file.clone(), file.revision, &created.last_saved_hash,
    ).unwrap();
    assert_eq!(saved.file.title, file.title);
    assert_eq!(vault.join(saved.path), long_path);
    assert_eq!(read_mind_map_file(&FsVfs::new(vault), &long_path).unwrap().0.title, file.title);
}
