use shard_core::{
    dataset::{create_dataset, read_dataset, DatasetLimits},
    vault_lock::VaultProcessLock,
};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
};

fn fixture() -> (tempfile::TempDir, String) {
    let directory = tempfile::tempdir().unwrap();
    let vault = directory.path().join("vault");
    fs::create_dir(&vault).unwrap();
    let created = create_dataset(
        &vault,
        "阅读记录",
        vec!["id".into(), "名称".into()],
        vec![vec!["r_000000000001".into(), "旧书".into()]],
        Some("id".into()),
        &DatasetLimits::default(),
    )
    .unwrap();
    (directory, created.path)
}

fn cli(vault: &Path, path: &str, input: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_shard-cli"))
        .args(["--vault", vault.to_str().unwrap(), "--append-dataset", path])
        .env("SHARD_LOCK_DIR", vault.parent().unwrap().join("locks"))
        .env("SHARD_LOCK_TIMEOUT_MS", "100")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn appends_and_retries_idempotently() {
    let (directory, path) = fixture();
    let vault = directory.path().join("vault");
    let input =
        r#"{"expectedHeader":["id","名称"],"records":[{"id":"r_000000000002","名称":"新书"}]}"#;
    let first = cli(&vault, &path, input);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let result: serde_json::Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(result["appended"], 1);
    assert_eq!(result["skipped"], 0);
    let snapshot = read_dataset(&vault, &path, &DatasetLimits::default()).unwrap();
    assert_eq!(result["sha"], snapshot.sha);
    assert_eq!(snapshot.table.rows[1], ["r_000000000002", "新书"]);
    let bytes = fs::read(vault.join(&path)).unwrap();

    let second = cli(&vault, &path, input);
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    let result: serde_json::Value = serde_json::from_slice(&second.stdout).unwrap();
    assert_eq!(result["appended"], 0);
    assert_eq!(result["skipped"], 1);
    assert_eq!(result["sha"], snapshot.sha);
    assert_eq!(fs::read(vault.join(&path)).unwrap(), bytes);
}

#[test]
fn fills_missing_columns_and_skips_duplicate_ids_within_batch() {
    let (directory, path) = fixture();
    let vault = directory.path().join("vault");
    let input = r#"{"expectedHeader":["id","名称"],"records":[{"id":"r_000000000002"},{"id":"r_000000000002"}]}"#;
    let result = cli(&vault, &path, input);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let receipt: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(receipt["appended"], 1);
    assert_eq!(receipt["skipped"], 1);
    let snapshot = read_dataset(&vault, &path, &DatasetLimits::default()).unwrap();
    assert_eq!(snapshot.table.rows[1], ["r_000000000002", ""]);
}

#[test]
fn rejects_missing_key_and_unknown_column_without_writing() {
    let (directory, path) = fixture();
    let vault = directory.path().join("vault");
    let bytes = fs::read(vault.join(&path)).unwrap();
    for input in [
        r#"{"expectedHeader":["id","名称"],"records":[{"名称":"无 ID"}]}"#,
        r#"{"expectedHeader":["id","名称"],"records":[{"id":"r_000000000002","其他":"额外列"}]}"#,
    ] {
        let result = cli(&vault, &path, input);
        assert_eq!(result.status.code(), Some(1));
        assert_eq!(fs::read(vault.join(&path)).unwrap(), bytes);
    }
}

#[test]
fn conflicting_id_rejects_entire_batch_without_writing() {
    let (directory, path) = fixture();
    let vault = directory.path().join("vault");
    let bytes = fs::read(vault.join(&path)).unwrap();
    let input = r#"{"expectedHeader":["id","名称"],"records":[{"id":"r_000000000002","名称":"新书"},{"id":"r_000000000001","名称":"冲突"}]}"#;
    let result = cli(&vault, &path, input);
    assert_eq!(result.status.code(), Some(3));
    assert!(String::from_utf8_lossy(&result.stderr).contains("主键冲突"));
    assert_eq!(fs::read(vault.join(&path)).unwrap(), bytes);
}

#[test]
fn header_mismatch_returns_two_without_writing() {
    let (directory, path) = fixture();
    let vault = directory.path().join("vault");
    let bytes = fs::read(vault.join(&path)).unwrap();
    let result = cli(
        &vault,
        &path,
        r#"{"expectedHeader":["id","书名"],"records":[]}"#,
    );
    assert_eq!(result.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&result.stderr).contains("表头已变化"));
    assert_eq!(fs::read(vault.join(&path)).unwrap(), bytes);
}

#[test]
fn held_lock_times_out_without_writing() {
    let (directory, path) = fixture();
    let vault = directory.path().join("vault");
    let bytes = fs::read(vault.join(&path)).unwrap();
    let _held = VaultProcessLock::acquire(&directory.path().join("locks"), &vault, None).unwrap();
    let result = cli(
        &vault,
        &path,
        r#"{"expectedHeader":["id","名称"],"records":[{"id":"r_000000000002"}]}"#,
    );
    assert_eq!(result.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&result.stderr).contains("Shard 正在写入资料库，请稍后重试"));
    assert_eq!(fs::read(vault.join(&path)).unwrap(), bytes);
}

#[test]
fn rejects_fragment_content_in_append_mode() {
    let (directory, path) = fixture();
    let vault = directory.path().join("vault");
    let result = Command::new(env!("CARGO_BIN_EXE_shard-cli"))
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "--append-dataset",
            &path,
            "碎片内容",
        ])
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&result.stderr).contains("不能与碎片内容同时使用"));
}
