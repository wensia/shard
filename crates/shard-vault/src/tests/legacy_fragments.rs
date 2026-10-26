//! 迁自 src-tauri/src/lib.rs 的领域测试：碎片读写、属性、关系、碎片⇄笔记转换。
//! 本地目录 + NoHooks（与未初始化 Git 的本地资料库等价），准备数据照旧直接写文件。

use super::*;

#[test]
fn expected_file_sha_guard_detects_stale_base() {
    let file = "---\nid: one\n---\n\n第一版正文\n";
    let sha = content_sha256_hex(file);

    assert!(ensure_expected_file_sha(file, None).is_ok());
    assert!(ensure_expected_file_sha(file, Some(&sha)).is_ok());

    let error = ensure_expected_file_sha(
        "---\nid: one\nauthor: 外部修改\n---\n\n第一版正文\n",
        Some(&sha),
    )
    .unwrap_err();
    assert!(error.starts_with("STALE_BASE:"), "实际：{error}");
}

#[test]
fn custom_property_dto_is_ordered_json_safe_and_tolerates_large_integer() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let id = write_public_test_fragment(vault, "属性正文");
    let path = find_fragment_path(&FsVfs::new(vault), &id).unwrap().unwrap();
    let parsed = parse_fragment(&fs::read_to_string(&path).unwrap()).unwrap();
    let raw = format!(
        "{}\n文本: '00123'\n数字: 1.50\n勾选: true\n空值: null\n列表: [甲, 2, false]\n嵌套:\n  child: value\n标签值: !custom value\n超大整数: 184467440737095516160",
        parsed.raw
    );
    fs::write(&path, format!("---\n{raw}\n---{}", parsed.body)).unwrap();

    let fragment = read_fragment(
        &LocalVault::new(vault).cx(),
        &path,
        &dirty_paths(vault),
        None,
    )
    .unwrap();
    assert_eq!(fragment.properties.iter().map(|item| item.key.as_str()).collect::<Vec<_>>(),
        vec!["文本", "数字", "勾选", "空值", "列表", "嵌套", "标签值", "超大整数"]);
    assert_eq!(fragment.properties[0].value, PropertyValue::Text { text: "00123".into() });
    assert_eq!(fragment.properties[1].value, PropertyValue::Number { text: "1.5".into() });
    assert_eq!(fragment.properties[2].value, PropertyValue::Bool { value: true });
    assert_eq!(fragment.properties[3].value, PropertyValue::Null);
    assert_eq!(fragment.properties[4].value, PropertyValue::List {
        items: vec!["甲".into(), "2".into(), "false".into()],
    });
    assert!(fragment.properties[5..].iter().all(|item|
        matches!(item.value, PropertyValue::Other { .. }) && !item.editable));
}

#[test]
fn property_input_and_registry_contracts_are_validated() {
    assert!(matches!(
        property_input_to_yaml(PropertyInputValue::Number(Some("1.50".into()))).unwrap(),
        serde_yaml::Value::Number(_)
    ));
    assert!(matches!(
        property_input_to_yaml(PropertyInputValue::Number(Some(".5".into()))).unwrap(),
        serde_yaml::Value::Number(_)
    ));
    assert!(property_input_to_yaml(PropertyInputValue::Number(Some("1e3".into()))).is_err());
    assert!(property_input_to_yaml(PropertyInputValue::Number(Some("9223372036854775808".into()))).is_err());
    assert!(property_input_to_yaml(PropertyInputValue::Date(Some("2026-02-29".into()))).is_err());
    assert!(property_input_to_yaml(PropertyInputValue::Datetime(Some("2026-09-28T25:00".into()))).is_err());
    for input in ["目标", "[[目标]]"] {
        assert_eq!(
            property_input_to_yaml(PropertyInputValue::Link(Some(input.into()))).unwrap(),
            serde_yaml::Value::String("[[目标]]".into())
        );
    }
    assert_eq!(property_input_to_yaml(PropertyInputValue::Text(None)).unwrap(), serde_yaml::Value::Null);

    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let empty = read_property_registry_in_vault(&LocalVault::new(vault).cx()).unwrap();
    assert_eq!(empty.sha, content_sha256_hex(""));
    let written = register_property_type_in_vault(
        &LocalVault::new(vault).cx(),
        "截止日期",
        PropertyType::Date,
        &empty.sha,
    )
    .unwrap();
    assert_eq!(written.registry.properties["截止日期"].property_type, PropertyType::Date);
    assert_eq!(read_property_registry_in_vault(&LocalVault::new(vault).cx()).unwrap(), written);
    assert!(register_property_type_in_vault(
        &LocalVault::new(vault).cx(),
        "截止日期",
        PropertyType::Datetime,
        &empty.sha
    )
    .is_err());
    let id = write_public_test_fragment(vault, "登记表损坏不影响读取");
    fs::write(property_registry_path(vault), "{bad json").unwrap();
    assert!(read_property_registry_in_vault(&LocalVault::new(vault).cx()).is_err());
    let path = find_fragment_path(&FsVfs::new(vault), &id).unwrap().unwrap();
    assert!(read_fragment(
        &LocalVault::new(vault).cx(),
        &path,
        &dirty_paths(vault),
        None
    )
    .is_ok());
}

