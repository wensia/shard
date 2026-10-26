//! 迁自 src-tauri/src/lib.rs 的领域测试：改名、移动、引用改写与回收站。
//! 本地目录 + NoHooks（与未初始化 Git 的本地资料库等价），准备数据照旧直接写文件。

use super::*;

#[test]
fn renaming_or_moving_images_rewrites_document_references() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join("notes/旅行")).unwrap();
    fs::create_dir_all(vault.join("notes/归档")).unwrap();
    fs::write(vault.join("notes/旅行/a.jpg"), TEST_PNG).unwrap();
    fs::write(vault.join("notes/旅行/a.jpg.bak"), "x").unwrap();
    fs::write(
        vault.join("notes/旅行/游记.md"),
        "![海边](notes/旅行/a.jpg) ![备份](notes/旅行/a.jpg.bak)\n",
    )
    .unwrap();
    let fragment = write_public_test_fragment(vault, "碎片里也引用 ![海边](notes/旅行/a.jpg)");
    // 资料库外的表格：带 BOM、CRLF，改写后照旧。
    fs::write(
        vault.join("notes/旅行/行程.csv"),
        "\u{feff}地点,照片\r\n海边,notes/旅行/a.jpg\r\n山上,notes/旅行/a.jpg.bak\r\n",
    )
    .unwrap();

    let (_, links, images) =
        rename_library_entry_in_vault(
            &LocalVault::new(vault).cx(),
            "notes/旅行/a.jpg",
            "海边 日落",
        )
        .unwrap();
    assert_eq!((links, images), (0, 3));
    assert_eq!(
        fs::read_to_string(vault.join("notes/旅行/行程.csv")).unwrap(),
        "\u{feff}地点,照片\r\n海边,notes/旅行/海边 日落.jpg\r\n山上,notes/旅行/a.jpg.bak\r\n"
    );
    assert!(vault.join("notes/旅行/海边 日落.jpg").is_file());
    assert_eq!(
        fs::read_to_string(vault.join("notes/旅行/游记.md")).unwrap(),
        "![海边](<notes/旅行/海边 日落.jpg>) ![备份](notes/旅行/a.jpg.bak)\n"
    );
    let mut fragment_files = Vec::new();
    collect_markdown_files(
        &FsVfs::new(vault),
        &vault.join("fragments"),
        &mut fragment_files,
    )
    .unwrap();
    let fragment_text = fragment_files
        .iter()
        .map(|path| fs::read_to_string(path).unwrap())
        .find(|text| text.contains("碎片里也引用"))
        .unwrap();
    assert!(fragment_text.contains("<notes/旅行/海边 日落.jpg>"), "{fragment_text}");
    let _ = fragment;

    // 整个目录移走：目录里的文档跟着走，也要按新位置写回。
    let images = move_library_entry_in_vault(
        &LocalVault::new(vault).cx(),
        "notes/旅行",
        Some("notes/归档"),
    )
    .unwrap();
    assert_eq!(images, 3);
    assert!(fs::read_to_string(vault.join("notes/归档/旅行/行程.csv"))
        .unwrap()
        .contains("海边,notes/归档/旅行/海边 日落.jpg\r\n"));
    assert_eq!(
        fs::read_to_string(vault.join("notes/归档/旅行/游记.md")).unwrap(),
        "![海边](<notes/归档/旅行/海边 日落.jpg>) ![备份](notes/旅行/a.jpg.bak)\n"
    );
    assert_eq!(
        image_references_in_vault(&LocalVault::new(vault).cx(), "notes/归档/旅行/海边 日落.jpg").unwrap().len(),
        3
    );
    assert!(
        image_references_in_vault(&LocalVault::new(vault).cx(), "notes/旅行/a.jpg")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn library_and_fragment_trash_are_separate_and_empty_only_the_requested_scope() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join(".trash/fragments/2025/03")).unwrap();
    fs::create_dir_all(vault.join(".trash/notes/project")).unwrap();
    fs::write(vault.join(".trash/fragments/2025/03/first.md"), "fragment").unwrap();
    fs::write(vault.join(".trash/notes/project/doc.md"), "document").unwrap();
    let tree = build_library_tree(&LocalVault::new(vault).cx()).unwrap();
    assert_eq!(tree.trash_entries.len(), 1);
    assert_eq!(tree.trash_entries[0].path, ".trash/notes");
    assert_eq!(tree.fragment_trash_entries.len(), 1);
    assert_eq!(
        tree.fragment_trash_entries[0].path,
        ".trash/fragments/2025/03/first.md"
    );
    assert!(tree.fragment_trash_entries[0].children.is_none());
    assert!(serde_json::to_value(&tree).unwrap()["fragmentTrashEntries"].is_array());

    empty_trash_in_vault(&LocalVault::new(vault).cx(), ContentScope::default()).unwrap();
    assert!(!vault.join(".trash/notes").exists());
    assert!(vault.join(".trash/fragments/2025/03/first.md").is_file());
    fs::create_dir_all(vault.join(".trash/notes")).unwrap();
    fs::write(vault.join(".trash/notes/keep.md"), "keep").unwrap();
    empty_trash_in_vault(&LocalVault::new(vault).cx(), ContentScope::Fragments).unwrap();
    assert!(!vault.join(".trash/fragments").exists());
    assert!(vault.join(".trash/notes/keep.md").is_file());
    assert_eq!(
        serde_json::from_str::<ContentScope>("\"all\"").unwrap(),
        ContentScope::All
    );
    fs::create_dir_all(vault.join(".trash/fragments/2025/03")).unwrap();
    fs::write(vault.join(".trash/fragments/2025/03/second.md"), "fragment").unwrap();
    empty_trash_in_vault(&LocalVault::new(vault).cx(), ContentScope::All).unwrap();
    assert!(fs::read_dir(vault.join(".trash")).unwrap().next().is_none());
}

