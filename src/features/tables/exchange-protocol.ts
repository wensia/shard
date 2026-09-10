import type { CsvEncoding } from "@/lib/csv"
import type { TableExportScope, TableImportIssue, TableImportMapping } from "./exchange"
import type { TableContent, TableFile } from "./model"
import type { XlsxIssue, XlsxPreview } from "./xlsx-api"

export type ExchangePreview = { format: "csv" | "xlsx" | "native"; encoding?: CsvEncoding; hasHeader: boolean; columns: { sourceColumn: number; name: string }[]; rows: (string | null)[][]; rowCount: number; mappings: TableImportMapping[]; sourceIssues: XlsxIssue[]; sourceIssueCount: number; sourceHasWarnings: boolean; sourceHasErrors: boolean }
export type ExchangeValidation = { valid: boolean; rowCount: number; fieldCount: number; issues: TableImportIssue[]; issueCount: number }
export type ExchangeExport = { type: "bytes" | "xlsx"; bytes: Uint8Array; escapedCells: number; recordCount: number; fieldCount: number }
export type ExchangeCommand =
  | { type: "loadCsv"; bytes: Uint8Array; hasHeader: boolean; encoding: "auto" | CsvEncoding }
  | { type: "loadXlsx"; preview: XlsxPreview; hasHeader: boolean }
  | { type: "loadNative"; bytes: Uint8Array }
  | { type: "validate"; mappings: TableImportMapping[]; errorsAsText: boolean; acknowledgeWarnings: boolean }
  | { type: "content" }
  | { type: "export"; file: TableFile; format: "csv" | "xlsx" | "native"; scope: TableExportScope; mode: "safe" | "raw" }
export type ExchangeResult = ExchangePreview | ExchangeValidation | ExchangeExport | TableContent
export type ExchangeRequest = { id: number; command: ExchangeCommand }
export type ExchangeResponse = { id: number; value?: ExchangeResult; error?: string }
