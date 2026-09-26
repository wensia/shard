use shard_core::vault_lock::VaultProcessLock;
use std::{fs, process::Command, time::Duration};

#[test]
fn cli_refuses_locked_vault_then_writes_after_release() {
    let directory = tempfile::tempdir().unwrap();
    let vault = directory.path().join("vault");
    let lock_dir = directory.path().join("locks");
    fs::create_dir(&vault).unwrap();

    let held = VaultProcessLock::acquire(&lock_dir, &vault, None).unwrap();
    let run_cli = || {
        Command::new(env!("CARGO_BIN_EXE_shard-cli"))
            .args(["--vault", vault.to_str().unwrap(), "跨进程锁测试"])
            .env("SHARD_LOCK_DIR", &lock_dir)
            .env("SHARD_LOCK_TIMEOUT_MS", "200")
            .output()
            .unwrap()
    };

    let blocked = run_cli();
    assert!(!blocked.status.success());
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("Shard 正在写入资料库，请稍后重试"));
    assert!(!vault.join("fragments").exists());

    drop(held);
    let written = run_cli();
    assert!(
        written.status.success(),
        "{}",
        String::from_utf8_lossy(&written.stderr)
    );
    let relative = String::from_utf8(written.stdout).unwrap();
    assert!(vault.join(relative.trim()).is_file());
    VaultProcessLock::acquire(&lock_dir, &vault, Some(Duration::from_millis(100))).unwrap();
}
