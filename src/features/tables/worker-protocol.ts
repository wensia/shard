import type { CellValue, TableContent, TableError, TableFile, TableReadResult, TableRecord } from "./model";
import type { ApplyTableMutationsRequest, TableMutation } from "./mutations";
import type { TableSaveState } from "./save-queue";
import type { projectTableView } from "./views";

export type TableWorkerCommand =
  | { type: "open"; initial: TableReadResult }
  | { type: "mutate"; operations: TableMutation[] }
  | { type: "undo" | "redo" | "flush" | "draft" | "file" | "identity" }
  | { type: "paste"; viewId: string; generation: number; displayRevision?: number; column: number; row: number; values: string[][] }
  | { type: "copy"; viewId: string; generation: number; displayRevision?: number; selection: { x: number; y: number; width: number; height: number } }
  | { type: "clearCells"; viewId: string; generation: number; displayRevision?: number; selection: { x: number; y: number; width: number; height: number } }
  | { type: "selectView"; viewId: string }
  | { type: "setGroupCollapsed"; viewId: string; key?: string; collapsed: boolean }
  | { type: "bulkSetField"; recordIds: string[]; fieldId: string; value: CellValue }
  | { type: "acceptExternal"; snapshot: TableReadResult };
export type TableWorkerRequest =
  | { id: number; command: TableWorkerCommand }
  | { type: "rpcResult"; id: number; value?: unknown; error?: TableError };
export type TableWorkerSnapshot = {
  metadata: Omit<TableContent, "records">;
  records: Record<string, TableRecord>;
  deletedRecordIds: string[];
  reset: boolean;
  /** Grid coordinates changed; the owner must discard existing row/cell selections. */
  selectionReset?: boolean;
  projection: ReturnType<typeof projectTableView>;
  history: { canUndo: boolean; canRedo: boolean };
};
export type TablePasteResult = { insertedCount: number; hiddenInsertedCount: number };
export type TableCopyCell = { kind: "text"; data: string; displayData: string; allowOverlay: false };
export type TableWorkerIdentity = { tableId: string; path: string; revision: number; contentHash: string; updatedAt: string };
export type TableWorkerValue = TableContent | TableFile | TablePasteResult | TableCopyCell[][] | TableWorkerIdentity | undefined;
export type TableWorkerMessage =
  | { type: "rpc"; id: number; method: "apply"; request: ApplyTableMutationsRequest }
  | { type: "rpc"; id: number; method: "read"; request: { path: string; expectedTableId: string } }
  | { type: "state"; state: TableSaveState }
  | { type: "snapshot"; snapshot: TableWorkerSnapshot }
  | { type: "result"; id: number; value?: TableWorkerValue; error?: TableError };
