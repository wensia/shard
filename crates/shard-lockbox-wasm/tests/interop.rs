//! wasm ↔ 桌面互通的原生一半（由 `tests/interop.sh` 编排，单独跑会跳过）：
//! 1. `desktop_writes_vault_for_wasm`：桌面函数（`FsVfs` 上的 `shard_vault::lockbox`）写一个密匣目录与期望值；
//!    Node 里的 wasm 会话读它（`tests/node-session.cjs`），再自己写一个目录；
//! 2. `desktop_reads_vault_written_by_wasm`：桌面函数解开 wasm 写出的目录，与 wasm 记下的期望值逐条比对。
//!
//! 运行：`bash crates/shard-lockbox-wasm/tests/interop.sh`（`pnpm test:lockbox-wasm`）。

use std::{collections::{BTreeMap, HashSet}, path::PathBuf};

use serde_json::{json, Value};
use shard_core::FsVfs;
use shard_vault::{lockbox as desktop, Fragment, NoHooks, VaultCtx};

const PASSWORD: &str = "interop password";

fn interop_dir() -> Option<PathBuf> {
    std::env::var_os("SHARD_LOCKBOX_INTEROP_DIR").map(PathBuf::from)
}

fn essence(fragments: &[Fragment]) -> BTreeMap<String, Value> {
    fragments
        .iter()
        .map(|fragment| {
            (
                fragment.id.clone(),
                json!({
                    "content": fragment.content,
                    "tags": fragment.tags,
                    "pinned": fragment.pinned,
                    "archived": fragment.archived,
                    "path": fragment.path,
                    "fileSha": fragment.file_sha,
                    "createdAt": fragment.created_at,
                    "properties": fragment.properties,
                }),
            )
        })
        .collect()
}

fn desktop_list(vfs: &FsVfs) -> Vec<Fragment> {
    let cx = VaultCtx::local(vfs, &NoHooks);
    let master_key = desktop::unlock_lockbox(&cx, PASSWORD).expect("桌面用口令解锁");
    let keys = desktop::read_lockbox_manifest(vfs).unwrap().read_keys(&master_key).unwrap();
    desktop::list_lockbox_fragments(&cx, &HashSet::new(), &keys).unwrap()
}

#[test]
#[ignore = "由 tests/interop.sh 编排"]
fn desktop_writes_vault_for_wasm() {
    let Some(root) = interop_dir() else {
        return;
    };
    let dir = root.join("desktop");
    std::fs::create_dir_all(&dir).unwrap();
    let vfs = FsVfs::new(&dir);
    let cx = VaultCtx::local(&vfs, &NoHooks);
    let setup = desktop::setup_lockbox(&cx, PASSWORD).unwrap();
    let keys = desktop::read_lockbox_manifest(&vfs).unwrap().read_keys(&setup.master_key).unwrap();
    let first = desktop::create_lockbox_fragment(&cx, Some(&keys), "桌面写的第一条\n\n第二段", vec!["读书".into()]).unwrap();
    let locked = desktop::create_lockbox_fragment(&cx, None, "桌面锁着写的", vec![]).unwrap();
    let path = shard_vault::find_lockbox_fragment_path(&vfs, &first.id).unwrap().unwrap();
    desktop::set_lockbox_fragment_pinned_in_vault(&cx, &path, &keys, true).unwrap();
    desktop::mutate_lockbox_fragment_property_in_vault(&cx, &path, &keys, "评分", Some(&serde_yaml::Value::from(5))).unwrap();
    let path = shard_vault::find_lockbox_fragment_path(&vfs, &locked.id).unwrap().unwrap();
    desktop::set_lockbox_fragment_archived_in_vault(&cx, &path, &keys, true).unwrap();
    let expect = essence(&desktop_list(&vfs));
    assert_eq!(expect.len(), 2);
    std::fs::write(root.join("desktop-expect.json"), serde_json::to_string_pretty(&expect).unwrap()).unwrap();
}

#[test]
#[ignore = "由 tests/interop.sh 编排"]
fn desktop_reads_vault_written_by_wasm() {
    let Some(root) = interop_dir() else {
        return;
    };
    let expect: BTreeMap<String, Value> =
        serde_json::from_str(&std::fs::read_to_string(root.join("web-expect.json")).expect("先跑 node-session.cjs")).unwrap();
    let vfs = FsVfs::new(root.join("web"));
    let actual = essence(&desktop_list(&vfs));
    assert!(expect.len() >= 3, "wasm 应当写出至少 3 条");
    assert_eq!(actual, expect);
}
