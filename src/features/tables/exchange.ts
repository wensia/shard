// Import/exports traverse entire tables and must run in the table Worker.
import { decodeCsvBytes, parseCsvBytes, type CsvEncoding } from "@/lib/csv"
import { TABLE_LIMITS, TableValidationError, canonicalJson, createTableId, isDateOnly, normalizeTableContent, parseTableFile,
  tableAssert, tableContent, validUnicode, validateTableContent, validateTableFile, validateTimestamp,
  type CellValue, type FieldType, type TableContent, type TableField, type TableFile, type Timestamp } from "./model"
import { projectTableView } from "./views"

export type CsvTablePreview = { encoding: CsvEncoding; hasHeader: boolean; columns: { sourceColumn: number; name: string }[]; rows: string[][] }
export type TableImportMapping = { sourceColumn: number; name?: string; type: FieldType; primary?: boolean; options?: string[] }
export type TableImportIssue = { sourceRow: number | null; sourceColumn: number; code: "INVALID_MAPPING" | "INVALID_VALUE" | "LIMIT_EXCEEDED"; message: string; rawValue?: string }
export type TableImportResult = { content: TableContent | null; issues: TableImportIssue[] }
export type TableExportScope = { type: "all" } | { type: "view"; viewId: string }
export type XlsxExportColumn = { name: string; kind: "text" | "number" | "date" | "checkbox" }
export type XlsxExportRows = { columns: XlsxExportColumn[]; rows: (string | number | boolean | null)[][] }
type ImportOptions = { now?: () => Timestamp; id?: (prefix: "fld" | "opt" | "rec" | "view") => string }

// A delimiter-only budget pass prevents millions of empty records from being allocated by the
// shared parser. It never decodes field values or replaces parseCsvBytes' CSV syntax validation.
function checkCsvBudget(text: string, header: boolean) {
  text = text.replace(/^\uFEFF/u, "")
  let quoted = false; let rows = 0; let columns = 1; let maxColumns = 0; let ended = false
  const finish = () => {
    rows++; maxColumns = Math.max(maxColumns, columns); columns = 1
    const dataRows = Math.max(0, rows - Number(header))
    tableAssert(dataRows <= TABLE_LIMITS.rows && maxColumns <= TABLE_LIMITS.fields && Math.max(1, dataRows) * maxColumns <= TABLE_LIMITS.cells, "", "CSV 行列数量超过数据表容量", "LIMIT_EXCEEDED")
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '"') { if (quoted && text[index + 1] === '"') index++; else quoted = !quoted; ended = false }
    else if (!quoted && char === ",") { columns++; ended = false; tableAssert(columns <= TABLE_LIMITS.fields, "", "CSV 字段数量超过容量", "LIMIT_EXCEEDED") }
    else if (!quoted && (char === "\r" || char === "\n")) { if (char === "\r" && text[index + 1] === "\n") index++; finish(); ended = true }
    else ended = false
  }
  if (text.length && !ended) finish()
}
export function parseCsvTablePreview(bytes: Uint8Array, options: { header?: boolean } = {}): CsvTablePreview {
  tableAssert(bytes.byteLength <= TABLE_LIMITS.fileBytes, "", "CSV 文件超过容量", "LIMIT_EXCEEDED")
  const hasHeader = options.header ?? true
  checkCsvBudget(decodeCsvBytes(bytes).text, hasHeader)
  const parsed = parseCsvBytes(bytes); const headers = hasHeader ? parsed.records[0] ?? [] : []
  const rows = hasHeader ? parsed.records.slice(1) : parsed.records
  const width = Math.max(headers.length, ...rows.map(row => row.length), 0)
  return { encoding: parsed.encoding, hasHeader, columns: Array.from({ length: width }, (_, sourceColumn) => ({ sourceColumn, name: headers[sourceColumn]?.trim() ? headers[sourceColumn] : `列 ${sourceColumn + 1}` })), rows }
}
export function defaultImportMappings(preview: CsvTablePreview): TableImportMapping[] {
  return preview.columns.map(column => ({ sourceColumn: column.sourceColumn, name: column.name, type: "text" }))
}
function validLabel(value: unknown): value is string { return typeof value === "string" && validUnicode(value) && value.trim().length > 0 && Array.from(value).length <= TABLE_LIMITS.name }
function conversionError(message: string, limit = false): never { throw new TableValidationError(limit ? "LIMIT_EXCEEDED" : "INVALID_VALUE", message) }

