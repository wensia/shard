//! 自动标签的公开资料读写边界。调用方在写门 / SQLite 写事务内应用结果；网络推理不持门。

use std::{
    io::ErrorKind,
    path::{Component, Path, PathBuf},
};

use shard_core::{
    auto_tagging::{is_untagged, metadata_is_public, validate_topic_tag, TaggingItem, MAX_TAGS_PER_ITEM},
    extract_tags,
    frontmatter::{apply_tags, parse_fragment, ParsedFragment},
    library::note_title,
};

use crate::{content_sha256_hex, VaultCtx};

/// 无主题标签的公开文档；不存在、回收站、隐藏、密匣、归档和已打标签的内容均返回 None。
/// 非受管路径返回 Err，防止调用方把任意资料库文件发给模型。
pub fn read_tagging_item(cx: &VaultCtx<'_>, path: &Path) -> Result<Option<TaggingItem>, String> {
    let Some((_, _, parsed)) = eligible_document(cx, path)? else {
        return Ok(None);
    };
    Ok(Some(TaggingItem {
        id: parsed.frontmatter.id,
        title: note_title(&parsed.body),
        body: parsed.body,
        tags: parsed.frontmatter.tags,
    }))
}

/// 只增 frontmatter 标签，不改正文、其他元数据或 Git。
/// 文件已变化、已消失或不再适合自动标注时返回 false；输入错误 / I/O 错误返回 Err。
/// `expected_file_sha` 必须是推理输入对应的完整文件 SHA256。
pub fn apply_auto_tags(
    cx: &VaultCtx<'_>,
    path: &Path,
    expected_file_sha: &str,
    tags: Vec<String>,
) -> Result<bool, String> {
    if tags.len() > MAX_TAGS_PER_ITEM {
        return Err("自动标签超过数量限制".into());
    }
    for tag in &tags {
        validate_topic_tag(tag)?;
    }
    if tags.is_empty() {
        return Ok(false);
    }
    let Some((path, text, mut parsed)) = eligible_document(cx, path)? else {
        return Ok(false);
    };
    if content_sha256_hex(&text) != expected_file_sha {
        return Ok(false);
    }
    for tag in tags {
        if !parsed.frontmatter.tags.contains(&tag) {
            parsed.frontmatter.tags.push(tag);
        }
    }
    let raw = apply_tags(&parsed.raw, &parsed.frontmatter.tags)?;
    // parse_fragment.body 包含原始闭合线后的所有字节；不能用 render_fragment 的 trim/补换行。
    let updated = format!("---\n{raw}\n---{}", parsed.body);
    if updated == text {
        return Ok(false);
    }
    cx.vfs
        .write_atomic(&path, updated.as_bytes())
        .map_err(|error| error.to_string())?;
    Ok(true)
}

fn eligible_document(
    cx: &VaultCtx<'_>,
    path: &Path,
) -> Result<Option<(PathBuf, String, ParsedFragment)>, String> {
    let relative = if path.is_absolute() {
        path.strip_prefix(cx.root())
            .map_err(|_| "自动标签路径不在资料库内".to_string())?
    } else {
        path
    };
    let parts: Vec<_> = relative.components().collect();
    if parts
        .iter()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("自动标签只接受规范的公开 Markdown 路径".into());
    }
    if parts
        .iter()
        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
        || parts
            .first()
            .is_some_and(|part| part.as_os_str() == "lockbox")
    {
        return Ok(None);
    }
    if parts.len() < 2
        || !parts
            .first()
            .is_some_and(|part| part.as_os_str() == "fragments" || part.as_os_str() == "notes")
        || !relative
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Err("自动标签只接受 fragments/ 或 notes/ 下的 Markdown".into());
    }
    let mut resolved = cx.root().to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        resolved.push(part.as_os_str());
        let metadata = match cx.vfs.symlink_metadata(&resolved) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if metadata.is_symlink() || (index + 1 == parts.len() && !metadata.is_file()) {
            return Ok(None);
        }
    }
    let text = match cx.vfs.read_to_string(&resolved) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    // 无身份元数据的旧外部 Markdown 留给显式导入，不自动补造 id 或重写文件。
    if !text.starts_with("---\n") {
        return Ok(None);
    }
    // 畸形元数据是确定的不适用文件，留给用户修复；不能让队列反复重试它而饿死后续内容。
    // VFS 的读取错误仍原样返回 Err，调用方可以重试暂时故障。
    let Ok(parsed) = parse_fragment(&text) else {
        return Ok(None);
    };
    if !metadata_is_public(&parsed.raw) {
        return Ok(None);
    }
    let mut tags = parsed.frontmatter.tags.clone();
    tags.extend(extract_tags(&parsed.body));
    if !is_untagged(&tags) || parsed.body.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some((resolved, text, parsed)))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::NoHooks;
    use shard_core::FsVfs;

    #[test]
    fn auto_tags_do_not_follow_file_or_directory_symlinks() {
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(vault.path().join("notes")).unwrap();
        let original = "---\nid: outside\ncreated_at: now\nupdated_at: now\ntags: [inbox]\nsource: test\n---\n\nprivate body\n";
        std::fs::write(outside.path().join("private.md"), original).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("private.md"),
            vault.path().join("notes/link.md"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), vault.path().join("notes/linked-dir")).unwrap();
        let vfs = FsVfs::new(vault.path());
        let cx = VaultCtx::local(&vfs, &NoHooks);
        for path in ["notes/link.md", "notes/linked-dir/private.md"] {
            assert!(read_tagging_item(&cx, Path::new(path)).unwrap().is_none());
            assert!(!apply_auto_tags(
                &cx,
                Path::new(path),
                &content_sha256_hex(original),
                vec!["主题".into()]
            )
            .unwrap());
        }
        assert_eq!(
            std::fs::read_to_string(outside.path().join("private.md")).unwrap(),
            original
        );
    }
}
