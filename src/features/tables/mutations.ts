import { TABLE_LIMITS, TableValidationError, businessSnapshot, canonicalJson, laterTimestamp, normalizeCellValue, normalizeTableContent, objectShape, tableAssert,
  validateCellValue, validateField, validateId, validateOrder, validateTableContent, validateTableRecord, validateTimestamp, validateView,
  type CellValue, type FieldId, type MutationId, type RecordId, type Sha256, type TableContent,
  type TableField, type TableId, type TableRecord, type TableView, type Timestamp, type ViewId } from "./model"

export type CellEdit = { recordId: RecordId; fieldId: FieldId; value: CellValue }
export type NewRecord = { id: RecordId; values: Record<FieldId, CellValue>; createdAt?: Timestamp }
export type TableMutation =
  | { type: "setCells"; cells: CellEdit[] }
  | { type: "insertRecords"; records: NewRecord[]; beforeRecordId: RecordId | null }
  | { type: "deleteRecords"; recordIds: RecordId[] }
  | { type: "setRecordOrder"; recordIds: RecordId[] }
  | { type: "putField"; field: TableField; beforeFieldId: FieldId | null }
  | { type: "deleteField"; fieldId: FieldId }
  | { type: "setFieldOrder"; fieldIds: FieldId[] }
  | { type: "putView"; view: TableView; beforeViewId: ViewId | null }
  | { type: "deleteView"; viewId: ViewId }
  | { type: "setViewOrder"; viewIds: ViewId[] }
export type ApplyTableMutationsRequest = {
  path: string; tableId: TableId; expectedRevision: number; expectedHash: Sha256; mutationId: MutationId; operations: TableMutation[]
}
export type ApplyTableMutationsResult = {
  tableId: TableId; path: string; mutationId: MutationId; baseRevision: number; revision: number; contentHash: Sha256; updatedAt: Timestamp
  changedRecords: TableRecord[]; deletedRecordIds: RecordId[]; changedFields: TableField[]; deletedFieldIds: FieldId[]
  changedViews: TableView[]; deletedViewIds: ViewId[]; fieldOrder?: FieldId[]; recordOrder?: RecordId[]; viewOrder?: ViewId[]
}

