//! 迁自 src-tauri/src/lib.rs 的领域测试：思维导图与碎片里的大纲 / 流程图。
//! 本地目录 + NoHooks（与未初始化 Git 的本地资料库等价），准备数据照旧直接写文件。

use super::*;

#[test]
fn creates_and_lists_mind_map_with_public_fragment_link() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let fragment_id = write_public_test_fragment(vault, "linked public note");

    let created =
        create_mind_map_in_vault(&LocalVault::new(vault).cx(), "Launch Plan".to_string(), Some(fragment_id.clone()))
            .unwrap();

    assert_eq!(created.file.kind, SHARD_MAP_KIND);
    assert_eq!(created.file.schema_version, SHARD_MAP_SCHEMA_VERSION);
    assert_eq!(created.file.revision, 1);
    assert_eq!(created.path, "notes/Launch Plan.shardmap.json");
    assert!(!created.last_saved_hash.is_empty());

    let root = created.file.nodes.get(&created.file.root_id).unwrap();
    assert_eq!(root.links.len(), 1);
    let root_children = created
        .file
        .nodes
        .values()
        .filter(|node| node.parent_id.as_deref() == Some(created.file.root_id.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(root_children.len(), 1);
    assert_eq!(root_children[0].text, "");
    match &root.links[0] {
        ShardDocumentLink::Fragment { target_id, .. } => {
            assert_eq!(target_id, &fragment_id);
        }
        _ => panic!("expected fragment link"),
    }

    let summaries = list_mind_maps_in_vault(&LocalVault::new(vault).cx()).unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].id, created.file.id);
    assert_eq!(summaries[0].node_count, 2);

    let duplicate =
        create_mind_map_in_vault(
            &LocalVault::new(vault).cx(),
            "Launch Plan".to_string(),
            None,
        )
        .unwrap();
    assert_eq!(duplicate.path, "notes/Launch Plan-2.shardmap.json");
}

#[test]
fn rejects_invalid_mind_map_tree_shape() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let created =
        create_mind_map_in_vault(&LocalVault::new(vault).cx(), "Draft".to_string(), None).unwrap();
    let mut edited = created.file.clone();
    let child_id = edited
        .nodes
        .values()
        .find(|node| node.parent_id.as_deref() == Some(edited.root_id.as_str()))
        .unwrap()
        .id
        .clone();
    edited.nodes.get_mut(&edited.root_id).unwrap().parent_id = Some(child_id);

    let error = validate_mind_map_file(&FsVfs::new(vault), &edited).unwrap_err();
    assert!(error.contains("root 节点"));
}

#[test]
fn conflicting_mind_map_write_creates_conflict_copy() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let created =
        create_mind_map_in_vault(&LocalVault::new(vault).cx(), "Draft".to_string(), None).unwrap();
    let mut edited = created.file.clone();
    edited.title = "Edited Draft".to_string();

    let error = write_mind_map_in_vault(
        &LocalVault::new(vault).cx(),
        &created.file.id,
        edited,
        created.file.revision,
        "stale-hash",
    )
    .unwrap_err();

    assert!(error.contains("冲突副本"));
    let mut conflicts = Vec::new();
    collect_mind_map_files(
        &FsVfs::new(vault),
        &vault.join("maps").join(".conflicts"),
        &mut conflicts,
    )
    .unwrap();
    assert_eq!(conflicts.len(), 1);
}

