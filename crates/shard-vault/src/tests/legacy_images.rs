//! 迁自 src-tauri/src/lib.rs 的领域测试：图片附件、资料库图片宫格与引用。
//! 本地目录 + NoHooks（与未初始化 Git 的本地资料库等价），准备数据照旧直接写文件。

use super::*;

#[test]
fn detects_extensionless_png_images() {
    let bytes = b"\x89PNG\r\n\x1a\nrest";
    let path = Path::new("assets/2026/06/clipboard-png");

    assert_eq!(image_mime_type(path, bytes).unwrap(), "image/png");
}

#[test]
fn resolves_content_addressed_attachment_references() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    let hash = "a".repeat(64);
    let asset_dir = vault.join("assets").join("aa");
    fs::create_dir_all(&asset_dir).unwrap();
    let expected = asset_dir.join(format!("{hash}.png"));
    fs::write(&expected, b"\x89PNG\r\n\x1a\nrest").unwrap();

    let resolved =
        resolve_vault_asset_path(&FsVfs::new(vault), &format!("shard-attachment:{hash}")).unwrap();

    assert_eq!(resolved, expected.canonicalize().unwrap());
}

#[test]
fn rejects_malformed_content_addressed_attachment_references() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    fs::create_dir_all(vault.join("assets")).unwrap();

    assert!(
        resolve_vault_asset_path(&FsVfs::new(vault), "shard-attachment:../../etc/passwd").is_err()
    );
    assert!(resolve_vault_asset_path(&FsVfs::new(vault), "shard-attachment:abc").is_err());
}

#[test]
fn library_asset_svg_with_long_prolog_is_listed() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::write(
        vault.join("notes/svg.md"),
        "![图](assets/long-prolog.svg)",
    )
    .unwrap();
    let mut svg = b"<?xml version=\"1.0\"?>\n<!--".to_vec();
    svg.extend(vec![b' '; 8 * 1024]);
    svg.extend(b"-->\n<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
    fs::write(vault.join("assets/long-prolog.svg"), svg).unwrap();

    let assets = collect_library_assets(&LocalVault::new(vault).cx());
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].mime_type, "image/svg+xml");
}

#[test]
fn library_tree_skips_non_images_damaged_assets_and_hidden_directories() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::write(vault.join("notes/说明.md"), "note").unwrap();
    let asset_dir = vault.join("assets/ff");
    fs::create_dir_all(&asset_dir).unwrap();
    fs::write(asset_dir.join("valid.jpg"), b"\xff\xd8\xffimage-data").unwrap();
    fs::write(vault.join("notes/说明.md"), "![说明](assets/ff/valid.jpg)").unwrap();
    fs::write(asset_dir.join("not-image.txt"), b"plain text").unwrap();
    fs::write(asset_dir.join("damaged.png"), b"not really a png").unwrap();
    let hidden_dir = vault.join("assets/.conflicts");
    fs::create_dir_all(&hidden_dir).unwrap();
    fs::write(hidden_dir.join("hidden.png"), b"\x89PNG\r\n\x1a\nhidden").unwrap();

    let tree = build_library_tree(&LocalVault::new(vault).cx()).unwrap();

    assert_eq!(tree.assets.len(), 1);
    assert_eq!(tree.assets[0].path, "assets/ff/valid.jpg");
    assert_eq!(tree.assets[0].mime_type, "image/jpeg");
    assert_eq!(tree.entries.len(), 1);
    assert_eq!(tree.entries[0].name, "说明.md");
}

