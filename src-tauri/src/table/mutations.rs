use super::{
    model::*,
    storage::{canonical_bytes, mutation_payload_hash, sha256},
    validation::*,
};
use std::collections::{BTreeMap, BTreeSet};

fn invalid(message: &str) -> TableError {
    TableError::new("INVALID_MODEL", message, "")
}
fn insert_before(order: &mut Vec<String>, id: String, before: Option<&String>) -> TableResult<()> {
    let position = match before {
        Some(target) => order
            .iter()
            .position(|item| item == target)
            .ok_or_else(|| invalid("插入位置不存在"))?,
        None => order.len(),
    };
    order.insert(position, id);
    Ok(())
}
fn require_unique(ids: &[String]) -> TableResult<()> {
    if ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
        Err(invalid("操作包含重复 ID"))
    } else {
        Ok(())
    }
}

/// Pure operation evaluation. The hash is of the original bytes, not a reserialization.
// Retain full validation for untrusted callers and shared-fixture parity tests;
// production storage uses the strict parser's immutable token below.
#[cfg_attr(not(test), allow(dead_code))]
pub fn apply_mutations(
    current: &TableFile,
    current_hash: &str,
    request: &ApplyTableMutationsRequest,
    now: &str,
    limits: &TableLimits,
) -> TableResult<(TableFile, ApplyTableMutationsResult)> {
    validate_table(current, limits)?;
    let prepared = prepare_validated_mutations(current, current_hash, request, now, limits)?;
    Ok((prepared.file, prepared.result))
}

pub(super) struct PreparedTableMutation {
    // The pure public evaluator returns this file for validation/fixture parity.
    // Storage writes the prepared bytes and only returns the incremental result.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) file: TableFile,
    pub(super) result: ApplyTableMutationsResult,
    pub(super) bytes: Vec<u8>,
}

pub(super) fn prepare_parsed_mutations(
    current: &ParsedTableFile,
    current_hash: &str,
    request: &ApplyTableMutationsRequest,
    now: &str,
) -> TableResult<PreparedTableMutation> {
    prepare_validated_mutations(current.file(), current_hash, request, now, current.limits())
}

