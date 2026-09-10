import { invoke, isTauri } from "@tauri-apps/api/core"
import { DESKTOP_RUNTIME_MESSAGE } from "@/lib/api"
import { tableError } from "./api"
import { decodeTableResponse } from "./codec"
import type { CellValue, TableError } from "./model"

export type XlsxIssue = { code: string; message: string; severity: string; row: number | null; column: number | null }
export type XlsxCell = { value: CellValue; kind: string; rawText: string | null; formula: string | null; issues: XlsxIssue[] }
export type XlsxWorkbookInfo = { sheetNames: string[]; issues: XlsxIssue[] }
export type XlsxPreview = XlsxWorkbookInfo & { sheetIndex: number; rows: XlsxCell[][]; totalRows: number; totalColumns: number; truncated: boolean }

function desktop<T>(command: string, request: unknown): Promise<T> {
  if (!isTauri()) return Promise.reject({ code: "IO_ERROR", message: DESKTOP_RUNTIME_MESSAGE } satisfies TableError)
  return invoke<T>(command, { request }).catch((error: unknown) => Promise.reject(tableError(error)))
}
export const inspectTableXlsx = (path: string) => desktop<XlsxWorkbookInfo>("inspect_table_xlsx", { path })
export async function previewTableXlsx(path: string, sheetIndex: number): Promise<XlsxPreview> {
  return decodeTableResponse<XlsxPreview>(await desktop<ArrayBuffer>("preview_table_xlsx", { path, sheetIndex }))
}
export async function prepareTableXlsxExport(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isTauri()) throw { code: "IO_ERROR", message: DESKTOP_RUNTIME_MESSAGE } satisfies TableError
  const buffer = await invoke<ArrayBuffer>("prepare_table_xlsx_export", bytes).catch((error: unknown): never => { throw tableError(error) })
  return new Uint8Array(buffer)
}
export async function readTableExchangeFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await desktop<ArrayBuffer>("read_table_exchange_file", { path }))
}
export async function writeTableExchangeFile(path: string, bytes: Uint8Array): Promise<void> {
  if (!isTauri()) throw { code: "IO_ERROR", message: DESKTOP_RUNTIME_MESSAGE } satisfies TableError
  // Raw IPC avoids a large number[] -> JSON serialization on the UI thread.
  await invoke<void>("write_table_exchange_file", bytes, { headers: { "x-shard-export-path": encodeURIComponent(path) } }).catch((error: unknown) => Promise.reject(tableError(error)))
}
