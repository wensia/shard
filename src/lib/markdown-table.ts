/**
 * GFM 表格解析。
 *
 * 只认 GitHub Flavored Markdown 那一套（CommonMark 本身没有表格）：
 * 首行是表头，第二行是形如 `| --- | :---: |` 的分隔行，之后是数据行。
 * 行首尾的 `|` 可选，单元格前后空格会被 trim——所以用空格把列"填齐"
 * 只是给人看的，不影响解析。
 *
 * 单元格里的竖线必须写成 `\|`。GFM 是先按 `|` 切分再解析行内内容的，
 * 所以行内代码里的裸 `|` 同样会把单元格切开，这里保持一致行为。
 */

export type TableAlign = "center" | "left" | "right" | null

export interface MarkdownTable {
  align: TableAlign[]
  header: string[]
  rows: string[][]
  /** 表格占用的行数，供调用方跳过这些行 */
  lineCount: number
}

const DELIMITER_CELL = /^:?-+:?$/

/** 一行是否可能是表格的一部分：至少有一个未转义的竖线。 */
export function isTableCandidateLine(line: string) {
  return splitRow(line).length > 1 || /^\s*\|/.test(line)
}

/**
 * 尝试从 `lines[start]` 开始解析一张表格。
 * 不是表格时返回 null，调用方按普通行处理。
 */
export function parseMarkdownTable(
  lines: string[],
  start: number
): MarkdownTable | null {
  const headerLine = lines[start]
  const delimiterLine = lines[start + 1]
  if (headerLine === undefined || delimiterLine === undefined) return null
  if (!isTableCandidateLine(headerLine)) return null

  const align = parseDelimiterRow(delimiterLine)
  if (!align) return null

  const header = normalizeRow(splitRow(headerLine), align.length)
  const rows: string[][] = []
  let cursor = start + 2

  while (cursor < lines.length) {
    const line = lines[cursor]
    if (line === undefined || line.trim() === "") break
    if (!isTableCandidateLine(line)) break

    rows.push(normalizeRow(splitRow(line), align.length))
    cursor += 1
  }

  return { align, header, lineCount: cursor - start, rows }
}

/** 分隔行必须每一格都是 `---` / `:--` / `--:` / `:-:`，否则不是表格。 */
function parseDelimiterRow(line: string): TableAlign[] | null {
  const cells = splitRow(line)
  if (cells.length === 0) return null

  const align: TableAlign[] = []
  for (const cell of cells) {
    const trimmed = cell.trim()
    if (!DELIMITER_CELL.test(trimmed)) return null

    const left = trimmed.startsWith(":")
    const right = trimmed.endsWith(":") && trimmed.length > 1
    if (left && right) align.push("center")
    else if (right) align.push("right")
    else if (left) align.push("left")
    else align.push(null)
  }

  return align
}

/**
 * 按未转义的 `|` 切分一行，并丢掉首尾那对可选的竖线。
 * `\|` 还原成字面量 `|`。
 */
function splitRow(line: string): string[] {
  const cells: string[] = []
  let current = ""
  let index = 0

  while (index < line.length) {
    const char = line[index]
    if (char === "\\" && line[index + 1] === "|") {
      current += "|"
      index += 2
      continue
    }
    if (char === "|") {
      cells.push(current)
      current = ""
      index += 1
      continue
    }
    current += char
    index += 1
  }
  cells.push(current)

  // 行首/行尾的竖线会切出空串，GFM 允许写也允许省，这里统一去掉
  if (cells.length > 0 && cells[0]?.trim() === "") cells.shift()
  if (cells.length > 0 && cells[cells.length - 1]?.trim() === "") cells.pop()

  return cells.map((cell) => cell.trim())
}

/** 列数以分隔行为准：多的截断，少的补空。 */
function normalizeRow(cells: string[], columnCount: number): string[] {
  const next = cells.slice(0, columnCount)
  while (next.length < columnCount) next.push("")
  return next
}

/* ------------------------------------------------------------------ */
/* 编辑态用的结构操作。全部是纯函数：接收一张表，返回新的一张表，       */
/* 由调用方负责序列化回正文并写进编辑器。                              */
/* ------------------------------------------------------------------ */

