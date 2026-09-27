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

export type DatasetSnapshot = {
  path: string
  table: CsvTable
  sha: string
  schema: DatasetSchema | null
  schemaSha: string | null
  editable: boolean
  readOnlyReason: string | null
}

export type DatasetOp =
  | { op: "setCells"; cells: { row: number; column: number; value: string }[] }
  | { op: "insertRows"; at: number; rows: string[][] }
  | { op: "deleteRows"; rows: number[] }
  | { op: "insertColumn"; at: number; name: string }
  | { op: "renameColumn"; column: number; name: string }
  | { op: "deleteColumn"; column: number }
