//! Public canvas documents. Commands do all validation, scanning and I/O off the UI thread.
//! 领域逻辑（校验、扫描、读写、拆分）在 `shard_vault::canvas`；这里只剩 Tauri 命令
//! （二进制 IPC、取写门）与依赖本地 Git 的测试。
#[cfg(test)]
pub(crate) use crate::CanvasEdge;
#[cfg(test)]
use crate::ShardDocumentLink;
pub(crate) use crate::CanvasFile;
#[cfg(test)]
pub(crate) use crate::CanvasNode;
use crate::LocalVault;
#[cfg(test)]
use crate::ShardMapFile;
use serde::Deserialize;
pub(crate) use shard_vault::canvas::*;
#[cfg(test)]
use shard_core::Vfs;
#[cfg(test)]
use std::path::Path;

pub(crate) mod split;

/// Deleted public targets remain valid document links. Privacy and path boundaries
/// still apply, so a missing link never turns a migrated diagram into an unreadable file.
#[cfg(test)]
pub(crate) fn validate_public_link(vfs: &dyn Vfs, link: &ShardDocumentLink) -> CanvasResult<()> {
    shard_core::graph_model::validate_public_link(vfs, link)
}

fn request_bytes(request: &tauri::ipc::Request<'_>) -> CanvasResult<Vec<u8>> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) if bytes.len() <= MAX_BYTES + 16 * 1024 => {
            Ok(bytes.clone())
        }
        tauri::ipc::InvokeBody::Raw(_) => Err("画布请求超过 8 MiB 内容上限。".into()),
        _ => Err("画布请求需要二进制 JSON。".into()),
    }
}