const DEFAULT_DELIMITER_WIDTH = 3

/**
 * 编辑态可视化表格的单元格上限。
 *
 * 编辑态每个单元格是一个受控 input，改一个格子要重写整段正文并 reconcile
 * 全部 input。实测（headless chromium，6 列）：
 *   1000 行 /  6000 格 → 每敲一个字 129ms
 *   2500 行 / 15000 格 → 528ms
 *   5000 行 / 30000 格 → 860ms，已经是卡死
 * 6000 格是"还能用"的边界，超过就退回纯文本——源码照样能编辑，只是没有
 * 可视化表格，但至少不会把编辑器打字卡住。
 */
export const MAX_EDITABLE_TABLE_CELLS = 6000

/**
 * 空表骨架。rowCount 含表头那一行，所以 3×2 = 表头 + 1 行数据，
 * 3×1 就是一张只有表头的表——GFM 允许，用户在选择器里看到几行就是几行。
 */
export function createMarkdownTable(
  columnCount: number,
  rowCount: number
): MarkdownTable {
  const columns = Math.max(1, Math.round(columnCount))
  const bodyRows = Math.max(0, Math.round(rowCount) - 1)

  return {
    align: Array.from({ length: columns }, () => null),
    header: Array.from({ length: columns }, () => ""),
    lineCount: bodyRows + 2,
    rows: Array.from({ length: bodyRows }, () =>
      Array.from({ length: columns }, () => "")
    ),
  }
}

/**
 * 写回 GFM 文本。列宽按最宽单元格补齐——纯粹为了让源文本本身也能读，
 * 解析时这些空格会被 trim 掉，不影响语义。
 */
export function serializeMarkdownTable(table: MarkdownTable): string {
  const widths = table.align.map((_, column) => {
    const cells = [
      table.header[column] ?? "",
      ...table.rows.map((row) => row[column] ?? ""),
    ]
    const contentWidth = cells.reduce(
      (widest, cell) => Math.max(widest, getDisplayWidth(escapeCell(cell))),
      0
    )
    return Math.max(contentWidth, DEFAULT_DELIMITER_WIDTH)
  })

  return [
    formatRow(table.header, widths),
    formatDelimiterRow(table.align, widths),
    ...table.rows.map((row) => formatRow(row, widths)),
  ].join("\n")
}

/**
 * 正文里有没有大到不给可视化编辑的表格。导入后用它决定要不要提醒一句，
 * 免得用户以为表格「没渲染出来」是坏了。
 */
export function hasOversizedTable(markdown: string) {
  const lines = markdown.split("\n")

  for (let index = 0; index < lines.length; index += 1) {
    const table = parseMarkdownTable(lines, index)
    if (!table) continue
    if (getTableCellCount(table) > MAX_EDITABLE_TABLE_CELLS) return true
    index += table.lineCount - 1
  }

  return false
}

/** 表格有多少个单元格（含表头行）。 */
export function getTableCellCount(table: MarkdownTable) {
  return (table.rows.length + 1) * table.align.length
}

/** rowIndex 为 -1 时改表头，否则改第 rowIndex 行数据。 */
export function withTableCell(
  table: MarkdownTable,
  rowIndex: number,
  columnIndex: number,
  text: string
): MarkdownTable {
  const value = text.replace(/[\r\n]+/g, " ")

  if (rowIndex < 0) {
    return {
      ...table,
      header: replaceAt(table.header, columnIndex, value),
    }
  }

  const row = table.rows[rowIndex]
  if (!row) return table

  return {
    ...table,
    rows: replaceAt(table.rows, rowIndex, replaceAt(row, columnIndex, value)),
  }
}

/** 在 rowIndex 之后插入一行空数据；rowIndex 为 -1 表示插到表头下面。 */
export function withInsertedTableRow(
  table: MarkdownTable,
  rowIndex: number
): MarkdownTable {
  const emptyRow = table.align.map(() => "")
  const position = Math.min(Math.max(rowIndex + 1, 0), table.rows.length)
  const rows = [...table.rows]
  rows.splice(position, 0, emptyRow)

  return { ...table, lineCount: rows.length + 2, rows }
}