// Only recursively frozen snapshots created here can use the local cell path.
// Public mutable inputs still enter through full validation; a previously validated
// object is never treated as trusted merely because its identity was seen before.
const ownedContents = new WeakMap<TableContent, Timestamp>()
const preparedChanges = new WeakSet<PreparedTableChange>()
function freezeOwnedValue<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeOwnedValue(child)
    Object.freeze(value)
  }
  return value
}
function sealOwnedContent(content: TableContent, timestamp?: Timestamp): TableContent {
  if (timestamp === undefined) {
    timestamp = "0001-01-01T00:00:00Z"
    for (const record of Object.values(content.records)) timestamp = laterTimestamp(timestamp, laterTimestamp(record.createdAt, record.updatedAt))
  }
  freezeOwnedValue(content); ownedContents.set(content, timestamp); return content
}
export function createOwnedTableContent(content: TableContent): TableContent {
  validateTableContent(content)
  return sealOwnedContent(normalizeTableContent(content))
}
export function ownedTableTimestamp(content: TableContent): Timestamp {
  const timestamp = ownedContents.get(content)
  tableAssert(timestamp !== undefined, "", "内部快照必须经过完整验证并保持不可变")
  return timestamp
}
export type PreparedTableChange = {
  readonly source: TableContent; readonly content: TableContent
  readonly operations: readonly TableMutation[]; readonly inverse: readonly TableMutation[]
  readonly changed: boolean
  // null means a structural batch, for which callers must refresh the whole projection.
  readonly changedRecordIds: readonly RecordId[] | null; readonly changedFieldIds: readonly FieldId[] | null
}
export function assertPreparedTableChange(change: PreparedTableChange, source: TableContent) {
  tableAssert(preparedChanges.has(change) && change.source === source, "", "修改不是当前草稿的已验证结果")
}
function prepareResult(change: PreparedTableChange): PreparedTableChange {
  freezeOwnedValue(change); preparedChanges.add(change); return change
}
export function prepareTableMutations(source: TableContent, operations: readonly TableMutation[], timestamp: Timestamp): PreparedTableChange {
  const sourceTimestamp = ownedTableTimestamp(source)
  validateMutationBatch(operations); validateTimestamp(timestamp, "/updatedAt")
  timestamp = laterTimestamp(timestamp, sourceTimestamp)
  const forward = structuredClone(operations) as TableMutation[]
  if (!forward.every(operation => operation.type === "setCells")) {
    const next = applyTableMutations(source, forward, timestamp)
    const changed = businessSnapshot(source) !== businessSnapshot(next)
    return prepareResult({ source, content: changed ? sealOwnedContent(next) : source, operations: changed ? forward : [],
      inverse: changed ? restorationMutations(next, source) : [], changed, changedRecordIds: null, changedFieldIds: null })
  }
  const touched = new Map<RecordId, { record: TableRecord; fields: Set<FieldId> }>()
  for (const [operationIndex, operation] of forward.entries()) {
    if (operation.type !== "setCells") continue
    try {
      for (const cell of operation.cells) {
        const original = source.records[cell.recordId]
        tableAssert(original && source.fields[cell.fieldId], `/operations/${operationIndex}`, "记录或字段不存在")
        let entry = touched.get(cell.recordId)
        if (!entry) { entry = { record: { ...original, values: { ...original.values }, updatedAt: timestamp }, fields: new Set() }; touched.set(cell.recordId, entry) }
        entry.fields.add(cell.fieldId); entry.record.values[cell.fieldId] = cell.value
      }
    } catch (error) { if (error instanceof TableValidationError) error.operationIndex = operationIndex; throw error }
  }
  const inverse: CellEdit[] = []; const changedRecordIds: RecordId[] = []; const changedFields = new Set<FieldId>()
  for (const [recordId, { record, fields }] of touched) {
    let changed = false
    for (const fieldId of fields) {
      // The complete batch determines the final value, matching the general path.
      const value = record.values[fieldId]
      validateCellValue(source.fields[fieldId], value, `/records/${recordId}/values/${fieldId}`)
      if (value === null) delete record.values[fieldId]
      else record.values[fieldId] = normalizeCellValue(value)
      const before = source.records[recordId].values[fieldId] ?? null; const after = record.values[fieldId] ?? null
      if (canonicalJson(before) !== canonicalJson(after)) {
        inverse.push({ recordId, fieldId, value: structuredClone(before) }); changed = true; changedFields.add(fieldId)
      }
    }
    if (changed) changedRecordIds.push(recordId)
  }
  const changed = changedRecordIds.length > 0
  let content = source
  if (changed) {
    const records = { ...source.records }
    for (const [id, entry] of touched) records[id] = entry.record
    content = sealOwnedContent({ ...source, records }, timestamp)
  }
  return prepareResult({ source, content, operations: changed ? forward : [], inverse: changed ? [{ type: "setCells", cells: inverse }] : [],
    changed, changedRecordIds, changedFieldIds: [...changedFields] })
}
// A save acknowledgement may replace existing records, never smuggle structural changes.
// Each untrusted replacement is fully validated before sharing any prior immutable rows.
export function replaceOwnedTableRecords(source: TableContent, changes: readonly TableRecord[]): TableContent {
  let timestamp = ownedTableTimestamp(source)
  if (changes.length === 0) return source
  const records = { ...source.records }; const seen = new Set<string>()
  for (const record of changes) {
    tableAssert(record && typeof record.id === "string" && !!source.records[record.id] && !seen.has(record.id), "", "保存响应记录不存在或重复")
    seen.add(record.id); validateTableRecord(record, source.fields, record.id)
    const next = structuredClone(record)
    for (const [id, cell] of Object.entries(next.values)) { if (cell === null) delete next.values[id]; else next.values[id] = normalizeCellValue(cell) }
    timestamp = laterTimestamp(timestamp, laterTimestamp(next.createdAt, next.updatedAt)); records[next.id] = next
  }
  return sealOwnedContent({ ...source, records }, timestamp)
}

