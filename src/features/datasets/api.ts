import { getApiErrorMessage } from "@/lib/api"
import { transport } from "@/lib/transport"
import { uploadBlob } from "@/lib/transport/http"
import { fileBytes } from "@/lib/web-files"
import type { DatasetOp, DatasetSnapshot } from "./types"

function desktopInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return transport()
    .invoke<T>(command, args)
    .catch((error) => Promise.reject(getApiErrorMessage(error)))
}

export function readDataset(path: string): Promise<DatasetSnapshot> {
  return desktopInvoke("read_dataset", { path })
}

export function applyDatasetOps(
  path: string,
  expectedSha: string,
  expectedSchemaSha: string | null,
  ops: DatasetOp[]
): Promise<DatasetSnapshot> {
  return desktopInvoke("apply_dataset_ops", { path, expectedSha, expectedSchemaSha, ops })
}

/** 用户确认后把 GBK/UTF-16 或列数不齐的 CSV 转换成可编辑的 UTF-8 文件（会改写原文件）。 */
export function normalizeCsvFile(path: string, expectedSha: string): Promise<DatasetSnapshot> {
  return desktopInvoke("normalize_csv_file", { path, expectedSha })
}

export function createDataset(
  title: string,
  header: string[],
  rows: string[][],
  primaryKey?: string
): Promise<DatasetSnapshot> {
  return desktopInvoke("create_dataset", { title, header, rows, primaryKey: primaryKey ?? null })
}

/** 表格里的本地图片引用中真正存在的那些（只有它们画成缩略图）。 */
export function existingVaultImages(paths: string[]): Promise<string[]> {
  return desktopInvoke("existing_vault_images", { paths })
}

export function isStaleBaseError(error: unknown): boolean {
  return getApiErrorMessage(error).startsWith("STALE_BASE:")
}

/** Excel 第一个工作表读成的字符串矩阵（第一行是表头）；只用于导入为数据集。 */
export type XlsxRecords = {
  sheetName: string
  sheetCount: number
  records: string[][]
  warnings: string[]
}

export function readImportXlsxFile(path: string): Promise<XlsxRecords> {
  return desktopInvoke("read_import_xlsx_file", { path })
}

/** 网页端：浏览器选的 Excel 先上传，再由服务器读第一个工作表（不落进资料库）。 */
export async function readImportXlsxUpload(file: File): Promise<XlsxRecords> {
  const blobSha = await uploadBlob(await fileBytes(file))
  return desktopInvoke("read_import_xlsx_blob", { blobSha })
}

export async function readImportCsvFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await desktopInvoke<number[]>("read_import_csv_file", { path }))
}
