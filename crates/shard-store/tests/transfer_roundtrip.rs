//! 旧 vault → 内容库 → 导出：逐字节一致（只差排除清单），修改时间保留，重复导入幂等，前置检查能拦住没迁移完的库。

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use shard_store::{
    transfer::{export_vault, import_vault, precheck},
    Store,
};

fn write(root: &Path, rel: &str, bytes: &[u8]) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
}

fn set_mtime(path: &Path, seconds: u64) {
    let time = SystemTime::UNIX_EPOCH + Duration::from_secs(seconds);
    fs::File::open(path).unwrap().set_modified(time).unwrap();
}

fn fragment(id: &str, tags: &[&str], body: &str) -> String {
    let tags = tags.iter().map(|tag| format!("- {tag}\n")).collect::<String>();
    format!(
        "---\nid: {id}\ncreated_at: 2026-10-01T09:00:00+08:00\nupdated_at: 2026-10-01T09:00:00+08:00\ntags:\n{tags}category: null\nai_status: none\nsource: desktop\n# 自定义属性与注释原样保留\nrating: 1.50\n---\n\n{body}"
    )
}

/// 有代表性的旧 vault：碎片、笔记、回收站、命名图片、内容寻址附件（含无扩展名旧图）、GBK CSV、
/// 导图与画布 JSON、空目录、密匣信封与 manifest，以及要被排除的垃圾。
fn sample_vault(root: &Path) {
    write(root, ".shard/format.json", br#"{"markdownDialect":2}"#);
    write(root, ".shard/properties.json", b"{\"rating\":{\"type\":\"number\"}}\n");
    write(root, ".shard/lockbox.json", b"{\n  \"version\": 1,\n  \"write_public_key\": \"MII...\"\n}\n");
    write(root, ".gitignore", b".DS_Store\n");
    write(root, "fragments/2026/10/20261001-090000-aaaaaaaa-000001.md", fragment("20261001-090000-aaaaaaaa-000001", &["inbox"], "碎片正文 #读书\n").as_bytes());
    write(root, ".trash/fragments/2026/09/20260901-090000-bbbbbbbb-000002.md", fragment("20260901-090000-bbbbbbbb-000002", &["inbox"], "归档的\n").as_bytes());
    write(root, "notes/私人顾问/晚上上头的应对方案.md", fragment("20261018-200629-f3b9d192-f77612", &["inbox", "note"], "# 晚上上头的应对方案\n\n- 一\n- 二\n").as_bytes());
    write(root, "notes/证件/营业执照 1.jpg", b"\xFF\xD8\xFF\xE0fake-jpeg");
    write(root, "notes/季度规划.shardmap.json", r#"{"kind":"shard.map","id":"map-1","title":"季度规划"}"#.as_bytes());
    write(root, "assets/ab/abababababababababababababababababababababababababababababababab.png", b"\x89PNG\r\n\x1a\nfake");
    write(root, "assets/2026/06/20260601-120000-png", b"\x89PNG\r\n\x1a\nlegacy");
    // GBK 编码的「书名」：原字节入库，不转码。
    write(root, "datasets/阅读记录.csv", b"\xca\xe9\xc3\xfb,\xc8\xd5\xc6\xda\r\n\xd6\xc3\xc9\xed,2026\r\n");
    write(root, "datasets/.gitattributes", b"*.csv merge=binary\n");
    write(root, "maps/.last-good/map-1.shardmap.json", b"{}");
    fs::create_dir_all(root.join("debts")).unwrap();
    write(root, "lockbox/fragments/2026/10/20261002-090000-cccccccc-000003.shard", b"{\n  \"version\": 1,\n  \"id\": \"20261002-090000-cccccccc-000003\",\n  \"nonce\": \"n\",\n  \"ciphertext\": \"c\"\n}\n");
    write(root, "lockbox/notes/私密/标题.shard", b"{\n  \"version\": 1,\n  \"id\": \"20261003-090000-dddddddd-000004\",\n  \"nonce\": \"n\",\n  \"ciphertext\": \"c\"\n}\n");
    fs::create_dir_all(root.join("lockbox/archive")).unwrap();
    // 要被排除的垃圾。
    write(root, ".DS_Store", b"junk");
    write(root, "assets/.DS_Store", b"junk");
    write(root, ".git/HEAD", b"ref: refs/heads/main\n");
    write(root, ".shard/notes.sqlite3", b"old store");
    set_mtime(&root.join("notes/私人顾问/晚上上头的应对方案.md"), 1_760_000_000);
    set_mtime(&root.join("notes/证件/营业执照 1.jpg"), 1_750_000_000);
    set_mtime(&root.join(".shard/lockbox.json"), 1_740_000_000);
    set_mtime(&root.join("lockbox/notes/私密/标题.shard"), 1_730_000_000);
}

/// 相对路径 → (是否目录, 内容, 修改时间秒)。
fn tree(root: &Path) -> BTreeMap<String, (bool, Vec<u8>, u64)> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let path: PathBuf = entry.unwrap().path();
            let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            let metadata = fs::metadata(&path).unwrap();
            let mtime = metadata.modified().unwrap().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs();
            if metadata.is_dir() {
                out.insert(rel, (true, Vec::new(), 0));
                stack.push(path);
            } else {
                out.insert(rel, (false, fs::read(&path).unwrap(), mtime));
            }
        }
    }
    out
}