export function validateMutationBatch(operations: unknown): asserts operations is TableMutation[] {
  tableAssert(Array.isArray(operations) && operations.length > 0, "/operations", "修改批次不能为空")
  tableAssert(operations.length <= TABLE_LIMITS.operations, "/operations", "操作数量超过容量限制", "LIMIT_EXCEEDED")
  let cells = 0
  operations.forEach((value, index) => {
    const p = `/operations/${index}`; const op = objectShape(value, p)
    switch (op.type) {
      case "setCells": {
        objectShape(op, p, ["type", "cells"]); tableAssert(Array.isArray(op.cells), `${p}/cells`)
        const seen = new Set<string>()
        op.cells.forEach((value, i) => { const cell = objectShape(value, `${p}/cells/${i}`, ["recordId", "fieldId", "value"])
          validateId(cell.recordId, "rec", `${p}/cells/${i}/recordId`); validateId(cell.fieldId, "fld", `${p}/cells/${i}/fieldId`)
          const key = `${cell.recordId}/${cell.fieldId}`; tableAssert(!seen.has(key), `${p}/cells/${i}`, "同一操作不能重复修改单元格"); seen.add(key) })
        cells += op.cells.length; break
      }
      case "insertRecords":
        objectShape(op, p, ["type", "records", "beforeRecordId"]); tableAssert(Array.isArray(op.records), `${p}/records`)
        if (op.beforeRecordId !== null) validateId(op.beforeRecordId, "rec", `${p}/beforeRecordId`)
        op.records.forEach((value, i) => { const record = objectShape(value, `${p}/records/${i}`, ["id", "values", "createdAt"], ["createdAt"])
          validateId(record.id, "rec", `${p}/records/${i}/id`); const values = objectShape(record.values, `${p}/records/${i}/values`)
          if (record.createdAt !== undefined) validateTimestamp(record.createdAt, `${p}/records/${i}/createdAt`)
          cells += Object.keys(values).length })
        break
      case "deleteRecords": case "setRecordOrder": case "setFieldOrder": case "setViewOrder": {
        const key = op.type === "setFieldOrder" ? "fieldIds" : op.type === "setViewOrder" ? "viewIds" : "recordIds"
        objectShape(op, p, ["type", key]); tableAssert(Array.isArray(op[key]) && new Set(op[key]).size === (op[key] as unknown[]).length, `${p}/${key}`)
        ;(op[key] as unknown[]).forEach(id => validateId(id, key === "fieldIds" ? "fld" : key === "viewIds" ? "view" : "rec", `${p}/${key}`)); break
      }
      case "putField": objectShape(op, p, ["type", "field", "beforeFieldId"]); validateField(op.field, `${p}/field`); if (op.beforeFieldId !== null) validateId(op.beforeFieldId, "fld", `${p}/beforeFieldId`); break
      case "deleteField": objectShape(op, p, ["type", "fieldId"]); validateId(op.fieldId, "fld", `${p}/fieldId`); break
      case "putView": objectShape(op, p, ["type", "view", "beforeViewId"]); objectShape(op.view, `${p}/view`); if (op.beforeViewId !== null) validateId(op.beforeViewId, "view", `${p}/beforeViewId`); break
      case "deleteView": objectShape(op, p, ["type", "viewId"]); validateId(op.viewId, "view", `${p}/viewId`); break
      default: tableAssert(false, `${p}/type`, "未知修改操作")
    }
  })
  tableAssert(cells <= TABLE_LIMITS.mutationCells, "/operations", "单元格修改数量超过容量限制", "LIMIT_EXCEEDED")
  tableAssert(new TextEncoder().encode(JSON.stringify(operations)).byteLength <= TABLE_LIMITS.mutationBytes, "/operations", "修改请求超过容量限制", "LIMIT_EXCEEDED")
}

