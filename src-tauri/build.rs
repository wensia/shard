use std::{env, fs, path::PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn main() {
    ensure_cli_sidecar();
    tauri_build::build()
}

/// 直接运行 Cargo 时，给 Tauri 的 sidecar 校验准备一个不可用的开发占位文件。
/// 正式打包前，`build-cli-sidecar.mjs` 会用真实 CLI 覆盖它。
fn ensure_cli_sidecar() {
    println!("cargo:rerun-if-env-changed=TARGET");

    let target = env::var("TARGET").expect("Cargo 未提供 TARGET");
    let binaries_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let sidecar = binaries_dir.join(format!("shard-cli-{target}"));
    println!("cargo:rerun-if-changed={}", sidecar.display());
    if sidecar.exists() {
        return;
    }

    fs::create_dir_all(&binaries_dir).expect("创建 sidecar 目录失败");
    fs::write(
        &sidecar,
        "#!/bin/sh\nprintf '%s\\n' '开发构建未包含 shard CLI' >&2\nexit 1\n",
    )
    .expect("写入 sidecar 占位文件失败");

    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&sidecar)
            .expect("读取 sidecar 占位文件权限失败")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&sidecar, permissions).expect("设置 sidecar 占位文件权限失败");
    }
}
