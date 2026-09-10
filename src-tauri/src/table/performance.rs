//! Opt-in real-vault benchmarks. No AppHandle, configured vault, service, or remote.
use super::*;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap, fs, hint::black_box, path::Path, process::Command, time::Instant,
};

const SAMPLES: usize = 20;
fn id(prefix: &str, index: usize) -> String {
    format!(
        "{prefix}_{}",
        &storage::sha256(format!("{prefix}-{index}").as_bytes())[..32]
    )
}
fn value(row: usize, column: usize, pass: usize, field: &TableField) -> CellValue {
    if pass == 0 && (row + column) % 17 == 0 {
        return CellValue::Null;
    }
    match field.field_type {
        FieldType::Text => CellValue::Text(if pass == 0 && row % 29 == 0 {
            String::new()
        } else if row % 100 == 0 {
            format!(
                "记录 {row} / {column} / {pass} {}",
                "长文本合成样本".repeat(80)
            )
        } else {
            format!("记录 {row} · 合成中文 {column} · {pass}")
        }),
        FieldType::Number => {
            CellValue::Number(((row * 37 + column * 13) % 100003) as f64 / 10.0 + pass as f64)
        }
        FieldType::Date => {
            CellValue::Text(format!("2026-09-{:02}", (row + column + pass) % 28 + 1))
        }
        FieldType::Checkbox => CellValue::Checkbox((row + column + pass) % 2 == 0),
        FieldType::Select => {
            CellValue::Text(field.options.as_ref().unwrap()[(row + pass) % 4].id.clone())
        }
        FieldType::MultiSelect => CellValue::OptionIds(vec![
            field.options.as_ref().unwrap()[(row + pass) % 4].id.clone(),
            field.options.as_ref().unwrap()[(row + pass + 1) % 4]
                .id
                .clone(),
        ]),
    }
}
fn content(rows: usize, columns: usize) -> TableContent {
    let field_order = (0..columns).map(|n| id("fld", n)).collect::<Vec<_>>();
    let fields = field_order
        .iter()
        .enumerate()
        .map(|(column, id)| {
            let field_type = [
                FieldType::Text,
                FieldType::Number,
                FieldType::Date,
                FieldType::Select,
                FieldType::MultiSelect,
                FieldType::Checkbox,
            ][column % 6];
            let options =
                matches!(field_type, FieldType::Select | FieldType::MultiSelect).then(|| {
                    (0..4)
                        .map(|n| SelectOption {
                            id: self::id("opt", column * 4 + n),
                            label: format!("选项 {n}"),
                            color: OptionColor::Blue,
                        })
                        .collect()
                });
            (
                id.clone(),
                TableField {
                    id: id.clone(),
                    name: format!("字段 {}", column + 1),
                    field_type,
                    options,
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    let record_order = (0..rows).map(|n| id("rec", n)).collect::<Vec<_>>();
    let records = record_order
        .iter()
        .enumerate()
        .map(|(row, id)| {
            (
                id.clone(),
                TableRecord {
                    id: id.clone(),
                    created_at: "2026-09-01T00:00:00.000Z".into(),
                    updated_at: "2026-09-01T00:00:00.000Z".into(),
                    values: field_order
                        .iter()
                        .enumerate()
                        .map(|(column, id)| (id.clone(), value(row, column, 0, &fields[id])))
                        .collect(),
                },
            )
        })
        .collect();
    let view_id = id("view", 0);
    let view = TableView {
        id: view_id.clone(),
        name: "默认视图".into(),
        view_type: "table".into(),
        filters: TableFilter {
            operator: FilterOperator::And,
            conditions: vec![],
        },
        sorts: vec![],
        group_by: None,
        field_order: field_order.clone(),
        hidden_field_ids: vec![],
        column_widths: BTreeMap::new(),
    };
    TableContent {
        primary_field_id: field_order[0].clone(),
        field_order,
        fields,
        record_order,
        records,
        view_order: vec![view_id.clone()],
        views: BTreeMap::from([(view_id, view)]),
    }
}
fn elapsed(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}
fn command(program: &str, args: &[&str]) -> String {
    Command::new(program)
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().into())
        .unwrap_or_else(|| "unavailable".into())
}
fn git(vault: &Path, args: &[&str]) -> String {
    crate::run_git(vault, args).unwrap()
}
fn distribution(values: &[f64]) -> Value {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    json!({ "n": sorted.len(), "p50Ms": sorted[(sorted.len() as f64 * 0.5).ceil() as usize - 1], "p95Ms": sorted[(sorted.len() as f64 * 0.95).ceil() as usize - 1], "minMs": sorted[0], "maxMs": sorted[sorted.len()-1] })
}
fn save_report(path: &Path, result: &Value) {
    fs::write(path, serde_json::to_vec_pretty(result).unwrap()).unwrap();
}

#[test]
#[ignore = "20-sample real Git / fsync benchmark; run scripts/dev/table-performance.sh"]
fn real_vault_read_edit_and_paste() {
    let output = std::env::var_os("SHARD_TABLE_PERFORMANCE_OUTPUT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("shard-table-performance.json"));
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let sources = [
        (
            "src-tauri/src/lib.rs",
            include_bytes!("../lib.rs").as_slice(),
        ),
        (
            "src-tauri/src/table_commands.rs",
            include_bytes!("../table_commands.rs").as_slice(),
        ),
        (
            "src-tauri/src/table/model.rs",
            include_bytes!("model.rs").as_slice(),
        ),
        (
            "src-tauri/src/table/mutations.rs",
            include_bytes!("mutations.rs").as_slice(),
        ),
        (
            "src-tauri/src/table/storage.rs",
            include_bytes!("storage.rs").as_slice(),
        ),
        (
            "src-tauri/src/table/validation.rs",
            include_bytes!("validation.rs").as_slice(),
        ),
        (
            "src-tauri/src/table/performance.rs",
            include_bytes!("performance.rs").as_slice(),
        ),
    ]
    .into_iter()
    .map(|(path, bytes)| json!({"path":path,"sha256":storage::sha256(bytes)}))
    .collect::<Vec<_>>();
    let mut report = json!({"startedAt":chrono::Utc::now().to_rfc3339(),"build":{"debugAssertions":cfg!(debug_assertions),"targetArch":std::env::consts::ARCH,"os":std::env::consts::OS},
        "machine":{"cpu":command("sysctl", &["-n", "machdep.cpu.brand_string"]),"os":command("sw_vers", &[]),"rustc":command("rustc", &["--version"]),"git":command("git", &["--version"])},
        "method":"Warm-cache sequential Rust command bodies, fresh temporary vault + real local Git per dataset, real file sync_all and atomic installation. Each create/apply holds the actual vault gate. No AppHandle/configured vault/UI/IPC/remote. No timer includes fixture generation, Git initialization/checkpoint, output-report writes, or post-write verification. All 20 samples retained; nearest-rank percentiles.",
        "sources":sources,"datasets":[]});
    for (rows, columns) in [(1000usize, 20usize), (10000, 30)] {
        let temporary = tempfile::Builder::new()
            .prefix("shard-table-performance-")
            .tempdir()
            .unwrap();
        let vault = temporary.path();
        crate::ensure_vault_layout(vault).unwrap();
        git(vault, &["init", "--initial-branch=main"]);
        git(vault, &["config", "user.name", "Table performance fixture"]);
        git(
            vault,
            &["config", "user.email", "table-performance@example.invalid"],
        );
        git(vault, &["config", "commit.gpgsign", "false"]);
        git(vault, &["config", "core.hooksPath", ".disabled-test-hooks"]);
        let content = content(rows, columns);
        let request = CreateTableRequest {
            request_id: id("req", rows),
            table_id: id("tbl", rows),
            parent_path: "notes".into(),
            suggested_name: format!("performance-{rows}x{columns}"),
            content: content.clone(),
        };
        let start = Instant::now();
        let created = {
            let _gate = crate::lock_vault_gate(vault);
            crate::table_commands::create_in_vault(vault, &request).unwrap()
        };
        let create_ms = elapsed(start);
        let absolute = vault.join(&created.path);
        let initial_bytes = fs::read(&absolute).unwrap();
        git(vault, &["add", "--", &created.path]);
        git(
            vault,
            &["commit", "-m", "Synthetic table benchmark baseline"],
        );
        let original_head = git(vault, &["rev-parse", "HEAD"]);
        let read_request = ReadTableRequest {
            path: created.path.clone(),
            expected_table_id: Some(created.file.id.clone()),
        };
        let mut samples = Vec::new();
        for sample in 0..SAMPLES {
            let start = Instant::now();
            let bytes = fs::read(&absolute).unwrap();
            let read_bytes_ms = elapsed(start);
            black_box(&bytes);
            let start = Instant::now();
            let parsed = validation::parse_table_bytes(&bytes, &TableLimits::default()).unwrap();
            let parse_ms = elapsed(start);
            black_box(&parsed);
            let start = Instant::now();
            let read = crate::table_commands::read_in_vault(vault, &read_request).unwrap();
            let command_read_ms = elapsed(start);
            let start = Instant::now();
            let serialized = serde_json::to_vec(&read).unwrap();
            let serialize_read_ms = elapsed(start);
            black_box(&serialized);
            let start = Instant::now();
            crate::ensure_no_unfinished_git_operation(vault).unwrap();
            let git_check_ms = elapsed(start);
            samples.push(json!({"kind":"read","sample":sample,"readBytesMs":read_bytes_ms,"parseValidateMs":parse_ms,"readInVaultMs":command_read_ms,"serializeReadMs":serialize_read_ms,"gitCheckMs":git_check_ms,"responseBytes":serialized.len()}));
        }
        let mut revision = created.revision;
        let mut hash = created.content_hash.clone();
        for (kind, count) in [("edit", 1usize), ("paste1000x10", 10_000usize)] {
            for sample in 0..SAMPLES {
                let cells = if count == 1 {
                    vec![CellEdit {
                        record_id: content.record_order[(sample * 479) % rows].clone(),
                        field_id: content.primary_field_id.clone(),
                        value: CellValue::Text(format!("单格编辑 {sample} · 真实落盘")),
                    }]
                } else {
                    (0..1000)
                        .flat_map(|row| (0..10).map(move |column| (row, column)))
                        .map(|(row, column)| {
                            let field_id = &content.field_order[column];
                            CellEdit {
                                record_id: content.record_order[row].clone(),
                                field_id: field_id.clone(),
                                value: value(row, column, sample + 100, &content.fields[field_id]),
                            }
                        })
                        .collect()
                };
                let request = ApplyTableMutationsRequest {
                    path: created.path.clone(),
                    table_id: created.file.id.clone(),
                    expected_revision: revision,
                    expected_hash: hash.clone(),
                    mutation_id: id(
                        "mut",
                        rows * 1000 + if count == 1 { sample } else { 100 + sample },
                    ),
                    operations: vec![TableMutation::SetCells { cells }],
                };
                let request_bytes = serde_json::to_vec(&request).unwrap().len();
                let start = Instant::now();
                let result = {
                    let _gate = crate::lock_vault_gate(vault);
                    crate::table_commands::apply_in_vault(vault, &request).unwrap()
                };
                let save_ms = elapsed(start);
                let start = Instant::now();
                let serialized = serde_json::to_vec(&result).unwrap();
                let serialize_ack_ms = elapsed(start);
                black_box(&serialized);
                let bytes = fs::read(&absolute).unwrap();
                assert_eq!(storage::sha256(&bytes), result.content_hash);
                assert_eq!(result.revision, revision + 1);
                assert!(!result.changed_records.is_empty());
                revision = result.revision;
                hash = result.content_hash;
                samples.push(json!({"kind":kind,"sample":sample,"cells":count,"applyInVaultMs":save_ms,"serializeAckMs":serialize_ack_ms,"requestBytes":request_bytes,"responseBytes":serialized.len(),"fileBytes":bytes.len(),"changedRecords":result.changed_records.len(),"revision":revision}));
                println!(
                    "{rows}x{columns} {kind} {sample}: {save_ms:.2} ms, {} byte response",
                    serialized.len()
                );
            }
        }
        let final_read = crate::table_commands::read_in_vault(vault, &read_request).unwrap();
        assert_eq!(final_read.revision, revision);
        assert_eq!(final_read.content_hash, hash);
        assert_eq!(
            git(vault, &["rev-parse", "HEAD"]),
            original_head,
            "content saves must not create commits"
        );
        assert!(
            !git(vault, &["status", "--porcelain"]).trim().is_empty(),
            "content saves must remain pending checkpoint"
        );
        for entry in fs::read_dir(vault.join("notes")).unwrap() {
            assert!(!entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".table-tmp-"));
        }
        let mut summary = serde_json::Map::new();
        for (kind, metrics) in [
            (
                "read",
                vec![
                    "readBytesMs",
                    "parseValidateMs",
                    "readInVaultMs",
                    "serializeReadMs",
                    "gitCheckMs",
                ],
            ),
            ("edit", vec!["applyInVaultMs", "serializeAckMs"]),
            ("paste1000x10", vec!["applyInVaultMs", "serializeAckMs"]),
        ] {
            let mut distributions = serde_json::Map::new();
            for metric in metrics {
                let values = samples
                    .iter()
                    .filter(|item| item["kind"] == kind)
                    .map(|item| item[metric].as_f64().unwrap())
                    .collect::<Vec<_>>();
                distributions.insert(metric.into(), distribution(&values));
            }
            summary.insert(kind.into(), Value::Object(distributions));
        }
        let dataset = json!({"rows":rows,"columns":columns,"cells":rows*columns,"fixture":"six field types; Chinese text; null every 17 cells; empty text; 560+ character text every 100 rows; multi-select two of four options","initialFileBytes":initial_bytes.len(),"finalFileBytes":fs::metadata(&absolute).unwrap().len(),"createInVaultMs":create_ms,"vaultTableFiles":1,"pasteRectangle":{"rows":1000,"columns":10},"git":{"realRepository":true,"commitsBefore":1,"commitsAfter":1,"remotes":git(vault,&["remote"]).trim(),"contentWritesRemainUncommitted":true},"summary":summary,"samples":samples});
        println!(
            "DATASET {}",
            serde_json::to_string(&dataset["summary"]).unwrap()
        );
        report["datasets"].as_array_mut().unwrap().push(dataset);
        save_report(&output, &report);
    }
    report["finishedAt"] = json!(chrono::Utc::now().to_rfc3339());
    save_report(&output, &report);
    println!("TABLE_PERFORMANCE_RESULT={}", output.display());
}