function insertBefore(order: string[], ids: string[], before: string | null, pointer: string) {
  const index = before === null ? order.length : order.indexOf(before)
  tableAssert(index >= 0, pointer, "插入位置不存在"); order.splice(index, 0, ...ids)
}
// Atomically applies the ten domain operations to a clone. Call in the table Worker, not an event handler.
export function applyTableMutations(source: TableContent, operations: readonly TableMutation[], timestamp: Timestamp): TableContent {
  validateTableContent(source); validateMutationBatch(operations); validateTimestamp(timestamp, "/updatedAt")
  for (const record of Object.values(source.records)) timestamp = laterTimestamp(timestamp, laterTimestamp(record.createdAt, record.updatedAt))
  for (const op of operations) if (op.type === "insertRecords") for (const record of op.records) if (record.createdAt) timestamp = laterTimestamp(timestamp, record.createdAt)
  const content = structuredClone(source)
  for (const [operationIndex, op] of operations.entries()) {
    const p = `/operations/${operationIndex}`
    try {
      switch (op.type) {
        case "setCells":
          for (const cell of op.cells) {
            const record = content.records[cell.recordId]; tableAssert(record && content.fields[cell.fieldId], p, "记录或字段不存在")
            // Option/value consistency is checked after the whole batch, allowing explicit replacements.
            record.values[cell.fieldId] = structuredClone(cell.value); record.updatedAt = timestamp
          }
          break
        case "insertRecords": {
          const ids: string[] = []
          for (const record of op.records) {
            tableAssert(!content.records[record.id], p, "不能覆盖现有记录")
            for (const id of Object.keys(record.values)) tableAssert(content.fields[id], p, "字段不存在")
            content.records[record.id] = { id: record.id, values: structuredClone(record.values), createdAt: record.createdAt ?? timestamp, updatedAt: timestamp }; ids.push(record.id)
          }
          // Anchor must have existed before this insertion, not be one of the new records.
          insertBefore(content.recordOrder, ids, op.beforeRecordId, p); break
        }
        case "deleteRecords":
          for (const id of op.recordIds) { tableAssert(content.records[id], p, "记录不存在"); delete content.records[id] }
          content.recordOrder = content.recordOrder.filter(id => !op.recordIds.includes(id)); break
        case "setRecordOrder": validateOrder(op.recordIds, Object.keys(content.records), p); content.recordOrder = [...op.recordIds]; break
        case "putField": {
          const existing = content.fields[op.field.id]
          if (existing) {
            tableAssert(op.beforeFieldId === null, p, "更新字段不能同时重排")
            if (existing.type !== op.field.type) {
              tableAssert(op.field.id !== content.primaryFieldId, p, "不能改变主字段类型")
              tableAssert(Object.values(content.records).every(record => record.values[op.field.id] == null), p, "非空字段不能改变类型")
            }
          } else {
            insertBefore(content.fieldOrder, [op.field.id], op.beforeFieldId, p)
            for (const view of Object.values(content.views)) view.fieldOrder.push(op.field.id)
          }
          content.fields[op.field.id] = structuredClone(op.field); break
        }
        case "deleteField": {
          const id = op.fieldId; tableAssert(content.fields[id], p, "字段不存在"); tableAssert(id !== content.primaryFieldId, p, "不能删除主字段")
          delete content.fields[id]; content.fieldOrder = content.fieldOrder.filter(key => key !== id)
          for (const record of Object.values(content.records)) if (Object.prototype.hasOwnProperty.call(record.values, id)) { delete record.values[id]; record.updatedAt = timestamp }
          for (const view of Object.values(content.views)) {
            view.fieldOrder = view.fieldOrder.filter(key => key !== id); view.hiddenFieldIds = view.hiddenFieldIds.filter(key => key !== id); delete view.columnWidths[id]
            view.filters.conditions = view.filters.conditions.filter(condition => condition.fieldId !== id); view.sorts = view.sorts.filter(sort => sort.fieldId !== id)
            if (view.groupBy === id) view.groupBy = null
          }
          break
        }
        case "setFieldOrder": validateOrder(op.fieldIds, Object.keys(content.fields), p); content.fieldOrder = [...op.fieldIds]; break
        case "putView": {
          validateView(op.view, content, `${p}/view`)
          if (content.views[op.view.id]) tableAssert(op.beforeViewId === null, p, "更新视图不能同时重排")
          else insertBefore(content.viewOrder, [op.view.id], op.beforeViewId, p)
          content.views[op.view.id] = structuredClone(op.view); break
        }
        case "deleteView":
          tableAssert(content.views[op.viewId] && content.viewOrder.length > 1, p, "视图不存在或已是最后一个视图")
          delete content.views[op.viewId]; content.viewOrder = content.viewOrder.filter(id => id !== op.viewId); break
        case "setViewOrder": validateOrder(op.viewIds, Object.keys(content.views), p); content.viewOrder = [...op.viewIds]; break
      }
    } catch (error) { if (error instanceof TableValidationError) error.operationIndex = operationIndex; throw error }
  }
  validateTableContent(content)
  return normalizeTableContent(content)
}

