import { invoke, isTauri } from "@tauri-apps/api/core"

import { DESKTOP_RUNTIME_MESSAGE, getApiErrorMessage } from "@/lib/api"
import type { DatasetOp, DatasetSnapshot } from "./types"

function desktopInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(DESKTOP_RUNTIME_MESSAGE)
  return invoke<T>(command, args).catch((error) => Promise.reject(getApiErrorMessage(error)))
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

export function createDataset(
  title: string,
  header: string[],
  rows: string[][],
  primaryKey?: string
): Promise<DatasetSnapshot> {
  return desktopInvoke("create_dataset", { title, header, rows, primaryKey: primaryKey ?? null })
}

export function isStaleBaseError(error: unknown): boolean {
  return getApiErrorMessage(error).startsWith("STALE_BASE:")
}