#[test]
fn public_fragment_updates_use_the_complete_file_as_the_save_baseline() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let id = write_public_test_fragment(vault, "第一版正文");
    let path = find_fragment_path(&FsVfs::new(vault), &id).unwrap().unwrap();
    let original = fs::read_to_string(&path).unwrap();
    let stale_sha = content_sha256_hex(&original);
    let externally_edited = original.replacen("source: test", "source: test\nauthor: 外部修改", 1);
    fs::write(&path, &externally_edited).unwrap();
    let before_failed_save = fs::read(&path).unwrap();

    let error = update_public_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        &path,
        "第二版正文",
        vec!["inbox".into()],
        Some(&stale_sha),
    )
    .unwrap_err();
    assert_eq!(error, STALE_BASE_ERROR);
    assert_eq!(fs::read(&path).unwrap(), before_failed_save);

    let fresh_sha = content_sha256_hex(&fs::read_to_string(&path).unwrap());
    let updated = update_public_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        &path,
        "第二版正文",
        vec!["inbox".into()],
        Some(&fresh_sha),
    )
    .unwrap();
    assert_eq!(updated.content, "第二版正文\n");
    assert!(fs::read_to_string(&path).unwrap().contains("author: 外部修改"));

    let updated = update_public_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        &path,
        "无基线保存",
        vec!["inbox".into()],
        None,
    )
    .unwrap();
    assert_eq!(updated.content, "无基线保存\n");
}

#[test]
fn fragment_updates_enforce_protected_type_rules() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();

    let ordinary = vault.join("fragments/tests/ordinary.md");
    fs::create_dir_all(ordinary.parent().unwrap()).unwrap();
    write_t6_fragment(&ordinary, "ordinary", vec!["inbox"], "普通正文");
    let updated = update_public_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        &ordinary,
        "正文带 #outline",
        vec!["inbox".into(), "outline".into()],
        None,
    )
    .unwrap();
    assert_eq!(derive_type(&updated.tags), None);

    let outline = vault.join("fragments/tests/outline.md");
    write_t6_fragment(&outline, "outline", vec!["inbox", "outline"], "- 根节点");
    let updated = update_public_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        &outline,
        "- 修改后的根节点",
        vec!["inbox".into(), "document".into()],
        None,
    )
    .unwrap();
    assert_eq!(derive_type(&updated.tags), Some("outline"));
    assert!(!updated.tags.iter().any(|tag| tag == "document"));
}

#[test]
fn test_link_fragments_rejects_self() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let fragment_id = write_public_test_fragment(vault, "standalone note");

    assert!(
        link_fragments_in_vault(&LocalVault::new(vault).cx(), &fragment_id, &fragment_id, "manual", None).is_err()
    );
}

#[test]
fn test_link_fragments_rejects_bad_origin() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let source_id = write_public_test_fragment(vault, "source note");
    let target_id = write_public_test_fragment(vault, "target note");

    assert!(link_fragments_in_vault(
        &LocalVault::new(vault).cx(),
        &source_id,
        &target_id,
        "automatic",
        None
    )
    .is_err());
}