// Produces domain operations to restore business content; never restores a stale file revision/hash.
// Used only for the changes belonging to one undo/redo gesture.
export function restorationMutations(current: TableContent, target: TableContent): TableMutation[] {
  validateTableContent(current); validateTableContent(target); tableAssert(current.primaryFieldId === target.primaryFieldId, "/primaryFieldId")
  const work = structuredClone(current); const operations: TableMutation[] = []
  const deletedRecords = work.recordOrder.filter(id => !target.records[id])
  if (deletedRecords.length) { operations.push({ type: "deleteRecords", recordIds: deletedRecords }); for (const id of deletedRecords) delete work.records[id]; work.recordOrder = work.recordOrder.filter(id => target.records[id]) }
  const clear: CellEdit[] = []
  for (const field of Object.values(target.fields)) if (work.fields[field.id] && work.fields[field.id].type !== field.type) {
    for (const record of Object.values(work.records)) if (record.values[field.id] != null) { clear.push({ recordId: record.id, fieldId: field.id, value: null }); delete record.values[field.id] }
  }
  if (clear.length) operations.push({ type: "setCells", cells: clear })
  for (const id of [...work.fieldOrder]) if (!target.fields[id]) {
    operations.push({ type: "deleteField", fieldId: id }); delete work.fields[id]; work.fieldOrder = work.fieldOrder.filter(key => key !== id)
    for (const record of Object.values(work.records)) delete record.values[id]
    // Restoration replaces complete target views below, including all removed references.
  }
  for (const id of target.fieldOrder) if (canonicalJson(work.fields[id]) !== canonicalJson(target.fields[id])) {
    operations.push({ type: "putField", field: structuredClone(target.fields[id]), beforeFieldId: null })
    if (!work.fields[id]) work.fieldOrder.push(id); work.fields[id] = target.fields[id]
  }
  const inserted = target.recordOrder.filter(id => !work.records[id]).map(id => ({ id, values: structuredClone(target.records[id].values), createdAt: target.records[id].createdAt }))
  if (inserted.length) { operations.push({ type: "insertRecords", records: inserted, beforeRecordId: null }); work.recordOrder.push(...inserted.map(record => record.id)) }
  const edits: CellEdit[] = []
  for (const id of target.recordOrder) if (work.records[id]) {
    for (const fieldId of target.fieldOrder) {
      const before = work.records[id].values[fieldId] ?? null; const after = target.records[id].values[fieldId] ?? null
      if (canonicalJson(before) !== canonicalJson(after)) edits.push({ recordId: id, fieldId, value: structuredClone(after) })
    }
  }
  if (edits.length) operations.push({ type: "setCells", cells: edits })
  const fieldsChanged = canonicalJson(current.fieldOrder) !== canonicalJson(work.fieldOrder)
  for (const id of target.viewOrder) if (fieldsChanged || canonicalJson(work.views[id]) !== canonicalJson(target.views[id])) {
    operations.push({ type: "putView", view: structuredClone(target.views[id]), beforeViewId: null })
    if (!work.views[id]) work.viewOrder.push(id); work.views[id] = target.views[id]
  }
  for (const id of [...work.viewOrder]) if (!target.views[id]) { operations.push({ type: "deleteView", viewId: id }); delete work.views[id]; work.viewOrder = work.viewOrder.filter(key => key !== id) }
  if (canonicalJson(work.fieldOrder) !== canonicalJson(target.fieldOrder)) operations.push({ type: "setFieldOrder", fieldIds: [...target.fieldOrder] })
  if (canonicalJson(work.recordOrder) !== canonicalJson(target.recordOrder)) operations.push({ type: "setRecordOrder", recordIds: [...target.recordOrder] })
  if (canonicalJson(work.viewOrder) !== canonicalJson(target.viewOrder)) operations.push({ type: "setViewOrder", viewIds: [...target.viewOrder] })
  return operations
}