#[test]
fn rejects_library_path_escape_and_moves_non_empty_directory_to_trash() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join("notes/目录")).unwrap();
    fs::write(vault.join("notes/目录/note.md"), "note").unwrap();

    for invalid in [
        "",
        "notes",
        "../outside",
        "notes/../outside",
        "/tmp/outside",
    ] {
        assert!(existing_library_path(&FsVfs::new(vault), invalid).is_err(), "{invalid}");
    }
    move_to_trash_in_vault(&LocalVault::new(vault).cx(), "notes/目录").unwrap();
    assert!(!vault.join("notes/目录").exists());
    assert!(vault.join(".trash/notes/目录/note.md").is_file());
}

#[test]
fn supports_library_create_move_and_empty_directory_soft_delete() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    create_library_directory_in_vault(&LocalVault::new(vault).cx(), "来源", None).unwrap();
    create_library_directory_in_vault(&LocalVault::new(vault).cx(), "目标", None).unwrap();
    let note =
        create_library_note_in_vault(&LocalVault::new(vault).cx(), "移动测试", Some("notes/来源"))
            .unwrap();
    assert_eq!(note.path, "notes/来源/移动测试.md");

    move_library_entry_in_vault(
        &LocalVault::new(vault).cx(),
        "notes/来源/移动测试.md",
        Some("notes/目标"),
    )
    .unwrap();
    assert!(vault.join("notes/目标/移动测试.md").is_file());
    move_to_trash_in_vault(&LocalVault::new(vault).cx(), "notes/来源").unwrap();
    assert!(!vault.join("notes/来源").exists());
    assert!(vault.join(".trash/notes/来源").is_dir());
}

#[test]
fn moves_all_supported_content_types_and_directories_to_trash() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let files = [
        ("notes/note.md", b"md".as_slice()),
        ("notes/table.csv", b"csv".as_slice()),
        ("maps/map.shardmap.json", b"map".as_slice()),
        ("assets/image.png", b"png".as_slice()),
    ];
    for (rel_path, content) in files {
        let path = vault.join(rel_path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        move_to_trash_in_vault(&LocalVault::new(vault).cx(), rel_path).unwrap();
        assert!(!path.exists(), "{rel_path}");
        assert!(vault.join(".trash").join(rel_path).is_file(), "{rel_path}");
    }
    fs::create_dir_all(vault.join("notes/folder/nested")).unwrap();
    fs::write(vault.join("notes/folder/nested/unknown.bin"), b"dir").unwrap();

    move_to_trash_in_vault(&LocalVault::new(vault).cx(), "notes/folder").unwrap();

    assert!(!vault.join("notes/folder").exists());
    assert!(vault
        .join(".trash/notes/folder/nested/unknown.bin")
        .is_file());
}

#[test]
fn restores_from_trash_without_overwriting_existing_target() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::write(vault.join("notes/collision.md"), "deleted version").unwrap();
    move_to_trash_in_vault(&LocalVault::new(vault).cx(), "notes/collision.md").unwrap();
    fs::write(vault.join("notes/collision.md"), "new version").unwrap();

    let restored =
        restore_from_trash_in_vault(&LocalVault::new(vault).cx(), ".trash/notes/collision.md").unwrap();

    assert_eq!(
        fs::read_to_string(vault.join("notes/collision.md")).unwrap(),
        "new version"
    );
    assert_ne!(restored, vault.join("notes/collision.md"));
    assert_eq!(fs::read_to_string(restored).unwrap(), "deleted version");
}

