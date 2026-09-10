// Renderer-independent wire model. Full-document validation/serialization belongs in a Worker.
export type TableId = string
export type FieldId = string
export type OptionId = string
export type RecordId = string
export type ViewId = string
export type RequestId = string
export type MutationId = string
export type Sha256 = string
export type Timestamp = string
export type DateOnly = string
export type CellValueByType = {
  text: string | null
  number: number | null
  date: DateOnly | null
  select: OptionId | null
  multiSelect: OptionId[] | null
  checkbox: boolean | null
}
export type FieldType = keyof CellValueByType
export type CellValue = CellValueByType[FieldType]
export type OptionColor = "neutral" | "red" | "orange" | "yellow" | "green" | "blue" | "purple"
export type SelectOption = { id: OptionId; label: string; color: OptionColor }
export type TableField = { id: FieldId; name: string } & (
  | { type: "text" | "number" | "date" | "checkbox" }
  | { type: "select" | "multiSelect"; options: SelectOption[] }
)
export type TableRecord = { id: RecordId; createdAt: Timestamp; updatedAt: Timestamp; values: Record<FieldId, CellValue> }
export type FilterCondition =
  | { fieldId: FieldId; operator: "isEmpty" | "isNotEmpty" }
  | { fieldId: FieldId; operator: "eq" | "ne"; value: string | number | boolean }
  | { fieldId: FieldId; operator: "contains" | "notContains" | "startsWith" | "endsWith"; value: string }
  | { fieldId: FieldId; operator: "gt" | "gte" | "lt" | "lte"; value: number | DateOnly }
  | { fieldId: FieldId; operator: "between"; lower: number | DateOnly; upper: number | DateOnly }
  | { fieldId: FieldId; operator: "in" | "notIn" | "hasAny" | "hasAll" | "hasNone"; optionIds: OptionId[] }
export type TableFilter = { operator: "and" | "or"; conditions: FilterCondition[] }
export type TableSort = { fieldId: FieldId; direction: "asc" | "desc" }
export type TableView = {
  id: ViewId; name: string; type: "table"; filters: TableFilter; sorts: TableSort[]
  groupBy: FieldId | null; fieldOrder: FieldId[]; hiddenFieldIds: FieldId[]; columnWidths: Record<FieldId, number>
}
export type TableContent = {
  primaryFieldId: FieldId; fields: Record<FieldId, TableField>; fieldOrder: FieldId[]
  records: Record<RecordId, TableRecord>; recordOrder: RecordId[]; views: Record<ViewId, TableView>; viewOrder: ViewId[]
}
export type TableFile = TableContent & {
  kind: "shard.table"; schemaVersion: 1; id: TableId; revision: number
  creation: { requestId: RequestId; payloadHash: Sha256 }
  lastMutationId: MutationId | null; lastMutationHash: Sha256 | null
  createdAt: Timestamp; updatedAt: Timestamp
  copiedFrom?: { tableId: TableId; revision: number; contentHash: Sha256 }
}
export type TableReadResult = { file: TableFile; path: string; title: string; revision: number; contentHash: Sha256 }
export type TableErrorCode = "INVALID_JSON" | "DUPLICATE_KEY" | "UNSUPPORTED_VERSION" | "INVALID_MODEL" |
  "INVALID_VALUE" | "INVALID_FILTER" | "LIMIT_EXCEEDED" | "INVALID_PATH" | "NOT_FOUND" | "TARGET_IN_TRASH" |
  "IDENTITY_MISMATCH" | "DUPLICATE_TABLE_ID" | "STALE_BASE" | "IDEMPOTENCY_CONFLICT" | "ALREADY_APPLIED" | "GIT_BUSY" | "IO_ERROR"
