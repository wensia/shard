import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type RefObject, type SyntheticEvent } from "react";
import { Tabs } from "@base-ui/react/tabs";
import DataEditor, { GridCellKind, CompactSelection, emptyGridSelection, type CellArray, type DataEditorRef, type GridCell, type GridSelection, type Item, type Rectangle } from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { TableIcon, PlusIcon, MoreHorizontalIcon, SettingsIcon, ListIcon, DownloadIcon, Maximize2Icon, FunnelIcon, ArrowDownWideNarrowIcon, Undo2Icon, Redo2Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { readTable, saveTableCopy, tableError, type SaveTableCopyRequest } from "./api";
import { TableExportDialog } from "./exchange-dialog";
import { readKilnGridTheme } from "./kiln-grid-theme";
import { createTableId, TABLE_LIMITS, type CellValue, type TableContent, type TableError, type TableFile, type TableReadResult, type TableRecord, type TableView } from "./model";
import type { TableMutation } from "./mutations";
import type { TableSaveState } from "./save-queue";
import { TableSettingsPopover } from "./table-settings-popover";
import { TableFieldList } from "./table-field-list";
import { TableConfigPanel, type TablePanelHandle, type TableConfigMode } from "./table-config-panel";
import { TableBulkEditPanel } from "./table-bulk-edit-panel";
import { TableFieldMenu, TABLE_FIELD_HEADER_ICONS, tableFieldIconName, tableFieldMenuViewChange, type TableFieldMenuAction } from "./table-field-menu";
import { TableRecordPanel } from "./table-record-panel";
import { displayTableValue, makeTableGridEditor, tableGridValue, type TableEditorSession, type TableTextCell } from "./table-value-editor";
import { TableWorkerClient } from "./worker-client";
import type { TableWorkerCommand, TableWorkerIdentity, TableWorkerSnapshot, TableWorkerValue } from "./worker-protocol";
import "./table-workspace.css";

export type TableWorkspaceHandle = { flush(): Promise<boolean>; isDirty(): boolean; setInteractionBlocked(blocked: boolean): void };
export type TableWorkspaceProps = { path: string; title: string; initialRead?: TableReadResult | null; onSaved?(): void; onClose?(): void; onSaveStateChange?(state: "dirty" | "saving" | "saved" | "error"): void; onReady?(revision: string): void; onLoadError?(error: unknown): void; refreshToken?: unknown; embedded?: boolean; disabled?: boolean };
const INITIAL_STATE: TableSaveState = { status: "saved", generation: 0, savedGeneration: 0, dirty: false, pendingCount: 0, error: null };
function problemText(error: unknown): string { const detail = tableError(error); return detail.message + (detail.pointer ? `（${detail.pointer}）` : ""); }
function isContent(value: TableWorkerValue): value is TableContent { return !!value && !Array.isArray(value) && "records" in value; }
function isIdentity(value: TableWorkerValue): value is TableWorkerIdentity { return !!value && !Array.isArray(value) && "contentHash" in value; }
function isFile(value: TableWorkerValue): value is TableFile { return isContent(value) && "kind" in value && value.kind === "shard.table"; }
function groupIndex(groups: TableWorkerSnapshot["projection"]["groups"], row: number) {
  let low = 0, high = groups.length - 1;
  while (low <= high) { const middle = (low + high) >>> 1; const group = groups[middle]; if (row < group.gridStart) high = middle - 1; else if (row >= group.gridStart + (group.collapsed ? 1 : group.count + 1)) low = middle + 1; else return middle; }
  return -1;
}

/** Independent table session. The parent must await flush before navigation/unmount. */
export const TableWorkspace = forwardRef<TableWorkspaceHandle, TableWorkspaceProps>(function TableWorkspace(props, ref) {
  const { path, title, refreshToken } = props;
  const callbacks = useRef(props); callbacks.current = props;
  const initialRead = useRef(props.initialRead ?? null);
  const host = useRef<HTMLDivElement>(null);
  const portal = useRef<HTMLDivElement>(null);
  const grid = useRef<DataEditorRef>(null);
  const gridHost = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLElement | Rectangle | null>(null);
  const [gridSize, setGridSize] = useState({ width: 0, height: 0, scrollbar: 0 });
  const client = useRef<TableWorkerClient | null>(null);
  const records = useRef<Record<string, TableRecord>>({});
  const snapshotRef = useRef<TableWorkerSnapshot | null>(null);
  const [snapshot, setSnapshot] = useState<TableWorkerSnapshot | null>(null);
  const [metrics, setMetrics] = useState<ReturnType<typeof readKilnGridTheme>>();
  const [saveState, setSaveState] = useState(INITIAL_STATE);
  const saveStateRef = useRef(saveState); saveStateRef.current = saveState;
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<TableError | null>(null);
  const [notice, setNotice] = useState("");
  const [external, setExternal] = useState(false);
  const externalRef = useRef(false); externalRef.current = external;
  const [frozen, setFrozen] = useState(false);
  const frozenRef = useRef(false);
  const [interactionBlockedState, setInteractionBlockedState] = useState(false);
  const interactionBlocked = !!props.disabled || interactionBlockedState;
  const interactionBlockedRef = useRef(interactionBlocked); interactionBlockedRef.current = interactionBlocked;
  const confirmingInputs = useRef(false);
  const setInteractionBlocked = useCallback((blocked: boolean) => {
    interactionBlockedRef.current = !!callbacks.current.disabled || blocked;
    setInteractionBlockedState(blocked);
  }, []);
  const guardInteraction = useCallback((event: SyntheticEvent) => { if (interactionBlockedRef.current) { event.preventDefault(); event.stopPropagation(); } }, []);
  const [pendingCount, setPendingCount] = useState(0);
  const pending = useRef(new Set<Promise<unknown>>());
  const failedEdits = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushPromise = useRef<Promise<boolean> | null>(null);
  const editor = useRef<TableEditorSession | null>(null);
  const composing = useRef(false);
  const panelHandle = useRef<TablePanelHandle>(null);
  type ActivePanel = TableConfigMode | "record" | "bulk" | "fieldList" | null;
  const [panel, updatePanel] = useState<ActivePanel>(null);
  const panelRef = useRef<ActivePanel>(null);
  const setPanel = useCallback((next: ActivePanel) => { panelRef.current = next; updatePanel(next); }, []);
  const [selectedFieldId, setSelectedFieldId] = useState<string | undefined>();
  const [fieldAction, setFieldAction] = useState<"newField" | "deleteField" | "filterField" | undefined>();
  const [fieldMenu, setFieldMenu] = useState<{ fieldId: string; anchor: Rectangle } | null>(null);
  const [recordMenu, setRecordMenu] = useState<Rectangle | null>(null);
  const recordMenuAnchor = useMemo(() => recordMenu ? { getBoundingClientRect: () => DOMRect.fromRect(recordMenu) } : null, [recordMenu]);
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [bulkRecordIds, setBulkRecordIds] = useState<string[]>([]);
  const [bulkSession, setBulkSession] = useState(0);
  const groupRequest = useRef(false);
  const addingRecord = useRef(false);
  const [selection, setSelection] = useState<GridSelection>(emptyGridSelection);
  const [selectedRecord, setSelectedRecord] = useState<string | null>(null);
  const [visibleGroup, setVisibleGroup] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [confirm, setConfirm] = useState<"reload" | "deleteRecord" | "deleteView" | "abandon" | null>(null);
  const [localVersion, setLocalVersion] = useState(0);
  const copyRequest = useRef<SaveTableCopyRequest | null>(null);
  const tableId = useRef("");
  const initialSource = useRef<{ tableId: string; revision: number; contentHash: string } | null>(null);
  const alive = useRef(true);
  const abandoned = useRef(false);
  const notifyLocal = useCallback(() => setLocalVersion(value => value + 1), []);
  const registerEditor = useCallback((session: TableEditorSession | null) => { editor.current = session; notifyLocal(); }, [notifyLocal]);
  const GridEditor = useMemo(() => makeTableGridEditor(registerEditor), [registerEditor]);
  const provideEditor = useCallback(() => GridEditor, [GridEditor]);
  const restoreGridFocus = useCallback(() => {
    // Glide focuses before removing its overlay. Restore only the focus that
    // falls back to body; a toolbar, dialog or form may already own focus.
    requestAnimationFrame(() => { if (host.current?.isConnected && !editor.current && document.activeElement === document.body) grid.current?.focus(); });
  }, []);
  const isDirty = useCallback(() => !abandoned.current && !!(client.current?.isDirty() || editor.current?.dirty || editor.current?.composing || composing.current || panelHandle.current?.isDirty()), []);
  const showError = useCallback((error: unknown) => { if (alive.current) setProblem(tableError(error)); }, []);

  useEffect(() => {
    alive.current = true; let cancelled = false;
    setLoading(true); setSnapshot(null); snapshotRef.current = null; records.current = {}; setProblem(null); setExternal(false); setPanel(null); setSelectedRecord(null); setSaveState(INITIAL_STATE);
    const instance = new TableWorkerClient({
      onSnapshot(next) {
        if (cancelled || (!next.reset && snapshotRef.current && next.projection.generation < snapshotRef.current.projection.generation)) return;
        if (next.reset) { records.current = next.records; setSelection(emptyGridSelection); setSelectedRecord(null); }
        else { Object.assign(records.current, next.records); for (const id of next.deletedRecordIds) delete records.current[id]; }
        if (next.reset || (snapshotRef.current && (next.projection.generation !== snapshotRef.current.projection.generation || next.projection.displayRevision !== snapshotRef.current.projection.displayRevision || next.projection.viewId !== snapshotRef.current.projection.viewId))) {
          setSelectedRecordIds([]);
          setSelection(current => next.selectionReset ? emptyGridSelection : current.rows.length ? { ...current, rows: CompactSelection.empty() } : current);
        }
        // Keep one records map; React stores only the projection, metadata and incremental patch.
        snapshotRef.current = next; setSnapshot(next);
      },
      onState(next) {
        if (cancelled) return;
        const previouslyDirty = saveStateRef.current.dirty;
        saveStateRef.current = next; setSaveState(next);
        if (next.error) showError(next.error);
        if (next.status === "saved" && previouslyDirty) { setProblem(null); callbacks.current.onSaved?.(); }
      },
      onError: showError,
    });
    client.current = instance;
    const provided = initialRead.current?.path === path ? initialRead.current : null; initialRead.current = null;
    void (provided ? Promise.resolve(provided) : readTable({ path })).then(async initial => {
      if (cancelled) return;
      tableId.current = initial.file.id;
      initialSource.current = { tableId: initial.file.id, revision: initial.revision, contentHash: initial.contentHash };
      await instance.open(initial);
      if (!cancelled) { setLoading(false); callbacks.current.onReady?.(String(initial.revision)); }
    }).catch(error => { if (!cancelled) { showError(error); setLoading(false); callbacks.current.onLoadError?.(error); } });
    return () => { cancelled = true; alive.current = false; clearTimeout(debounce.current); instance.dispose(); if (client.current === instance) client.current = null; };
  }, [path, showError]);

  useEffect(() => {
    let cancelled = false;
    const update = () => { if (!cancelled && host.current) setMetrics(readKilnGridTheme(host.current)); };
    void document.fonts.ready.then(update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-density", "style"] });
    return () => { cancelled = true; observer.disconnect(); };
  }, []);

  useEffect(() => {
    const element = gridHost.current; if (!element) return;
    const measure = document.createElement("div");
    Object.assign(measure.style, { position: "absolute", visibility: "hidden", width: "var(--space-12)", height: "var(--space-12)", overflow: "scroll" });
    element.append(measure); const scrollbar = measure.offsetWidth - measure.clientWidth; measure.remove();
    const observer = new ResizeObserver(entries => { const rect = entries[0].contentRect; setGridSize({ width: rect.width, height: rect.height, scrollbar }); });
    observer.observe(element); return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const state = problem || external || saveState.status === "error" || saveState.status === "conflict" ? "error" : frozen || saveState.status === "saving" || saveState.status === "checking" ? "saving" : isDirty() ? "dirty" : "saved";
    callbacks.current.onSaveStateChange?.(state);
  }, [saveState, problem, external, frozen, localVersion, pendingCount, isDirty]);

  const scheduleSave = useCallback(() => {
    clearTimeout(debounce.current);
    if (abandoned.current) return;
    debounce.current = setTimeout(() => { if (!abandoned.current && !frozenRef.current && !interactionBlockedRef.current && !externalRef.current) void client.current?.flush(); }, 800);
  }, []);
  const request = useCallback(async (command: TableWorkerCommand): Promise<TableWorkerValue> => {
    const instance = client.current; if (!instance) throw new Error("多维表格尚未读取完成");
    const work = instance.request(command); pending.current.add(work); setPendingCount(pending.current.size);
    try { return await work; } finally { pending.current.delete(work); if (alive.current) setPendingCount(pending.current.size); }
  }, []);
  const mutate = useCallback(async (operations: TableMutation[]): Promise<boolean> => {
    if ((interactionBlockedRef.current || frozenRef.current) && !confirmingInputs.current) return false;
    if (!operations.length) return true;
    try { await request({ type: "mutate", operations }); setProblem(null); scheduleSave(); return true; }
    catch (error) { failedEdits.current++; showError(error); return false; }
  }, [request, scheduleSave, showError]);
  async function confirmInputs(): Promise<boolean> {
    confirmingInputs.current = true;
    try {
      if (composing.current) { showError(new Error("请先完成中文输入候选词，再保存或离开")); return false; }
      if (editor.current && !editor.current.commit()) return false;
      if (panelHandle.current && !await panelHandle.current.commit()) return false;
      return true;
    } finally { confirmingInputs.current = false; }
  }
  async function settlePending() { while (pending.current.size) await Promise.allSettled([...pending.current]); }
  const flush = useCallback((): Promise<boolean> => {
    if (abandoned.current) return Promise.resolve(true);
    if (flushPromise.current) return flushPromise.current;
    const task = (async () => {
      clearTimeout(debounce.current); frozenRef.current = true; setFrozen(true);
      const before = failedEdits.current;
      try {
        if (!await confirmInputs()) return false;
        await settlePending();
        if (before !== failedEdits.current) return false;
        if (!snapshotRef.current || !isDirty()) return !isDirty();
        if (externalRef.current || !client.current) return false;
        const result = await client.current.flush();
        return result && !isDirty();
      } catch (error) { showError(error); return false; }
      finally { frozenRef.current = false; if (alive.current) setFrozen(false); }
    })();
    flushPromise.current = task.finally(() => { flushPromise.current = null; });
    return flushPromise.current;
    // confirmInputs reads current handles and pending requests, never a captured table.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, showError]);
  useImperativeHandle(ref, () => ({ flush, isDirty, setInteractionBlocked }), [flush, isDirty, setInteractionBlocked]);

  const refreshSeen = useRef(refreshToken);
  const refreshRequested = useRef(false);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  useEffect(() => {
    if (refreshSeen.current !== refreshToken) { refreshSeen.current = refreshToken; refreshRequested.current = true; }
    if (!refreshRequested.current || frozen || interactionBlocked || saveState.status === "saving" || saveState.status === "checking") return;
    const instance = client.current; if (!instance || !snapshotRef.current || !tableId.current) return;
    refreshRequested.current = false;
    let cancelled = false;
    void (async () => {
      const before = await instance.request({ type: "identity" });
      if (!isIdentity(before)) throw new Error("无法核对磁盘版本");
      const disk = await readTable({ path, expectedTableId: before.tableId });
      const after = await instance.request({ type: "identity" });
      if (cancelled || client.current !== instance || !isIdentity(after)) return;
      if (interactionBlockedRef.current) { refreshRequested.current = true; return; }
      if (before.contentHash !== after.contentHash || before.revision !== after.revision || saveStateRef.current.status === "saving" || saveStateRef.current.status === "checking") {
        refreshRequested.current = true; setRefreshAttempt(value => value + 1); return;
      }
      if (after.contentHash === disk.contentHash && after.revision === disk.revision) return;
      if (isDirty() || frozenRef.current) { setExternal(true); showError({ code: "STALE_BASE", message: "磁盘中的多维表格已变化，当前草稿已保留。请选择如何处理。" }); return; }
      if (editor.current && !editor.current.cancel()) { refreshRequested.current = true; return; }
      setPanel(null);
      await instance.request({ type: "acceptExternal", snapshot: disk });
      setProblem(null); setExternal(false);
    })().catch(error => { if (!cancelled) { setExternal(true); showError(error); } });
    return () => { cancelled = true; refreshRequested.current = true; };
  }, [refreshToken, path, saveState.status, frozen, interactionBlocked, refreshAttempt, isDirty, showError]);

  const metadata = snapshot?.metadata;
  const view = metadata && snapshot ? metadata.views[snapshot.projection.viewId] : undefined;
  const visibleFields = view && metadata ? view.fieldOrder.filter(id => !view.hiddenFieldIds.includes(id)).map(id => metadata.fields[id]) : [];
  const columnSignature = visibleFields.map(field => `${field.id}:${field.type}:${field.name}:${view?.columnWidths[field.id] ?? metrics?.columnWidth}`).join("\n");
  const columns = useMemo(() => visibleFields.map(field => ({ id: field.id, title: field.name, icon: tableFieldIconName(field.type), width: view?.columnWidths[field.id] ?? metrics?.columnWidth ?? 0, hasMenu: true })), [columnSignature]); // Stable across save notifications and editor changes.
  const gridRows = snapshot?.projection.gridRows ?? [];
  const groups = snapshot?.projection.groups ?? [];
  const rowGroups = useMemo(() => groups.map(group => ({ headerIndex: group.gridStart, isCollapsed: false })), [groups]);
  const groupsByKey = useMemo(() => new Map(groups.map(group => [group.key, group])), [groups]);
  const groupField = view?.groupBy && metadata ? metadata.fields[view.groupBy] : undefined;
  const groupLabel = (group: typeof groups[number]) => groupField ? `${groupField.name}：${group.value == null ? "未填写" : groupField.type === "checkbox" ? group.value ? "已勾选" : "未勾选" : displayTableValue(groupField, group.value) || "空文本"}` : "";
  const busy = frozen || interactionBlocked;
  const navigationBlocked = loading || busy || abandoned.current || exportOpen || confirm !== null;
  const blocked = navigationBlocked || panel !== null || fieldMenu !== null || recordMenu !== null;
  const getCellContent = useCallback(([column, row]: Item): GridCell => {
    const gridRow = gridRows[row];
    if (gridRow?.kind === "group") {
      const group = groupsByKey.get(gridRow.key)!;
      const text = `${group.collapsed ? "▸" : "▾"} ${groupLabel(group)} · ${group.count} 条`;
      return { kind: GridCellKind.Text, data: text, displayData: text, readonly: true, allowOverlay: false, span: [0, Math.max(0, visibleFields.length - 1)] };
    }
    const field = visibleFields[column], recordId = gridRow?.recordId;
    const record = recordId ? records.current[recordId] : undefined;
    if (!field || !record) return { kind: GridCellKind.Text, data: "", displayData: "", readonly: true, allowOverlay: false };
    const value = record.values[field.id]; const text = displayTableValue(field, value);
    return { kind: GridCellKind.Text, data: text, displayData: field.type === "checkbox" ? value == null ? "" : value ? "是" : "否" : text, allowOverlay: !blocked, readonly: blocked,
      tableField: field, tableRecordId: recordId, ...(field.type === "select" || field.type === "multiSelect" || field.type === "checkbox" ? { tableValue: value ?? null } : {}) } as TableTextCell;
  }, [snapshot, columnSignature, blocked]);
  async function commandEdit(command: TableWorkerCommand) {
    if (interactionBlockedRef.current || frozenRef.current) return undefined;
    try { const result = await request(command); setProblem(null); scheduleSave(); return result; } catch (error) { failedEdits.current++; showError(error); return undefined; }
  }
  async function openPanel(next: typeof panel, fieldId?: string, action?: typeof fieldAction, anchor?: HTMLElement | Rectangle) {
    if (interactionBlockedRef.current || frozenRef.current) return;
    if (await confirmInputs()) { await settlePending(); setFieldMenu(null); setSettingsAnchor(anchor instanceof HTMLElement && anchor.closest("[data-slot=table-settings-popover]") ? anchor.getBoundingClientRect() : anchor ?? toolbar.current); setSelectedFieldId(fieldId); setFieldAction(action); setPanel(next); setNotice(""); }
  }
  async function closeSettings() {
    // Escape/outside clicks must not silently create or rename a field.
    // The explicit confirm/cancel actions own an unapplied field draft.
    if (panelRef.current === "fields" && panelHandle.current?.isDirty()) return false;
    if (!await confirmInputs()) return false;
    await settlePending(); setPanel(null); return true;
  }
  async function toggleFieldVisibility(fieldId: string) {
    if (!metadata || !view || fieldId === metadata.primaryFieldId || busy) return;
    const hidden = view.hiddenFieldIds.includes(fieldId);
    await mutate([{ type: "putView", view: { ...view, hiddenFieldIds: hidden ? view.hiddenFieldIds.filter(id => id !== fieldId) : [...view.hiddenFieldIds, fieldId] }, beforeViewId: null }]);
  }
  async function openFieldMenu(column: number, anchor: Rectangle) {
    if (blocked || !visibleFields[column] || !await confirmInputs()) return;
    await settlePending(); setFieldMenu({ fieldId: visibleFields[column].id, anchor });
  }
  async function openRecordMenu(row: number, anchor: Rectangle) {
    const item = gridRows[row];
    if (blocked || item?.kind !== "record" || !await confirmInputs()) return;
    await settlePending();
    setSelectedRecord(item.recordId); setRecordMenu(anchor);
  }
  async function fieldMenuAction(action: TableFieldMenuAction, target = fieldMenu) {
    if (!target || !view || !metadata) return;
    const field = metadata.fields[target.fieldId]; const anchor = target.anchor;
    setFieldMenu(null);
    if (action === "edit" || action === "delete" || action === "filter") {
      await openPanel(action === "filter" ? "filters" : "fields", field.id, action === "delete" ? "deleteField" : action === "filter" ? "filterField" : undefined, anchor);
      return;
    }
    if (!await confirmInputs()) return;
    await settlePending();
    const next = tableFieldMenuViewChange(view, field, metadata.primaryFieldId, action);
    if (next) await mutate([{ type: "putView", view: next, beforeViewId: null }]);
  }
  async function toggleGroup(key: string | undefined, collapsed: boolean) {
    if (blocked || groupRequest.current || !view || !await confirmInputs()) return;
    groupRequest.current = true;
    try { await settlePending(); await request({ type: "setGroupCollapsed", viewId: view.id, key, collapsed });
      const row = key ? snapshotRef.current?.projection.groups.find(group => group.key === key)?.gridStart : undefined;
      setSelection(row === undefined ? emptyGridSelection : { ...emptyGridSelection, current: { cell: [0, row], range: { x: 0, y: row, width: 1, height: 1 }, rangeStack: [] } }); setSelectedRecord(null); }
    catch (error) { showError(error); }
    finally { groupRequest.current = false; }
  }
  async function openBulkEdit() {
    if (blocked || !selectedRecordIds.length || !await confirmInputs()) return;
    await settlePending(); setBulkRecordIds([...selectedRecordIds]); setBulkSession(value => value + 1); setPanel("bulk"); setNotice("");
  }
  async function applyBulkField(fieldId: string, value: CellValue) {
    if ((interactionBlockedRef.current || frozenRef.current) && !confirmingInputs.current) return false;
    try { await request({ type: "bulkSetField", recordIds: bulkRecordIds, fieldId, value }); setProblem(null); scheduleSave(); return true; }
    catch (error) { failedEdits.current++; showError(error); return false; }
  }
  function openField(column: number) { if (!blocked && visibleFields[column]) void openPanel("fields", visibleFields[column].id, undefined, grid.current?.getBounds(column, -1)); }
  async function selectView(viewId: string) {
    if (interactionBlockedRef.current || frozenRef.current) return;
    if (!await confirmInputs()) return;
    try { await settlePending(); await request({ type: "selectView", viewId }); setPanel(null); setSelection(emptyGridSelection); setSelectedRecord(null); setVisibleGroup(0); } catch (error) { showError(error); }
  }
  async function addRecord() {
    if (addingRecord.current || panelRef.current !== null || interactionBlockedRef.current || frozenRef.current) return;
    addingRecord.current = true;
    try {
      if (!await confirmInputs()) return;
      await settlePending();
      const id = createTableId("rec");
      if (await mutate([{ type: "insertRecords", records: [{ id, values: {} }], beforeRecordId: null }])) {
        setSelectedRecord(id); setPanel("record");
        if (!snapshotRef.current?.projection.recordIds.includes(id)) setNotice("新记录暂不符合当前筛选，填写后会重新计算视图。");
      }
    } finally { addingRecord.current = false; }
  }
  async function addView(duplicate: boolean) {
    if (!metadata || !view || interactionBlockedRef.current || frozenRef.current || !await confirmInputs()) return;
    await settlePending();
    const id = createTableId("view");
    const next: TableView = duplicate ? { ...structuredClone(view), id, name: `${view.name} 副本` } : { id, name: "新视图", type: "table", filters: { operator: "and", conditions: [] }, sorts: [], groupBy: null, fieldOrder: [...metadata.fieldOrder], hiddenFieldIds: [], columnWidths: {} };
    if (await mutate([{ type: "putView", view: next, beforeViewId: null }])) { await selectView(id); setPanel("view"); }
  }
  async function loadDisk() {
    if (interactionBlockedRef.current) return;
    if (composing.current || editor.current?.composing) { showError(new Error("请先完成中文输入候选词，再载入磁盘版本")); return; }
    frozenRef.current = true; setFrozen(true); clearTimeout(debounce.current);
    try {
      await settlePending();
      await client.current?.settleInFlightWrites();
      const disk = await readTable({ path, expectedTableId: tableId.current });
      await request({ type: "acceptExternal", snapshot: disk });
      editor.current?.cancel(); setPanel(null); setSelectedRecord(null); copyRequest.current = null;
      initialSource.current = { tableId: disk.file.id, revision: disk.revision, contentHash: disk.contentHash };
      setExternal(false); setProblem(null); setConfirm(null); setNotice("已载入磁盘版本");
    } catch (error) { showError(error); }
    finally { frozenRef.current = false; setFrozen(false); }
  }
  async function saveCopy() {
    if (interactionBlockedRef.current) return;
    clearTimeout(debounce.current); frozenRef.current = true; setFrozen(true);
    try {
      if (!copyRequest.current) {
        if (!await confirmInputs()) return;
        await settlePending();
        const content = await request({ type: "draft" });
        const identity = await request({ type: "identity" });
        if (!isContent(content) || !isIdentity(identity)) throw new Error("无法取得当前草稿");
        copyRequest.current = { requestId: createTableId("req"), tableId: createTableId("tbl"), parentPath: path.slice(0, path.lastIndexOf("/")), suggestedName: `${title} 副本`, content, source: { tableId: identity.tableId, revision: identity.revision, contentHash: identity.contentHash } };
      }
      const result = await saveTableCopy(copyRequest.current);
      copyRequest.current = null; setNotice(`副本已保存到 ${result.path}。本表草稿仍然保留。`); callbacks.current.onSaved?.();
    } catch (error) { showError(error); }
    finally { frozenRef.current = false; setFrozen(false); }
  }
  async function getExportFile(): Promise<TableFile> {
    if (interactionBlockedRef.current) throw new Error("文件操作进行中，请稍后导出");
    if (!await flush()) throw new Error("多维表格尚未保存，已保留当前内容。请先处理保存问题。");
    const file = await request({ type: "file" }); if (!isFile(file)) throw new Error("无法取得完整多维表格备份"); return file;
  }
  const currentGroup = groups[Math.min(visibleGroup, groups.length - 1)];

  const recovery = external || saveState.status === "conflict" || saveState.status === "error" || (!!problem && !!client.current?.isDirty());
  const statusText = abandoned.current ? "已放弃未保存修改" : !snapshot && problem ? "读取失败" : frozen ? "正在确认并保存…" : saveState.status === "saving" ? "正在保存…" : saveState.status === "checking" ? "正在核对保存结果…" : recovery ? isDirty() ? "草稿已保留" : "磁盘版本需要核对" : isDirty() ? "有未保存修改" : "已保存";

  return <Tabs.Root render={<section />} value={view?.id ?? "loading"} onValueChange={value => { if (typeof value === "string" && metadata?.views[value]) void selectView(value); }} ref={host} className="table-workspace" aria-label={`多维表格：${title}`} aria-disabled={interactionBlocked || undefined} aria-busy={busy || pendingCount > 0} inert={interactionBlocked || undefined} data-table-workspace data-density="compact" onPointerDownCapture={guardInteraction} onClickCapture={guardInteraction} onKeyDownCapture={guardInteraction} onBeforeInputCapture={guardInteraction} onPasteCapture={guardInteraction} onCompositionStartCapture={() => { composing.current = true; notifyLocal(); }} onCompositionEndCapture={() => { composing.current = false; notifyLocal(); }} onKeyDown={event => {
    event.stopPropagation();
    if (interactionBlockedRef.current) { event.preventDefault(); return; }
    const target = event.target as HTMLElement;
    if (event.nativeEvent.isComposing || target.closest("input,textarea,select,[contenteditable=true]")) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void flush(); }
    else if (!blocked && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); void commandEdit({ type: event.shiftKey ? "redo" : "undo" }); }
  }}>
    {!props.embedded && <header className="table-workspace-header"><strong title={title}>{title}</strong><div className="table-inline-actions"><Button variant="outline" size="sm" disabled={loading || busy} onClick={() => { void flush(); }}>保存</Button>{props.onClose && <Button variant="outline" size="sm" disabled={busy} onClick={() => { void flush().then(ok => { if (ok) props.onClose?.(); }); }}>关闭</Button>}</div></header>}
    {metadata && view && <><div className="table-view-bar">
      <Tabs.List className="table-view-tabs" aria-label="多维表格视图" activateOnFocus={false}>{metadata.viewOrder.map(id => <div className="table-view-tab-group" key={id} data-active={id === view.id}>
        <Tabs.Tab className="table-view-tab" value={id} disabled={navigationBlocked}><TableIcon /><span>{metadata.views[id].name}</span></Tabs.Tab>
        {id === view.id && <DropdownMenu><DropdownMenuTrigger render={<Button className="table-view-menu" variant="ghost" size="icon-sm" aria-label="视图" title="视图操作" disabled={navigationBlocked}><MoreHorizontalIcon /></Button>} /><DropdownMenuContent>
        <DropdownMenuItem onClick={() => { void openPanel("view", undefined, undefined, toolbar.current ?? undefined); }}>筛选、排序与列设置</DropdownMenuItem>
        <DropdownMenuItem onClick={() => { void openPanel("view", undefined, undefined, toolbar.current ?? undefined); }}>重命名当前视图</DropdownMenuItem>
        <DropdownMenuItem disabled={metadata.viewOrder.length >= TABLE_LIMITS.views} onClick={() => { void addView(true); }}>复制当前视图</DropdownMenuItem>
        <DropdownMenuItem disabled={metadata.viewOrder.indexOf(view.id) === 0} onClick={() => { const order = [...metadata.viewOrder], at = order.indexOf(view.id); [order[at - 1], order[at]] = [order[at], order[at - 1]]; void mutate([{ type: "setViewOrder", viewIds: order }]); }}>视图前移</DropdownMenuItem>
        <DropdownMenuItem disabled={metadata.viewOrder.indexOf(view.id) === metadata.viewOrder.length - 1} onClick={() => { const order = [...metadata.viewOrder], at = order.indexOf(view.id); [order[at + 1], order[at]] = [order[at], order[at + 1]]; void mutate([{ type: "setViewOrder", viewIds: order }]); }}>视图后移</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" disabled={metadata.viewOrder.length < 2} onClick={() => setConfirm("deleteView")}>删除当前视图</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>}
      </div>)}</Tabs.List>
      <Button className="table-new-view" variant="ghost" size="sm" disabled={navigationBlocked || metadata.viewOrder.length >= TABLE_LIMITS.views} onClick={() => { void addView(false); }}><PlusIcon />新建视图</Button>
    </div><div className="table-workspace-toolbar" ref={toolbar} aria-label="表格工具栏">
      <div className="table-toolbar-primary">
        <Button variant="ghost" size="sm" className="table-add-record" aria-label="新增记录" disabled={blocked || metadata.recordOrder.length >= TABLE_LIMITS.rows} onClick={() => { void addRecord(); }}><PlusIcon />添加记录</Button>
        <span className="table-toolbar-divider" />
        <Button variant="ghost" size="sm" data-table-settings-trigger aria-label="字段" aria-expanded={panel === "fieldList" || panel === "fields"} disabled={navigationBlocked} onClick={event => { void openPanel("fieldList", undefined, undefined, event.currentTarget); }}><SettingsIcon />字段配置</Button>
        <Button variant="ghost" size="sm" data-table-settings-trigger aria-expanded={panel === "view"} disabled={navigationBlocked} onClick={event => { void openPanel("view", undefined, undefined, event.currentTarget); }}><TableIcon />视图配置</Button>
        <Button variant="ghost" size="sm" data-table-settings-trigger aria-pressed={view.filters.conditions.length > 0} aria-expanded={panel === "filters"} disabled={navigationBlocked} onClick={event => { void openPanel("filters", undefined, undefined, event.currentTarget); }}><FunnelIcon />筛选{view.filters.conditions.length ? ` ${view.filters.conditions.length}` : ""}</Button>
        <Button variant="ghost" size="sm" data-table-settings-trigger aria-pressed={!!view.groupBy} aria-expanded={panel === "group"} disabled={navigationBlocked} onClick={event => { void openPanel("group", undefined, undefined, event.currentTarget); }}><ListIcon />分组{view.groupBy ? " 1" : ""}</Button>
        <Button variant="ghost" size="sm" data-table-settings-trigger aria-pressed={view.sorts.length > 0} aria-expanded={panel === "sorts"} disabled={navigationBlocked} onClick={event => { void openPanel("sorts", undefined, undefined, event.currentTarget); }}><ArrowDownWideNarrowIcon />排序{view.sorts.length ? ` ${view.sorts.length}` : ""}</Button>
      </div>
      <div className="table-toolbar-secondary">
        {props.embedded && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void flush(); }}>保存</Button>}
        <Button variant="ghost" size="icon-sm" aria-label="撤销" title="撤销" disabled={blocked || !snapshot?.history.canUndo} onClick={() => { void commandEdit({ type: "undo" }); }}><Undo2Icon /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="重做" title="重做" disabled={blocked || !snapshot?.history.canRedo} onClick={() => { void commandEdit({ type: "redo" }); }}><Redo2Icon /></Button>
        <span className="table-toolbar-divider" />
        <Button variant="ghost" size="icon-sm" aria-label="记录详情" title="记录详情" disabled={blocked || !selectedRecord} onClick={() => { void openPanel("record"); }}><Maximize2Icon /></Button>
        <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="记录" title="记录操作" disabled={blocked || !selectedRecord}><MoreHorizontalIcon /></Button>} /><DropdownMenuContent><DropdownMenuItem onClick={() => { void openPanel("record"); }}>记录详情</DropdownMenuItem><DropdownMenuItem variant="destructive" onClick={() => setConfirm("deleteRecord")}>删除此记录</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        <Button variant="ghost" size="icon-sm" aria-label="导出" title="导出" disabled={blocked} onClick={() => setExportOpen(true)}><DownloadIcon /></Button>
      </div>
    </div></>}
    {(problem || recovery) && <div className="table-workspace-alert" role="alert"><p>{problem ? problemText(problem) : "保存尚未完成，当前草稿已保留。"}</p>{recovery && <div className="table-inline-actions"><Button size="sm" variant="outline" disabled={busy} onClick={() => setNotice("继续保留当前草稿；离开前仍需完成保存或明确载入磁盘版本。")}>继续保留草稿</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => { void flush(); }}>核对并重试保存</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => { void saveCopy(); }}>{copyRequest.current ? "核对先前副本" : "另存副本"}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm("reload")}>载入磁盘版本</Button><Button size="sm" variant="destructive" disabled={busy || pendingCount > 0 || saveState.status === "saving" || saveState.status === "checking"} onClick={() => setConfirm("abandon")}>放弃草稿并离开</Button></div>}</div>}
    {notice && <p className="table-workspace-notice" role="status">{notice}</p>}
    {selectedRecordIds.length > 0 && panel !== "bulk" && <div className="table-selection-bar" aria-label="批量操作"><strong>已选择 {selectedRecordIds.length} 条记录</strong><Button size="sm" variant="outline" disabled={blocked} onClick={() => { void openBulkEdit(); }}>批量修改字段</Button><Button size="sm" variant="outline" disabled={blocked} onClick={() => { setSelection(emptyGridSelection); setSelectedRecordIds([]); }}>取消选择</Button></div>}
    {groups.length > 0 && currentGroup && <div className="table-group-bar" aria-label="分组导航"><span>{groupLabel(currentGroup)} · {currentGroup.count} 条</span><span>{Math.min(visibleGroup + 1, groups.length)} / {groups.length} 组</span><Button size="sm" variant="outline" disabled={blocked || visibleGroup <= 0} onClick={() => { const next = visibleGroup - 1; setVisibleGroup(next); grid.current?.scrollTo(0, groups[next].gridStart); }}>上一组</Button><Button size="sm" variant="outline" disabled={blocked || visibleGroup >= groups.length - 1} onClick={() => { const next = visibleGroup + 1; setVisibleGroup(next); grid.current?.scrollTo(0, groups[next].gridStart); }}>下一组</Button><Button size="sm" variant="outline" disabled={blocked || !groups.some(group => !group.collapsed)} onClick={() => { void toggleGroup(undefined, true); }}>全部折叠</Button><Button size="sm" variant="outline" disabled={blocked || !groups.some(group => group.collapsed)} onClick={() => { void toggleGroup(undefined, false); }}>全部展开</Button></div>}
    <Tabs.Panel value={view?.id ?? "loading"} keepMounted className="table-workspace-body" data-panel-open={panel === "record" || panel === "bulk"}>
      <div ref={gridHost} className="table-workspace-grid" aria-label="可编辑多维表格" aria-busy={loading || busy || pendingCount > 0} inert={panel === "record" || panel === "bulk" || undefined}>
        {loading ? <div className="table-workspace-empty" role="status">正在读取多维表格…</div> : !snapshot ? <div className="table-workspace-empty">无法打开此多维表格，请查看上方错误。</div> : metrics && <DataEditor ref={grid} portalElementRef={portal as RefObject<HTMLElement>} width="100%" height={Math.min(gridSize.height || 1, metrics.headerHeight + (gridRows.length + 1) * metrics.rowHeight + gridSize.scrollbar + 1)} columns={columns} rows={gridRows.length}
          theme={metrics.theme} headerIcons={TABLE_FIELD_HEADER_ICONS} rightElement={<Button className="table-add-field" variant="outline" disabled={blocked || (metadata?.fieldOrder.length ?? 0) >= TABLE_LIMITS.fields} onClick={event => { void openPanel("fields", undefined, "newField", event.currentTarget); }}>＋ 新增字段</Button>} rightElementProps={{ sticky: false }} rowHeight={metrics.rowHeight} headerHeight={metrics.headerHeight} getCellContent={getCellContent} provideEditor={provideEditor} onFinishedEditing={restoreGridFocus}
          isOutsideClick={event => { if (event.target instanceof Element && event.target.closest(".click-outside-ignore")) return false; if (!editor.current || portal.current?.contains(event.target as Node)) return true; if (!editor.current.commit()) { event.preventDefault(); event.stopPropagation(); } return false; }}
          rowMarkers={{ kind: "both", width: metrics.headerHeight }} cellActivationBehavior="double-click" rowSelect="multi" rowSelectionMode="multi" columnSelect="none" rangeSelect="rect" gridSelection={selection}
          onGridSelectionChange={next => {
            // Glide can finish append-row focus using a callback from the old
            // projection, after the new record drawer has already been opened.
            if (blocked || panelRef.current !== null) return;
            const rows = next.rows.toArray().filter(row => gridRows[row]?.kind === "record");
            setSelection({ ...next, rows: CompactSelection.fromArray(rows) });
            setSelectedRecordIds(rows.flatMap(row => { const item = gridRows[row]; return item.kind === "record" ? [item.recordId] : []; }));
            if (next.current) { const item = gridRows[next.current.cell[1]]; setSelectedRecord(item?.kind === "record" ? item.recordId : null); }
          }}
          onHeaderClicked={openField} onHeaderContextMenu={(column, event) => { event.preventDefault(); void openFieldMenu(column, event.bounds); }} onHeaderMenuClick={(column, anchor) => { void openFieldMenu(column, anchor); }}
          onCellContextMenu={([, row], event) => { event.preventDefault(); void openRecordMenu(row, event.bounds); }}
          onCellClicked={([, row]) => { if (blocked || panelRef.current !== null) return; const item = gridRows[row]; if (item?.kind === "group") { const group = groupsByKey.get(item.key)!; void toggleGroup(item.key, !group.collapsed); } else setSelectedRecord(item?.recordId ?? null); }}
          onCellActivated={([, row], event) => { if (blocked || panelRef.current !== null) return; const item = gridRows[row]; if (item?.kind === "group") { if (event.inputType === "keyboard") { const group = groupsByKey.get(item.key)!; void toggleGroup(item.key, !group.collapsed); } } else setSelectedRecord(item?.recordId ?? null); }}
          onCellsEdited={edits => { try { const cells = edits.map(({ value }) => { const cell = value as TableTextCell; return { recordId: cell.tableRecordId, fieldId: cell.tableField.id, value: tableGridValue(cell) }; }); void mutate([{ type: "setCells", cells }]); } catch (error) { showError(error); } return true; }}
          onPaste={([column, row], values) => { if (!blocked) void commandEdit({ type: "paste", viewId: snapshot.projection.viewId, generation: snapshot.projection.generation, displayRevision: snapshot.projection.displayRevision, column, row, values: values as string[][] }).then(result => { if (result && !Array.isArray(result) && "hiddenInsertedCount" in result && result.hiddenInsertedCount) setNotice(`已粘贴；其中 ${result.hiddenInsertedCount} 条新记录不符合当前筛选，已保留在表中。`); }); return false; }}
          onDelete={next => { if (!blocked && next.current) void commandEdit({ type: "clearCells", viewId: snapshot.projection.viewId, generation: snapshot.projection.generation, displayRevision: snapshot.projection.displayRevision, selection: next.current.range }); return false; }}
          getCellsForSelection={(range, signal) => async () => { if (signal.aborted) return []; try { const result = await request({ type: "copy", viewId: snapshot.projection.viewId, generation: snapshot.projection.generation, displayRevision: snapshot.projection.displayRevision, selection: range }); return !signal.aborted && Array.isArray(result) ? result as CellArray : []; } catch (error) { showError(error); return []; } }}
          onColumnResizeEnd={(column, width) => { if (!blocked && column.id) void mutate([{ type: "putView", view: { ...view!, columnWidths: { ...view!.columnWidths, [column.id]: Math.max(64, Math.min(1200, Math.round(width))) } }, beforeViewId: null }]); }}
          onVisibleRegionChanged={range => { const index = groupIndex(groups, range.y); if (index >= 0) setVisibleGroup(index); }}
          getRowThemeOverride={row => gridRows[row]?.kind === "group" ? { bgCell: metrics.theme.bgHeader, textDark: metrics.theme.textHeader } : undefined}
          // The Worker already folds rows; Glide only marks the remaining headers
          // so they have no record checkbox and retain ordinary keyboard focus.
          rowGrouping={rowGroups.length ? { groups: rowGroups, height: metrics.rowHeight, themeOverride: { bgCell: metrics.theme.bgHeader, textDark: metrics.theme.textHeader }, navigationBehavior: "normal", selectionBehavior: "allow-spanning" } : undefined}
          trailingRowOptions={{ hint: "添加记录", sticky: false }} onRowAppended={async () => { if (!blocked) await addRecord(); return undefined; }}
          spanRangeBehavior="allowPartial"
          smoothScrollX smoothScrollY />}
        {!loading && snapshot && !snapshot.projection.recordIds.length && <div className="table-workspace-empty table-empty-overlay">{snapshot.metadata.recordOrder.length ? "没有符合当前筛选的记录" : "还没有记录，点击“新增记录”开始"}</div>}
      </div>
      {panel === "record" && selectedRecord && records.current[selectedRecord] && metadata && <TableRecordPanel key={selectedRecord} ref={panelHandle} record={records.current[selectedRecord]} metadata={metadata} busy={busy} onMutate={mutate} onClose={() => { setPanel(null); restoreGridFocus(); }} onDirtyChange={notifyLocal} />}
      {panel === "bulk" && metadata && <TableBulkEditPanel key={bulkSession} ref={panelHandle} metadata={metadata} recordIds={bulkRecordIds} busy={busy} onApply={applyBulkField} onClose={() => setPanel(null)} onDirtyChange={notifyLocal} />}
    </Tabs.Panel>
    {panel !== null && panel !== "record" && panel !== "bulk" && metadata && view && <TableSettingsPopover anchor={settingsAnchor ?? toolbar.current} label={panel === "fieldList" ? "字段配置" : panel === "fields" ? fieldAction === "newField" ? "新增字段" : "编辑字段" : panel === "view" ? "视图设置" : panel === "filters" ? "筛选设置" : panel === "sorts" ? "排序设置" : "分组设置"} className={panel === "fieldList" ? "table-fields-popover" : undefined} busy={busy} onRequestClose={closeSettings}>
      {panel === "fieldList" ? <TableFieldList metadata={metadata} view={view} busy={busy || pendingCount > 0} onEdit={(fieldId, anchor) => { void openPanel("fields", fieldId, undefined, anchor); }} onAdd={anchor => { void openPanel("fields", undefined, "newField", anchor); }} onToggleVisibility={fieldId => { void toggleFieldVisibility(fieldId); }} onMenuAction={(fieldId, action, anchor) => { void fieldMenuAction(action, { fieldId, anchor }); }} />
        : <TableConfigPanel key={`${panel}:${view.id}:${selectedFieldId ?? ""}:${fieldAction ?? ""}`} ref={panelHandle} mode={panel} compactField={panel === "fields"} initialFieldId={selectedFieldId} initialAction={fieldAction} metadata={metadata} viewId={view.id} busy={busy} onMutate={mutate} onClose={() => setPanel(null)} onCancel={() => { setPanel(null); notifyLocal(); }} onDirtyChange={notifyLocal} />}
    </TableSettingsPopover>}
    <footer className="table-workspace-footer"><span>{snapshot ? `${snapshot.projection.recordIds.length.toLocaleString()} / ${snapshot.metadata.recordOrder.length.toLocaleString()} 条记录 · ${visibleFields.length} 列` : "多维表格"}</span><output role="status">{statusText}</output></footer>
    {fieldMenu && metadata && view && metadata.fields[fieldMenu.fieldId] && <TableFieldMenu field={metadata.fields[fieldMenu.fieldId]} view={view} primaryFieldId={metadata.primaryFieldId} anchor={fieldMenu.anchor} busy={busy} onAction={action => { void fieldMenuAction(action); }} onClose={() => { setFieldMenu(null); restoreGridFocus(); }} />}
    {recordMenu && <DropdownMenu open onOpenChange={open => { if (!open) { setRecordMenu(null); restoreGridFocus(); } }}><DropdownMenuContent anchor={recordMenuAnchor} aria-label="记录操作" className="click-outside-ignore" finalFocus={false}>
      <DropdownMenuItem disabled={busy} onClick={() => { setRecordMenu(null); void openPanel("record"); }}>查看详情</DropdownMenuItem>
      <DropdownMenuItem disabled={busy} variant="destructive" onClick={() => { setRecordMenu(null); setConfirm("deleteRecord"); }}>删除此记录</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>}
    <div ref={portal} className="table-grid-portal" />
    {exportOpen && <TableExportDialog getFile={getExportFile} currentViewId={view?.id} suggestedName={title} onClose={() => setExportOpen(false)} />}
    <Dialog open={confirm !== null} onOpenChange={open => { if (!open && !frozen) setConfirm(null); }}><DialogContent showCloseButton={!frozen}><DialogHeader><DialogTitle>{confirm === "abandon" ? "放弃草稿并离开" : confirm === "reload" ? "载入磁盘版本" : confirm === "deleteView" ? "删除当前视图" : "删除此记录"}</DialogTitle><DialogDescription>{confirm === "abandon" ? "这会放弃当前未保存的单元格、记录和视图设置。磁盘中的文件不会被改动，已另存的副本会保留。" : confirm === "reload" ? "这会丢弃当前未保存的单元格、记录表单和视图设置，并清空撤销历史。可先另存副本。" : confirm === "deleteView" ? `只删除“${view?.name}”的显示配置，保留所有记录。此操作可撤销。` : "删除所选记录的所有字段值。此操作可撤销。"}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>取消</Button><Button variant="destructive" disabled={busy || (confirm === "abandon" && pendingCount > 0)} onClick={() => {
      if (confirm === "abandon") { if (composing.current || editor.current?.composing) { showError(new Error("请先完成中文输入候选词，再离开")); return; } clearTimeout(debounce.current); editor.current?.cancel(); setPanel(null); abandoned.current = true; setConfirm(null); setNotice("已放弃当前草稿，可以离开此表。"); notifyLocal(); props.onClose?.(); }
      else if (confirm === "reload") void loadDisk();
      else if (confirm === "deleteView" && view) void mutate([{ type: "deleteView", viewId: view.id }]).then(ok => { if (ok) { setConfirm(null); setSelection(emptyGridSelection); } });
      else if (selectedRecord) void mutate([{ type: "deleteRecords", recordIds: [selectedRecord] }]).then(ok => { if (ok) { setConfirm(null); setSelectedRecord(null); setSelection(emptyGridSelection); } });
    }}>{confirm === "abandon" ? "确认放弃并离开" : confirm === "reload" ? "丢弃草稿并载入" : "确认删除"}</Button></DialogFooter></DialogContent></Dialog>
  </Tabs.Root>;
});