fn outline_graph_fixture(node_count: usize) -> serde_json::Value {
    assert!(node_count > 0);
    let timestamp = "2026-09-28T08:00:00+08:00".to_string();
    let root_id = "root".to_string();
    let mut nodes = BTreeMap::new();
    nodes.insert(
        root_id.clone(),
        ShardMapNode {
            id: root_id.clone(),
            parent_id: None,
            sort_key: "m".to_string(),
            text: "中心主题".to_string(),
            note: None,
            collapsed: false,
            width: None,
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
            links: Vec::new(),
            style: None,
        },
    );
    for index in 1..node_count {
        let id = format!("node-{index}");
        nodes.insert(
            id.clone(),
            ShardMapNode {
                id,
                parent_id: Some(root_id.clone()),
                sort_key: format!("{index:04}"),
                text: format!("节点 {index}"),
                note: None,
                collapsed: false,
                width: None,
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
                links: Vec::new(),
                style: None,
            },
        );
    }
    serde_json::to_value(ShardMapFile {
        kind: SHARD_MAP_KIND.to_string(),
        schema_version: SHARD_MAP_SCHEMA_VERSION,
        id: "incoming-outline".to_string(),
        title: "测试大纲".to_string(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        saved_with_app_version: "test".to_string(),
        revision: 0,
        root_id,
        has_protected_links: false,
        nodes,
        viewport: None,
    })
    .unwrap()
}

fn unique_graph_operation_id() -> String {
    format!("test-{}", new_fragment_id(&Local::now()))
}

fn markdown_file_count(vault: &Path) -> usize {
    let mut files = Vec::new();
    collect_markdown_files(&FsVfs::new(vault), &vault.join("fragments"), &mut files).unwrap();
    files.len()
}

fn without_updated_at(raw: &str) -> String {
    raw.split('\n')
        .filter(|line| !line.starts_with("updated_at:"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn creates_and_reads_outline_graph_fragments() {
    let directory = tempfile::tempdir().unwrap();
    let vault = directory.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();

    let created = create_graph_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        "outline",
        &unique_graph_operation_id(),
        Some(outline_graph_fixture(3)),
        vec!["项目".into()],
    )
    .unwrap();
    assert!(created.fragment.path.starts_with("fragments/"));
    assert!(created.fragment.tags.iter().any(|tag| tag == "outline"));
    assert!(created.fragment.tags.iter().any(|tag| tag == "inbox"));
    assert_eq!(created.graph["id"], created.fragment.id);

    let path = vault.join(&created.fragment.path);
    let text = fs::read_to_string(path).unwrap();
    let parsed = parse_fragment(&text).unwrap();
    let region = find_region(&parsed.body, GraphRegionKind::Outline).unwrap();
    assert_eq!(parsed.body.matches("```shardmap").count(), 1);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&region.json_text).unwrap(),
        created.graph
    );

    let read =
        read_graph_fragment_in_vault(&LocalVault::new(vault).cx(), &created.fragment.id).unwrap();
    assert_eq!(read.fragment.id, created.fragment.id);
    assert_eq!(read.graph, created.graph);
}

#[test]
fn reads_core_canonical_outline_written_by_external_graph_writer() {
    let directory = tempfile::tempdir().unwrap();
    let vault = directory.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let id = "cli-compatible-outline";
    let mut graph = outline_graph_fixture(2);
    graph["id"] = serde_json::json!(id);
    let file = serde_json::from_value::<ShardMapFile>(graph.clone()).unwrap();
    let json_text = shard_core::graph_model::canonical_mind_map_text(&file).unwrap();
    let path = vault.join("fragments/tests/cli-compatible-outline.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    write_t6_fragment(
        &path,
        id,
        vec!["inbox", "outline"],
        &render_region(GraphRegionKind::Outline, &json_text),
    );

    let read = read_graph_fragment_in_vault(&LocalVault::new(vault).cx(), id).unwrap();

    assert_eq!(read.fragment.id, id);
    assert_eq!(read.graph, graph);
}

#[test]
fn creates_and_reads_empty_flowchart_graph_fragments() {
    let directory = tempfile::tempdir().unwrap();
    let vault = directory.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();

    let created = create_graph_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        "flowchart",
        &unique_graph_operation_id(),
        None,
        Vec::new(),
    )
    .unwrap();
    let file = serde_json::from_value::<canvas::CanvasFile>(created.graph.clone())
        .unwrap();
    canvas::validate_file(&FsVfs::new(vault), &file).unwrap();
    assert_eq!(file.kind, "shard.flow");
    assert_eq!(file.title, "未命名流程图");
    assert!(file.nodes.is_empty());
    assert!(file.edges.is_empty());

    let read =
        read_graph_fragment_in_vault(&LocalVault::new(vault).cx(), &created.fragment.id).unwrap();
    assert_eq!(read.graph, created.graph);
}

