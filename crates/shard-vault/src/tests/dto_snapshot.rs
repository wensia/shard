//! DTO 的 JSON 形状快照。
//!
//! `dto_snapshot.tsv` 是搬迁前（src-tauri/src/lib.rs 里的同名类型）用下面同一段构造代码导出的
//! 序列化结果与反序列化结果（Debug 文本）。搬迁后逐行比对，证明前端看到的 JSON 一个字节都没变。

use super::*;

fn snapshot_entries() -> Vec<(&'static str, String)> {
    use std::collections::BTreeMap;
    let relation = shard_core::FragmentRelation {
        target_id: "t1".into(),
        origin: "manual".into(),
        created_at: "2026-01-01T00:00:00+08:00".into(),
        note: Some("备注".into()),
    };
    let properties = vec![
        FragmentProperty { key: "a".into(), value: PropertyValue::Text { text: "文本".into() }, editable: true },
        FragmentProperty { key: "b".into(), value: PropertyValue::Number { text: "1.5".into() }, editable: true },
        FragmentProperty { key: "c".into(), value: PropertyValue::Bool { value: true }, editable: true },
        FragmentProperty { key: "d".into(), value: PropertyValue::Null, editable: false },
        FragmentProperty { key: "e".into(), value: PropertyValue::List { items: vec!["x".into()] }, editable: true },
        FragmentProperty { key: "f".into(), value: PropertyValue::Other { raw: "{a: 1}".into() }, editable: false },
    ];
    let fragment = |conflict: Option<String>| Fragment {
        id: "20260101-000000-aaaaaaaa-bbbbbb".into(),
        content: "正文".into(),
        file_sha: "sha".into(),
        created_at: "2026-01-01T00:00:00+08:00".into(),
        updated_at: "2026-01-02T00:00:00+08:00".into(),
        tags: vec!["inbox".into()],
        category: Some("分类".into()),
        path: "fragments/2026/01/x.md".into(),
        git_status: "saved".into(),
        error: Some("错误".into()),
        ai_status: "none".into(),
        archived: false,
        lockbox: true,
        pinned: true,
        related: vec![relation.clone()],
        properties: properties.clone(),
        conflict_of: conflict,
    };
    let leaf = LibraryTreeEntry {
        name: "a.md".into(),
        path: "notes/a.md".into(),
        kind: "markdown".into(),
        size: 12,
        modified_at: "2026-01-01T00:00:00+00:00".into(),
        created_at: None,
        mind_map_id: None,
        children: None,
    };
    let map_leaf = LibraryTreeEntry {
        name: "m.shardmap.json".into(),
        path: "notes/d/m.shardmap.json".into(),
        kind: "mindmap".into(),
        size: 34,
        modified_at: "2026-01-01T00:00:00+00:00".into(),
        created_at: Some("2025-12-31T00:00:00+00:00".into()),
        mind_map_id: Some("map-1".into()),
        children: None,
    };
    let dir = LibraryTreeEntry {
        name: "d".into(),
        path: "notes/d".into(),
        kind: "directory".into(),
        size: 0,
        modified_at: String::new(),
        created_at: None,
        mind_map_id: None,
        children: Some(vec![map_leaf.clone()]),
    };
    let stream = FragmentStreamSummary {
        total_count: 3,
        years: vec![FragmentYearSummary {
            year: "2026".into(),
            total_count: 3,
            months: vec![FragmentMonthSummary { month: "01".into(), count: 3 }],
        }],
    };
    let asset = LibraryAssetEntry {
        path: "assets/ab/x.png".into(),
        size: 9,
        modified_at: "2026-01-01T00:00:00+00:00".into(),
        mime_type: "image/png".into(),
    };
    let tree = LibraryTreeSnapshot {
        entries: vec![dir.clone(), leaf.clone()],
        fragment_entries: vec![leaf.clone()],
        trash_entries: vec![],
        fragment_trash_entries: vec![leaf.clone()],
        fragment_stream: stream.clone(),
        assets: vec![asset.clone()],
    };
    let mut registry = PropertyRegistry::default();
    for (key, property_type) in [
        ("t", PropertyType::Text), ("n", PropertyType::Number), ("d", PropertyType::Date),
        ("dt", PropertyType::Datetime), ("c", PropertyType::Checkbox), ("l", PropertyType::List),
        ("k", PropertyType::Link),
    ] {
        registry.properties.insert(key.to_string(), PropertyRegistryEntry { property_type });
    }
    let map_file: ShardMapFile = serde_json::from_value(serde_json::json!({
        "kind": "shard.map", "schemaVersion": 1, "id": "map-1", "title": "导图",
        "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
        "savedWithAppVersion": "0.1.3", "revision": 2, "rootId": "r", "hasProtectedLinks": false,
        "nodes": {"r": {"id": "r", "parentId": null, "sortKey": "m", "text": "根", "collapsed": false,
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z", "links": []}}
    })).unwrap();
    let dataset: shard_core::dataset::DatasetSnapshot = serde_json::from_value(serde_json::json!({
        "path": "datasets/a.csv", "table": {"header": ["id"], "rows": [["1"]]}, "sha": "s",
        "schema": null, "schemaSha": null, "editable": true, "readOnlyReason": null
    })).unwrap();
    let git = GitInfo {
        branch: "main".into(),
        short_commit: "abc".into(),
        has_remote: true,
        status: "clean".into(),
        error: Some("e".into()),
        ahead: 1,
        behind: 2,
    };
    let _ = BTreeMap::<String, String>::new();
    let mutation = |fragment: Option<Fragment>| LibraryMutationResult {
        tree: tree.clone(),
        fragment,
        updated_links: 2,
        updated_image_refs: 3,
    };
    let checkpoint = CheckpointResult {
        status: "committed".into(),
        changes: 4,
        reason: Some("r".into()),
        skipped_large: vec!["big.bin".into()],
        git: GitInfo {
            branch: "main".into(),
            short_commit: "abc".into(),
            has_remote: false,
            status: "no_git".into(),
            error: None,
            ahead: 0,
            behind: 0,
        },
    };
    vec![
        ("fragment", serde_json::to_string(&fragment(None)).unwrap()),
        ("fragment_conflict", serde_json::to_string(&fragment(Some("orig".into()))).unwrap()),
        ("tree", serde_json::to_string(&tree).unwrap()),
        ("registry", serde_json::to_string(&PropertyRegistryReadResult { registry, sha: "s".into() }).unwrap()),
        ("graph", serde_json::to_string(&GraphFragmentResult { fragment: fragment(None), graph: serde_json::json!({"a": 1.25}) }).unwrap()),
        ("csv", serde_json::to_string(&CsvFileSummary { name: "a.csv".into(), path: "notes/a.csv".into() }).unwrap()),
        ("mutation_none", serde_json::to_string(&mutation(None)).unwrap()),
        ("mutation_some", serde_json::to_string(&mutation(Some(fragment(None)))).unwrap()),
        ("map_summary", serde_json::to_string(&MindMapSummary { id: "map-1".into(), title: "导图".into(), created_at: "c".into(), updated_at: "u".into(), node_count: 1, path: "notes/m.shardmap.json".into() }).unwrap()),
        ("map_read", serde_json::to_string(&MindMapReadResult { file: map_file, path: "notes/m.shardmap.json".into(), last_saved_hash: "h".into() }).unwrap()),
        ("git", serde_json::to_string(&git).unwrap()),
        ("checkpoint", serde_json::to_string(&checkpoint).unwrap()),
        ("import", serde_json::to_string(&LibraryImportResult { tree: tree.clone(), imported: vec!["notes/a.png".into()], skipped: vec![LibraryImportSkip { path: "/x".into(), reason: "r".into() }] }).unwrap()),
        ("dataset", serde_json::to_string(&LibraryDatasetResult { dataset, library: mutation(None) }).unwrap()),
        ("input_text", format!("{:?}", serde_json::from_str::<PropertyInputValue>(r#"{"type":"text","value":"a"}"#).unwrap())),
        ("input_null", format!("{:?}", serde_json::from_str::<PropertyInputValue>(r#"{"type":"checkbox","value":null}"#).unwrap())),
        ("input_list", format!("{:?}", serde_json::from_str::<PropertyInputValue>(r#"{"type":"list","value":["a","b"]}"#).unwrap())),
        ("input_datetime", format!("{:?}", serde_json::from_str::<PropertyInputValue>(r#"{"type":"datetime","value":"2026-01-01T10:00"}"#).unwrap())),
        ("input_link", format!("{:?}", serde_json::from_str::<PropertyInputValue>(r#"{"type":"link","value":"x"}"#).unwrap())),
        ("scope", format!("{:?}", ["\"library\"", "\"fragments\"", "\"all\""].iter().map(|s| serde_json::from_str::<ContentScope>(s).unwrap()).collect::<Vec<_>>())),
        ("property_type", format!("{:?}", serde_json::from_str::<PropertyType>("\"datetime\"").unwrap())),
    ]
}


#[test]
fn dto_json_shapes_match_the_pre_move_snapshot() {
    let expected = include_str!("dto_snapshot.tsv");
    let actual: String = snapshot_entries()
        .into_iter()
        .map(|(name, json)| format!("{name}\t{json}\n"))
        .collect();
    for (left, right) in expected.lines().zip(actual.lines()) {
        assert_eq!(left, right);
    }
    assert_eq!(expected, actual);
}

/// 画布 DTO 搬迁前就是 `pub` 字段，搬迁没碰 serde 属性；这里钉住它们的 JSON 键名。
#[test]
fn canvas_dto_json_shapes_are_camel_case() {
    let file: CanvasFile = serde_json::from_value(serde_json::json!({
        "kind": "shard.flow", "schemaVersion": 1, "id": "f", "title": "流程",
        "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z", "revision": 1,
        "nodes": [], "edges": []
    }))
    .unwrap();
    let read = canvas::CanvasReadResult { file, path: "notes/a.shardflow.json".into(), last_saved_hash: "h".into() };
    let value = serde_json::to_value(&read).unwrap();
    assert_eq!(value["path"], "notes/a.shardflow.json");
    assert_eq!(value["lastSavedHash"], "h");
    assert_eq!(value["file"]["schemaVersion"], 1);
    let document = canvas::split::DiagramDocument {
        id: "m".into(),
        title: "导图".into(),
        path: "notes/m.shardmap.json".into(),
        kind: "mindmap".into(),
        node_count: 2,
    };
    let split = canvas::split::SplitResult { documents: vec![document], index_path: "notes/i.md".into() };
    assert_eq!(
        serde_json::to_string(&split).unwrap(),
        r#"{"documents":[{"id":"m","title":"导图","path":"notes/m.shardmap.json","kind":"mindmap","nodeCount":2}],"indexPath":"notes/i.md"}"#
    );
}
