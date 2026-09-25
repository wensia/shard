/**
 * 数据表围栏块（```datatable）的纯数据层。
 *
 * JSON 形状见技术方案 §3：`{ title?, columns, rows?, src?, view? }`。
 * 这里只有纯函数：校验、规范化、排序 / 分组 / 筛选、单元格格式化与 CSV 导出，
 * 不碰 DOM、不引 React，组件与 vitest 共用同一份实现。
 *
 * 视图状态（排序、分组、筛选）默认只活在组件里，`view` 字段仅在用户显式
 * 「保存视图」时才写回围栏 JSON——见 `writeDatatableView`。
 */

import { serializeCsv } from "@/lib/csv"

/** 围栏语言标识，与块注册表里的 lang 同源。 */
export const DATATABLE_BLOCK_LANGUAGE = "datatable"

export type DatatableColumnType =
  | "text"
  | "number"
  | "currency"
  | "percent"
  | "boolean"
  | "date"
  | "badge"

export type DatatableAlign = "left" | "center" | "right"

export interface DatatableColumn {
  key: string
  label: string
  type?: DatatableColumnType
  align?: DatatableAlign
}

export type DatatableSortDirection = "asc" | "desc"

export interface DatatableView {
  sort?: { key: string; direction: DatatableSortDirection }
  group?: string
  filter?: string
}

export type DatatableRow = Record<string, unknown>

export interface DatatableSpec {
  title?: string
  columns: DatatableColumn[]
  rows: DatatableRow[]
  /** 库内 CSV 路径；有 src 时 rows 由 CSV 提供，本阶段只读。 */
  src?: string
  view?: DatatableView
}

export interface DatatableParseError {
  error: string
}

/** 行在 `spec.rows` 里的原始下标随排序/分组一路带着，写回时才找得回原行。 */
export interface DatatableEntry {
  index: number
  row: DatatableRow
}

export interface DatatableGroup {
  value: string
  entries: DatatableEntry[]
}

const COLUMN_TYPES: ReadonlySet<string> = new Set([
  "text",
  "number",
  "currency",
  "percent",
  "boolean",
  "date",
  "badge",
])
const ALIGNS: ReadonlySet<string> = new Set(["left", "center", "right"])
const NUMERIC_TYPES: ReadonlySet<string> = new Set(["number", "currency", "percent"])
const EMPTY_CELL = "—"

export function isDatatableParseError(
  result: DatatableSpec | DatatableParseError
): result is DatatableParseError {
  return "error" in result
}

/**
 * 围栏正文 → 规范化后的数据表。缺失字段补默认值而不是报错：
 * 用户手写的 JSON 少一个 `rows` 不该整块变成错误块，但结构不对（不是对象、
 * columns 不是数组、列缺 key）必须报错，否则后面所有读取都要防御一遍。
 */
export function parseDatatableSource(source: string): DatatableSpec | DatatableParseError {
  if (!source.trim()) return { error: "数据表为空" }

  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (error) {
    return { error: error instanceof Error ? error.message : "数据表 JSON 无法解析" }
  }

  if (!isPlainObject(raw)) return { error: "数据表 JSON 必须是一个对象" }

  const columns: DatatableColumn[] = []
  if (raw.columns !== undefined) {
    if (!Array.isArray(raw.columns)) return { error: "columns 必须是数组" }
    const seen = new Set<string>()
    for (const item of raw.columns) {
      if (!isPlainObject(item)) return { error: "columns 的每一项必须是对象" }
      const key = typeof item.key === "string" ? item.key.trim() : ""
      if (!key) return { error: "列缺少 key" }
      if (seen.has(key)) return { error: `列 key 重复：${key}` }
      seen.add(key)
      const column: DatatableColumn = {
        key,
        label: typeof item.label === "string" && item.label ? item.label : key,
      }
      if (typeof item.type === "string" && COLUMN_TYPES.has(item.type)) {
        column.type = item.type as DatatableColumnType
      }
      if (typeof item.align === "string" && ALIGNS.has(item.align)) {
        column.align = item.align as DatatableAlign
      }
      columns.push(column)
    }
  }

  const rows: DatatableRow[] = []
  if (raw.rows !== undefined) {
    if (!Array.isArray(raw.rows)) return { error: "rows 必须是数组" }
    for (const item of raw.rows) {
      if (!isPlainObject(item)) return { error: "rows 的每一项必须是对象" }
      rows.push({ ...item })
    }
  }

  const src = typeof raw.src === "string" && raw.src.trim() ? raw.src.trim() : undefined
  if (!src && columns.length === 0) return { error: "数据表缺少 columns 或 src" }

  const spec: DatatableSpec = { columns, rows }
  if (typeof raw.title === "string" && raw.title) spec.title = raw.title
  if (src) spec.src = src
  const view = normalizeDatatableView(raw.view, columns)
  if (view) spec.view = view
  return spec
}

