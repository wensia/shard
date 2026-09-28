import type { CsvTable, DatasetOp, DatasetSchema } from "./types"

export class DatasetOpError extends Error {
  constructor(public readonly code: "OP_INVALID" | "HEADER_INVALID" | "PRIMARY_KEY_INVALID" | "LIMIT_EXCEEDED", message: string) {
    super(`${code}:${message}`)
    this.name = "DatasetOpError"
  }
}

const limits = {
  rows: 10_000,
  columns: 128,
  cells: 300_000,
  bytes: 64 * 1024 * 1024,
  cellChars: 16_384,
  ops: 64,
  explicitCells: 50_000,
} as const

const utf8 = new TextEncoder()

function fail(code: DatasetOpError["code"], message: string): never {
  throw new DatasetOpError(code, message)
}

function indexValid(index: number, end: number, allowEnd = false): boolean {
  return Number.isSafeInteger(index) && index >= 0 && (allowEnd ? index <= end : index < end)
}

function csvBytes(table: CsvTable): number {
  let bytes = 0
  for (const record of [table.header, ...table.rows]) {
    for (let i = 0; i < record.length; i++) {
      const value = record[i]
      // csv crate also quotes a single empty field so it stays a record.
      const quoted = /[",\r\n]/u.test(value) || (record.length === 1 && value === "")
      bytes += utf8.encode(value).length + (quoted ? 2 + (value.match(/"/gu)?.length ?? 0) : 0)
      if (i > 0) bytes++
    }
    bytes++
  }
  return bytes
}

function validate(table: CsvTable, schema: DatasetSchema | null): void {
  if (table.header.length === 0 || table.header.some((name) => !name) || new Set(table.header).size !== table.header.length) {
    fail("HEADER_INVALID", "表头名称不能为空且不能重复")
  }
  const key = schema?.primaryKey
  if (key !== undefined) {
    const column = table.header.indexOf(key)
    if (column < 0) fail("PRIMARY_KEY_INVALID", "主键列不存在")
    const values = new Set<string>()
    for (const row of table.rows) {
      const value = row[column]
      if (!value || values.has(value)) fail("PRIMARY_KEY_INVALID", "主键值不能为空且不能重复")
      values.add(value)
    }
  }
  if (table.rows.length > limits.rows || table.header.length > limits.columns || table.rows.length * table.header.length > limits.cells ||
    table.header.some((value) => [...value].length > limits.cellChars) ||
    table.rows.some((row) => row.some((value) => [...value].length > limits.cellChars)) ||
    csvBytes(table) > limits.bytes) {
    fail("LIMIT_EXCEEDED", "数据集超过可编辑上限")
  }
}

function applyOne(table: CsvTable, schema: DatasetSchema | null, op: DatasetOp): number {
  const key = schema?.primaryKey
  switch (op.op) {
    case "setCells":
      for (const cell of op.cells) {
        if (!indexValid(cell.row, table.rows.length) || !indexValid(cell.column, table.header.length)) fail("OP_INVALID", "单元格下标越界")
        if (key === table.header[cell.column] && table.rows[cell.row][cell.column] !== cell.value) fail("PRIMARY_KEY_INVALID", "不能修改已有主键值")
        table.rows[cell.row][cell.column] = cell.value
      }
      return op.cells.length
    case "insertRows":
      if (!indexValid(op.at, table.rows.length, true) || op.rows.some((row) => row.length !== table.header.length)) fail("OP_INVALID", "插入行的位置或列数无效")
      table.rows.splice(op.at, 0, ...op.rows.map((row) => [...row]))
      return op.rows.length * table.header.length
    case "deleteRows": {
      const indices = [...new Set(op.rows)].sort((a, b) => b - a)
      if (indices.some((index) => !indexValid(index, table.rows.length))) fail("OP_INVALID", "删除行下标越界")
      for (const index of indices) table.rows.splice(index, 1)
      return 0
    }
    case "insertColumn":
      if (!indexValid(op.at, table.header.length, true)) fail("OP_INVALID", "插入列下标越界")
      table.header.splice(op.at, 0, op.name)
      for (const row of table.rows) row.splice(op.at, 0, "")
      return 0
    case "renameColumn":
      if (!indexValid(op.column, table.header.length)) fail("OP_INVALID", "重命名列下标越界")
      if (key === table.header[op.column]) fail("PRIMARY_KEY_INVALID", "不能重命名主键列")
      table.header[op.column] = op.name
      return 0
    case "deleteColumn":
      if (!indexValid(op.column, table.header.length) || table.header.length === 1) fail("OP_INVALID", "不能删除该列")
      if (key === table.header[op.column]) fail("PRIMARY_KEY_INVALID", "不能删除主键列")
      table.header.splice(op.column, 1)
      for (const row of table.rows) row.splice(op.column, 1)
      return 0
  }
}

export function applyDatasetOps(table: CsvTable, schema: DatasetSchema | null, ops: DatasetOp[]): CsvTable {
  if (ops.length > limits.ops) fail("LIMIT_EXCEEDED", "操作数量超过上限")
  validate(table, schema)
  const next: CsvTable = { header: [...table.header], rows: table.rows.map((row) => [...row]) }
  let explicit = 0
  for (const op of ops) {
    explicit += applyOne(next, schema, op)
    validate(next, schema)
  }
  if (explicit > limits.explicitCells) fail("LIMIT_EXCEEDED", "显式单元格数量超过上限")
  return next
}

export function invertDatasetOps(tableBefore: CsvTable, ops: DatasetOp[]): DatasetOp[] {
  applyDatasetOps(tableBefore, null, ops)
  let current = tableBefore
  const inverse: DatasetOp[][] = []
  for (const op of ops) {
    let undo: DatasetOp[]
    switch (op.op) {
      case "setCells": {
        const originals = new Map<string, { row: number; column: number; value: string }>()
        for (const cell of op.cells) {
          const id = `${cell.row}:${cell.column}`
          if (!originals.has(id)) originals.set(id, { row: cell.row, column: cell.column, value: current.rows[cell.row]?.[cell.column] })
        }
        undo = [{ op: "setCells", cells: [...originals.values()] }]
        break
      }
      case "insertRows":
        undo = [{ op: "deleteRows", rows: op.rows.map((_, i) => op.at + i) }]
        break
      case "deleteRows": {
        const indices = [...new Set(op.rows)].sort((a, b) => a - b)
        undo = []
        for (const index of indices) {
          const last = undo[undo.length - 1]
          if (last?.op === "insertRows" && last.at + last.rows.length === index) last.rows.push([...current.rows[index]])
          else undo.push({ op: "insertRows", at: index, rows: [[...current.rows[index]]] })
        }
        break
      }
      case "insertColumn":
        undo = [{ op: "deleteColumn", column: op.at }]
        break
      case "renameColumn":
        undo = [{ op: "renameColumn", column: op.column, name: current.header[op.column] }]
        break
      case "deleteColumn":
        undo = [
          { op: "insertColumn", at: op.column, name: current.header[op.column] },
          { op: "setCells", cells: current.rows.map((row, index) => ({ row: index, column: op.column, value: row[op.column] })) },
        ]
        break
    }
    current = applyDatasetOps(current, null, [op])
    inverse.unshift(undo)
  }
  const result = inverse.flat()
  // An undo is itself a write batch and must satisfy the same operation limits.
  try {
    applyDatasetOps(current, null, result)
    return result
  } catch (error) {
    if (!(error instanceof DatasetOpError) || error.code !== "LIMIT_EXCEEDED" ||
      current.header.length !== tableBefore.header.length ||
      current.header.some((name, index) => name !== tableBefore.header[index])) throw error
    const rebuild: DatasetOp[] = [
      { op: "deleteRows", rows: current.rows.map((_, index) => index) },
      { op: "insertRows", at: 0, rows: tableBefore.rows.map((row) => [...row]) },
    ]
    applyDatasetOps(current, null, rebuild)
    return rebuild
  }
}

export function newRowId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return `r_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
