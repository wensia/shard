export type CsvTable = {
  header: string[]
  rows: string[][]
}

export type DatasetSchema = {
  schemaVersion: number
  datasetId: string
  title: string
  primaryKey?: string
}

/** 文件原来的写法；`datasets/` 外的 CSV 写回时保留它。 */
export type CsvDialect = {
  encoding: "utf8" | "utf16le" | "utf16be" | "gb18030"
  bom: boolean
  delimiter: string
  lineEnding: "lf" | "crlf"
  trailingNewline: boolean
}

export type DatasetSnapshot = {
  path: string
  table: CsvTable
  sha: string
  schema: DatasetSchema | null
  schemaSha: string | null
  editable: boolean
  readOnlyReason: string | null
  dialect?: CsvDialect
  /** 只读只因编码不是 UTF-8 或列数不齐：确认后可转换成可编辑的 UTF-8 文件。 */
  convertible?: boolean
}

export type DatasetOp =
  | { op: "setCells"; cells: { row: number; column: number; value: string }[] }
  | { op: "insertRows"; at: number; rows: string[][] }
  | { op: "deleteRows"; rows: number[] }
  | { op: "insertColumn"; at: number; name: string }
  | { op: "renameColumn"; column: number; name: string }
  | { op: "deleteColumn"; column: number }