function normalizeDatatableView(raw: unknown, columns: DatatableColumn[]): DatatableView | undefined {
  if (!isPlainObject(raw)) return undefined
  const keys = new Set(columns.map((column) => column.key))
  const view: DatatableView = {}

  if (isPlainObject(raw.sort)) {
    const key = typeof raw.sort.key === "string" ? raw.sort.key : ""
    const direction = raw.sort.direction === "desc" ? "desc" : "asc"
    if (key && (keys.size === 0 || keys.has(key))) view.sort = { key, direction }
  }
  if (typeof raw.group === "string" && raw.group && (keys.size === 0 || keys.has(raw.group))) {
    view.group = raw.group
  }
  if (typeof raw.filter === "string" && raw.filter) view.filter = raw.filter

  return Object.keys(view).length > 0 ? view : undefined
}

/** 固定键序输出：同一份数据在不同机器上序列化结果逐字相同，Git diff 才干净。 */
export function serializeDatatableSpec(spec: DatatableSpec): string {
  const output: Record<string, unknown> = {}
  if (spec.title) output.title = spec.title
  output.columns = spec.columns.map((column) => {
    const item: Record<string, unknown> = { key: column.key, label: column.label }
    if (column.type) item.type = column.type
    if (column.align) item.align = column.align
    return item
  })
  if (spec.src) output.src = spec.src
  // src 供数据时 rows 不写回围栏：真相源是 CSV 文件。
  if (!spec.src) output.rows = spec.rows
  if (spec.view) output.view = spec.view
  return JSON.stringify(output, null, 2)
}

/** 写回单元格：只改 rows，`view` 原样保留（视图状态不随编辑落盘）。 */
export function setDatatableCell(
  spec: DatatableSpec,
  index: number,
  key: string,
  value: unknown
): DatatableSpec {
  if (index < 0 || index >= spec.rows.length) return spec
  const rows = spec.rows.map((row, position) =>
    position === index ? { ...row, [key]: value } : row
  )
  return { ...spec, rows }
}

/** 末尾追加一行，每列先填空串，写回的 JSON 里列齐全、方便手改。 */
export function addDatatableRow(spec: DatatableSpec): DatatableSpec {
  const row: DatatableRow = {}
  for (const column of spec.columns) row[column.key] = ""
  return { ...spec, rows: [...spec.rows, row] }
}

export function removeDatatableRow(spec: DatatableSpec, index: number): DatatableSpec {
  if (index < 0 || index >= spec.rows.length) return spec
  return { ...spec, rows: spec.rows.filter((_, position) => position !== index) }
}

/**
 * 末尾追加一列文本列。key 取第一个没被占用的 `columnN`，label 用同一个序号，
 * 已有行补空串。
 */
export function addDatatableColumn(spec: DatatableSpec): { spec: DatatableSpec; key: string } {
  const used = new Set(spec.columns.map((column) => column.key))
  let serial = spec.columns.length + 1
  while (used.has(`column${serial}`)) serial += 1
  const key = `column${serial}`
  const column: DatatableColumn = { key, label: `列 ${serial}`, type: "text" }
  return {
    key,
    spec: {
      ...spec,
      columns: [...spec.columns, column],
      rows: spec.rows.map((row) => ({ ...row, [key]: "" })),
    },
  }
}

/** 改列名只动 label，key 不变：行数据与保存的视图都按 key 引用。空名不写。 */
export function renameDatatableColumn(
  spec: DatatableSpec,
  key: string,
  label: string
): DatatableSpec {
  const next = label.trim()
  const current = spec.columns.find((column) => column.key === key)
  if (!current || !next || current.label === next) return spec
  return {
    ...spec,
    columns: spec.columns.map((column) => (column.key === key ? { ...column, label: next } : column)),
  }
}