fn response(value: CanvasReadResult) -> CanvasResult<tauri::ipc::Response> {
    serde_json::to_vec(&value)
        .map(tauri::ipc::Response::new)
        .map_err(io)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    parent_path: String,
    title: String,
    file: CanvasFile,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadRequest {
    path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteRequest {
    path: String,
    file: CanvasFile,
    expected_revision: u64,
    last_saved_hash: String,
}

#[tauri::command]
pub(crate) async fn create_canvas(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> CanvasResult<tauri::ipc::Response> {
    let bytes = request_bytes(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request: CreateRequest = serde_json::from_slice(&bytes).map_err(io)?;
        let vault = crate::ensure_vault_dirs(&app)?;
        let _gate = crate::lock_vault_gate(&vault);
        let local = LocalVault::new(&vault);
        response(create_in_vault(
            &local.cx(),
            &request.parent_path,
            &request.title,
            request.file,
        )?)
    })
    .await
    .map_err(io)?
}

#[tauri::command]
pub(crate) async fn read_canvas(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> CanvasResult<tauri::ipc::Response> {
    let bytes = request_bytes(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request: ReadRequest = serde_json::from_slice(&bytes).map_err(io)?;
        let vault = crate::configured_vault_path(&app)?;
        let local = LocalVault::new(&vault);
        response(read_in_vault(&local.cx(), &request.path)?)
    })
    .await
    .map_err(io)?
}

#[tauri::command]
pub(crate) async fn write_canvas(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> CanvasResult<tauri::ipc::Response> {
    let bytes = request_bytes(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request: WriteRequest = serde_json::from_slice(&bytes).map_err(io)?;
        let vault = crate::ensure_vault_dirs(&app)?;
        let _gate = crate::lock_vault_gate(&vault);
        let local = LocalVault::new(&vault);
        response(write_in_vault(
            &local.cx(),
            &request.path,
            request.file,
            request.expected_revision,
            &request.last_saved_hash,
        )?)
    })
    .await
    .map_err(io)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use shard_core::FsVfs;
    use std::fs::{self, File};

    pub(super) fn vault() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        crate::ensure_vault_layout(&FsVfs::new(directory.path())).unwrap();
        crate::run_git(directory.path(), &["init", "--initial-branch=main"]).unwrap();
        crate::run_git(directory.path(), &["config", "user.name", "Canvas fixture"]).unwrap();
        crate::run_git(
            directory.path(),
            &["config", "user.email", "canvas@example.invalid"],
        )
        .unwrap();
        crate::run_git(directory.path(), &["config", "commit.gpgsign", "false"]).unwrap();
        crate::run_git(
            directory.path(),
            &["config", "core.hooksPath", ".disabled-test-hooks"],
        )
        .unwrap();
        directory
    }
    pub(super) fn fixture() -> CanvasFile {
        serde_json::from_value(json!({
            "kind":"shard.flow", "schemaVersion":1, "id":"canvas-fixture", "title":"中文画布",
            "createdAt":"2026-09-07T00:00:00.000Z", "updatedAt":"2026-09-07T00:00:00.000Z", "revision":0,
            "nodes":[{"id":"first","kind":"process","x":0,"y":0,"text":"准备"},{"id":"second","kind":"decision","x":300,"y":0,"text":"通过？"}],
            "edges":[{"id":"forward","source":"first","target":"second","label":"开始","sourceHandle":"right","targetHandle":"left"},{"id":"back","source":"second","target":"first","label":"重试"}]
        })).unwrap()
    }
    fn create(vault: &Path) -> CanvasReadResult {
        create_in_vault(&LocalVault::new(vault).cx(), "notes", "中文画布", fixture()).unwrap()
    }
    fn commits(vault: &Path) -> String {
        crate::run_git(vault, &["rev-list", "--all", "--count"])
            .unwrap()
            .trim()
            .into()
    }

    #[test]
    fn library_filename_flow_create_and_existing_long_name_save() {
        let dir = vault();
        let vault = dir.path();
        for (title, expected) in [
            ("字".repeat(65), "名称最多 64 个字符（不含扩展名）。"),
            ("😀".repeat(61), "名称占用空间过长，请减少部分字符。"),
        ] {
            let mut file = fixture();
            file.title = title.clone();
            assert_eq!(
                create_in_vault(&LocalVault::new(vault).cx(), "notes", &title, file).unwrap_err(),
                expected
            );
        }
        let title = "😀".repeat(60);
        let mut file = fixture();
        file.title = title.clone();
        let created = create_in_vault(&LocalVault::new(vault).cx(), "notes", &title, file).unwrap();
        assert_eq!(Path::new(&created.path).file_name().unwrap().len(), 255);
        let legacy_path = format!("notes/{}{FLOW_SUFFIX}", "a".repeat(240));
        fs::rename(vault.join(created.path), vault.join(&legacy_path)).unwrap();
        let legacy = read_in_vault(&LocalVault::new(vault).cx(), &legacy_path).unwrap();
        let mut file = legacy.file;
        file.title = "长标题".repeat(30);
        file.nodes[0].text = "已修改".into();
        let saved = write_in_vault(
            &LocalVault::new(vault).cx(),
            &legacy_path,
            file.clone(),
            file.revision,
            &legacy.last_saved_hash,
        )
        .unwrap();
        assert_eq!(saved.file.title, file.title);
        let reread = read_in_vault(&LocalVault::new(vault).cx(), &legacy_path).unwrap();
        assert_eq!(reread.path, legacy_path);
        assert_eq!(reread.file.nodes[0].text, "已修改");
    }

    #[test]
    fn canvas_protocol_document_links_accept_legacy_alias_and_emit_camel_case() {
        for target_type in ["fragment", "map", "flow"] {
            for key in ["targetId", "target_id"] {
                let input =
                    json!({"id":"link-fixture", "targetType":target_type, key:"document-fixture"});
                let link: ShardDocumentLink = serde_json::from_value(input).unwrap();
                let serialized = serde_json::to_value(&link).unwrap();
                assert_eq!(
                    serialized,
                    json!({"id":"link-fixture", "targetType":target_type, "targetId":"document-fixture"})
                );
                assert!(serialized.get("target_id").is_none());
            }
            let ambiguous = json!({"id":"link-fixture", "targetType":target_type, "targetId":"document-a", "target_id":"document-b"});
            assert!(
                serde_json::from_value::<ShardDocumentLink>(ambiguous).is_err(),
                "both spellings must not choose an arbitrary target"
            );
        }
    }

    #[test]
    fn canvas_protocol_coordinates_survive_exact_json_round_trip() {
        let native_x: f64 = serde_json::from_str("463.52000000000004").unwrap();
        assert_eq!(
            native_x.to_bits(),
            463.52000000000004_f64.to_bits(),
            "native x must preserve its original IEEE-754 value"
        );
        // Native WKWebView pan/zoom yields fractional positions around these actual
        // acceptance coordinates. Adjacent representable values must retain all bits.
        for center in [463.52_f64, 249.65999999999997_f64, 298.5_f64, 244.25_f64] {
            for offset in 0..512 {
                let coordinate = f64::from_bits(center.to_bits() - 256 + offset);
                let mut file = fixture();
                file.nodes[0].x = coordinate;
                file.nodes[0].y = -coordinate;
                file.nodes[0].width = Some(coordinate);
                file.nodes[0].height = Some(coordinate);
                let encoded = serde_json::to_vec(&file).unwrap();
                let decoded: CanvasFile = serde_json::from_slice(&encoded).unwrap();
                assert_eq!(
                    decoded.nodes[0].x.to_bits(),
                    coordinate.to_bits(),
                    "x drifted for {coordinate:?}"
                );
                assert_eq!(
                    decoded.nodes[0].y.to_bits(),
                    (-coordinate).to_bits(),
                    "y drifted for {coordinate:?}"
                );
                assert_eq!(
                    decoded.nodes[0].width.unwrap().to_bits(),
                    coordinate.to_bits(),
                    "width drifted for {coordinate:?}"
                );
                assert_eq!(
                    decoded.nodes[0].height.unwrap().to_bits(),
                    coordinate.to_bits(),
                    "height drifted for {coordinate:?}"
                );
            }
        }
    }

    #[test]
    fn canvas_protocol_mind_map_optional_width_survives_real_save_and_rejects_invalid_sizes() {
        let directory = vault();
        let vault = directory.path();
        let created =
            crate::create_mind_map_in_vault(&LocalVault::new(vault).cx(), "宽度兼容".into(), None)
                .unwrap();
        let legacy = serde_json::to_value(&created.file).unwrap();
        assert!(legacy["nodes"][&created.file.root_id]
            .get("width")
            .is_none());
        let mut map: ShardMapFile = serde_json::from_value(legacy).unwrap();
        assert!(map.nodes[&map.root_id].width.is_none());
        for width in [0.0, -1.0, 10_001.0, f64::INFINITY, f64::NAN] {
            map.nodes.get_mut(&map.root_id).unwrap().width = Some(width);
            assert!(
                crate::validate_mind_map_file(&FsVfs::new(vault), &map).is_err(),
                "invalid width accepted: {width}"
            );
        }
        map.nodes.get_mut(&map.root_id).unwrap().width = Some(244.25);
        let saved = crate::write_mind_map_in_vault(
            &LocalVault::new(vault).cx(),
            &created.file.id,
            map,
            created.file.revision,
            &created.last_saved_hash,
        )
        .unwrap();
        let read =
            crate::read_mind_map_in_vault(&LocalVault::new(vault).cx(), &created.file.id).unwrap();
        assert_eq!(read.file.nodes[&read.file.root_id].width, Some(244.25));
        assert_eq!(read.last_saved_hash, saved.last_saved_hash);
        assert_eq!(
            serde_json::to_value(&read.file).unwrap()["nodes"][&read.file.root_id]["width"],
            json!(244.25)
        );
    }

    #[test]
    fn canvas_create_save_read_and_checkpoint_without_embedded_commit() {
        let directory = vault();
        let vault = directory.path();
        let created = create(vault);
        assert_eq!(created.path, "notes/中文画布.shardflow.json");
        assert_eq!(created.file.revision, 1);
        assert_eq!(commits(vault), "0");
        let retried = create(vault);
        assert_eq!(retried.path, created.path);
        assert_eq!(retried.last_saved_hash, created.last_saved_hash);
        let mut edit = created.file.clone();
        edit.nodes[0].text = "第一步完成".into();
        let saved = write_in_vault(
            &LocalVault::new(vault).cx(),
            &created.path,
            edit,
            1,
            &created.last_saved_hash,
        )
        .unwrap();
        assert_eq!(saved.file.revision, 2);
        assert_eq!(
            read_in_vault(&LocalVault::new(vault).cx(), &created.path)
                .unwrap()
                .file
                .nodes[0]
                .text,
            "第一步完成"
        );
        assert_eq!(commits(vault), "0");
        let backup = internal_path(
            &FsVfs::new(vault),
            "last-good",
            &format!("{}.json", crate::hash_text(&saved.file.id)),
        )
        .unwrap();
        assert_eq!(
            read_bytes(&FsVfs::new(vault), &backup).unwrap(),
            read_bytes(&FsVfs::new(vault), &vault.join(&created.path)).unwrap()
        );
        assert_eq!(
            crate::checkpoint_vault_locked(vault, Some("画布检查点"))
                .unwrap()
                .status,
            "committed"
        );
        assert_eq!(commits(vault), "1");
    }

    #[test]
    fn canvas_library_rename_move_recycle_restore_preserves_identity_and_suffix() {
        let directory = vault();
        let vault = directory.path();
        let created = create(vault);
        crate::checkpoint_before_structural_locked(vault);
        crate::rename_library_entry_in_vault(
            &LocalVault::new(vault).cx(),
            &created.path,
            "改名画布",
        )
        .unwrap();
        let renamed = "notes/改名画布.shardflow.json";
        assert_eq!(
            create(vault).path,
            renamed,
            "创建重试找到重命名后的同一文档"
        );
        assert_eq!(
            read_in_vault(&LocalVault::new(vault).cx(), renamed)
                .unwrap()
                .file
                .id,
            created.file.id
        );
        fs::create_dir(vault.join("notes/分类")).unwrap();
        crate::checkpoint_before_structural_locked(vault);
        crate::move_library_entry_in_vault(
            &LocalVault::new(vault).cx(),
            renamed,
            Some("notes/分类"),
        )
        .unwrap();
        let moved = "notes/分类/改名画布.shardflow.json";
        assert_eq!(
            read_in_vault(&LocalVault::new(vault).cx(), moved)
                .unwrap()
                .last_saved_hash,
            created.last_saved_hash
        );
        let entries =
            crate::collect_library_entries(&FsVfs::new(vault), &vault.join("notes/分类")).unwrap();
        assert!(entries.iter().any(|entry| entry.kind == "flowchart"));
        crate::checkpoint_before_structural_locked(vault);
        let trash = crate::move_to_trash_in_vault(&LocalVault::new(vault).cx(), moved).unwrap();
        assert!(
            create_in_vault(&LocalVault::new(vault).cx(), "notes", "中文画布", fixture())
                .unwrap_err()
                .contains("回收站")
        );
        let trashed = crate::relative_path(vault, &trash).unwrap();
        assert!(read_in_vault(&LocalVault::new(vault).cx(), &trashed).is_err());
        assert!(
            crate::collect_library_entries(&FsVfs::new(vault), trash.parent().unwrap())
                .unwrap()
                .iter()
                .any(|entry| entry.kind == "flowchart")
        );
        // A new document occupies the original path. Restore must retain both.
        let mut occupying = fixture();
        occupying.id = "another-canvas".into();
        occupying.title = "改名画布".into();
        create_in_vault(
            &LocalVault::new(vault).cx(),
            "notes/分类",
            "改名画布",
            occupying,
        )
        .unwrap();
        crate::checkpoint_before_structural_locked(vault);
        let restored =
            crate::restore_from_trash_in_vault(&LocalVault::new(vault).cx(), &trashed).unwrap();
        let restored_relative = crate::relative_path(vault, &restored).unwrap();
        assert_ne!(restored_relative, moved);
        assert!(is_canvas(&restored));
        let read = read_in_vault(&LocalVault::new(vault).cx(), &restored_relative).unwrap();
        assert_eq!(read.file.id, created.file.id);
        assert_eq!(read.last_saved_hash, created.last_saved_hash);
        assert_eq!(
            read_in_vault(&LocalVault::new(vault).cx(), moved)
                .unwrap()
                .file
                .id,
            "another-canvas"
        );
    }

    #[test]
    fn canvas_checkpoint_excludes_only_exact_atomic_leftovers() {
        let directory = vault();
        let vault = directory.path();
        create(vault);
        let token = "a".repeat(32);
        let ignored = [
            format!("notes/.canvas.shardflow.json.canvas-tmp-{token}"),
            format!(".shard/canvas/last-good/.backup.json.canvas-tmp-{token}"),
        ];
        let retained = [
            "notes/.canvas.shardflow.json.canvas-tmp-short",
            ".shard/canvas/last-good/.backup.json.canvas-tmp-short",
            "notes/normal.json.canvas-tmp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ];
        for path in ignored.iter().map(String::as_str).chain(retained) {
            fs::write(vault.join(path), b"fixture").unwrap();
        }
        let dirty = crate::managed_dirty_paths(vault).unwrap();
        for path in &ignored {
            assert!(!dirty.contains(path), "temporary file was included: {path}");
        }
        for path in retained {
            assert!(dirty.contains(path), "ordinary file was excluded: {path}");
        }
        crate::checkpoint_vault_locked(vault, Some("临时文件范围")).unwrap();
        let tracked = crate::run_git(vault, &["ls-files"]).unwrap();
        for path in &ignored {
            assert!(!tracked.lines().any(|line| line == path));
        }
        for path in retained {
            assert!(
                tracked.lines().any(|line| line == path),
                "ordinary file was not staged: {path}"
            );
        }
    }

    #[test]
    fn canvas_conflicts_preserve_disk_and_every_draft() {
        let directory = vault();
        let vault = directory.path();
        let created = create(vault);
        let mut draft = created.file.clone();
        draft.nodes[0].text = "磁盘修改".into();
        write_in_vault(
            &LocalVault::new(vault).cx(),
            &created.path,
            draft,
            1,
            &created.last_saved_hash,
        )
        .unwrap();
        let expected = read_bytes(&FsVfs::new(vault), &vault.join(&created.path)).unwrap();
        for text in ["离线草稿一", "离线草稿二"] {
            let mut draft = created.file.clone();
            draft.nodes[0].text = text.into();
            let error = write_in_vault(
                &LocalVault::new(vault).cx(),
                &created.path,
                draft,
                1,
                &created.last_saved_hash,
            )
            .unwrap_err();
            let copy = error.split('：').next_back().unwrap();
            assert!(error.contains("冲突副本"));
            assert!(
                read_file(&FsVfs::new(vault), &vault.join(copy))
                    .unwrap()
                    .file
                    .nodes[0]
                    .text
                    == text
            );
            assert_eq!(
                read_bytes(&FsVfs::new(vault), &vault.join(&created.path)).unwrap(),
                expected
            );
        }
        assert_eq!(
            fs::read_dir(vault.join(".shard/canvas/conflicts"))
                .unwrap()
                .count(),
            2
        );
    }

    #[test]
    fn canvas_lost_save_response_retry_returns_existing_revision() {
        let directory = vault();
        let vault = directory.path();
        let created = create(vault);
        let mut draft = created.file.clone();
        draft.nodes[0].text = "已写入但没有收到响应".into();
        let saved = write_in_vault(
            &LocalVault::new(vault).cx(),
            &created.path,
            draft.clone(),
            1,
            &created.last_saved_hash,
        )
        .unwrap();
        let retry = write_in_vault(
            &LocalVault::new(vault).cx(),
            &created.path,
            draft,
            1,
            &created.last_saved_hash,
        )
        .unwrap();
        assert_eq!(retry.file.revision, 2);
        assert_eq!(retry.last_saved_hash, saved.last_saved_hash);
        assert!(!vault.join(".shard/canvas/conflicts").exists());
    }

    #[test]
    fn canvas_hash_detects_external_edit_without_revision_bump() {
        let directory = vault();
        let vault = directory.path();
        let created = create(vault);
        let mut external = created.file.clone();
        external.nodes[0].text = "外部编辑未更新版本".into();
        let bytes = canonical(&external).unwrap();
        fs::write(vault.join(&created.path), &bytes).unwrap();
        assert!(write_in_vault(
            &LocalVault::new(vault).cx(),
            &created.path,
            created.file,
            1,
            &created.last_saved_hash
        )
        .unwrap_err()
        .contains("冲突"));
        assert_eq!(
            read_bytes(&FsVfs::new(vault), &vault.join(&created.path)).unwrap(),
            bytes
        );
    }

    #[test]
    #[cfg(unix)]
    fn canvas_recovery_failure_does_not_publish_primary_or_follow_symlinks() {
        let directory = vault();
        let vault = directory.path();
        let created = create(vault);
        let expected = read_bytes(&FsVfs::new(vault), &vault.join(&created.path)).unwrap();
        let backup = internal_path(
            &FsVfs::new(vault),
            "last-good",
            &format!("{}.json", crate::hash_text(&created.file.id)),
        )
        .unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::remove_file(&backup).unwrap();
        std::os::unix::fs::symlink(outside.path(), &backup).unwrap();
        let mut draft = created.file;
        draft.nodes[0].text = "不能发布".into();
        assert!(write_in_vault(
            &LocalVault::new(vault).cx(),
            &created.path,
            draft,
            1,
            &created.last_saved_hash
        )
        .unwrap_err()
        .contains("符号链接"));
        assert_eq!(
            read_bytes(&FsVfs::new(vault), &vault.join(&created.path)).unwrap(),
            expected
        );
        assert_eq!(fs::metadata(outside.path()).unwrap().len(), 0);
    }

    #[test]
    fn canvas_rejects_identity_reuse_duplicate_and_changed_target() {
        let directory = vault();
        let vault = directory.path();
        let created = create(vault);
        let mut different = fixture();
        different.nodes[0].text = "另一个请求".into();
        assert!(
            create_in_vault(&LocalVault::new(vault).cx(), "notes", "中文画布", different)
                .unwrap_err()
                .contains("不同的创建请求")
        );
        let mut impostor = created.file.clone();
        impostor.id = "unrelated".into();
        assert!(write_in_vault(
            &LocalVault::new(vault).cx(),
            &created.path,
            impostor,
            1,
            &created.last_saved_hash
        )
        .unwrap_err()
        .contains("身份"));
        fs::copy(
            vault.join(&created.path),
            vault.join("notes/复制.shardflow.json"),
        )
        .unwrap();
        assert!(read_in_vault(&LocalVault::new(vault).cx(), &created.path)
            .unwrap_err()
            .contains("重复"));
        assert!(
            create_in_vault(&LocalVault::new(vault).cx(), "notes", "中文画布", fixture())
                .unwrap_err()
                .contains("重复")
        );
    }

    #[test]
    fn canvas_rejects_paths_symlinks_and_missing_target_writes() {
        let directory = vault();
        let vault = directory.path();
        let created = create(vault);
        for path in [
            "../notes/x.shardflow.json",
            "/notes/x.shardflow.json",
            "notes/./x.shardflow.json",
            "notes/../notes/x.shardflow.json",
            "notes\\x.shardflow.json",
            "lockbox/x.shardflow.json",
            ".trash/notes/x.shardflow.json",
            "notes/.hidden/x.shardflow.json",
        ] {
            assert!(
                read_in_vault(&LocalVault::new(vault).cx(), path).is_err(),
                "accepted {path}"
            );
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                vault.join(&created.path),
                vault.join("notes/别名.shardflow.json"),
            )
            .unwrap();
            assert!(
                read_in_vault(&LocalVault::new(vault).cx(), "notes/别名.shardflow.json")
                    .unwrap_err()
                    .contains("符号链接")
            );
            std::os::unix::fs::symlink(vault.join("notes"), vault.join("notes/目录别名")).unwrap();
            assert!(create_in_vault(
                &LocalVault::new(vault).cx(),
                "notes/目录别名",
                "中文画布",
                fixture()
            )
            .unwrap_err()
            .contains("符号链接"));
        }
        fs::remove_file(vault.join(&created.path)).unwrap();
        assert!(write_in_vault(
            &LocalVault::new(vault).cx(),
            &created.path,
            created.file,
            1,
            &created.last_saved_hash
        )
        .is_err());
        assert!(!vault.join(&created.path).exists());
    }

    #[test]
    fn canvas_validation_rejects_unknown_fields_invalid_graph_and_oversized_files() {
        let directory = vault();
        let vault = directory.path();
        let base = fixture();
        let mut invalid = base.clone();
        invalid.edges[0].target = "missing".into();
        assert!(validate_file(&FsVfs::new(vault), &invalid).is_err());
        invalid = base.clone();
        invalid.nodes[1].id = "first".into();
        assert!(validate_file(&FsVfs::new(vault), &invalid).is_err());
        invalid = base.clone();
        invalid.nodes[0].kind = "reference".into();
        assert!(validate_file(&FsVfs::new(vault), &invalid).is_err());
        invalid = base.clone();
        invalid.nodes[0].x = f64::INFINITY;
        assert!(validate_file(&FsVfs::new(vault), &invalid).is_err());
        invalid = base.clone();
        invalid.nodes[0].width = Some(-1.0);
        assert!(validate_file(&FsVfs::new(vault), &invalid).is_err());
        invalid = base.clone();
        invalid.edges[0].source_handle = Some("arbitrary".into());
        assert!(validate_file(&FsVfs::new(vault), &invalid).is_err());
        let mut value = serde_json::to_value(&base).unwrap();
        value["unknown"] = json!(true);
        assert!(serde_json::from_value::<CanvasFile>(value).is_err());
        let path = vault.join("notes/huge.shardflow.json");
        File::create(&path)
            .unwrap()
            .set_len(MAX_BYTES as u64 + 1)
            .unwrap();
        assert!(read_bytes(&FsVfs::new(vault), &path)
            .unwrap_err()
            .contains("8 MiB"));
    }

    #[test]
    fn canvas_node_edge_and_embedded_total_limits_are_enforced() {
        let directory = vault();
        let vault = directory.path();
        let mut file = fixture();
        file.nodes = (0..401)
            .map(|index| {
                let mut node = file.nodes[0].clone();
                node.id = format!("n{index}");
                node
            })
            .collect();
        file.edges.clear();
        assert!(validate_file(&FsVfs::new(vault), &file).is_err());
        let mut file = fixture();
        file.edges = (0..1601)
            .map(|index| {
                let mut edge = file.edges[0].clone();
                edge.id = format!("e{index}");
                edge
            })
            .collect();
        assert!(validate_file(&FsVfs::new(vault), &file).is_err());
        let mut file = fixture();
        file.kind = "shard.canvas".into();
        file.edges.clear();
        let mut map =
            crate::create_mind_map_in_vault(&LocalVault::new(vault).cx(), "节点上限".into(), None)
                .unwrap()
                .file;
        let root = map.nodes[&map.root_id].clone();
        map.nodes.retain(|id, _| id == &map.root_id);
        for index in 0..399 {
            let mut child = root.clone();
            child.id = format!("child{index}");
            child.parent_id = Some(map.root_id.clone());
            child.sort_key = format!("a{index:04}");
            map.nodes.insert(child.id.clone(), child);
        }
        file.nodes = (0..5)
            .map(|index| {
                let mut node = file.nodes[0].clone();
                node.id = format!("map{index}");
                node.kind = "mindmap".into();
                node.mind_map = Some(map.clone());
                node
            })
            .collect();
        assert!(validate_file(&FsVfs::new(vault), &file)
            .unwrap_err()
            .contains("2000"));
        file.nodes.pop();
        validate_file(&FsVfs::new(vault), &file).unwrap();
    }

    #[test]
    fn canvas_embedded_tree_and_missing_public_references_are_validated() {
        let directory = vault();
        let vault = directory.path();
        let map = crate::create_mind_map_in_vault(&LocalVault::new(vault).cx(), "树".into(), None)
            .unwrap()
            .file;
        let mut file = fixture();
        file.kind = "shard.canvas".into();
        file.nodes[0].kind = "mindmap".into();
        file.nodes[0].mind_map = Some(map);
        validate_file(&FsVfs::new(vault), &file).unwrap();
        let mut invalid = file.clone();
        let map = invalid.nodes[0].mind_map.as_mut().unwrap();
        map.nodes.get_mut(&map.root_id).unwrap().parent_id = Some("missing".into());
        assert!(validate_file(&FsVfs::new(vault), &invalid).is_err());
        file.nodes[1].kind = "reference".into();
        file.nodes[1].link = Some(ShardDocumentLink::MarkdownPath {
            id: "ref".into(),
            path: "notes/deleted.md".into(),
        });
        validate_file(&FsVfs::new(vault), &file).unwrap();
        let legacy_path = "notes/中文画布.shardcanvas.json";
        fs::write(vault.join(legacy_path), canonical(&file).unwrap()).unwrap();
        let created = read_in_vault(&LocalVault::new(vault).cx(), legacy_path).unwrap();
        assert_eq!(
            read_in_vault(&LocalVault::new(vault).cx(), &created.path)
                .unwrap()
                .file
                .nodes
                .len(),
            2
        );
        for path in [
            "lockbox/private.md",
            "notes/../lockbox/private.md",
            "notes/.internal/private.md",
        ] {
            file.nodes[1].link = Some(ShardDocumentLink::MarkdownPath {
                id: "ref".into(),
                path: path.into(),
            });
            assert!(validate_file(&FsVfs::new(vault), &file).is_err());
        }
        fs::create_dir_all(vault.join("lockbox/fragments")).unwrap();
        fs::write(
            vault.join("lockbox/fragments/private.shard"),
            br#"{"id":"secret-fragment"}"#,
        )
        .unwrap();
        file.nodes[1].link = Some(ShardDocumentLink::Fragment {
            id: "ref".into(),
            target_id: "secret-fragment".into(),
        });
        assert!(validate_file(&FsVfs::new(vault), &file)
            .unwrap_err()
            .contains("密匣"));
        file.nodes[1].link = Some(ShardDocumentLink::Fragment {
            id: "ref".into(),
            target_id: "missing-public-fragment".into(),
        });
        validate_file(&FsVfs::new(vault), &file).unwrap();
    }
}
