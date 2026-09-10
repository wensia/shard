// The worker owns full-table validation, history, projection and the save queue.
// Main-thread RPC only transports Tauri requests; it never replays domain operations.
import { TableHistory } from "@/features/tables/history";
import { TableSaveQueue } from "@/features/tables/save-queue";
import { projectOwnedTableView, type TableProjection } from "@/features/tables/views";
import { clearTableRectangle, copyTableRectangle, prepareTablePaste, type TableRectangle } from "@/features/tables/clipboard";
import { TABLE_LIMITS, tableAssert, type TableContent, type TableError, type TableRecord, type TableReadResult } from "@/features/tables/model";
import type { PreparedTableChange } from "@/features/tables/mutations";
import type { TableWorkerCommand, TableWorkerMessage, TableWorkerRequest, TableWorkerValue } from "@/features/tables/worker-protocol";
import type { TableSaveTransport } from "@/features/tables/save-queue";

let queue: TableSaveQueue | undefined;
const history = new TableHistory();
let viewId = "";
let previous: TableContent | undefined;
let displayRevision = 0;
const collapsedGroups = new Map<string, Set<string>>();
let projectionCache: { content: TableContent; projection: TableProjection } | undefined;
let previousProjection: TableProjection | undefined;
let previousVisibleFields: string[] = [];
const clipboardCache = new WeakMap<TableProjection, { projection: TableProjection; before: number[] }>();
let rpcId = 0;
const pendingRpc = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
const emit = (message: TableWorkerMessage) => self.postMessage(message);
function errorValue(error: unknown): TableError {
  const value = error as Partial<TableError> | null;
  return { code: value?.code ?? "IO_ERROR", message: value?.message ?? String(error), ...(value?.pointer ? { pointer: value.pointer } : {}), ...(value?.operationIndex !== undefined ? { operationIndex: value.operationIndex } : {}) };
}
function state() { if (queue) { const current = queue.getState(); emit({ type: "state", state: { ...current, error: current.error ? errorValue(current.error) : null } }); } }
function rpc(method: "apply" | "read", request: Parameters<TableSaveTransport["apply"]>[0] | Parameters<TableSaveTransport["read"]>[0]): Promise<unknown> {
  const id = ++rpcId;
  state();
  return new Promise((resolve, reject) => {
    pendingRpc.set(id, { resolve, reject });
    emit({ type: "rpc", id, method, request } as TableWorkerMessage);
  });
}
function displayScope(content: TableContent) { return `${viewId}/${content.views[viewId].groupBy ?? ""}`; }
function project(content: TableContent): TableProjection {
  const cached = projectionCache;
  const generation = queue!.getState().generation;
  if (cached?.content === content && cached.projection.viewId === viewId && cached.projection.generation === generation && cached.projection.displayRevision === displayRevision) return cached.projection;
  const projection = projectOwnedTableView(content, viewId, generation, { collapsedGroups: collapsedGroups.get(displayScope(content)), displayRevision });
  projectionCache = { content, projection };
  return projection;
}
// Convert canvas rows to visible record rows once in the Worker. Group headers and
// collapsed records must never become mutation targets or clipboard data.
function clipboardRows(projection: TableProjection) {
  const cached = clipboardCache.get(projection); if (cached) return cached;
  const recordIds: string[] = []; const before = [0];
  for (const row of projection.gridRows) {
    if (row.kind === "record") recordIds.push(row.recordId);
    before.push(recordIds.length);
  }
  const value = { projection: { ...projection, recordIds }, before };
  clipboardCache.set(projection, value);
  return value;
}
function gridRectangle(content: TableContent, projection: TableProjection, selection: TableRectangle, before: number[]): TableRectangle {
  const { x, y, width, height } = selection;
  const view = content.views[viewId]; const columns = view.fieldOrder.length - view.hiddenFieldIds.length;
  tableAssert([x, y, width, height].every(Number.isSafeInteger) && x >= 0 && y >= 0 && width > 0 && height > 0, "/selection", "选区无效");
  tableAssert(x + width <= columns && y + height <= projection.gridRows.length, "/selection", "选区超出当前视图");
  return { x, y: before[y], width, height: before[y + height] - before[y] };
}
function snapshot(reset = false) {
  if (!queue) return;
  const content = queue.peekDraft();
  if (!content.views[viewId]) viewId = content.viewOrder[0];
  if (previous && previous !== content) displayRevision++;
  const { records, ...metadata } = content;
  const changed: Record<string, TableRecord> = {};
  for (const [id, record] of Object.entries(records)) {
    if (reset || record !== previous?.records[id]) changed[id] = record;
  }
  const deletedRecordIds = previous ? Object.keys(previous.records).filter((id) => !records[id]) : [];
  const projection = project(content);
  const view = content.views[viewId]; const hidden = new Set(view.hiddenFieldIds);
  const visibleFields = view.fieldOrder.filter(id => !hidden.has(id));
  const selectionReset = reset || !previousProjection || projection.viewId !== previousProjection.viewId ||
    visibleFields.length !== previousVisibleFields.length || visibleFields.some((id, index) => id !== previousVisibleFields[index]) ||
    projection.gridRows.length !== previousProjection.gridRows.length || projection.gridRows.some((row, index) => {
      const before = previousProjection!.gridRows[index];
      return row.kind === "record" ? before.kind !== "record" || row.recordId !== before.recordId : before.kind !== "group" || row.key !== before.key;
    });
  emit({ type: "snapshot", snapshot: { metadata, records: changed, deletedRecordIds, reset, selectionReset,
    projection, history: { canUndo: history.canUndo, canRedo: history.canRedo } } });
  previousProjection = projection; previousVisibleFields = visibleFields;
  previous = content;
  state();
}
async function execute(command: TableWorkerCommand): Promise<TableWorkerValue> {
  if (command.type === "open") {
    if (queue) throw new Error("每个数据表会话使用独立 Worker");
    queue = new TableSaveQueue(command.initial, {
      apply: (request) => rpc("apply", request) as ReturnType<TableSaveTransport["apply"]>,
      read: (request) => rpc("read", request) as ReturnType<TableSaveTransport["read"]>,
    });
    viewId = command.initial.file.viewOrder[0];
    history.clear(); snapshot(true); return;
  }
  if (!queue) throw new Error("数据表尚未读取完成");
  if (command.type === "draft") return queue.getDraft();
  if (command.type === "identity") return queue.getIdentity();
  if (command.type === "file") {
    tableAssert(!queue.getState().dirty, "", "请先保存数据表后导出完整备份");
    const baseline = queue.getIdentity();
    const disk = await rpc("read", { path: baseline.path, expectedTableId: baseline.tableId }) as TableReadResult;
    tableAssert(!queue.getState().dirty && disk.contentHash === baseline.contentHash && disk.revision === baseline.revision, "", "导出前磁盘内容已变化，请先刷新数据表", "STALE_BASE");
    return disk.file;
  }
  if (command.type === "flush") {
    try { await queue.flush(); } finally { snapshot(); }
    return;
  }
  if (command.type === "acceptExternal") { queue.acceptExternal(command.snapshot); history.clear(); snapshot(true); return; }
  if (command.type === "selectView") {
    tableAssert(queue.peekDraft().views[command.viewId], "/viewId", "视图不存在");
    if (viewId !== command.viewId) displayRevision++;
    viewId = command.viewId; snapshot(); return;
  }
  const draft = queue.peekDraft();
  if (command.type === "setGroupCollapsed") {
    tableAssert(command.viewId === viewId, "/viewId", "视图已变化，请重新选择后操作", "STALE_BASE");
    tableAssert(draft.views[viewId].groupBy !== null && typeof command.collapsed === "boolean", "/groupBy", "当前视图未分组");
    const projection = project(draft); const scope = displayScope(draft);
    const keys = command.key === undefined ? projection.groups.map(group => group.key) : [command.key];
    tableAssert(command.key === undefined || projection.groups.some(group => group.key === command.key), "/key", "分组已变化，请重新选择后操作", "STALE_BASE");
    const collapsed = collapsedGroups.get(scope) ?? new Set<string>(); let changed = false;
    for (const key of keys) {
      if (command.collapsed !== collapsed.has(key)) changed = true;
      if (command.collapsed) collapsed.add(key); else collapsed.delete(key);
    }
    collapsedGroups.set(scope, collapsed);
    if (changed) { displayRevision++; snapshot(); }
    return;
  }
  const timestamp = new Date().toISOString();
  const accept = (change: PreparedTableChange) => { queue!.enqueuePrepared(change); };
  if (command.type === "paste" || command.type === "copy" || command.type === "clearCells") {
    tableAssert(command.viewId === viewId && command.generation === queue.getState().generation && (command.displayRevision ?? 0) === displayRevision, "", "视图已变化，请重新选择后操作", "STALE_BASE");
    const projection = project(draft); const visible = clipboardRows(projection);
    if (command.type === "copy" || command.type === "clearCells") {
      const selection = gridRectangle(draft, projection, command.selection, visible.before);
      if (command.type === "copy") return selection.height ? copyTableRectangle(draft, visible.projection, selection) : [];
      if (selection.height) history.applyPrepared(draft, clearTableRectangle(draft, visible.projection, selection), timestamp, accept);
    }
    else {
      tableAssert(Number.isSafeInteger(command.row) && command.row >= 0 && command.row <= projection.gridRows.length, "/row", "粘贴位置超出当前视图");
      tableAssert(projection.gridRows[command.row]?.kind !== "group", "/row", "分组标题不可粘贴，请先选择记录单元格", "INVALID_VALUE");
      const pasted = prepareTablePaste(draft, visible.projection, command.column, visible.before[command.row], command.values);
      history.applyPrepared(draft, pasted.operations, timestamp, accept);
      const matchingIds = new Set(project(queue.peekDraft()).recordIds);
      snapshot();
      return { insertedCount: pasted.insertedIds.length, hiddenInsertedCount: pasted.insertedIds.filter(id => !matchingIds.has(id)).length };
    }
  } else if (command.type === "bulkSetField") {
    tableAssert(Array.isArray(command.recordIds) && command.recordIds.length > 0 && new Set(command.recordIds).size === command.recordIds.length, "/recordIds", "请选择不重复的记录");
    tableAssert(command.recordIds.length <= TABLE_LIMITS.mutationCells, "/recordIds", "一次批量修改最多 50000 条记录", "LIMIT_EXCEEDED");
    const cells = command.recordIds.map(recordId => ({ recordId, fieldId: command.fieldId, value: command.value }));
    history.applyPrepared(draft, [{ type: "setCells", cells }], timestamp, accept);
  } else if (command.type === "mutate") history.applyPrepared(draft, command.operations, timestamp, accept);
  else if (command.type === "undo") history.undoPrepared(draft, timestamp, accept);
  else history.redoPrepared(draft, timestamp, accept);
  snapshot();
}
self.onmessage = ({ data }: MessageEvent<TableWorkerRequest>) => {
  if ("type" in data && data.type === "rpcResult") {
    const waiter = pendingRpc.get(data.id); pendingRpc.delete(data.id);
    if (data.error) waiter?.reject(data.error); else waiter?.resolve(data.value);
    return;
  }
  if (!("command" in data)) return;
  void execute(data.command).then((value) => emit({ type: "result", id: data.id, value }), (error: unknown) => { state(); emit({ type: "result", id: data.id, error: errorValue(error) }); });
};