#[test]
fn test_legacy_fragment_roundtrip() {
    #[derive(Serialize)]
    struct LegacyFragmentFrontmatter {
        id: String,
        created_at: String,
        updated_at: String,
        tags: Vec<String>,
        category: Option<String>,
        ai_status: Option<String>,
        source: String,
    }

    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let path = vault.join("fragments").join("legacy.md");
    let legacy = LegacyFragmentFrontmatter {
        id: "legacy-fragment".to_string(),
        created_at: "2026-08-18T08:00:00+08:00".to_string(),
        updated_at: "2026-08-18T08:00:00+08:00".to_string(),
        tags: vec!["inbox".to_string()],
        category: None,
        ai_status: Some("none".to_string()),
        source: "test".to_string(),
    };
    let yaml = serde_yaml::to_string(&legacy).unwrap();
    let yaml = yaml.strip_prefix("---\n").unwrap_or(&yaml);
    let original = format!("---\n{}---\n\nlegacy body\n", yaml);
    fs::write(&path, original.as_bytes()).unwrap();

    let before = fs::read(&path).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(!text.contains("related:"));
    let (frontmatter, body) = parse_fragment_text(&text).unwrap();
    assert!(frontmatter.related.is_empty());
    write_fragment_file(
        &FsVfs::new(vault),
        &path,
        &frontmatter,
        body.trim_start_matches('\n'),
    )
    .unwrap();

    assert_eq!(fs::read(path).unwrap(), before);
}

fn fidelity_raw(id: &str, related_target: Option<&str>) -> String {
    let related = related_target
        .map(|target| {
            format!(
                "\nrelated:\n- targetId: {target}\n  origin: manual\n  createdAt: 2026-09-28T08:30:00+08:00"
            )
        })
        .unwrap_or_default();
    format!(
        concat!(
            "# 自定义顶部注释\n",
            "author: 张三\n",
            "id: {id}\n",
            "created_at: 2026-09-28T08:00:00+08:00\n",
            "rating: 5 # 自定义行尾注释\n",
            "updated_at: 2026-09-28T08:00:00+08:00\n",
            "tags: [inbox, 自定义]\n",
            "category: null\n",
            "custom_list:\n",
            "  - first\n",
            "  - second\n",
            "\n",
            "ai_status: none\n",
            "source: test # 系统键未变化时也保留\n",
            "isbn: '00123'\n",
            "description: |\n",
            "  第一行\n",
            "  第二行\n",
            "# 自定义尾部注释{related}"
        ),
        id = id,
        related = related
    )
}

fn write_fidelity_fragment(vault: &Path, id: &str, related_target: Option<&str>) -> PathBuf {
    let path = vault.join("fragments/tests").join(format!("{id}.md"));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        format!(
            "---\n{}\n---\n\n原正文\n",
            fidelity_raw(id, related_target)
        ),
    )
    .unwrap();
    path
}

fn assert_fidelity_markers(path: &Path) {
    let text = fs::read_to_string(path).unwrap();
    for marker in [
        "# 自定义顶部注释\nauthor: 张三\n",
        "rating: 5 # 自定义行尾注释",
        "custom_list:\n  - first\n  - second\n\n",
        "isbn: '00123'",
        "description: |\n  第一行\n  第二行\n# 自定义尾部注释",
    ] {
        assert!(text.contains(marker), "missing preserved marker: {marker}");
    }
}

#[test]
fn public_write_paths_preserve_unknown_frontmatter() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let target_id = write_public_test_fragment(vault, "关联目标");
    let id = "fidelity-public";
    let mut path = write_fidelity_fragment(vault, id, None);

    let updated = update_public_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        &path,
        "更新正文",
        vec!["alpha".to_string()],
        Some(&content_sha256_hex(&fs::read_to_string(&path).unwrap())),
    )
    .unwrap();
    assert_eq!(updated.content, "更新正文\n");
    assert_fidelity_markers(&path);

    let updated =
        update_public_fragment_tags_in_vault(&LocalVault::new(vault).cx(), &path, vec!["beta".to_string()])
            .unwrap();
    assert_eq!(updated.tags, vec!["beta"]);
    assert_fidelity_markers(&path);

    let linked =
        link_fragments_in_vault(&LocalVault::new(vault).cx(), id, &target_id, "manual", Some("保真".into()))
            .unwrap();
    assert_eq!(linked.related.len(), 1);
    assert_fidelity_markers(&path);

    let unlinked = unlink_fragments_in_vault(&LocalVault::new(vault).cx(), id, &target_id).unwrap();
    assert!(unlinked.related.is_empty());
    assert_fidelity_markers(&path);

    let pinned =
        set_public_fragment_pinned_in_vault(&LocalVault::new(vault).cx(), &path, true).unwrap();
    assert!(pinned.pinned);
    assert_fidelity_markers(&path);

    let (note, _) =
        convert_fragment_to_note_in_vault(&LocalVault::new(vault).cx(), id, None, Some("保真笔记"))
            .unwrap();
    path = vault.join(&note.path);
    assert!(note.tags.iter().any(|tag| tag == "note"));
    assert_fidelity_markers(&path);

    let (fragment, _) =
        convert_note_to_fragment_in_vault(&LocalVault::new(vault).cx(), id).unwrap();
    path = vault.join(&fragment.path);
    assert!(!fragment.tags.iter().any(|tag| tag == "note"));
    assert_fidelity_markers(&path);
}

