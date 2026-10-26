//! 命令的去向：离线能读的、离线能写的、只能在线的。名字与服务器 `POST /api/rpc/{命令}` 一致。

/// 一个命令离线时怎么办。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandClass {
    /// 读命令：离线时在「副本 ∪ overlay」上跑同一套领域函数，返回同形结果。
    LocalRead,
    /// 离线允许的写：在 overlay 上跑同一套领域函数，把 RPC 原样记进 outbox，联网后补交。
    OfflineWrite,
    /// 只能在线：离线时返回「需要联网：…」。
    OnlineOnly,
}

/// 离线可读（前端常用的读）。`lockbox_snapshot` 读的是最近一次在线时缓存的密文快照。
pub const LOCAL_READS: &[&str] = &[
    "list_fragments",
    "list_markdown_dialect_migration",
    "read_property_registry",
    "list_library_tree",
    "list_mind_maps",
    "list_csv_files",
    "list_diagram_documents",
    "read_mind_map",
    "read_canvas",
    "read_dataset",
    "read_csv_file",
    "read_graph_fragment",
    "image_references",
    "existing_vault_images",
    "read_fragment_image",
    "search_vault",
    "read_search_target",
    "lockbox_snapshot",
];

/// 离线允许的写（方案 §5「离线允许」中本版实现的部分）。
pub const OFFLINE_WRITES: &[&str] = &[
    "create_fragment",
    "update_fragment",
    "update_fragment_tags",
    "set_fragment_pinned",
    "set_fragment_property",
    "remove_fragment_property",
    "save_fragment_image",
];

pub fn classify(command: &str) -> CommandClass {
    if LOCAL_READS.contains(&command) {
        CommandClass::LocalRead
    } else if OFFLINE_WRITES.contains(&command) {
        CommandClass::OfflineWrite
    } else {
        CommandClass::OnlineOnly
    }
}

/// 只读、不改服务器的命令（在线时转发后不必触发拉取）。
pub fn is_read_only(command: &str) -> bool {
    LOCAL_READS.contains(&command)
        || matches!(
            command,
            "list_revisions"
                | "list_deleted_entries"
                | "server_status"
                | "read_import_xlsx_blob"
                | "list_tags"
                | "list_documents"
                | "read_document"
                | "resolve_target"
                | "list_library"
                | "remote:revision_bytes"
        )
}

/// 「需要联网：…」里的操作名。
pub fn offline_label(command: &str) -> &'static str {
    match command {
        "lockbox_apply" | "seal_fragment_into_lockbox" | "move_fragment_to_lockbox" | "set_lockbox_web_unlock"
        | "lockbox_snapshot" => "密匣（本版密匣只能在线写入）",
        "create_library_note" | "create_library_dataset" | "create_library_directory" | "create_note"
        | "ensure_library_folder" => "在资料库里新建",
        "rename_library_entry" => "改名",
        "move_library_entry" => "移动",
        "delete_library_entry" | "set_fragment_archived" => "删除（移入回收站）",
        "restore_from_trash" | "purge_from_trash" | "empty_trash" => "回收站操作",
        "convert_fragment_to_note" | "convert_note_to_fragment" => "碎片与笔记互转",
        "import_library_blobs" | "import_graph_file_to_timeline" | "remote:import_library_files" => "导入",
        "create_mind_map" | "write_mind_map" | "delete_mind_map" => "保存导图",
        "create_canvas" | "write_canvas" | "split_canvas" | "create_graph_fragment" | "write_graph_fragment" => {
            "保存流程图与大纲"
        }
        "apply_dataset_ops" | "create_dataset" | "normalize_csv_file" | "append_dataset_records" => "编辑数据集",
        "register_property_type" => "修改属性类型",
        "link_fragments" | "unlink_fragments" => "关联碎片",
        "list_revisions" | "restore_revision" | "remote:revision_bytes" | "list_deleted_entries"
        | "erase_deleted_entries" => "版本历史与数据找回",
        "read_import_xlsx_blob" => "读取 Excel",
        _ => "这个操作",
    }
}

/// 离线时拒绝命令的说明文字（前端照常显示；传输层据前缀给出「需要联网」提示）。
pub fn offline_message(command: &str) -> String {
    format!("需要联网：{}。现在连不上服务器，联网后再试。", offline_label(command))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_that_change_structure_need_the_network() {
        for command in [
            "rename_library_entry",
            "move_library_entry",
            "delete_library_entry",
            "set_fragment_archived",
            "empty_trash",
            "convert_fragment_to_note",
            "import_library_blobs",
            "write_mind_map",
            "write_canvas",
            "apply_dataset_ops",
            "register_property_type",
            "lockbox_apply",
            "seal_fragment_into_lockbox",
        ] {
            assert_eq!(classify(command), CommandClass::OnlineOnly, "{command}");
            assert!(offline_message(command).starts_with("需要联网："), "{command}");
        }
        for command in OFFLINE_WRITES {
            assert_eq!(classify(command), CommandClass::OfflineWrite);
            assert!(!is_read_only(command));
        }
        assert_eq!(classify("search_vault"), CommandClass::LocalRead);
        assert!(is_read_only("list_revisions"));
    }
}