/** 删列连带删掉各行里的这个字段，以及引用它的已保存排序/分组。最后一列不删。 */
export function removeDatatableColumn(spec: DatatableSpec, key: string): DatatableSpec {
  if (spec.columns.length <= 1 || !spec.columns.some((column) => column.key === key)) return spec
  const rows = spec.rows.map((row) => {
    const { [key]: _removed, ...rest } = row
    return rest
  })
  const next: DatatableSpec = {
    ...spec,
    columns: spec.columns.filter((column) => column.key !== key),
    rows,
  }
  if (spec.view) {
    const view: DatatableView = { ...spec.view }
    if (view.sort?.key === key) delete view.sort
    if (view.group === key) delete view.group
    return writeDatatableView(next, view)
  }
  return next
}

/** 「保存视图」：把当前视图状态写进围栏 JSON；空视图删掉该字段。 */
export function writeDatatableView(spec: DatatableSpec, view: DatatableView): DatatableSpec {
  const next: DatatableView = {}
  if (view.sort) next.sort = { ...view.sort }
  if (view.group) next.group = view.group
  if (view.filter) next.filter = view.filter
  const { view: _current, ...rest } = spec
  return Object.keys(next).length > 0 ? { ...rest, view: next } : { ...rest }
}

export function toDatatableEntries(rows: readonly DatatableRow[]): DatatableEntry[] {
  return rows.map((row, index) => ({ index, row }))
}

/** 搜索：对所有列的「显示文本」做大小写无关的包含匹配，与用户眼睛看到的一致。 */
export function filterDatatableEntries(
  entries: readonly DatatableEntry[],
  columns: readonly DatatableColumn[],
  query: string
): DatatableEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...entries]
  return entries.filter((entry) =>
    columns.some((column) => {
      const value = entry.row[column.key]
      if (value === null || value === undefined) return false
      const text = formatDatatableCell(value, column.type)
      return (
        text.toLowerCase().includes(needle) || String(value).toLowerCase().includes(needle)
      )
    })
  )
}

export function sortDatatableEntries(
  entries: readonly DatatableEntry[],
  columns: readonly DatatableColumn[],
  sort: DatatableView["sort"]
): DatatableEntry[] {
  if (!sort) return [...entries]
  const column = columns.find((item) => item.key === sort.key)
  const sign = sort.direction === "desc" ? -1 : 1
  // 稳定排序：值相等时回退到原始行序，避免同值行在两次排序间跳来跳去。
  return [...entries].sort((left, right) => {
    const a = left.row[sort.key]
    const b = right.row[sort.key]
    // 空值永远沉底，不参与正负翻转：否则降序时一屏空格挡在最前面。
    const emptyA = isEmptyCell(a)
    const emptyB = isEmptyCell(b)
    if (emptyA || emptyB) {
      if (emptyA && emptyB) return left.index - right.index
      return emptyA ? 1 : -1
    }
    const compared = compareCells(a, b, column?.type)
    return compared !== 0 ? compared * sign : left.index - right.index
  })
}

function isEmptyCell(value: unknown) {
  return value === null || value === undefined || value === ""
}

function compareCells(left: unknown, right: unknown, type?: DatatableColumnType) {
  if (type && NUMERIC_TYPES.has(type)) {
    const a = Number(left)
    const b = Number(right)
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b ? 0 : a < b ? -1 : 1
  }
  if (type === "date") {
    const a = new Date(String(left)).getTime()
    const b = new Date(String(right)).getTime()
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b ? 0 : a < b ? -1 : 1
  }
  if (type === "boolean") {
    const a = left ? 1 : 0
    const b = right ? 1 : 0
    return a === b ? 0 : a < b ? -1 : 1
  }
  if (typeof left === "number" && typeof right === "number") {
    return left === right ? 0 : left < right ? -1 : 1
  }
  return String(left).localeCompare(String(right), "zh-CN")
}

