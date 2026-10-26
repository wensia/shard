//! 迁自 src-tauri/src/lib.rs 的领域测试：CSV 数据集。
//! 本地目录 + NoHooks（与未初始化 Git 的本地资料库等价），准备数据照旧直接写文件。

use super::*;

#[test]
fn dataset_commands_create_read_apply_and_reject_stale_base() {
    let directory = tempfile::tempdir().unwrap();
    let vault = directory.path();
    ensure_vault_layout(&FsVfs::new(vault)).unwrap();

    let created = create_dataset_in_vault(
        &LocalVault::new(vault).cx(),
        "阅读记录",
        vec!["id".into(), "书名".into()],
        vec![vec!["r_000000000001".into(), "第一本".into()]],
        Some("id".into()),
    )
    .unwrap();
    assert_eq!(created.path, "datasets/阅读记录.csv");
    assert_eq!(
        read_dataset_in_vault(&LocalVault::new(vault).cx(), &created.path).unwrap(),
        created
    );
    let json = serde_json::to_value(&created).unwrap();
    assert!(json.get("schemaSha").is_some());
    assert!(json.get("readOnlyReason").is_some());

    let ops = vec![DatasetOp::SetCells {
        cells: vec![dataset::CellEdit {
            row: 0,
            column: 1,
            value: "第二本".into(),
        }],
    }];
    let updated = apply_dataset_ops_in_vault(
        &LocalVault::new(vault).cx(),
        &created.path,
        &created.sha,
        created.schema_sha.as_deref(),
        &ops,
    )
    .unwrap();
    assert_eq!(updated.table.rows[0][1], "第二本");
    assert_ne!(updated.sha, created.sha);
    assert_eq!(
        read_dataset_in_vault(&LocalVault::new(vault).cx(), &created.path).unwrap(),
        updated
    );

    let error = apply_dataset_ops_in_vault(
        &LocalVault::new(vault).cx(),
        &created.path,
        &created.sha,
        created.schema_sha.as_deref(),
        &ops,
    )
    .unwrap_err();
    assert_eq!(error, "STALE_BASE:数据文件已在别处被修改");
    assert_eq!(
        read_dataset_in_vault(&LocalVault::new(vault).cx(), &created.path).unwrap(),
        updated
    );
}