#[test]
fn failed_frontmatter_update_leaves_file_unchanged() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let path = vault.join("fragments/tests/unsafe.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let raw = raw_from_frontmatter(&FragmentFrontmatter {
        id: "unsafe".into(),
        created_at: "2026-09-28T08:00:00+08:00".into(),
        updated_at: "2026-09-28T08:00:00+08:00".into(),
        tags: vec!["inbox".into()],
        category: None,
        ai_status: Some("none".into()),
        pinned: false,
        source: "test".into(),
        conflict_of: None,
        related: Vec::new(),
    })
    .unwrap()
    .replacen("tags:\n- inbox", "tags: &shared\n- inbox\nmirror: *shared", 1);
    fs::write(&path, format!("---\n{raw}\n---\n\n原正文\n")).unwrap();
    let before = fs::read(&path).unwrap();

    let error = update_public_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        &path,
        "新正文",
        vec!["changed".into()],
        None,
    )
    .unwrap_err();
    assert!(error.contains("YAML 别名引用"));
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn converts_fragment_to_note_and_back_with_physical_filename_rules() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join("fragments/2026/08")).unwrap();
    let id = "20260830-120000-aabbcc-dd0011";
    write_t6_fragment(
        &vault.join(format!("fragments/2026/08/{id}.md")),
        id,
        vec!["inbox"],
        "# 中文/标题:示例\n\n正文",
    );

    let (note, upgraded_links) =
        convert_fragment_to_note_in_vault(&LocalVault::new(vault).cx(), id, None, None).unwrap();
    assert_eq!(upgraded_links, 0);
    assert_eq!(note.path, "notes/中文 标题 示例.md");
    assert!(note.tags.iter().any(|tag| tag == "note"));
    assert!(!vault.join(format!("fragments/2026/08/{id}.md")).exists());

    let (fragment, downgraded_links) =
        convert_note_to_fragment_in_vault(&LocalVault::new(vault).cx(), id).unwrap();
    assert_eq!(downgraded_links, 0);
    let now = Local::now();
    assert_eq!(
        fragment.path,
        format!(
            "fragments/{}/{}/{}.md",
            now.format("%Y"),
            now.format("%m"),
            id
        )
    );
    assert!(!fragment.tags.iter().any(|tag| tag == "note"));
}

#[test]
fn conversion_title_keeps_exact_body_identity_metadata_and_original_month() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let id = write_public_test_fragment(vault, "# 原标题\n\n正文  ");
    let source = find_fragment_path(&FsVfs::new(vault), &id).unwrap().unwrap();
    let original = fs::read_to_string(&source).unwrap();
    let (mut metadata, _) = parse_fragment_text(&original).unwrap();
    metadata.created_at = "2024-02-03T10:11:12+08:00".to_string();
    metadata.tags = vec!["想法".into(), "inbox".into()];
    metadata.pinned = true;
    metadata.related = vec![FragmentRelation {
        target_id: "source-id".into(),
        origin: "manual".into(),
        created_at: "2024-02-03T11:12:13+08:00".into(),
        note: None,
    }];
    let exact_body = "\n\n# 原标题\n\n正文  \n\n";
    let yaml = serde_yaml::to_string(&metadata).unwrap();
    fs::write(&source, format!("---\n{yaml}---{exact_body}")).unwrap();
    fs::write(vault.join("notes/自定标题.md"), "existing").unwrap();

    let (note, _) =
        convert_fragment_to_note_in_vault(&LocalVault::new(vault).cx(), &id, None, Some("自定标题"))
            .unwrap();
    assert_eq!(note.path, "notes/自定标题-2.md");
    assert_eq!(note.id, id);
    assert_eq!(note.created_at, metadata.created_at);
    assert_eq!(note.related, metadata.related);
    assert!(note.pinned);
    assert!(metadata.tags.iter().all(|tag| note.tags.contains(tag)));
    let text = fs::read_to_string(vault.join(&note.path)).unwrap();
    assert_eq!(parse_fragment_text(&text).unwrap().1, exact_body);
    assert_eq!(
        fs::read_to_string(vault.join("notes/自定标题.md")).unwrap(),
        "existing"
    );
    let (fragment, _) =
        convert_note_to_fragment_in_vault(&LocalVault::new(vault).cx(), &id).unwrap();
    assert_eq!(fragment.path, format!("fragments/2024/02/{id}.md"));
    assert_eq!(fragment.created_at, metadata.created_at);
    assert_eq!(fragment.related, metadata.related);
    let text = fs::read_to_string(vault.join(&fragment.path)).unwrap();
    assert_eq!(parse_fragment_text(&text).unwrap().1, exact_body);
}