export function buildImportedTable(preview: CsvTablePreview, mappings: readonly TableImportMapping[] = defaultImportMappings(preview), options: ImportOptions = {}): TableImportResult {
  const issues: TableImportIssue[] = []
  const id = options.id ?? createTableId; const timestamp = (options.now ?? (() => new Date().toISOString()))(); validateTimestamp(timestamp, "/createdAt")
  if (preview.columns.length > 0 && mappings.length === 0) return { content: null, issues: [{ sourceRow: null, sourceColumn: 0, code: "INVALID_MAPPING", message: "至少映射一个来源列" }] }
  if (mappings.length > TABLE_LIMITS.fields || preview.rows.length > TABLE_LIMITS.rows || Math.max(1, preview.rows.length) * Math.max(1, mappings.length) > TABLE_LIMITS.cells)
    return { content: null, issues: [{ sourceRow: null, sourceColumn: 0, code: "LIMIT_EXCEEDED", message: "映射结果超过数据表容量" }] }
  const selectedPrimary = mappings.filter(mapping => mapping.primary)
  if (selectedPrimary.length > 1 || selectedPrimary.some(mapping => mapping.type !== "text")) issues.push({ sourceRow: null, sourceColumn: 0, code: "INVALID_MAPPING", message: "只能选择一个文本主字段" })
  const states = mappings.map(mapping => {
    const column = preview.columns[mapping.sourceColumn]; const name = mapping.name ?? column?.name ?? ""
    if (!Number.isInteger(mapping.sourceColumn) || mapping.sourceColumn < 0 || !column || !validLabel(name) || !["text", "number", "date", "select", "multiSelect", "checkbox"].includes(mapping.type))
      issues.push({ sourceRow: null, sourceColumn: mapping.sourceColumn + 1, code: "INVALID_MAPPING", message: "来源列、字段名或字段类型无效" })
    if (mapping.options !== undefined && ((mapping.type !== "select" && mapping.type !== "multiSelect") || !Array.isArray(mapping.options) || mapping.options.some(option => !validLabel(option)) || new Set(mapping.options).size !== mapping.options.length || mapping.options.length > TABLE_LIMITS.options))
      issues.push({ sourceRow: null, sourceColumn: mapping.sourceColumn + 1, code: "INVALID_MAPPING", message: "选项必须是不重复的有效标签" })
    const field: TableField = mapping.type === "select" || mapping.type === "multiSelect"
      ? { id: id("fld"), name, type: mapping.type, options: [] } : { id: id("fld"), name, type: mapping.type }
    return { mapping, field, optionIds: new Map<string, string>() }
  })
  if (issues.length) return { content: null, issues }
  function optionId(state: typeof states[number], label: string): string {
    if (!validLabel(label)) conversionError("选项标签不能为空白且最多 128 个字符")
    const existing = state.optionIds.get(label); if (existing) return existing
    if (state.mapping.options !== undefined && !state.mapping.options.includes(label)) conversionError("值不在指定的选项中")
    if (state.optionIds.size >= TABLE_LIMITS.options) conversionError("选项数量超过容量", true)
    const option = id("opt"); state.optionIds.set(label, option)
    if ("options" in state.field) state.field.options.push({ id: option, label, color: "neutral" })
    return option
  }
  for (const state of states) for (const label of state.mapping.options ?? []) optionId(state, label)
  let primary = states.find(state => state.mapping.primary)?.field ?? states.find(state => state.field.type === "text")?.field
  const fields = states.map(state => state.field)
  if (!primary) { primary = { id: id("fld"), name: "名称", type: "text" }; fields.unshift(primary) }
  if (fields.length > TABLE_LIMITS.fields || Math.max(1, preview.rows.length) * fields.length > TABLE_LIMITS.cells)
    return { content: null, issues: [{ sourceRow: null, sourceColumn: 0, code: "LIMIT_EXCEEDED", message: "加入必需的文本主字段后超过容量" }] }
  const viewId = id("view")
  const content: TableContent = { primaryFieldId: primary.id, fields: Object.fromEntries(fields.map(field => [field.id, field])), fieldOrder: fields.map(field => field.id),
    records: {}, recordOrder: [], views: {}, viewOrder: [viewId] }
  content.views[viewId] = { id: viewId, name: "全部记录", type: "table", filters: { operator: "and", conditions: [] }, sorts: [], groupBy: null, fieldOrder: [...content.fieldOrder], hiddenFieldIds: [], columnWidths: {} }
  preview.rows.forEach((row, rowIndex) => {
    const recordId = id("rec"); const values: Record<string, CellValue> = {}
    for (const state of states) {
      const raw = row[state.mapping.sourceColumn]
      if (raw === undefined) continue
      try {
        if (!validUnicode(raw) || Array.from(raw).length > TABLE_LIMITS.text) conversionError("单元格文本无效或超过容量", true)
        if (state.field.type !== "text" && raw === "") continue
        const trimmed = raw.trim()
        switch (state.field.type) {
          case "text": values[state.field.id] = raw; break
          case "number": {
            if (!/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) conversionError("不是有效数值；带前导零的编号请保留为文本")
            const value = Number(trimmed)
            if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) conversionError("数值超出安全范围，请保留为文本")
            values[state.field.id] = Object.is(value, -0) ? 0 : value; break
          }
          case "date": if (!isDateOnly(trimmed)) conversionError("日期必须是有效的 YYYY-MM-DD，不能自动截断日期时间"); values[state.field.id] = trimmed; break
          case "checkbox":
            if (!/^(?:true|false|1|0)$/i.test(trimmed)) conversionError("复选框只接受 true、false、1 或 0")
            values[state.field.id] = /^(?:true|1)$/i.test(trimmed); break
          case "select": values[state.field.id] = optionId(state, raw); break
          case "multiSelect": {
            let labels: unknown
            try { labels = JSON.parse(raw) } catch { conversionError('多选值必须是标签的 JSON 数组，例如 ["甲","乙"]') }
            if (!Array.isArray(labels) || labels.some(label => typeof label !== "string") || new Set(labels).size !== labels.length) conversionError("多选值必须是不重复的文本标签数组")
            if (labels.length > TABLE_LIMITS.options) conversionError("多选数量超过容量", true)
            values[state.field.id] = labels.map(label => optionId(state, label)); break
          }
        }
      } catch (error) {
        issues.push({ sourceRow: rowIndex + (preview.hasHeader ? 2 : 1), sourceColumn: state.mapping.sourceColumn + 1,
          code: error instanceof TableValidationError && error.code === "LIMIT_EXCEEDED" ? "LIMIT_EXCEEDED" : "INVALID_VALUE", message: error instanceof Error ? error.message : String(error), rawValue: raw })
      }
    }
    content.records[recordId] = { id: recordId, values, createdAt: timestamp, updatedAt: timestamp }; content.recordOrder.push(recordId)
  })
  if (issues.length) return { content: null, issues }
  validateTableContent(content)
  const normalized = normalizeTableContent(content)
  tableAssert(new TextEncoder().encode(canonicalJson(normalized)).byteLength <= TABLE_LIMITS.fileBytes, "", "导入结果超过文件容量", "LIMIT_EXCEEDED")
  return { content: normalized, issues: [] }
}