#[test]
fn moves_and_restores_dataset_through_trash() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::write(vault.join("datasets/a.csv"), "name\nvalue\n").unwrap();

    let trashed = move_to_trash_in_vault(&LocalVault::new(vault).cx(), "datasets/a.csv").unwrap();
    assert_eq!(relative_path(vault, &trashed).unwrap(), ".trash/datasets/a.csv");
    let restored =
        restore_from_trash_in_vault(&LocalVault::new(vault).cx(), ".trash/datasets/a.csv").unwrap();
    assert_eq!(restored, vault.join("datasets/a.csv"));
    assert_eq!(fs::read_to_string(restored).unwrap(), "name\nvalue\n");
}

#[test]
fn purge_and_empty_trash_reject_paths_outside_canonical_trash_root() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join(".trash/notes/directory")).unwrap();
    fs::write(vault.join(".trash/notes/deleted.md"), "deleted").unwrap();
    fs::write(vault.join(".trash/notes/directory/nested.md"), "nested").unwrap();
    fs::write(vault.join("notes/outside.md"), "outside").unwrap();

    for invalid in [
        "notes/outside.md",
        ".trash/../notes/outside.md",
        "../outside.md",
        "/tmp/outside.md",
    ] {
        assert!(
            purge_from_trash_in_vault(&LocalVault::new(vault).cx(), invalid).is_err(),
            "{invalid}"
        );
    }
    assert!(vault.join("notes/outside.md").is_file());

    purge_from_trash_in_vault(&LocalVault::new(vault).cx(), ".trash/notes/directory").unwrap();
    assert!(!vault.join(".trash/notes/directory").exists());
    empty_trash_in_vault(&LocalVault::new(vault).cx(), ContentScope::Library).unwrap();
    assert!(vault.join(".trash").is_dir());
    assert!(fs::read_dir(vault.join(".trash")).unwrap().next().is_none());
    assert!(vault.join("notes/outside.md").is_file());
}

#[cfg(unix)]
#[test]
fn empty_trash_rejects_external_symlink_without_deleting_any_entry() {
    use std::os::unix::fs::symlink;

    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join(".trash/notes")).unwrap();
    fs::write(vault.join(".trash/notes/keep.md"), "keep").unwrap();
    fs::create_dir_all(vault.join(".trash/fragments")).unwrap();
    fs::write(vault.join(".trash/fragments/keep.md"), "fragment").unwrap();
    fs::write(vault.join("notes/outside.md"), "outside").unwrap();
    symlink(
        vault.join("notes/outside.md"),
        vault.join(".trash/external-link"),
    )
    .unwrap();

    for scope in [ContentScope::Library, ContentScope::All] {
        assert!(empty_trash_in_vault(&LocalVault::new(vault).cx(), scope).is_err());
        assert!(vault.join(".trash/notes/keep.md").is_file());
        assert!(vault.join(".trash/fragments/keep.md").is_file());
        assert!(vault.join("notes/outside.md").is_file());
    }
}

#[test]
fn renaming_fragment_returns_new_path_and_preserves_id_wikilinks() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join("fragments/2026/08")).unwrap();
    let old_path = "fragments/2026/08/fragment-id.md";
    write_t6_fragment(&vault.join(old_path), "fragment-id", vec!["inbox", "test"], "# 标题\n[[fragment-id]]");
    fs::write(vault.join("notes/ref.md"), "[[fragment-id]] [[fragment-id|别名]]").unwrap();
    let before = fs::read_to_string(vault.join(old_path)).unwrap();

    let (fragment, updated_links, _) =
        rename_library_entry_in_vault(&LocalVault::new(vault).cx(), old_path, "新文件名").unwrap();
    let result =
        library_mutation_result(&LocalVault::new(vault).cx(), fragment, updated_links).unwrap();

    assert_eq!(result.updated_links, 0);
    let fragment = result.fragment.unwrap();
    assert_eq!(fragment.id, "fragment-id");
    assert_eq!(fragment.path, "fragments/2026/08/新文件名.md");
    assert_eq!(fragment.tags, vec!["inbox", "test"]);
    assert!(!vault.join(old_path).exists());
    assert_eq!(fs::read_to_string(vault.join(&fragment.path)).unwrap(), before);
    assert_eq!(fs::read_to_string(vault.join("notes/ref.md")).unwrap(), "[[fragment-id]] [[fragment-id|别名]]");
    assert_eq!(
        find_fragment_path(&FsVfs::new(vault), "fragment-id").unwrap(),
        Some(vault.join(&fragment.path))
    );
    assert_eq!(result.tree.fragment_entries[0].path, fragment.path);
}