#[test]
fn conversion_plans_reference_reads_before_moving_content() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let id = write_public_test_fragment(vault, "# 标题\n\n正文");
    let source = find_fragment_path(&FsVfs::new(vault), &id).unwrap().unwrap();
    let original = fs::read(&source).unwrap();
    fs::write(vault.join("notes/damaged.md"), [0xff, 0xfe]).unwrap();
    assert!(convert_fragment_to_note_in_vault(
        &LocalVault::new(vault).cx(),
        &id,
        None,
        Some("目标")
    )
    .is_err());
    assert_eq!(fs::read(&source).unwrap(), original);
    assert!(!vault.join("notes/目标.md").exists());
}

#[test]
fn conversion_rolls_back_content_and_written_references_on_mid_write_failure() {
    use std::cell::Cell;
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let id = write_public_test_fragment(vault, "# 标题\n\n正文");
    let source = find_fragment_path(&FsVfs::new(vault), &id).unwrap().unwrap();
    let original = fs::read_to_string(&source).unwrap();
    let (metadata, body) = parse_fragment_text(&original).unwrap();
    let reference = format!("[[{id}]]");
    for name in ["first", "second"] {
        fs::write(vault.join(format!("notes/{name}.md")), &reference).unwrap();
    }
    let writes = Cell::new(0);
    let failing_writer = |path: &Path, text: &str| {
        writes.set(writes.get() + 1);
        if writes.get() == 3 {
            return Err("injected reference write failure".into());
        }
        write_text_atomically(path, text)
    };
    let destination = vault.join("notes/目标.md");
    let error = convert_public_fragment_file_with_writer(
        &LocalVault::new(vault).cx(),
        &source,
        &destination,
        &metadata,
        body,
        &[(&id, "目标")],
        "test conversion",
        &failing_writer,
    )
    .unwrap_err();
    assert!(error.contains("injected reference write failure"));
    assert_eq!(fs::read_to_string(&source).unwrap(), original);
    assert!(!destination.exists());
    for name in ["first", "second"] {
        assert_eq!(
            fs::read_to_string(vault.join(format!("notes/{name}.md"))).unwrap(),
            reference
        );
    }
}

#[test]
fn converting_between_fragment_and_note_updates_wikilink_targets() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join("fragments/2026/08")).unwrap();
    let id = "20260830-130000-aabbcc-dd0011";
    write_t6_fragment(
        &vault.join(format!("fragments/2026/08/{id}.md")),
        id,
        vec!["inbox"],
        "# 升级标题\n\n正文",
    );
    write_t6_fragment(
        &vault.join("fragments/2026/08/ref.md"),
        "ref",
        vec!["inbox"],
        &format!("[[{id}]] [[{id}|旧别名]]"),
    );

    let (_, upgraded_links) =
        convert_fragment_to_note_in_vault(&LocalVault::new(vault).cx(), id, None, None).unwrap();
    assert_eq!(upgraded_links, 2);
    let upgraded_ref = fs::read_to_string(vault.join("fragments/2026/08/ref.md")).unwrap();
    assert!(upgraded_ref.contains("[[升级标题]] [[升级标题|旧别名]]"));

    fs::write(
        vault.join("notes/title-ref.md"),
        "[[升级标题]] [[升级标题|标题别名]]",
    )
    .unwrap();
    let (_, downgraded_links) =
        convert_note_to_fragment_in_vault(&LocalVault::new(vault).cx(), id).unwrap();
    assert_eq!(downgraded_links, 4);
    let downgraded_ref = fs::read_to_string(vault.join("fragments/2026/08/ref.md")).unwrap();
    assert!(downgraded_ref.contains(&format!("[[{id}]] [[{id}|旧别名]]")));
    let title_ref = fs::read_to_string(vault.join("notes/title-ref.md")).unwrap();
    assert_eq!(title_ref, format!("[[{id}]] [[{id}|标题别名]]"));
}