#[test]
fn imports_outline_graph_file_to_timeline_without_git() {
    let directory = tempfile::tempdir().unwrap();
    let vault = directory.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let mut graph = outline_graph_fixture(3);
    graph["id"] = serde_json::json!("map-20260405-123456-abcd");
    graph["createdAt"] = serde_json::json!("2024-05-06T23:30:00-07:00");
    graph["updatedAt"] = serde_json::json!("2026-09-28T08:00:00+08:00");
    let raw = serde_json::to_string_pretty(&graph).unwrap();
    let source = vault.join("notes/项目导图.shardmap.json");
    fs::write(&source, format!("{raw}\n")).unwrap();

    let imported =
        import_graph_file_to_timeline_in_vault(
            &LocalVault::new(vault).cx(),
            "notes/项目导图.shardmap.json",
        )
        .unwrap();

    assert_eq!(imported.id, "map-20260405-123456-abcd");
    assert_eq!(imported.created_at, "2024-05-06T23:30:00-07:00");
    assert_eq!(
        imported.path,
        "fragments/2024/05/map-20260405-123456-abcd.md"
    );
    assert_eq!(imported.tags, vec!["inbox", "outline"]);
    assert!(!source.exists());
    assert!(vault.join(".trash/notes/项目导图.shardmap.json").is_file());
    let text = fs::read_to_string(vault.join(&imported.path)).unwrap();
    let parsed = parse_fragment(&text).unwrap();
    let region = find_region(&parsed.body, GraphRegionKind::Outline).unwrap();
    assert_eq!(parsed.body.matches("```shardmap").count(), 1);
    assert_eq!(region.json_text, raw);
    let read = read_graph_fragment_in_vault(&LocalVault::new(vault).cx(), &imported.id).unwrap();
    assert_eq!(read.graph, graph);
}

#[test]
fn graph_file_import_rejects_conflicts_invalid_graphs_and_legacy_canvas_without_changes() {
    let conflict_directory = tempfile::tempdir().unwrap();
    let conflict_vault = conflict_directory.path();
    ensure_vault_layout(&FsVfs::new(conflict_vault)).unwrap();
    let mut conflict_graph = outline_graph_fixture(2);
    conflict_graph["id"] = serde_json::json!("duplicate-id");
    let conflict_source = conflict_vault.join("notes/冲突.shardmap.json");
    fs::write(
        &conflict_source,
        serde_json::to_string_pretty(&conflict_graph).unwrap(),
    )
    .unwrap();
    let existing = conflict_vault.join("notes/已有.md");
    write_t6_fragment(&existing, "duplicate-id", vec!["note"], "已有文档");
    let conflict_before = fs::read(&conflict_source).unwrap();
    let existing_before = fs::read(&existing).unwrap();
    let error =
        import_graph_file_to_timeline_in_vault(&LocalVault::new(conflict_vault).cx(), "notes/冲突.shardmap.json")
            .unwrap_err();
    assert!(error.contains("duplicate-id") || error.contains("大纲或流程图"));
    assert_eq!(fs::read(&conflict_source).unwrap(), conflict_before);
    assert_eq!(fs::read(&existing).unwrap(), existing_before);
    assert_eq!(markdown_file_count(conflict_vault), 0);
    assert!(!conflict_vault
        .join(".trash/notes/冲突.shardmap.json")
        .exists());

    for (name, suffix, value) in [
        (
            "无效",
            ".shardmap.json",
            serde_json::json!({
                "kind": "shard.map", "schemaVersion": 1, "id": "invalid-map",
                "title": "无效", "createdAt": "2026-09-28T08:00:00+08:00",
                "updatedAt": "2026-09-28T08:00:00+08:00", "savedWithAppVersion": "test",
                "revision": 0, "rootId": "missing", "hasProtectedLinks": false, "nodes": {}
            }),
        ),
        (
            "旧画布",
            ".shardflow.json",
            serde_json::json!({
                "kind": "shard.canvas", "schemaVersion": 1, "id": "legacy-canvas",
                "title": "旧画布", "createdAt": "2026-09-28T08:00:00+08:00",
                "updatedAt": "2026-09-28T08:00:00+08:00", "revision": 0,
                "nodes": [], "edges": []
            }),
        ),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path();
        ensure_vault_layout(&FsVfs::new(vault)).unwrap();
        let rel_path = format!("notes/{name}{suffix}");
        let bytes = serde_json::to_vec_pretty(&value).unwrap();
        fs::write(vault.join(&rel_path), &bytes).unwrap();
        assert!(
            import_graph_file_to_timeline_in_vault(&LocalVault::new(vault).cx(), &rel_path).is_err()
        );
        assert_eq!(fs::read(vault.join(&rel_path)).unwrap(), bytes);
        assert_eq!(markdown_file_count(vault), 0);
        assert!(!vault.join(".trash").exists());
    }
}