fn prepare_validated_mutations(
    current: &TableFile,
    current_hash: &str,
    request: &ApplyTableMutationsRequest,
    now: &str,
    limits: &TableLimits,
) -> TableResult<PreparedTableMutation> {
    let mut latest_time = validate_timestamp(now, "/updatedAt")?;
    let mut save_time = now;
    let existing_times = std::iter::once(current.created_at.as_str())
        .chain(std::iter::once(current.updated_at.as_str()))
        .chain(
            current
                .records
                .values()
                .flat_map(|record| [record.created_at.as_str(), record.updated_at.as_str()]),
        );
    let inserted_times = request
        .operations
        .iter()
        .flat_map(|operation| match operation {
            TableMutation::InsertRecords { records, .. } => records
                .iter()
                .filter_map(|record| record.created_at.as_deref())
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        });
    for timestamp in existing_times.chain(inserted_times) {
        let parsed = validate_timestamp(timestamp, "/updatedAt")?;
        if parsed > latest_time {
            latest_time = parsed;
            save_time = timestamp;
        }
    }
    if !valid_id(&request.mutation_id, "mut_") || !valid_hash(&request.expected_hash) {
        return Err(invalid("操作 ID/hash 无效"));
    }
    if request.table_id != current.id {
        return Err(TableError::new(
            "IDENTITY_MISMATCH",
            "目标表 ID 已变化",
            "/tableId",
        ));
    }
    if request.operations.is_empty() || request.operations.len() > limits.max_operations {
        return Err(TableError::new(
            "LIMIT_EXCEEDED",
            "操作批次为空或超过上限",
            "/operations",
        ));
    }
    if canonical_bytes(request)?.len() > limits.max_request_bytes {
        return Err(TableError::new(
            "LIMIT_EXCEEDED",
            "操作请求超过字节上限",
            "",
        ));
    }
    let explicit_cells = request
        .operations
        .iter()
        .map(|op| match op {
            TableMutation::SetCells { cells } => cells.len(),
            TableMutation::InsertRecords { records, .. } => {
                records.iter().map(|r| r.values.len()).sum()
            }
            _ => 0usize,
        })
        .sum::<usize>();
    if explicit_cells > limits.max_explicit_cells {
        return Err(TableError::new(
            "LIMIT_EXCEEDED",
            "批次单元格数量超过上限",
            "/operations",
        ));
    }
    let payload_hash = mutation_payload_hash(request)?;
    if current.last_mutation_id.as_deref() == Some(&request.mutation_id) {
        if current.last_mutation_hash.as_deref() != Some(&payload_hash) {
            return Err(TableError::new(
                "IDEMPOTENCY_CONFLICT",
                "同一操作 ID 对应不同请求",
                "/mutationId",
            ));
        }
        return Err(TableError::new(
            "ALREADY_APPLIED",
            "此批已应用，请读取完整快照确认",
            "/mutationId",
        ));
    }
    if request.expected_revision != current.revision || request.expected_hash != current_hash {
        return Err(TableError::new(
            "STALE_BASE",
            "磁盘内容已变化，保存已中止",
            "/expectedHash",
        ));
    }
    if current.revision >= MAX_SAFE_INTEGER {
        return Err(invalid("revision 已达上限"));
    }
    let mut next = current.clone();
    for (index, operation) in request.operations.iter().enumerate() {
        apply_one(&mut next, operation, save_time, limits)
            .map_err(|err| err.at_operation(index))?;
    }
    next.revision += 1;
    next.updated_at = save_time.into();
    next.last_mutation_id = Some(request.mutation_id.clone());
    next.last_mutation_hash = Some(payload_hash);
    // Validate before normalization so duplicate multi-select values cannot be repaired silently.
    validate_table(&next, limits)?;
    normalize_values(&mut next);
    let bytes = canonical_bytes(&next)?;
    if bytes.len() > limits.max_file_bytes {
        return Err(TableError::new(
            "LIMIT_EXCEEDED",
            "修改后的文件超过字节上限",
            "",
        ));
    }
    let result = ApplyTableMutationsResult {
        table_id: next.id.clone(),
        path: request.path.clone(),
        mutation_id: request.mutation_id.clone(),
        base_revision: current.revision,
        revision: next.revision,
        content_hash: sha256(&bytes),
        updated_at: next.updated_at.clone(),
        changed_records: changed(&current.records, &next.records),
        deleted_record_ids: deleted(&current.records, &next.records),
        changed_fields: changed(&current.fields, &next.fields),
        deleted_field_ids: deleted(&current.fields, &next.fields),
        changed_views: changed(&current.views, &next.views),
        deleted_view_ids: deleted(&current.views, &next.views),
        field_order: (current.field_order != next.field_order).then(|| next.field_order.clone()),
        record_order: (current.record_order != next.record_order)
            .then(|| next.record_order.clone()),
        view_order: (current.view_order != next.view_order).then(|| next.view_order.clone()),
    };
    Ok(PreparedTableMutation {
        file: next,
        result,
        bytes,
    })
}
fn changed<T: PartialEq + Clone>(
    before: &BTreeMap<String, T>,
    after: &BTreeMap<String, T>,
) -> Vec<T> {
    after
        .iter()
        .filter(|(id, value)| before.get(*id) != Some(*value))
        .map(|(_, value)| value.clone())
        .collect()
}
fn deleted<T>(before: &BTreeMap<String, T>, after: &BTreeMap<String, T>) -> Vec<String> {
    before
        .keys()
        .filter(|id| !after.contains_key(*id))
        .cloned()
        .collect()
}