export type TableError = { code: TableErrorCode; message: string; pointer?: string; operationIndex?: number; recordId?: RecordId; fieldId?: FieldId }
export class TableValidationError extends Error implements TableError {
  operationIndex?: number
  constructor(public code: TableErrorCode, message: string, public pointer?: string) { super(message); this.name = "TableValidationError" }
}
export const TABLE_LIMITS = Object.freeze({ rows: 10_000, fields: 128, cells: 300_000, fileBytes: 64 * 1024 * 1024,
  text: 16_384, name: 128, options: 256, views: 32, filters: 64, sorts: 16, operations: 64,
  mutationCells: 50_000, mutationBytes: 16 * 1024 * 1024 })
export function tableAssert(condition: unknown, pointer: string, message = "数据表内容无效", code: TableErrorCode = "INVALID_MODEL"): asserts condition {
  if (!condition) throw new TableValidationError(code, message, pointer)
}
export function jsonPointer(parent: string, key: string | number) { return `${parent}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}` }
export function objectShape(value: unknown, pointer: string, keys?: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  tableAssert(value !== null && typeof value === "object" && !Array.isArray(value), pointer)
  const object = value as Record<string, unknown>
  if (keys) {
    for (const key of Object.keys(object)) tableAssert(keys.includes(key), jsonPointer(pointer, key), "未知属性")
    for (const key of keys) if (!optional.includes(key)) tableAssert(hasOwn(object, key), jsonPointer(pointer, key), "缺少属性")
  }
  return object
}
export function hasOwn(value: object, key: PropertyKey): boolean { return Object.prototype.hasOwnProperty.call(value, key) }
export function validUnicode(value: string): boolean {
  for (const character of value) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) return false }
  return true
}
export function validateId(value: unknown, prefix: string, pointer: string): asserts value is string {
  tableAssert(typeof value === "string" && new RegExp(`^${prefix}_[0-9a-f]{32}$`).test(value), pointer, "ID 格式无效")
}
export function createTableId(prefix: "tbl" | "fld" | "opt" | "rec" | "view" | "req" | "mut"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `${prefix}_${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`
}
function text(value: unknown, pointer: string, name = false): asserts value is string {
  tableAssert(typeof value === "string" && validUnicode(value), pointer)
  tableAssert(Array.from(value).length <= (name ? TABLE_LIMITS.name : TABLE_LIMITS.text), pointer, "文本超过容量限制", "LIMIT_EXCEEDED")
  if (name) tableAssert(value.trim().length > 0, pointer, "名称不能为空白")
}
export function isDateOnly(value: unknown): value is DateOnly {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split("-").map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}
export function validateTimestamp(value: unknown, pointer: string): asserts value is Timestamp {
  tableAssert(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/.test(value) && isDateOnly(value.slice(0, 10)), pointer, "UTC 时间戳无效")
}
function timestampKey(value: string) { return value.slice(0, 19) + (value.slice(19, -1).replace(/^\./, "")).padEnd(9, "0") }
export function laterTimestamp(left: Timestamp, right: Timestamp): Timestamp { return timestampKey(left) >= timestampKey(right) ? left : right }
function timestamps(value: Record<string, unknown>, pointer: string) {
  validateTimestamp(value.createdAt, jsonPointer(pointer, "createdAt")); validateTimestamp(value.updatedAt, jsonPointer(pointer, "updatedAt"))
  tableAssert(timestampKey(value.updatedAt) >= timestampKey(value.createdAt), jsonPointer(pointer, "updatedAt"), "更新时间早于创建时间")
}
export function compareCodePoints(a: string, b: string): number {
  const left = a[Symbol.iterator](); const right = b[Symbol.iterator]()
  for (;;) { const x = left.next(); const y = right.next(); if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!; if (d) return d }
}
export function validateOrder(value: unknown, ids: readonly string[], pointer: string): asserts value is string[] {
  tableAssert(Array.isArray(value) && value.length === ids.length && new Set(value).size === value.length, pointer, "顺序必须完整且不重复")
  const allowed = new Set(ids); tableAssert(value.every(id => typeof id === "string" && allowed.has(id)), pointer, "顺序引用不存在的 ID")
}
export function validateField(value: unknown, pointer = ""): asserts value is TableField {
  const field = objectShape(value, pointer); validateId(field.id, "fld", jsonPointer(pointer, "id")); text(field.name, jsonPointer(pointer, "name"), true)
  tableAssert(["text", "number", "date", "select", "multiSelect", "checkbox"].includes(String(field.type)), jsonPointer(pointer, "type"), "字段类型无效")
  const select = field.type === "select" || field.type === "multiSelect"
  objectShape(field, pointer, select ? ["id", "name", "type", "options"] : ["id", "name", "type"])
  if (select) {
    const p = jsonPointer(pointer, "options"); tableAssert(Array.isArray(field.options), p)
    tableAssert(field.options.length <= TABLE_LIMITS.options, p, "选项超过容量限制", "LIMIT_EXCEEDED")
    const ids = new Set<string>()
    for (const [i, value] of field.options.entries()) {
      const option = objectShape(value, jsonPointer(p, i), ["id", "label", "color"])
      validateId(option.id, "opt", jsonPointer(jsonPointer(p, i), "id")); tableAssert(!ids.has(option.id), p, "选项 ID 重复"); ids.add(option.id)
      text(option.label, jsonPointer(jsonPointer(p, i), "label"), true)
      tableAssert(["neutral", "red", "orange", "yellow", "green", "blue", "purple"].includes(String(option.color)), jsonPointer(jsonPointer(p, i), "color"))
    }
  }
}
export function validateCellValue(field: TableField, value: unknown, pointer = ""): asserts value is CellValue {
  if (value === null) return
  let valid = false
  switch (field.type) {
    case "text": valid = typeof value === "string" && validUnicode(value); if (valid) tableAssert(Array.from(value as string).length <= TABLE_LIMITS.text, pointer, "文本超过容量限制", "LIMIT_EXCEEDED"); break
    case "number": valid = typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER; break
    case "date": valid = isDateOnly(value); break
    case "checkbox": valid = typeof value === "boolean"; break
    case "select": valid = typeof value === "string" && field.options.some(option => option.id === value); break
    case "multiSelect": { const ids = new Set(field.options.map(option => option.id)); valid = Array.isArray(value) && value.length <= TABLE_LIMITS.options && new Set(value).size === value.length && value.every(id => typeof id === "string" && ids.has(id)); break }
  }
  tableAssert(valid, pointer, "单元格值与字段类型或选项不匹配", "INVALID_VALUE")
}
export function normalizeCellValue(value: CellValue): CellValue { return Array.isArray(value) ? [...value].sort(compareCodePoints) : Object.is(value, -0) ? 0 : value }
const FILTER_OPS: Record<FieldType, string[]> = {
  text: ["eq", "ne", "contains", "notContains", "startsWith", "endsWith"], number: ["eq", "ne", "gt", "gte", "lt", "lte", "between"],
  date: ["eq", "ne", "gt", "gte", "lt", "lte", "between"], select: ["eq", "ne", "in", "notIn"], multiSelect: ["hasAny", "hasAll", "hasNone"], checkbox: ["eq", "ne"],
}
export function validateFilter(value: unknown, fields: Record<FieldId, TableField>, pointer = ""): asserts value is FilterCondition {
  try {
    const c = objectShape(value, pointer); const field = typeof c.fieldId === "string" ? fields[c.fieldId] : undefined
    tableAssert(field, pointer); const op = String(c.operator)
    if (op === "isEmpty" || op === "isNotEmpty") { objectShape(c, pointer, ["fieldId", "operator"]); return }
    tableAssert(FILTER_OPS[field.type].includes(op), pointer)
    if (["in", "notIn", "hasAny", "hasAll", "hasNone"].includes(op)) {
      objectShape(c, pointer, ["fieldId", "operator", "optionIds"])
      tableAssert(Array.isArray(c.optionIds) && c.optionIds.length > 0, pointer)
      tableAssert("options" in field, pointer); validateCellValue({ ...field, type: "multiSelect" }, c.optionIds, pointer)
    } else if (op === "between") {
      objectShape(c, pointer, ["fieldId", "operator", "lower", "upper"])
      tableAssert(c.lower !== null && c.upper !== null, pointer); validateCellValue(field, c.lower, pointer); validateCellValue(field, c.upper, pointer)
      tableAssert((c.lower as number | string) <= (c.upper as number | string), pointer)
    } else {
      objectShape(c, pointer, ["fieldId", "operator", "value"]); tableAssert(c.value !== null, pointer); validateCellValue(field, c.value, pointer)
    }
  } catch (error) { if (error instanceof TableValidationError) throw new TableValidationError("INVALID_FILTER", "筛选运算符、参数或字段引用无效", pointer); throw error }
}
export function validateView(value: unknown, content: Pick<TableContent, "fields" | "primaryFieldId">, pointer = ""): asserts value is TableView {
  const view = objectShape(value, pointer, ["id", "name", "type", "filters", "sorts", "groupBy", "fieldOrder", "hiddenFieldIds", "columnWidths"])
  validateId(view.id, "view", jsonPointer(pointer, "id")); text(view.name, jsonPointer(pointer, "name"), true); tableAssert(view.type === "table", jsonPointer(pointer, "type"))
  const ids = Object.keys(content.fields); validateOrder(view.fieldOrder, ids, jsonPointer(pointer, "fieldOrder"))
  const hidden = view.hiddenFieldIds; const hiddenPath = jsonPointer(pointer, "hiddenFieldIds")
  tableAssert(Array.isArray(hidden) && new Set(hidden).size === hidden.length && hidden.every(id => typeof id === "string" && hasOwn(content.fields, id)) && !hidden.includes(content.primaryFieldId), hiddenPath)
  const widths = objectShape(view.columnWidths, jsonPointer(pointer, "columnWidths"))
  for (const [id, width] of Object.entries(widths)) tableAssert(hasOwn(content.fields, id) && typeof width === "number" && Number.isInteger(width) && width >= 64 && width <= 1200, jsonPointer(jsonPointer(pointer, "columnWidths"), id))
  tableAssert(view.groupBy === null || (typeof view.groupBy === "string" && hasOwn(content.fields, view.groupBy) && content.fields[view.groupBy].type !== "multiSelect"), jsonPointer(pointer, "groupBy"))
  const fp = jsonPointer(pointer, "filters"); const filters = objectShape(view.filters, fp, ["operator", "conditions"])
  tableAssert(filters.operator === "and" || filters.operator === "or", fp, "过滤组合无效", "INVALID_FILTER")
  tableAssert(Array.isArray(filters.conditions), fp, "过滤条件无效", "INVALID_FILTER")
  tableAssert(filters.conditions.length <= TABLE_LIMITS.filters, fp, "筛选条件超过容量限制", "LIMIT_EXCEEDED")
  filters.conditions.forEach((condition, i) => validateFilter(condition, content.fields, `${fp}/conditions/${i}`))
  const sp = jsonPointer(pointer, "sorts"); tableAssert(Array.isArray(view.sorts), sp)
  tableAssert(view.sorts.length <= TABLE_LIMITS.sorts, sp, "排序字段超过容量限制", "LIMIT_EXCEEDED")
  const seen = new Set<string>()
  view.sorts.forEach((value, i) => { const sort = objectShape(value, jsonPointer(sp, i), ["fieldId", "direction"])
    tableAssert(typeof sort.fieldId === "string" && hasOwn(content.fields, sort.fieldId) && !seen.has(sort.fieldId) && (sort.direction === "asc" || sort.direction === "desc"), jsonPointer(sp, i)); seen.add(sort.fieldId) })
}
const CONTENT_KEYS = ["primaryFieldId", "fields", "fieldOrder", "records", "recordOrder", "views", "viewOrder"] as const
export function tableContent(file: TableContent): TableContent { const { primaryFieldId, fields, fieldOrder, records, recordOrder, views, viewOrder } = file; return { primaryFieldId, fields, fieldOrder, records, recordOrder, views, viewOrder } }
export function validateTableContent(value: unknown): asserts value is TableContent {
  const content = objectShape(value, "", CONTENT_KEYS)
  const fields = objectShape(content.fields, "/fields"); const records = objectShape(content.records, "/records"); const views = objectShape(content.views, "/views")
  tableAssert(Object.keys(fields).length > 0, "/fields"); tableAssert(Object.keys(views).length > 0, "/views")
  tableAssert(Object.keys(fields).length <= TABLE_LIMITS.fields, "/fields", "字段超过容量限制", "LIMIT_EXCEEDED")
  tableAssert(Object.keys(records).length <= TABLE_LIMITS.rows && Math.max(1, Object.keys(records).length) * Object.keys(fields).length <= TABLE_LIMITS.cells, "/records", "记录超过容量限制", "LIMIT_EXCEEDED")
  tableAssert(Object.keys(views).length <= TABLE_LIMITS.views, "/views", "视图超过容量限制", "LIMIT_EXCEEDED")
  for (const [id, field] of Object.entries(fields)) { const p = jsonPointer("/fields", id); validateField(field, p); tableAssert(field.id === id, `${p}/id`) }
  tableAssert(typeof content.primaryFieldId === "string" && hasOwn(fields, content.primaryFieldId) && (fields[content.primaryFieldId] as TableField).type === "text", "/primaryFieldId")
  validateOrder(content.fieldOrder, Object.keys(fields), "/fieldOrder"); validateOrder(content.recordOrder, Object.keys(records), "/recordOrder"); validateOrder(content.viewOrder, Object.keys(views), "/viewOrder")
  for (const [id, value] of Object.entries(records)) {
    validateTableRecord(value, fields as Record<FieldId, TableField>, id)
  }
  for (const [id, view] of Object.entries(views)) { const p = jsonPointer("/views", id); validateView(view, content as unknown as TableContent, p); tableAssert(view.id === id, `${p}/id`) }
}
export function validateTableRecord(value: unknown, fields: Record<FieldId, TableField>, id: RecordId): asserts value is TableRecord {
  const p = jsonPointer("/records", id); const record = objectShape(value, p, ["id", "createdAt", "updatedAt", "values"])
  validateId(record.id, "rec", `${p}/id`); tableAssert(record.id === id, `${p}/id`); timestamps(record, p)
  for (const [fieldId, cell] of Object.entries(objectShape(record.values, `${p}/values`))) {
    const cp = jsonPointer(`${p}/values`, fieldId); tableAssert(hasOwn(fields, fieldId), cp); validateCellValue(fields[fieldId], cell, cp)
  }
}
export function validateTableFile(value: unknown): asserts value is TableFile {
  const file = objectShape(value, "")
  tableAssert(file.schemaVersion === 1, "/schemaVersion", "不支持的数据表版本", "UNSUPPORTED_VERSION")
  objectShape(file, "", [...CONTENT_KEYS, "kind", "schemaVersion", "id", "revision", "creation", "lastMutationId", "lastMutationHash", "createdAt", "updatedAt", "copiedFrom"], ["copiedFrom"])
  tableAssert(file.kind === "shard.table", "/kind"); validateId(file.id, "tbl", "/id"); validateRevision(file.revision, "/revision"); timestamps(file, "")
  const creation = objectShape(file.creation, "/creation", ["requestId", "payloadHash"]); validateId(creation.requestId, "req", "/creation/requestId"); validateHash(creation.payloadHash, "/creation/payloadHash")
  if (file.lastMutationId !== null) validateId(file.lastMutationId, "mut", "/lastMutationId")
  tableAssert((file.lastMutationId === null) === (file.lastMutationHash === null), "/lastMutationHash")
  if (file.lastMutationHash !== null) validateHash(file.lastMutationHash, "/lastMutationHash")
  if (file.copiedFrom !== undefined) { const source = objectShape(file.copiedFrom, "/copiedFrom", ["tableId", "revision", "contentHash"]); validateId(source.tableId, "tbl", "/copiedFrom/tableId"); validateRevision(source.revision, "/copiedFrom/revision"); validateHash(source.contentHash, "/copiedFrom/contentHash") }
  validateTableContent(tableContent(file as unknown as TableFile))
}
export function validateRevision(value: unknown, pointer: string): asserts value is number { tableAssert(typeof value === "number" && Number.isSafeInteger(value) && value >= 1, pointer, "revision 无效") }
export function validateHash(value: unknown, pointer: string): asserts value is Sha256 { tableAssert(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), pointer, "内容 hash 无效") }
export function normalizeTableContent(value: TableContent): TableContent {
  const content = structuredClone(value)
  for (const record of Object.values(content.records)) for (const [id, cell] of Object.entries(record.values)) { if (cell === null) delete record.values[id]; else record.values[id] = normalizeCellValue(cell) }
  return content
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort(compareCodePoints).map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`
  return JSON.stringify(value)
}
// Only server-maintained timestamps are omitted; IDs, every cell and all view/order configuration remain.
export function businessSnapshot(content: TableContent): string {
  const normalized = normalizeTableContent(tableContent(content))
  return canonicalJson({ ...normalized, records: Object.fromEntries(Object.entries(normalized.records).map(([id, record]) => [id, { id: record.id, values: record.values }])) })
}
export function parseTableFile(source: string | Uint8Array): TableFile {
  tableAssert((typeof source === "string" ? new TextEncoder().encode(source).byteLength : source.byteLength) <= TABLE_LIMITS.fileBytes, "", "文件超过容量限制", "LIMIT_EXCEEDED")
  let input: string
  try { input = typeof source === "string" ? source : new TextDecoder("utf-8", { fatal: true }).decode(source) } catch { throw new TableValidationError("INVALID_JSON", "文件不是有效 UTF-8") }
  let index = 0
  const fail = (pointer: string): never => { throw new TableValidationError("INVALID_JSON", `JSON 无效，位置 ${index}`, pointer) }
  const skip = () => { while (/[\t\r\n ]/.test(input[index] ?? "!") && index < input.length) index++ }
  function string(pointer: string): string {
    if (input[index] !== '"') return fail(pointer)
    const start = index++
    while (index < input.length) { const char = input[index++]; if (char === "\\") index++; else if (char === '"') {
      try { const value: string = JSON.parse(input.slice(start, index)); if (!validUnicode(value)) fail(pointer); return value } catch { return fail(pointer) }
    } }
    return fail(pointer)
  }
  function value(pointer: string, depth: number): unknown {
    if (depth > 64) throw new TableValidationError("LIMIT_EXCEEDED", "JSON 嵌套过深", pointer)
    skip(); const char = input[index]
    if (char === '"') return string(pointer)
    if (char === "{" || char === "[") {
      index++; skip(); const object: Record<string, unknown> = Object.create(null); const array: unknown[] = []; const close = char === "{" ? "}" : "]"
      if (input[index] === close) { index++; return char === "{" ? object : array }
      for (;;) {
        skip()
        if (char === "{") { const key = string(pointer); const path = jsonPointer(pointer, key); if (hasOwn(object, key)) throw new TableValidationError("DUPLICATE_KEY", "JSON 键重复", path)
          skip(); if (input[index++] !== ":") fail(path); object[key] = value(path, depth + 1)
        } else array.push(value(jsonPointer(pointer, array.length), depth + 1))
        skip(); if (input[index] === close) { index++; return char === "{" ? object : array }
        if (input[index++] !== ",") fail(pointer)
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(input.slice(index))
    if (!match) return fail(pointer); index += match[0].length; const result: unknown = JSON.parse(match[0]); if (typeof result === "number" && !Number.isFinite(result)) fail(pointer); return result
  }
  const file = value("", 0); skip(); if (index !== input.length) fail(""); validateTableFile(file); return file
}