const EXCLUDED: &[&str] = &[".DS_Store", "assets/.DS_Store", ".git", ".git/HEAD", ".shard/notes.sqlite3", "lockbox/archive"];

#[test]
fn import_then_export_reproduces_the_vault_byte_for_byte() {
    let source = tempfile::tempdir().unwrap();
    sample_vault(source.path());
    let data = tempfile::tempdir().unwrap();
    let store = Store::open(data.path()).unwrap();

    let report = import_vault(&store, source.path()).unwrap();
    assert_eq!(report.lockbox_items, 2);
    assert!(report.lockbox_manifest);
    let skipped: Vec<&str> = report.skipped.iter().map(|(path, _)| path.as_str()).collect();
    for expected in [".DS_Store", "assets/.DS_Store", ".git", ".shard/notes.sqlite3", "lockbox/archive"] {
        assert!(skipped.contains(&expected), "排除清单里应该有 {expected}：{skipped:?}");
    }

    let out = tempfile::tempdir().unwrap();
    let target = out.path().join("vault");
    export_vault(&store, &target).unwrap();

    let mut original = tree(source.path());
    original.retain(|path, _| !EXCLUDED.contains(&path.as_str()));
    let exported = tree(&target);
    let strip_dir_times = |map: &BTreeMap<String, (bool, Vec<u8>, u64)>| {
        map.iter().map(|(path, (dir, bytes, _))| (path.clone(), (*dir, bytes.clone()))).collect::<BTreeMap<_, _>>()
    };
    assert_eq!(strip_dir_times(&exported), strip_dir_times(&original), "导出的内容必须与原 vault 逐字节一致");
    // 修改时间保留（树与碎片按它排序）：每个文件都要对上，包括密匣信封与 manifest。
    for (path, (is_dir, _, mtime)) in &original {
        if !is_dir {
            assert_eq!(exported[path].2, *mtime, "{path} 的修改时间");
        }
    }
}

#[test]
fn reimporting_the_same_vault_changes_nothing() {
    let source = tempfile::tempdir().unwrap();
    sample_vault(source.path());
    let data = tempfile::tempdir().unwrap();
    let store = Store::open(data.path()).unwrap();
    import_vault(&store, source.path()).unwrap();
    let head = store.head_seq().unwrap();
    import_vault(&store, source.path()).unwrap();
    assert_eq!(store.head_seq().unwrap(), head, "第二次导入不应产生任何变化");
}

#[test]
fn unmigrated_vaults_are_refused_before_anything_is_written() {
    let source = tempfile::tempdir().unwrap();
    sample_vault(source.path());
    write(source.path(), ".shard/format.json", br#"{"markdownDialect":1}"#);
    fs::create_dir_all(source.path().join("archive")).unwrap();
    write(
        source.path(),
        "fragments/2026/10/20261004-090000-eeeeeeee-000005.md",
        fragment("20261004-090000-eeeeeeee-000005", &["inbox", "note"], "旧笔记\n").as_bytes(),
    );
    let problems = precheck(source.path()).unwrap();
    assert_eq!(problems.len(), 3, "{problems:#?}");

    let data = tempfile::tempdir().unwrap();
    let store = Store::open(data.path()).unwrap();
    assert!(import_vault(&store, source.path()).is_err());
    assert_eq!(store.head_seq().unwrap(), 0, "拒绝导入时库里什么都不留");
}

#[test]
fn unknown_files_in_the_lockbox_and_symlinks_are_errors_not_silent_drops() {
    let source = tempfile::tempdir().unwrap();
    sample_vault(source.path());
    write(source.path(), "lockbox/notes/草稿.md", b"plaintext!");
    let data = tempfile::tempdir().unwrap();
    let store = Store::open(data.path()).unwrap();
    let error = import_vault(&store, source.path()).unwrap_err().to_string();
    assert!(error.contains("密匣目录里有不认识的文件"), "{error}");

    let source = tempfile::tempdir().unwrap();
    sample_vault(source.path());
    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc/hosts", source.path().join("notes/link.md")).unwrap();
    #[cfg(unix)]
    {
        let error = import_vault(&store, source.path()).unwrap_err().to_string();
        assert!(error.contains("符号链接"), "{error}");
    }
}