fn apply_one(
    file: &mut TableFile,
    operation: &TableMutation,
    now: &str,
    limits: &TableLimits,
) -> TableResult<()> {
    use TableMutation::*;
    match operation {
        SetCells { cells } => {
            let mut seen = BTreeSet::new();
            for cell in cells {
                if !seen.insert((&cell.record_id, &cell.field_id)) {
                    return Err(invalid("setCells 包含重复坐标"));
                }
                if !file.fields.contains_key(&cell.field_id) {
                    return Err(invalid("目标字段不存在"));
                }
                let record = file
                    .records
                    .get_mut(&cell.record_id)
                    .ok_or_else(|| invalid("目标记录不存在"))?;
                let old = record.values.get(&cell.field_id);
                let changed = if matches!(cell.value, CellValue::Null) {
                    old.is_some()
                } else {
                    old != Some(&cell.value)
                };
                if changed {
                    if matches!(cell.value, CellValue::Null) {
                        record.values.remove(&cell.field_id);
                    } else {
                        record
                            .values
                            .insert(cell.field_id.clone(), cell.value.clone());
                    }
                    record.updated_at = now.into();
                }
            }
        }
        InsertRecords {
            records,
            before_record_id,
        } => {
            for input in records {
                if file.records.contains_key(&input.id) {
                    return Err(invalid("插入记录 ID 已存在"));
                }
                insert_before(
                    &mut file.record_order,
                    input.id.clone(),
                    before_record_id.as_ref(),
                )?;
                file.records.insert(
                    input.id.clone(),
                    TableRecord {
                        id: input.id.clone(),
                        created_at: input.created_at.clone().unwrap_or_else(|| now.into()),
                        updated_at: now.into(),
                        values: input.values.clone(),
                    },
                );
            }
        }
        DeleteRecords { record_ids } => {
            require_unique(record_ids)?;
            for id in record_ids {
                if file.records.remove(id).is_none() {
                    return Err(invalid("删除的记录不存在"));
                }
            }
            file.record_order.retain(|id| !record_ids.contains(id));
        }
        SetRecordOrder { record_ids } => {
            validate_order(record_ids, file.records.keys(), "/recordOrder")?;
            file.record_order = record_ids.clone();
        }
        PutField {
            field,
            before_field_id,
        } => {
            validate_field(field, "/field", limits)?;
            if let Some(existing) = file.fields.get(&field.id) {
                if before_field_id.is_some() {
                    return Err(invalid("更新已有字段不能指定插入位置"));
                }
                if existing.field_type != field.field_type {
                    if field.id == file.primary_field_id {
                        return Err(invalid("不能修改主字段类型"));
                    }
                    if file.records.values().any(|record| {
                        record
                            .values
                            .get(&field.id)
                            .is_some_and(|value| !matches!(value, CellValue::Null))
                    }) {
                        return Err(invalid("非空字段不能直接换类型"));
                    }
                }
            } else {
                insert_before(
                    &mut file.field_order,
                    field.id.clone(),
                    before_field_id.as_ref(),
                )?;
                for view in file.views.values_mut() {
                    view.field_order.push(field.id.clone());
                }
            }
            file.fields.insert(field.id.clone(), field.clone());
        }
        DeleteField { field_id } => {
            if field_id == &file.primary_field_id {
                return Err(invalid("不能删除主字段"));
            }
            if file.fields.remove(field_id).is_none() {
                return Err(invalid("删除的字段不存在"));
            }
            file.field_order.retain(|id| id != field_id);
            for record in file.records.values_mut() {
                if record.values.remove(field_id).is_some() {
                    record.updated_at = now.into();
                }
            }
            for view in file.views.values_mut() {
                view.field_order.retain(|id| id != field_id);
                view.hidden_field_ids.retain(|id| id != field_id);
                view.column_widths.remove(field_id);
                view.filters
                    .conditions
                    .retain(|condition| condition.field_id() != field_id);
                view.sorts.retain(|sort| &sort.field_id != field_id);
                if view.group_by.as_ref() == Some(field_id) {
                    view.group_by = None;
                }
            }
        }
        SetFieldOrder { field_ids } => {
            validate_order(field_ids, file.fields.keys(), "/fieldOrder")?;
            file.field_order = field_ids.clone();
        }
        PutView {
            view,
            before_view_id,
        } => {
            if file.views.contains_key(&view.id) {
                if before_view_id.is_some() {
                    return Err(invalid("更新已有视图不能指定插入位置"));
                }
            } else {
                insert_before(
                    &mut file.view_order,
                    view.id.clone(),
                    before_view_id.as_ref(),
                )?;
            }
            file.views.insert(view.id.clone(), view.clone());
        }
        DeleteView { view_id } => {
            if file.views.len() <= 1 {
                return Err(invalid("不能删除最后一个视图"));
            }
            if file.views.remove(view_id).is_none() {
                return Err(invalid("删除的视图不存在"));
            }
            file.view_order.retain(|id| id != view_id);
        }
        SetViewOrder { view_ids } => {
            validate_order(view_ids, file.views.keys(), "/viewOrder")?;
            file.view_order = view_ids.clone();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::PathBuf;
    fn fixtures() -> PathBuf {
        option_env!("SHARD_TABLE_FIXTURES")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/tables")
            })
    }
    fn request(
        file: &TableFile,
        hash: &str,
        operations: Vec<TableMutation>,
    ) -> ApplyTableMutationsRequest {
        ApplyTableMutationsRequest {
            path: "notes/样例.shardtable.json".into(),
            table_id: file.id.clone(),
            expected_revision: file.revision,
            expected_hash: hash.into(),
            mutation_id: format!("mut_{:032x}", 1),
            operations,
        }
    }
    #[test]
    fn evaluates_shared_real_operation_batches() {
        let root = fixtures();
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
        let limits = TableLimits::default();
        for entry in manifest["operations"].as_array().unwrap() {
            let case: Value = serde_json::from_slice(
                &std::fs::read(root.join(entry["file"].as_str().unwrap())).unwrap(),
            )
            .unwrap();
            let bytes = std::fs::read(root.join(case["source"].as_str().unwrap())).unwrap();
            let current = parse_table_bytes(&bytes, &limits).unwrap();
            let original = current.clone();
            let req = request(
                &current,
                &sha256(&bytes),
                serde_json::from_value(case["operations"].clone()).unwrap(),
            );
            let result = apply_mutations(
                &current,
                &sha256(&bytes),
                &req,
                "2026-09-07T01:00:00.000Z",
                &limits,
            );
            if let Some(code) = case["expected"]["errorCode"].as_str() {
                assert_eq!(result.unwrap_err().code, code, "{entry}");
                assert_eq!(current, original);
            } else {
                let (next, ack) = result.unwrap();
                assert_eq!(ack.revision, current.revision + 1);
                assert_eq!(ack.content_hash, sha256(&canonical_bytes(&next).unwrap()));
                if let Some(records) = case["expected"]["changedValues"].as_object() {
                    for (id, values) in records {
                        for (field, value) in values.as_object().unwrap() {
                            let expected: CellValue =
                                serde_json::from_value(value.clone()).unwrap();
                            assert_eq!(next.records[id].values.get(field), Some(&expected));
                        }
                    }
                }
                if let Some(field) = case["expected"]["mustRemoveValuesForField"].as_str() {
                    assert!(!next.fields.contains_key(field));
                    assert!(next.records.values().all(|r| !r.values.contains_key(field)));
                    assert!(next.views.values().all(|v| !v
                        .field_order
                        .iter()
                        .any(|id| id == field)
                        && !v.filters.conditions.iter().any(|c| c.field_id() == field)
                        && !v.sorts.iter().any(|s| s.field_id == field)
                        && v.group_by.as_deref() != Some(field)
                        && !v.hidden_field_ids.iter().any(|id| id == field)
                        && !v.column_widths.contains_key(field)));
                }
            }
        }
    }
    #[test]
    fn unknown_response_and_reused_id_do_not_apply_twice() {
        let bytes = std::fs::read(fixtures().join("valid/six-types.json")).unwrap();
        let limits = TableLimits::default();
        let current = parse_table_bytes(&bytes, &limits).unwrap();
        let op = TableMutation::SetCells {
            cells: vec![CellEdit {
                record_id: format!("rec_{:032x}", 1),
                field_id: format!("fld_{:032x}", 2),
                value: CellValue::Number(10.0),
            }],
        };
        let mut req = request(&current, &sha256(&bytes), vec![op]);
        let (next, ack) = apply_mutations(
            &current,
            &sha256(&bytes),
            &req,
            "2026-09-07T01:00:00.000Z",
            &limits,
        )
        .unwrap();
        assert_eq!(
            apply_mutations(
                &next,
                &ack.content_hash,
                &req,
                "2026-09-07T01:00:00.000Z",
                &limits
            )
            .unwrap_err()
            .code,
            "ALREADY_APPLIED"
        );
        req.operations.clear();
        req.operations.push(TableMutation::DeleteRecords {
            record_ids: vec![format!("rec_{:032x}", 1)],
        });
        assert_eq!(
            apply_mutations(
                &next,
                &ack.content_hash,
                &req,
                "2026-09-07T01:00:00.000Z",
                &limits
            )
            .unwrap_err()
            .code,
            "IDEMPOTENCY_CONFLICT"
        );
        req.mutation_id = format!("mut_{:032x}", 2);
        assert_eq!(
            apply_mutations(
                &next,
                &ack.content_hash,
                &req,
                "2026-09-07T01:00:00.000Z",
                &limits
            )
            .unwrap_err()
            .code,
            "STALE_BASE"
        );
    }

    #[test]
    fn field_delete_can_be_undone_against_the_latest_baseline() {
        let limits = TableLimits::default();
        let bytes = std::fs::read(fixtures().join("valid/independent-views.json")).unwrap();
        let original = parse_table_bytes(&bytes, &limits).unwrap();
        let field_id = format!("fld_{:032x}", 4);
        let delete = request(
            &original,
            &sha256(&bytes),
            vec![TableMutation::DeleteField {
                field_id: field_id.clone(),
            }],
        );
        let (deleted, ack) = apply_mutations(
            &original,
            &sha256(&bytes),
            &delete,
            "2026-09-07T01:00:00.000Z",
            &limits,
        )
        .unwrap();
        let mut operations = vec![TableMutation::PutField {
            field: original.fields[&field_id].clone(),
            before_field_id: None,
        }];
        operations.push(TableMutation::SetCells {
            cells: original
                .records
                .values()
                .filter_map(|record| {
                    record.values.get(&field_id).map(|value| CellEdit {
                        record_id: record.id.clone(),
                        field_id: field_id.clone(),
                        value: value.clone(),
                    })
                })
                .collect(),
        });
        operations.push(TableMutation::SetFieldOrder {
            field_ids: original.field_order.clone(),
        });
        operations.extend(
            original
                .views
                .values()
                .cloned()
                .map(|view| TableMutation::PutView {
                    view,
                    before_view_id: None,
                }),
        );
        let mut undo = request(&deleted, &ack.content_hash, operations);
        undo.mutation_id = format!("mut_{:032x}", 2);
        let (restored, _) = apply_mutations(
            &deleted,
            &ack.content_hash,
            &undo,
            "2026-09-07T02:00:00.000Z",
            &limits,
        )
        .unwrap();
        assert_eq!(restored.fields, original.fields);
        assert_eq!(restored.views, original.views);
        assert_eq!(restored.field_order, original.field_order);
        let mut normalized = original;
        normalize_values(&mut normalized);
        for (id, record) in &restored.records {
            assert_eq!(record.values, normalized.records[id].values);
            assert_eq!(record.created_at, normalized.records[id].created_at);
        }
        assert_eq!(restored.revision, 3);
    }

    #[test]
    fn clock_behind_imported_metadata_does_not_make_valid_table_uneditable() {
        let limits = TableLimits::default();
        let bytes = std::fs::read(fixtures().join("valid/six-types.json")).unwrap();
        let current = parse_table_bytes(&bytes, &limits).unwrap();
        let edit = request(
            &current,
            &sha256(&bytes),
            vec![TableMutation::SetCells {
                cells: vec![CellEdit {
                    record_id: format!("rec_{:032x}", 1),
                    field_id: format!("fld_{:032x}", 2),
                    value: CellValue::Number(99.0),
                }],
            }],
        );
        let (next, _) = apply_mutations(
            &current,
            &sha256(&bytes),
            &edit,
            "2000-01-01T00:00:00.000Z",
            &limits,
        )
        .unwrap();
        assert_eq!(next.updated_at, current.updated_at);
        let row_id = format!("rec_{:032x}", 1);
        assert_eq!(
            next.records[&row_id].updated_at,
            current.records[&row_id].updated_at
        );
        assert_eq!(
            next.records[&row_id].values[&format!("fld_{:032x}", 2)],
            CellValue::Number(99.0)
        );
    }
}