#[test]
fn graph_file_import_resumes_after_fragment_creation() {
    let directory = tempfile::tempdir().unwrap();
    let vault = directory.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let mut graph = outline_graph_fixture(2);
    graph["id"] = serde_json::json!("map-resume-1");
    let raw = serde_json::to_string_pretty(&graph).unwrap();
    fs::write(vault.join("notes/待恢复.shardmap.json"), &raw).unwrap();
    let fragment_path = vault.join("fragments/2026/09/map-resume-1.md");
    fs::create_dir_all(fragment_path.parent().unwrap()).unwrap();
    write_t6_fragment(
        &fragment_path,
        "map-resume-1",
        vec!["inbox", "outline"],
        &render_region(GraphRegionKind::Outline, &raw),
    );

    let imported =
        import_graph_file_to_timeline_in_vault(
            &LocalVault::new(vault).cx(),
            "notes/待恢复.shardmap.json",
        )
        .unwrap();

    assert_eq!(imported.id, "map-resume-1");
    assert_eq!(markdown_file_count(vault), 1);
    assert!(!vault.join("notes/待恢复.shardmap.json").exists());
    assert!(vault.join(".trash/notes/待恢复.shardmap.json").is_file());
}

#[test]
fn graph_fragment_creation_is_idempotent_by_operation_id() {
    let directory = tempfile::tempdir().unwrap();
    let vault = directory.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let operation_id = unique_graph_operation_id();
    let graph = outline_graph_fixture(2);

    let first = create_graph_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        "outline",
        &operation_id,
        Some(graph.clone()),
        Vec::new(),
    )
    .unwrap();
    let second = create_graph_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        "outline",
        &operation_id,
        Some(graph),
        vec!["ignored-on-retry".into()],
    )
    .unwrap();
    assert_eq!(first.fragment.id, second.fragment.id);
    assert_eq!(markdown_file_count(vault), 1);

    let error = create_graph_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        "flowchart",
        &operation_id,
        None,
        Vec::new(),
    )
    .unwrap_err();
    assert!(error.contains("不同的图形内容类型"));
    assert_eq!(markdown_file_count(vault), 1);
}

#[test]
fn graph_writes_preserve_frontmatter_and_body_outside_the_region() {
    let directory = tempfile::tempdir().unwrap();
    let vault = directory.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let created = create_graph_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        "outline",
        &unique_graph_operation_id(),
        Some(outline_graph_fixture(2)),
        Vec::new(),
    )
    .unwrap();
    let path = vault.join(&created.fragment.path);
    let original = fs::read_to_string(&path).unwrap();
    let parsed = parse_fragment(&original).unwrap();
    let region = find_region(&parsed.body, GraphRegionKind::Outline).unwrap();
    let graph_region = &parsed.body[region.range.clone()];
    let raw = format!("# 自定义注释\nauthor: 张三\n{}", parsed.raw);
    let body = format!("\n\n区域前  \r\n{graph_region}\r\n区域后\t\n");
    fs::write(&path, format!("---\n{raw}\n---{body}")).unwrap();
    let before = fs::read_to_string(&path).unwrap();
    let before_parsed = parse_fragment(&before).unwrap();
    let before_region = find_region(&before_parsed.body, GraphRegionKind::Outline).unwrap();
    let before_sha = content_sha256_hex(&before);
    let mut next_graph = created.graph;
    next_graph["title"] = serde_json::Value::String("修改后的大纲".into());

    let written = write_graph_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        &created.fragment.id,
        next_graph,
        Some(&before_sha),
    )
    .unwrap();
    let after = fs::read_to_string(&path).unwrap();
    let after_parsed = parse_fragment(&after).unwrap();
    let after_region = find_region(&after_parsed.body, GraphRegionKind::Outline).unwrap();

    assert_eq!(without_updated_at(&before_parsed.raw), without_updated_at(&after_parsed.raw));
    assert_eq!(
        &before_parsed.body[..before_region.range.start],
        &after_parsed.body[..after_region.range.start]
    );
    assert_eq!(
        &before_parsed.body[before_region.range.end..],
        &after_parsed.body[after_region.range.end..]
    );
    assert!(after.contains("# 自定义注释\nauthor: 张三"));
    assert_ne!(written.fragment.file_sha, before_sha);
    assert_eq!(written.graph["title"], "修改后的大纲");
}

