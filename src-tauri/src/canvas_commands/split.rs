//! Explicit, resumable copying of legacy mixed canvases. The source is never rewritten.
//! 领域逻辑在 `shard_vault::canvas::split`；这里只剩 Tauri 命令与依赖本地 Git 的测试。
use super::*;
pub(crate) use shard_vault::canvas::split::*;

#[tauri::command]
pub(crate) async fn list_diagram_documents(
    app: tauri::AppHandle,
) -> CanvasResult<Vec<DiagramDocument>> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = crate::configured_vault_path(&app)?;
        let local = LocalVault::new(&vault);
        list_in_vault(&local.cx())
    })
    .await
    .map_err(io)?
}

#[tauri::command]
pub(crate) async fn split_canvas(
    app: tauri::AppHandle,
    path: String,
    expected_revision: u64,
    last_saved_hash: String,
) -> CanvasResult<SplitResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = crate::ensure_vault_dirs(&app)?;
        let _gate = crate::lock_vault_gate(&vault);
        let local = LocalVault::new(&vault);
        split_in_vault(&local.cx(), &path, expected_revision, &last_saved_hash)
    })
    .await
    .map_err(io)?
}

#[cfg(test)]
mod tests {
    use super::super::tests::{fixture, vault};
    use super::*;
    use shard_core::FsVfs;
    use std::collections::HashSet;
    use std::fs;
    use std::path::PathBuf;

    fn mixed(vault: &Path) -> CanvasReadResult {
        let mut map =
            crate::create_mind_map_in_vault(&LocalVault::new(vault).cx(), "项目导图".into(), None)
                .unwrap()
                .file;
        let root = map.nodes.get_mut(&map.root_id).unwrap();
        root.note = Some("保留完整备注\n第二行".into());
        root.width = Some(242.5);
        root.style = Some(crate::ShardMapNodeStyle {
            tone: Some("accent".into()),
        });
        root.links.push(ShardDocumentLink::MarkdownPath {
            id: "missing-note".into(),
            path: "notes/已移除.md".into(),
        });
        root.links.push(ShardDocumentLink::Map {
            id: "self-map".into(),
            target_id: map.id.clone(),
        });
        let mut source = fixture();
        source.kind = "shard.canvas".into();
        source.revision = 7;
        for index in 0..2 {
            source.nodes.push(CanvasNode {
                id: format!("embedded-{index}"),
                kind: "mindmap".into(),
                x: 40.5 + index as f64 * 400.0,
                y: 180.25,
                text: format!("导图对象 {index}"),
                width: Some(550.5),
                height: Some(400.0),
                link: None,
                mind_map: Some(map.clone()),
            });
        }
        source.edges.push(CanvasEdge {
            id: "map-flow-edge".into(),
            source: "embedded-0".into(),
            target: "first".into(),
            label: "需求 → 实施\n包含 [括号] 与 ```".into(),
            source_handle: Some("right".into()),
            target_handle: Some("top".into()),
        });
        source.edges.push(CanvasEdge {
            id: "map-map-edge".into(),
            source: "embedded-0".into(),
            target: "embedded-1".into(),
            label: "两个导图关联".into(),
            source_handle: None,
            target_handle: None,
        });
        let path = "notes/旧混合画布.shardcanvas.json";
        fs::write(vault.join(path), canonical(&source).unwrap()).unwrap();
        read_in_vault(&LocalVault::new(vault).cx(), path).unwrap()
    }

    fn receipt_path(vault: &Path, source: &CanvasReadResult) -> PathBuf {
        internal_path(
            &FsVfs::new(vault),
            "split",
            &format!("{}.json", crate::hash_text(&source.file.id)),
        )
        .unwrap()
    }

    #[test]
    fn library_filename_split_reservations_fit_unicode_and_collision_limits() {
        let temp = tempfile::tempdir().unwrap();
        let mut reserved = HashSet::new();
        for title in ["字".repeat(80), "😀".repeat(80)] {
            for suffix in [".md", ".shardmap.json", ".shardflow.json"] {
                for index in 1..=11 {
                    let path = reserve_path(
                        &FsVfs::new(temp.path()),
                        temp.path(),
                        &title,
                        suffix,
                        &mut reserved,
                    )
                    .unwrap();
                    let name = path.file_name().unwrap().to_str().unwrap();
                    let stem = name.strip_suffix(suffix).unwrap();
                    assert!(name.len() <= 255, "{name}");
                    assert!(stem.chars().count() <= 64, "{name}");
                    if index > 1 {
                        assert!(stem.ends_with(&format!("-{index}")), "{name}");
                    }
                    atomic_write(&FsVfs::new(temp.path()), &path, b"fixture", false).unwrap();
                }
            }
        }
    }