/** 分组：保持传入顺序（已排序），同值行聚到第一次出现的位置。 */
export function groupDatatableEntries(
  entries: readonly DatatableEntry[],
  columns: readonly DatatableColumn[],
  groupKey: string | null
): DatatableGroup[] | null {
  if (!groupKey) return null
  const column = columns.find((item) => item.key === groupKey)
  const groups: DatatableGroup[] = []
  const index = new Map<string, DatatableGroup>()
  for (const entry of entries) {
    const value = formatDatatableCell(entry.row[groupKey], column?.type)
    let group = index.get(value)
    if (!group) {
      group = { value, entries: [] }
      index.set(value, group)
      groups.push(group)
    }
    group.entries.push(entry)
  }
  return groups
}

/** 单元格显示文本，全部按 zh-CN 习惯格式化。 */
export function formatDatatableCell(value: unknown, type?: DatatableColumnType): string {
  if (value === null || value === undefined || value === "") return EMPTY_CELL

  switch (type) {
    case "currency": {
      const amount = Number(value)
      if (!Number.isFinite(amount)) return String(value)
      return new Intl.NumberFormat("zh-CN", {
        currency: "CNY",
        maximumFractionDigits: 2,
        style: "currency",
      }).format(amount)
    }
    case "percent": {
      const ratio = Number(value)
      if (!Number.isFinite(ratio)) return String(value)
      return new Intl.NumberFormat("zh-CN", {
        maximumFractionDigits: 1,
        style: "percent",
      }).format(ratio)
    }
    case "number": {
      const amount = Number(value)
      if (!Number.isFinite(amount)) return String(value)
      return new Intl.NumberFormat("zh-CN").format(amount)
    }
    case "boolean":
      return value === true || value === "true" ? "是" : "否"
    case "date": {
      const time = new Date(String(value)).getTime()
      if (!Number.isFinite(time)) return String(value)
      return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(time)
    }
    default:
      return String(value)
  }
}

/** 编辑态输入框里的文本：数字列显示原值而不是带分隔符的展示串。 */
export function datatableEditText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value)
}

/** 输入框文本 → 写回 JSON 的值：按列类型收敛，空文本一律写空串。 */
export function coerceDatatableValue(text: string, type?: DatatableColumnType): unknown {
  const trimmed = text.trim()
  if (!trimmed) return ""
  if (type && NUMERIC_TYPES.has(type)) {
    const amount = Number(trimmed)
    return Number.isFinite(amount) ? amount : text
  }
  if (type === "boolean") {
    if (/^(true|是|yes|1)$/iu.test(trimmed)) return true
    if (/^(false|否|no|0)$/iu.test(trimmed)) return false
    return text
  }
  return text
}

/** 导出：表头 + 当前可见行的显示文本，复用 `src/lib/csv.ts` 的 CSV 序列化。 */
export function datatableToCsv(
  columns: readonly DatatableColumn[],
  entries: readonly DatatableEntry[]
): string {
  const header = columns.map((column) => column.label)
  const rows = entries.map((entry) =>
    columns.map((column) => {
      const value = entry.row[column.key]
      if (value === null || value === undefined || value === "") return ""
      return formatDatatableCell(value, column.type)
    })
  )
  return `${serializeCsv([header, ...rows])}\r\n`
}

/** `/数据表` 插入的 2 列 2 行空表模板。 */
export function createDatatableTemplate(): string {
  return serializeDatatableSpec({
    columns: [
      { key: "column1", label: "列 1", type: "text" },
      { key: "column2", label: "列 2", type: "text" },
    ],
    rows: [
      { column1: "", column2: "" },
      { column1: "", column2: "" },
    ],
  })
}

/** CSV 表头 → 列定义；key 用列序号，表头文字可以重复也可以为空。 */
export function datatableColumnsFromCsv(header: readonly string[]): DatatableColumn[] {
  return header.map((label, index) => ({
    key: `c${index}`,
    label: label.trim() || `列 ${index + 1}`,
  }))
}

export function datatableRowsFromCsv(
  records: readonly (readonly string[])[],
  columns: readonly DatatableColumn[]
): DatatableRow[] {
  return records.map((record) => {
    const row: DatatableRow = {}
    columns.forEach((column, index) => {
      row[column.key] = record[index] ?? ""
    })
    return row
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