#[test]
fn library_assets_only_include_public_document_references() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    for name in [
        "fragment", "document", "shared", "canvas", "table", "unknown", "private", "deleted",
    ] {
        fs::write(
            vault.join(format!("assets/{name}.png")),
            b"\x89PNG\r\n\x1a\npng",
        )
        .unwrap();
    }
    let hash = "a".repeat(64);
    fs::create_dir_all(vault.join("assets/aa")).unwrap();
    fs::write(
        vault.join(format!("assets/aa/{hash}.png")),
        b"\x89PNG\r\n\x1a\npng",
    )
    .unwrap();
    write_public_test_fragment(
        vault,
        "![碎片](assets/fragment.png) ![共有](assets/shared.png)",
    );
    fs::write(vault.join("notes/document.md"), format!(
        "![文档](assets/document.png) ![共有](assets/shared.png) ![哈希](shard-attachment:{hash}) ![外部](https://example.com/assets/unknown.png)"
    )).unwrap();
    fs::write(
        vault.join("notes/canvas.shardcanvas.json"),
        r#"{"image":"assets/canvas.png"}"#,
    )
    .unwrap();
    // Retired multidimensional tables are no longer reference sources.
    fs::write(
        vault.join("notes/table.shardtable.json"),
        r#"{"cell":"assets/table.png"}"#,
    )
    .unwrap();
    fs::create_dir_all(vault.join("lockbox/notes")).unwrap();
    fs::write(
        vault.join("lockbox/notes/private.md"),
        "![私密](assets/private.png)",
    )
    .unwrap();
    fs::create_dir_all(vault.join(".trash/notes")).unwrap();
    fs::write(
        vault.join(".trash/notes/deleted.md"),
        "![删除](assets/deleted.png)",
    )
    .unwrap();

    let paths: HashSet<_> = collect_library_assets(&LocalVault::new(vault).cx())
        .into_iter()
        .map(|asset| asset.path)
        .collect();
    assert_eq!(
        paths,
        HashSet::from([
            "assets/document.png".into(),
            "assets/shared.png".into(),
            "assets/canvas.png".into(),
            format!("assets/aa/{hash}.png"),
        ])
    );
    for name in ["fragment", "table", "unknown", "private", "deleted"] {
        assert!(vault.join(format!("assets/{name}.png")).is_file());
    }
}

#[test]
fn named_library_images_are_tree_entries_and_gallery_items() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join("notes/证件")).unwrap();
    fs::write(vault.join("notes/证件/营业执照.JPG"), TEST_PNG).unwrap();
    fs::write(vault.join("notes/证件/说明.txt"), "不是图片").unwrap();
    fs::write(vault.join("notes/证件/.隐藏.png"), TEST_PNG).unwrap();
    // 数据集单元格引用的附件也属于资料库；只被碎片用到的仍不收。
    fs::write(vault.join("assets/表格.png"), TEST_PNG).unwrap();
    fs::write(vault.join("assets/碎片.png"), TEST_PNG).unwrap();
    fs::write(vault.join("datasets/证件.csv"), "名称,照片\n执照,assets/表格.png\n").unwrap();
    write_public_test_fragment(vault, "![碎片](assets/碎片.png)");

    let tree = build_library_tree(&LocalVault::new(vault).cx()).unwrap();
    let folder = tree.entries.iter().find(|entry| entry.name == "证件").unwrap();
    let children = folder.children.as_ref().unwrap();
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].name, "营业执照.JPG");
    assert_eq!(children[0].kind, "image");

    let gallery: HashSet<_> = tree.assets.iter().map(|asset| asset.path.as_str()).collect();
    assert_eq!(gallery, HashSet::from(["notes/证件/营业执照.JPG", "assets/表格.png"]));
    let named = tree.assets.iter().find(|asset| asset.path.ends_with(".JPG")).unwrap();
    assert_eq!(named.mime_type, "image/jpeg");
}

#[test]
fn existing_vault_images_filters_missing_private_and_non_image_refs() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::create_dir_all(vault.join("notes/相册")).unwrap();
    fs::create_dir_all(vault.join("lockbox")).unwrap();
    fs::write(vault.join("notes/相册/a.png"), TEST_PNG).unwrap();
    fs::write(vault.join("lockbox/b.png"), TEST_PNG).unwrap();
    fs::write(vault.join("notes/说明.md"), "x").unwrap();
    assert_eq!(
        existing_vault_images_in(
            &FsVfs::new(vault),
            vec![
                "notes/相册/a.png".into(),
                "./notes/相册/a.png".into(),
                "notes/相册/missing.png".into(),
                "lockbox/b.png".into(),
                "notes/说明.md".into(),
                "https://e.com/a.png".into(),
            ]
        ),
        vec!["notes/相册/a.png".to_string(), "./notes/相册/a.png".to_string()]
    );
}

#[test]
fn converting_content_changes_asset_visibility_without_moving_shared_images() {
    let tempdir = tempfile::tempdir().unwrap();
    let vault = tempdir.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();
    fs::write(vault.join("assets/shared.png"), b"\x89PNG\r\n\x1a\npng").unwrap();
    let id = write_public_test_fragment(vault, "![图片](assets/shared.png)");
    assert!(collect_library_assets(&LocalVault::new(vault).cx()).is_empty());
    convert_fragment_to_note_in_vault(&LocalVault::new(vault).cx(), &id, None, Some("图片文档"))
        .unwrap();
    assert_eq!(collect_library_assets(&LocalVault::new(vault).cx()).len(), 1);
    convert_note_to_fragment_in_vault(&LocalVault::new(vault).cx(), &id).unwrap();
    assert!(collect_library_assets(&LocalVault::new(vault).cx()).is_empty());
    assert!(vault.join("assets/shared.png").is_file());
}