    #[test]
    fn split_mixed_preserves_source_nodes_links_and_cross_document_edges() {
        let temp = vault();
        let vault = temp.path();
        let source = mixed(vault);
        let original = read_bytes(&FsVfs::new(vault), &vault.join(&source.path)).unwrap();
        let result = split_in_vault(
            &LocalVault::new(vault).cx(),
            &source.path,
            7,
            &source.last_saved_hash,
        )
        .unwrap();
        assert_eq!(result.documents.len(), 3);
        assert_eq!(
            read_bytes(&FsVfs::new(vault), &vault.join(&source.path)).unwrap(),
            original
        );
        assert_eq!(
            crate::run_git(vault, &["rev-list", "--all", "--count"])
                .unwrap()
                .trim(),
            "0"
        );
        let old_map = source.file.nodes[2].mind_map.as_ref().unwrap();
        let maps: Vec<_> = result
            .documents
            .iter()
            .filter(|summary| summary.kind == "mindmap")
            .collect();
        assert_eq!(maps.len(), 2);
        assert_ne!(maps[0].id, maps[1].id);
        for summary in &maps {
            assert_ne!(
                summary.id, old_map.id,
                "an imported copy must get its own document identity"
            );
            let read =
                crate::read_mind_map_in_vault(&LocalVault::new(vault).cx(), &summary.id).unwrap();
            assert_eq!(
                serde_json::to_value(&read.file.nodes).unwrap(),
                serde_json::to_value(&old_map.nodes).unwrap()
            );
            assert_eq!(read.file.root_id, old_map.root_id);
            assert_eq!(read.file.revision, 1);
            assert!(
                summary.path.starts_with("notes/项目导图-"),
                "existing original document is not overwritten"
            );
        }
        let flow = result
            .documents
            .iter()
            .find(|summary| summary.kind == "flowchart")
            .unwrap();
        let read = read_in_vault(&LocalVault::new(vault).cx(), &flow.path).unwrap();
        assert_eq!(read.file.kind, "shard.flow");
        assert_eq!(read.file.nodes.len(), 2);
        assert_eq!(read.file.edges.len(), 2);
        assert_eq!(
            serde_json::to_value(&read.file.edges).unwrap(),
            serde_json::to_value(&source.file.edges[..2]).unwrap()
        );
        let index = fs::read_to_string(vault.join(&result.index_path)).unwrap();
        let (metadata, body) = crate::parse_fragment_text(&index).unwrap();
        assert_eq!(metadata.tags, vec!["note"]);
        assert!(body.trim_start().starts_with("# 中文画布 · 关联说明"));
        let runtime = crate::LockboxRuntime::default();
        let state = crate::list_fragments_in_vault(&LocalVault::new(vault).cx(), &runtime).unwrap();
        let note = state
            .fragments
            .iter()
            .find(|fragment| fragment.path == result.index_path)
            .expect("关联说明必须由实际 list_fragments 扫描，并可按 path 打开");
        assert_eq!(note.id, metadata.id);
        assert!(note.content.contains("shard://map/"));
        assert!(note.tags.iter().any(|tag| tag == "note"));
        let read = crate::read_fragment(
            &LocalVault::new(vault).cx(),
            &vault.join(&result.index_path),
            &crate::dirty_paths(vault),
            None,
        )
        .unwrap();
        assert_eq!(read.id, note.id);
        assert!(
            crate::collect_library_entries(&FsVfs::new(vault), &vault.join("notes"))
                .unwrap()
                .iter()
                .any(|entry| entry.path == result.index_path && entry.kind == "markdown")
        );
        for summary in &result.documents {
            assert!(index.contains(&format!(
                "shard://{}/{}",
                if summary.kind == "mindmap" {
                    "map"
                } else {
                    "flow"
                },
                summary.id
            )));
        }
        for expected in [
            "map-flow-edge",
            "map-map-edge",
            "embedded-0",
            "embedded-1",
            "导图对象 0",
            "准备",
            "需求 → 实施",
            "两个导图关联",
            "sourceHandle",
            "right",
        ] {
            assert!(
                index.contains(expected),
                "lost association data: {expected}"
            );
        }
        let retry = split_in_vault(
            &LocalVault::new(vault).cx(),
            &source.path,
            7,
            &source.last_saved_hash,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&retry).unwrap(),
            serde_json::to_value(&result).unwrap()
        );
        crate::rename_library_entry_in_vault(
            &LocalVault::new(vault).cx(),
            &result.index_path,
            "项目关联文档",
        )
        .unwrap();
        let moved = split_in_vault(
            &LocalVault::new(vault).cx(),
            &source.path,
            7,
            &source.last_saved_hash,
        )
        .unwrap();
        assert_eq!(moved.index_path, "notes/项目关联文档.md");
        assert!(
            !vault.join(&result.index_path).exists(),
            "rename-aware retries must not duplicate the index note"
        );
        let unrelated = crate::create_library_note_in_vault(
            &LocalVault::new(vault).cx(),
            "中文画布 · 关联说明",
            Some("notes"),
        )
        .unwrap();
        assert_eq!(unrelated.path, result.index_path);
        assert_ne!(unrelated.id, metadata.id);
        let retry = split_in_vault(
            &LocalVault::new(vault).cx(),
            &source.path,
            7,
            &source.last_saved_hash,
        )
        .unwrap();
        assert_eq!(
            retry.index_path, moved.index_path,
            "an unrelated note reusing the old path must not be opened as the index"
        );
        crate::move_to_trash_in_vault(&LocalVault::new(vault).cx(), &moved.index_path).unwrap();
        assert!(split_in_vault(
            &LocalVault::new(vault).cx(),
            &source.path,
            7,
            &source.last_saved_hash
        )
        .unwrap_err()
        .contains("关联说明已移除"));
        assert!(!vault.join(&moved.index_path).exists());
        let retained = crate::read_fragment(
            &LocalVault::new(vault).cx(),
            &vault.join(&unrelated.path),
            &crate::dirty_paths(vault),
            None,
        )
        .unwrap();
        assert_eq!(
            retained.id, unrelated.id,
            "retry must leave the unrelated note untouched"
        );
        assert_eq!(
            list_in_vault(&LocalVault::new(vault).cx()).unwrap().len(),
            4,
            "retry did not duplicate the three outputs"
        );
    }

    #[test]
    fn split_retry_resumes_partial_publication_and_preserves_edited_or_moved_outputs() {
        let temp = vault();
        let vault = temp.path();
        let source = mixed(vault);
        let receipt = plan_split(&FsVfs::new(vault), &source).unwrap();
        let receipt_path = receipt_path(vault, &source);
        atomic_write(
            &FsVfs::new(vault),
            &receipt_path,
            &canonical(&receipt).unwrap(),
            false,
        )
        .unwrap();
        // Simulate success of the first atomic publication followed by a lost receipt update.
        let first = &receipt.outputs[0];
        atomic_write(
            &FsVfs::new(vault),
            &vault.join(&first.path),
            &output_bytes(&source.file, &receipt, first).unwrap(),
            false,
        )
        .unwrap();
        // The second target is independently occupied after planning: never overwrite it.
        let obstruction = &receipt.outputs[1].path;
        fs::write(vault.join(obstruction), b"do not overwrite this file").unwrap();
        assert!(split_in_vault(
            &LocalVault::new(vault).cx(),
            &source.path,
            7,
            &source.last_saved_hash
        )
        .is_err());
        assert_eq!(
            fs::read(vault.join(obstruction)).unwrap(),
            b"do not overwrite this file"
        );
        // A real edit to the already published document survives the retry.
        let read = crate::read_mind_map_in_vault(&LocalVault::new(vault).cx(), &first.id).unwrap();
        let mut edited = read.file;
        edited.nodes.get_mut(&edited.root_id).unwrap().text = "拆分后人工编辑".into();
        crate::write_mind_map_in_vault(
            &LocalVault::new(vault).cx(),
            &first.id,
            edited,
            1,
            &read.last_saved_hash,
        )
        .unwrap();
        fs::create_dir(vault.join("notes/移动后")).unwrap();
        fs::rename(
            vault.join(&first.path),
            vault.join("notes/移动后/已改名.shardmap.json"),
        )
        .unwrap();
        fs::remove_file(vault.join(obstruction)).unwrap();
        let result = split_in_vault(
            &LocalVault::new(vault).cx(),
            &source.path,
            7,
            &source.last_saved_hash,
        )
        .unwrap();
        assert_eq!(result.documents.len(), 3);
        assert_eq!(
            result.documents[0].path,
            "notes/移动后/已改名.shardmap.json"
        );
        assert!(!vault.join(&first.path).exists());
        assert_eq!(
            crate::read_mind_map_in_vault(&LocalVault::new(vault).cx(), &first.id)
                .unwrap()
                .file
                .nodes[&source.file.nodes[2].mind_map.as_ref().unwrap().root_id]
                .text,
            "拆分后人工编辑"
        );
        assert_eq!(
            list_in_vault(&LocalVault::new(vault).cx()).unwrap().len(),
            4
        );
        assert_eq!(
            read_in_vault(&LocalVault::new(vault).cx(), &source.path)
                .unwrap()
                .last_saved_hash,
            source.last_saved_hash
        );
    }

    #[test]
    fn split_rejects_stale_source_and_never_resurrects_removed_outputs() {
        let temp = vault();
        let vault = temp.path();
        let source = mixed(vault);
        assert!(split_in_vault(
            &LocalVault::new(vault).cx(),
            &source.path,
            6,
            &source.last_saved_hash
        )
        .is_err());
        assert!(split_in_vault(&LocalVault::new(vault).cx(), &source.path, 7, "stale").is_err());
        assert!(!receipt_path(vault, &source).exists());
        let result = split_in_vault(
            &LocalVault::new(vault).cx(),
            &source.path,
            7,
            &source.last_saved_hash,
        )
        .unwrap();
        let first = vault.join(&result.documents[0].path);
        fs::remove_file(&first).unwrap();
        assert!(split_in_vault(
            &LocalVault::new(vault).cx(),
            &source.path,
            7,
            &source.last_saved_hash
        )
        .unwrap_err()
        .contains("不会重复创建"));
        assert!(!first.exists());
        let mut changed = source.file.clone();
        changed.title = "外部新版本".into();
        fs::write(vault.join(&source.path), canonical(&changed).unwrap()).unwrap();
        let current = read_in_vault(&LocalVault::new(vault).cx(), &source.path).unwrap();
        assert!(split_in_vault(
            &LocalVault::new(vault).cx(),
            &source.path,
            7,
            &current.last_saved_hash
        )
        .unwrap_err()
        .contains("另一版本"));
    }

    #[test]
    fn split_lost_index_receipt_does_not_resurrect_a_trashed_note() {
        let temp = vault();
        let vault = temp.path();
        let source = mixed(vault);
        let result = split_in_vault(
            &LocalVault::new(vault).cx(),
            &source.path,
            7,
            &source.last_saved_hash,
        )
        .unwrap();
        let path = receipt_path(vault, &source);
        let mut receipt: SplitReceipt =
            serde_json::from_slice(&read_bytes(&FsVfs::new(vault), &path).unwrap()).unwrap();
        // Simulate index publication reaching disk but its receipt update being lost.
        receipt.index_published = false;
        atomic_write(
            &FsVfs::new(vault),
            &path,
            &canonical(&receipt).unwrap(),
            true,
        )
        .unwrap();
        let trashed =
            crate::move_to_trash_in_vault(&LocalVault::new(vault).cx(), &result.index_path)
                .unwrap();
        let before = fs::read(&trashed).unwrap();
        assert!(split_in_vault(
            &LocalVault::new(vault).cx(),
            &source.path,
            7,
            &source.last_saved_hash
        )
        .unwrap_err()
        .contains("关联说明位于回收站"));
        assert!(!vault.join(&result.index_path).exists());
        assert_eq!(fs::read(trashed).unwrap(), before);
        assert_eq!(
            list_in_vault(&LocalVault::new(vault).cx()).unwrap().len(),
            4
        );
        assert_eq!(
            read_in_vault(&LocalVault::new(vault).cx(), &source.path)
                .unwrap()
                .last_saved_hash,
            source.last_saved_hash
        );
    }

    #[test]
    fn flow_documents_reject_embedded_maps_and_legacy_files_are_read_only() {
        let temp = vault();
        let vault = temp.path();
        let source = mixed(vault);
        assert!(write_in_vault(
            &LocalVault::new(vault).cx(),
            &source.path,
            source.file.clone(),
            7,
            &source.last_saved_hash
        )
        .unwrap_err()
        .contains("只读"));
        let mut mixed_flow = source.file.clone();
        mixed_flow.kind = "shard.flow".into();
        assert!(validate_file(&FsVfs::new(vault), &mixed_flow)
            .unwrap_err()
            .contains("不能包含思维导图"));
        assert!(create_in_vault(
            &LocalVault::new(vault).cx(),
            "notes",
            &source.file.title,
            source.file.clone()
        )
        .is_err());
        let mut standalone_flow = fixture();
        standalone_flow.id = "standalone-flow".into();
        let flow = create_in_vault(
            &LocalVault::new(vault).cx(),
            "notes",
            "中文画布",
            standalone_flow,
        )
        .unwrap();
        assert!(split_in_vault(
            &LocalVault::new(vault).cx(),
            &flow.path,
            1,
            &flow.last_saved_hash
        )
        .is_err());
        let mut legacy = flow.file.clone();
        legacy.kind = "shard.canvas".into();
        assert!(write_in_vault(
            &LocalVault::new(vault).cx(),
            &flow.path,
            legacy,
            1,
            &flow.last_saved_hash
        )
        .is_err());
        fs::copy(
            vault.join(&flow.path),
            vault.join("notes/伪装.shardcanvas.json"),
        )
        .unwrap();
        assert!(
            read_in_vault(&LocalVault::new(vault).cx(), "notes/伪装.shardcanvas.json")
                .unwrap_err()
                .contains("扩展名")
        );
    }

    #[test]
    fn flow_links_resolve_after_rename_move_and_reject_unsafe_identifiers() {
        let temp = vault();
        let vault = temp.path();
        let flow =
            create_in_vault(&LocalVault::new(vault).cx(), "notes", "中文画布", fixture()).unwrap();
        let mut map =
            crate::create_mind_map_in_vault(&LocalVault::new(vault).cx(), "引用流程".into(), None)
                .unwrap()
                .file;
        map.nodes
            .get_mut(&map.root_id)
            .unwrap()
            .links
            .push(ShardDocumentLink::Flow {
                id: "flow-link".into(),
                target_id: flow.file.id.clone(),
            });
        crate::validate_mind_map_file(&FsVfs::new(vault), &map).unwrap();
        crate::rename_library_entry_in_vault(&LocalVault::new(vault).cx(), &flow.path, "新名称")
            .unwrap();
        fs::create_dir(vault.join("notes/子目录")).unwrap();
        crate::move_library_entry_in_vault(
            &LocalVault::new(vault).cx(),
            "notes/新名称.shardflow.json",
            Some("notes/子目录"),
        )
        .unwrap();
        let summary = list_in_vault(&LocalVault::new(vault).cx())
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == flow.file.id)
            .unwrap();
        assert_eq!(summary.path, "notes/子目录/新名称.shardflow.json");
        assert_eq!(summary.kind, "flowchart");
        crate::validate_mind_map_file(&FsVfs::new(vault), &map).unwrap();
        for target_id in ["", "../secret", "notes/private", "notes\\private"] {
            let link = ShardDocumentLink::Flow {
                id: "safe".into(),
                target_id: target_id.into(),
            };
            assert!(validate_public_link(&FsVfs::new(vault), &link).is_err());
        }
        crate::move_to_trash_in_vault(&LocalVault::new(vault).cx(), &summary.path).unwrap();
        assert!(!list_in_vault(&LocalVault::new(vault).cx())
            .unwrap()
            .iter()
            .any(|entry| entry.id == flow.file.id));
        crate::validate_mind_map_file(&FsVfs::new(vault), &map).unwrap(); // A broken public link remains editable.
    }

    #[test]
    #[cfg(unix)]
    fn split_and_document_listing_never_follow_symlinks_or_escape_public_notes() {
        let temp = vault();
        let vault = temp.path();
        let source = mixed(vault);
        let outside = tempfile::tempdir().unwrap();
        let mut flow = fixture();
        flow.id = "outside-flow".into();
        fs::write(
            outside.path().join("outside.shardflow.json"),
            canonical(&flow).unwrap(),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), vault.join("notes/外部目录")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("outside.shardflow.json"),
            vault.join("notes/别名.shardflow.json"),
        )
        .unwrap();
        assert!(!list_in_vault(&LocalVault::new(vault).cx())
            .unwrap()
            .iter()
            .any(|entry| entry.id == "outside-flow"));
        for path in [
            "notes/../notes/旧混合画布.shardcanvas.json",
            "lockbox/旧混合画布.shardcanvas.json",
            "notes/外部目录/旧混合画布.shardcanvas.json",
        ] {
            assert!(split_in_vault(
                &LocalVault::new(vault).cx(),
                path,
                7,
                &source.last_saved_hash
            )
            .is_err());
        }
        let receipt = plan_split(&FsVfs::new(vault), &source).unwrap();
        atomic_write(
            &FsVfs::new(vault),
            &receipt_path(vault, &source),
            &canonical(&receipt).unwrap(),
            false,
        )
        .unwrap();
        let output = &receipt.outputs[0];
        std::os::unix::fs::symlink(outside.path().join("untouched"), vault.join(&output.path))
            .unwrap();
        assert!(split_in_vault(
            &LocalVault::new(vault).cx(),
            &source.path,
            7,
            &source.last_saved_hash
        )
        .unwrap_err()
        .contains("符号链接"));
        assert!(!outside.path().join("untouched").exists());
        assert_eq!(
            read_in_vault(&LocalVault::new(vault).cx(), &source.path)
                .unwrap()
                .last_saved_hash,
            source.last_saved_hash
        );
    }

    #[test]
    fn split_map_only_flow_only_and_empty_legacy_files_have_exact_output_types() {
        for kind in ["mindmap", "flow", "empty"] {
            let temp = vault();
            let vault = temp.path();
            let source = mixed(vault);
            let mut file = source.file;
            file.nodes.retain(|node| match kind {
                "mindmap" => node.kind == "mindmap",
                "flow" => node.kind != "mindmap",
                _ => false,
            });
            let ids: HashSet<_> = file.nodes.iter().map(|node| node.id.as_str()).collect();
            file.edges.retain(|edge| {
                ids.contains(edge.source.as_str()) && ids.contains(edge.target.as_str())
            });
            fs::write(vault.join(&source.path), canonical(&file).unwrap()).unwrap();
            let source = read_in_vault(&LocalVault::new(vault).cx(), &source.path).unwrap();
            let result = split_in_vault(
                &LocalVault::new(vault).cx(),
                &source.path,
                7,
                &source.last_saved_hash,
            )
            .unwrap();
            assert_eq!(
                result.documents.len(),
                match kind {
                    "mindmap" => 2,
                    "flow" => 1,
                    _ => 0,
                }
            );
            assert!(result.documents.iter().all(|document| document.kind
                == if kind == "mindmap" {
                    "mindmap"
                } else {
                    "flowchart"
                }));
            assert!(vault.join(result.index_path).is_file());
        }
    }

    #[test]
    fn mind_map_creation_accepts_a_safe_library_parent_directly() {
        let temp = vault();
        let vault = temp.path();
        fs::create_dir(vault.join("notes/项目")).unwrap();
        let map = crate::create_mind_map_at_in_vault(
            &LocalVault::new(vault).cx(),
            "当前目录".into(),
            None,
            Some("notes/项目"),
        )
        .unwrap();
        assert_eq!(map.path, "notes/项目/当前目录.shardmap.json");
        assert!(!vault.join("notes/当前目录.shardmap.json").exists());
        for parent in ["notes/../notes", "lockbox", "notes/不存在"] {
            assert!(crate::create_mind_map_at_in_vault(
                &LocalVault::new(vault).cx(),
                "拒绝".into(),
                None,
                Some(parent)
            )
            .is_err());
        }
        assert_eq!(
            crate::run_git(vault, &["rev-list", "--all", "--count"])
                .unwrap()
                .trim(),
            "0"
        );
    }
}
