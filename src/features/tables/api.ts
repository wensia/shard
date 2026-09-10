import { invoke, isTauri } from "@tauri-apps/api/core";
import { DESKTOP_RUNTIME_MESSAGE } from "@/lib/api";
import type { TableContent, TableError, TableReadResult } from "./model";
import type { ApplyTableMutationsRequest, ApplyTableMutationsResult } from "./mutations";
import { encodeTableRequest, decodeTableResponse } from "./codec";

export type CreateTableRequest = { requestId: string; tableId: string; parentPath: string; suggestedName: string; content: TableContent };
export type SaveTableCopyRequest = CreateTableRequest & { source: { tableId: string; revision: number; contentHash: string } };

export function tableError(error: unknown): TableError {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const value = error as TableError;
    return { code: value.code, message: String(value.message), ...(value.pointer !== undefined ? { pointer: value.pointer } : {}), ...(value.operationIndex !== undefined ? { operationIndex: value.operationIndex } : {}) };
  }
  return { code: "IO_ERROR", message: error instanceof Error ? error.message : String(error) };
}

/** Preserve structured errors: the queue needs to distinguish conflicts from unknown write outcomes. */
async function tableInvoke<T>(command: string, request: unknown): Promise<T> {
  if (!isTauri()) return Promise.reject({ code: "IO_ERROR", message: DESKTOP_RUNTIME_MESSAGE } satisfies TableError);
  try {
    const bytes = request instanceof Uint8Array ? request : await encodeTableRequest(request);
    return await decodeTableResponse<T>(await invoke<ArrayBuffer>(command, bytes));
  } catch (error) { return Promise.reject(tableError(error)); }
}
export const createTable = (request: CreateTableRequest) => tableInvoke<TableReadResult>("create_table", request);
export const readTable = (request: { path: string; expectedTableId?: string }) => tableInvoke<TableReadResult>("read_table", request);
export const applyTableMutations = (request: ApplyTableMutationsRequest) => tableInvoke<ApplyTableMutationsResult>("apply_table_mutations", request);
export const saveTableCopy = (request: SaveTableCopyRequest) => tableInvoke<TableReadResult>("save_table_copy", request);