#[test]
fn graph_writes_reject_stale_file_baselines_without_changes() {
    let directory = tempfile::tempdir().unwrap();
    let vault = directory.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let created = create_graph_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        "outline",
        &unique_graph_operation_id(),
        Some(outline_graph_fixture(2)),
        Vec::new(),
    )
    .unwrap();
    let path = vault.join(&created.fragment.path);
    let before = fs::read(&path).unwrap();

    let error = write_graph_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        &created.fragment.id,
        created.graph,
        Some(&"0".repeat(64)),
    )
    .unwrap_err();
    assert_eq!(error, STALE_BASE_ERROR);
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn oversized_outlines_are_rejected_before_create_or_write() {
    let directory = tempfile::tempdir().unwrap();
    let vault = directory.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();

    let error = create_graph_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        "outline",
        &unique_graph_operation_id(),
        Some(outline_graph_fixture(401)),
        Vec::new(),
    )
    .unwrap_err();
    assert!(error.contains("400"));
    assert_eq!(markdown_file_count(vault), 0);

    let created = create_graph_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        "outline",
        &unique_graph_operation_id(),
        Some(outline_graph_fixture(2)),
        Vec::new(),
    )
    .unwrap();
    let path = vault.join(&created.fragment.path);
    let before = fs::read(&path).unwrap();
    let mut oversized = outline_graph_fixture(401);
    oversized["id"] = serde_json::Value::String(created.fragment.id.clone());
    let error = write_graph_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        &created.fragment.id,
        oversized,
        Some(&created.fragment.file_sha),
    )
    .unwrap_err();
    assert!(error.contains("400"));
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn text_saves_reject_managed_regions_but_allow_legacy_outlines() {
    let directory = tempfile::tempdir().unwrap();
    let vault = directory.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    let created = create_graph_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        "outline",
        &unique_graph_operation_id(),
        Some(outline_graph_fixture(2)),
        Vec::new(),
    )
    .unwrap();
    let graph_path = vault.join(&created.fragment.path);
    let before = fs::read(&graph_path).unwrap();
    let error = update_public_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        &graph_path,
        "错误的文本覆盖",
        created.fragment.tags,
        None,
    )
    .unwrap_err();
    assert_eq!(error, "大纲与流程图请在专用编辑器中保存。");
    assert_eq!(fs::read(graph_path).unwrap(), before);

    for (id, body) in [
        (
            "multiple-regions",
            "```shardmap\n{}\n```\n```shardmap\n{}\n```",
        ),
        ("unclosed-region", "```shardmap\n{}"),
    ] {
        let path = vault.join(format!("fragments/tests/{id}.md"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        write_t6_fragment(&path, id, vec!["inbox", "outline"], body);
        let before = fs::read(&path).unwrap();
        let error = update_public_fragment_in_vault(
            &LocalVault::new(vault).cx(),
            &path,
            "错误的文本覆盖",
            vec!["inbox".into(), "outline".into()],
            None,
        )
        .unwrap_err();
        assert_eq!(error, "大纲与流程图请在专用编辑器中保存。");
        assert_eq!(fs::read(path).unwrap(), before);
    }

    let legacy_path = vault.join("fragments/tests/legacy-outline.md");
    fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
    write_t6_fragment(
        &legacy_path,
        "legacy-outline",
        vec!["inbox", "outline"],
        "- 根节点\n  - 子节点",
    );
    let updated = update_public_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        &legacy_path,
        "- 新根节点\n  - 新子节点",
        vec!["inbox".into()],
        None,
    )
    .unwrap();
    assert!(updated.content.contains("新根节点"));
    assert!(updated.tags.iter().any(|tag| tag == "outline"));

    let fragment_path = vault.join("fragments/tests/ordinary-fragment.md");
    write_t6_fragment(
        &fragment_path,
        "ordinary-fragment",
        vec!["inbox"],
        "```shardmap\n{\"pasted\":true}\n```",
    );
    let updated = update_public_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        &fragment_path,
        "普通碎片更新后的正文",
        vec!["inbox".into()],
        None,
    )
    .unwrap();
    assert_eq!(updated.content.trim_end(), "普通碎片更新后的正文");
    assert_eq!(derive_type(&updated.tags), None);
}

#[test]
fn graph_creation_rejects_lockbox_tags_without_files() {
    let directory = tempfile::tempdir().unwrap();
    let vault = directory.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();

    let error = create_graph_fragment_in_vault(
        &LocalVault::new(vault).cx(),
        "outline",
        &unique_graph_operation_id(),
        Some(outline_graph_fixture(2)),
        vec![LOCKBOX_TAG.into()],
    )
    .unwrap_err();
    assert_eq!(error, LOCKBOX_TYPE_ERROR);
    assert_eq!(markdown_file_count(vault), 0);
}
