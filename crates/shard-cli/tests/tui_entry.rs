use std::{fs, process::Command};

#[test]
fn interactive_requires_terminal() {
    let temp = tempfile::tempdir().unwrap();
    let vault = temp.path().join("vault");
    let locks = temp.path().join("locks");
    let state = temp.path().join("state");
    let scratch = temp.path().join("tmp");
    let home = temp.path().join("home");
    for path in [&vault, &locks, &state, &scratch, &home] {
        fs::create_dir_all(path).unwrap();
    }
    let output = Command::new(env!("CARGO_BIN_EXE_shard-cli"))
        .args(["-i", "关键词"])
        .env("SHARD_VAULT", &vault)
        .env("SHARD_LOCK_DIR", &locks)
        .env("SHARD_CLI_STATE_DIR", &state)
        .env("TMPDIR", &scratch)
        .env("HOME", &home)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("交互界面需要在终端中运行"));
}