/** 表头不能删；数据行可以删空，只剩表头的表在 GFM 里同样合法。 */
export function withoutTableRow(
  table: MarkdownTable,
  rowIndex: number
): MarkdownTable {
  if (rowIndex < 0 || table.rows.length === 0) return table

  const rows = table.rows.filter((_, index) => index !== rowIndex)
  return { ...table, lineCount: rows.length + 2, rows }
}

/** 在 columnIndex 之后插入一列空单元格。 */
export function withInsertedTableColumn(
  table: MarkdownTable,
  columnIndex: number
): MarkdownTable {
  const position = Math.min(Math.max(columnIndex + 1, 0), table.align.length)

  return {
    ...table,
    align: insertAt(table.align, position, null),
    header: insertAt(table.header, position, ""),
    rows: table.rows.map((row) => insertAt(row, position, "")),
  }
}

export function withoutTableColumn(
  table: MarkdownTable,
  columnIndex: number
): MarkdownTable {
  if (columnIndex < 0 || table.align.length <= 1) return table

  const keep = (_: unknown, index: number) => index !== columnIndex

  return {
    ...table,
    align: table.align.filter(keep),
    header: table.header.filter(keep),
    rows: table.rows.map((row) => row.filter(keep)),
  }
}

export function withTableAlign(
  table: MarkdownTable,
  columnIndex: number,
  align: TableAlign
): MarkdownTable {
  if (columnIndex < 0 || columnIndex >= table.align.length) return table

  return { ...table, align: replaceAt(table.align, columnIndex, align) }
}

/** 把正文里 [startLine, startLine + lineCount) 这几行换成新表格。 */
export function replaceTableLines(
  content: string,
  startLine: number,
  lineCount: number,
  table: MarkdownTable
): string {
  const lines = content.split("\n")
  lines.splice(startLine, lineCount, ...serializeMarkdownTable(table).split("\n"))
  return lines.join("\n")
}

/** 正文里第 lineIndex 行的起始字符偏移，用来定位表格块。 */
export function getLineStartOffset(content: string, lineIndex: number) {
  let offset = 0
  const lines = content.split("\n")

  for (let index = 0; index < lineIndex && index < lines.length; index += 1) {
    offset += (lines[index]?.length ?? 0) + 1
  }

  return offset
}

function formatRow(cells: string[], widths: number[]) {
  const body = widths
    .map((width, column) => ` ${padCell(escapeCell(cells[column] ?? ""), width)} `)
    .join("|")

  return `|${body}|`
}

function formatDelimiterRow(align: TableAlign[], widths: number[]) {
  const body = align
    .map((value, column) => ` ${formatDelimiterCell(value, widths[column] ?? DEFAULT_DELIMITER_WIDTH)} `)
    .join("|")

  return `|${body}|`
}

function formatDelimiterCell(align: TableAlign, width: number) {
  const left = align === "center" || align === "left" ? ":" : ""
  const right = align === "center" || align === "right" ? ":" : ""
  const dashes = "-".repeat(Math.max(1, width - left.length - right.length))

  return `${left}${dashes}${right}`
}

/** 单元格里的裸 `|` 会把列切开，写回时必须转义。 */
function escapeCell(cell: string) {
  return cell.replace(/\|/g, "\\|")
}

function padCell(cell: string, width: number) {
  return cell + " ".repeat(Math.max(0, width - getDisplayWidth(cell)))
}

/** CJK 在等宽字体里占两格，按码点宽度补齐源文本才是齐的。 */
function getDisplayWidth(text: string) {
  let width = 0
  for (const char of text) {
    width += isWideCharacter(char) ? 2 : 1
  }
  return width
}

function isWideCharacter(char: string) {
  return /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{20000}-\u{3FFFD}]/u.test(
    char
  )
}

function replaceAt<T>(items: T[], index: number, value: T): T[] {
  if (index < 0 || index >= items.length) return items

  const next = [...items]
  next[index] = value
  return next
}

function insertAt<T>(items: T[], index: number, value: T): T[] {
  const next = [...items]
  next.splice(index, 0, value)
  return next
}