function exportSelection(content: TableContent, scope: TableExportScope): { fields: TableField[]; recordIds: string[] } {
  validateTableContent(content); tableAssert(scope?.type === "all" || scope?.type === "view", "/scope", "请选择全部记录或当前视图")
  if (scope.type === "all") return { fields: content.fieldOrder.map(id => content.fields[id]), recordIds: [...content.recordOrder] }
  const view = content.views[scope.viewId]; tableAssert(view, "/scope/viewId", "导出视图不存在")
  const hidden = new Set(view.hiddenFieldIds)
  return { fields: view.fieldOrder.filter(id => !hidden.has(id)).map(id => content.fields[id]), recordIds: projectTableView(content, view.id, 0).recordIds }
}
function exportValue(field: TableField, value: CellValue | undefined): string | number | boolean | null {
  if (value == null) return null
  if (field.type === "select") return field.options.find(option => option.id === value)!.label
  if (field.type === "multiSelect") { const selected = new Set(value as string[]); return JSON.stringify(field.options.filter(option => selected.has(option.id)).map(option => option.label)) }
  return value as string | number | boolean
}
export function exportTableXlsxRows(content: TableContent, scope: TableExportScope): XlsxExportRows {
  const { fields, recordIds } = exportSelection(content, scope)
  return { columns: fields.map(field => ({ name: field.name, kind: field.type === "select" || field.type === "multiSelect" ? "text" : field.type })),
    rows: recordIds.map(id => fields.map(field => exportValue(field, content.records[id].values[field.id]))) }
}
export function exportTableCsv(content: TableContent, scope: TableExportScope, mode: "safe" | "raw" = "safe"): { text: string; escapedCells: number; recordCount: number; fieldCount: number } {
  tableAssert(mode === "safe" || mode === "raw", "/mode")
  const data = exportTableXlsxRows(content, scope); let escapedCells = 0
  const csvCell = (value: string | number | boolean | null): string => {
    let text = value === null ? "" : String(value)
    if (mode === "safe" && typeof value === "string" && (/^[\t\r\n]/u.test(text) || /^\s*[=+\-@]/u.test(text))) { text = `'${text}`; escapedCells++ }
    return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text
  }
  return { text: [data.columns.map(column => csvCell(column.name)).join(","), ...data.rows.map(row => row.map(csvCell).join(","))].join("\r\n") + "\r\n",
    escapedCells, recordCount: data.rows.length, fieldCount: data.columns.length }
}
export function importNativeTableContent(source: string | Uint8Array): TableContent {
  // Intentionally excludes source tableId, revision, creation and mutation metadata. The create layer
  // must allocate a fresh tableId/requestId and retain the frozen request when retrying creation.
  return normalizeTableContent(tableContent(parseTableFile(source)))
}
export function exportNativeTable(file: TableFile): string {
  validateTableFile(file)
  const normalized = { ...file, ...normalizeTableContent(tableContent(file)) }
  const result = JSON.stringify(JSON.parse(canonicalJson(normalized)), null, 2) + "\n"
  tableAssert(new TextEncoder().encode(result).byteLength <= TABLE_LIMITS.fileBytes, "", "原生文件超过容量", "LIMIT_EXCEEDED")
  return result
}