#[test]
fn renaming_named_fragment_updates_filename_links_but_keeps_id_links() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    write_t6_fragment(&vault.join("fragments/旧文件名.md"), "stable-id", vec!["inbox"], "body");
    fs::write(vault.join("notes/ref.md"), "[[旧文件名]] [[旧文件名|别名]] [[stable-id]]").unwrap();

    let (fragment, count, _) = rename_library_entry_in_vault(
        &LocalVault::new(vault).cx(),
        "fragments/旧文件名.md",
        "新文件名.md",
    )
    .unwrap();

    assert_eq!(count, 2);
    assert_eq!(fragment.unwrap().id, "stable-id");
    assert_eq!(fs::read_to_string(vault.join("notes/ref.md")).unwrap(), "[[新文件名]] [[新文件名|别名]] [[stable-id]]");
}

#[test]
fn fragment_file_rename_rejects_directories_other_spaces_and_type_changes() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join("fragments/2026/08")).unwrap();
    fs::create_dir_all(vault.join("lockbox/fragments")).unwrap();
    fs::create_dir_all(vault.join(".trash/fragments")).unwrap();
    let source = "fragments/2026/08/fragment.md";
    write_t6_fragment(&vault.join(source), "fragment-id", vec!["inbox"], "body");
    fs::write(vault.join("fragments/data.csv"), "a,b").unwrap();
    fs::write(vault.join("lockbox/fragments/secret.md"), "private").unwrap();
    fs::write(vault.join(".trash/fragments/deleted.md"), "deleted").unwrap();
    for path in ["fragments", "fragments/2026/08", "fragments/data.csv", "lockbox/fragments/secret.md", ".trash/fragments/deleted.md", "fragments/../../notes/escape.md"] {
        assert!(
            rename_library_entry_in_vault(&LocalVault::new(vault).cx(), path, "新名称").is_err(),
            "{path}"
        );
    }
    for name in ["changed.csv", "notes/changed", "../changed"] {
        assert!(
            rename_library_entry_in_vault(&LocalVault::new(vault).cx(), source, name).is_err(),
            "{name}"
        );
    }
    assert!(move_library_entry_in_vault(&LocalVault::new(vault).cx(), source, None).is_err());
    fs::write(vault.join("notes/note.md"), "note").unwrap();
    assert!(move_library_entry_in_vault(
        &LocalVault::new(vault).cx(),
        "notes/note.md",
        Some("fragments/2026/08")
    )
    .is_err());
    assert!(vault.join(source).exists());
    assert!(vault.join("notes/note.md").exists());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(vault.join("notes"), vault.join("fragments/escape")).unwrap();
        assert!(rename_library_entry_in_vault(
            &LocalVault::new(vault).cx(),
            "fragments/escape/note.md",
            "escaped"
        )
        .is_err());
        std::os::unix::fs::symlink(vault.join(source), vault.join("fragments/link.md")).unwrap();
        assert!(rename_library_entry_in_vault(
            &LocalVault::new(vault).cx(),
            "fragments/link.md",
            "linked"
        )
        .is_err());
    }
}

#[test]
fn renaming_markdown_updates_plain_and_aliased_wikilinks_across_public_vault() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join("fragments/2026/08")).unwrap();
    fs::create_dir_all(vault.join("lockbox/fragments")).unwrap();
    write_t6_fragment(
        &vault.join("notes/旧名.md"),
        "note-id",
        vec!["note"],
        "# 标题",
    );
    write_t6_fragment(
        &vault.join("fragments/2026/08/source.md"),
        "source-id",
        vec!["inbox"],
        "[[旧名]] [[旧名|别名]] [[旧名字]]",
    );
    fs::write(vault.join("lockbox/fragments/secret.md"), "[[旧名]]").unwrap();

    let (fragment, updated, _) =
        rename_library_entry_in_vault(&LocalVault::new(vault).cx(), "notes/旧名.md", "新名")
            .unwrap();

    assert!(fragment.is_none());
    assert_eq!(updated, 2);
    assert!(vault.join("notes/新名.md").is_file());
    let source = fs::read_to_string(vault.join("fragments/2026/08/source.md")).unwrap();
    assert!(
        source.contains("[[新名]] [[新名|别名]] [[旧名字]]"),
        "{source}"
    );
    assert_eq!(
        fs::read_to_string(vault.join("lockbox/fragments/secret.md")).unwrap(),
        "[[旧名]]"
    );
}
