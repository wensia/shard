// Isolated DEV entry. Mock storage is enabled only by ?mock=1 outside a native Tauri runtime.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { createTable } from "@/features/tables/api";
import { TableWorkspace, type TableWorkspaceHandle } from "@/features/tables/table-workspace";
import { applyTableMutations, type ApplyTableMutationsRequest, type ApplyTableMutationsResult } from "@/features/tables/mutations";
import { createTableId, tableContent, type TableFile, type TableReadResult } from "@/features/tables/model";
import fixture from "../../tests/fixtures/tables/valid/six-types.json";
import "../index.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/500.css";
import "@fontsource/noto-sans-sc/600.css";

type Mock = { disk: TableReadResult; calls: { command: string; request: unknown }[]; failSave: boolean; missing: boolean; hold: boolean; release(): void; copies: TableReadResult[] };
declare global { interface Window { __tableWorkspaceMock?: Mock; __tableWorkspaceTest: { flush(): Promise<boolean>; dirty(): boolean; refresh(): void; setDisabled(disabled: boolean): void; setInteractionBlocked(blocked: boolean): void; closed: number; saved: number } } }
function installMock() {
  const waiting: (() => void)[] = [];
  const file = structuredClone(fixture) as TableFile;
  const mock: Mock = { disk: { file, path: "notes/工作区测试.shardtable.json", title: "工作区测试", revision: file.revision, contentHash: "a".repeat(64) }, calls: [], failSave: false,
    missing: new URLSearchParams(location.search).has("missing"), hold: false, release() { mock.hold = false; for (const resolve of waiting.splice(0)) resolve(); }, copies: [] };
  window.__tableWorkspaceMock = mock;
  const raw = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;
  Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, bytes: Uint8Array) => {
    if (!(bytes instanceof Uint8Array)) throw new Error("测试要求 Raw IPC 请求");
    const request = JSON.parse(new TextDecoder().decode(bytes)); mock.calls.push({ command, request });
    if (command === "read_table") { if (mock.missing) throw { code: "NOT_FOUND", message: "数据表文件不存在" }; return raw(mock.disk); }
    if (command === "apply_table_mutations") {
      if (mock.hold) await new Promise<void>(resolve => waiting.push(resolve));
      if (mock.failSave) throw { code: "GIT_BUSY", message: "测试保存失败，草稿仍然保留" };
      const operation = request as ApplyTableMutationsRequest;
      if (operation.expectedHash !== mock.disk.contentHash || operation.expectedRevision !== mock.disk.revision) throw { code: "STALE_BASE", message: "磁盘内容已被外部修改" };
      const before = mock.disk.file;
      const timestamp = "2030-01-01T00:00:00.000Z";
      const content = applyTableMutations(tableContent(before), operation.operations, timestamp);
      const revision = before.revision + 1;
      const hash = revision.toString(16).padStart(64, "0");
      const result: ApplyTableMutationsResult = { tableId: before.id, path: mock.disk.path, mutationId: operation.mutationId, baseRevision: before.revision, revision, contentHash: hash, updatedAt: timestamp,
        changedRecords: Object.values(content.records), deletedRecordIds: before.recordOrder.filter(id => !content.records[id]), changedFields: Object.values(content.fields), deletedFieldIds: before.fieldOrder.filter(id => !content.fields[id]),
        changedViews: Object.values(content.views), deletedViewIds: before.viewOrder.filter(id => !content.views[id]), fieldOrder: content.fieldOrder, recordOrder: content.recordOrder, viewOrder: content.viewOrder };
      mock.disk = { ...mock.disk, contentHash: hash, revision, file: { ...before, ...content, revision, updatedAt: timestamp, lastMutationId: operation.mutationId, lastMutationHash: "e".repeat(64) } };
      return raw(result);
    }
    if (command === "save_table_copy") {
      const existing = mock.copies.find(copy => copy.file.creation.requestId === request.requestId); if (existing) return raw(existing);
      const stamp = "2030-01-01T00:00:00.000Z";
      const file = { ...request.content, kind: "shard.table", schemaVersion: 1, id: request.tableId, revision: 1, creation: { requestId: request.requestId, payloadHash: "f".repeat(64) }, lastMutationId: null, lastMutationHash: null, createdAt: stamp, updatedAt: stamp, copiedFrom: request.source } as TableFile;
      const copy = { file, path: `notes/${request.suggestedName}.shardtable.json`, title: request.suggestedName, revision: 1, contentHash: "c".repeat(64) }; mock.copies.push(copy); return raw(copy);
    }
    throw new Error(`Unexpected test command: ${command}`);
  } } });
}
function Harness() {
  const handle = useRef<TableWorkspaceHandle>(null);
  const [path, setPath] = useState(window.__tableWorkspaceMock?.disk.path ?? new URLSearchParams(location.search).get("path"));
  const [refresh, setRefresh] = useState(0);
  const [disabled, setDisabled] = useState(false);
  const [message, setMessage] = useState("");
  const [inputTrace, setInputTrace] = useState<string[]>([]);
  const tracing = new URLSearchParams(location.search).get("trace") === "1";
  useEffect(() => {
    if (!tracing) return;
    let active = true;
    const events = ["keydown", "keyup", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend", "paste", "focusin", "focusout"] as const;
    const capture = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || (!target.closest(".table-workspace") && target !== document.body)) return;
      const keyboard = event as KeyboardEvent;
      const input = event as InputEvent;
      const summary = { type: event.type, target: target.tagName, role: target.getAttribute("role"), key: keyboard.key ?? null, data: input.data ?? null, inputType: input.inputType ?? null, isComposing: input.isComposing ?? keyboard.isComposing ?? false,
        isTrusted: event.isTrusted, value: target instanceof HTMLTextAreaElement ? target.value : null, selection: target instanceof HTMLTextAreaElement ? [target.selectionStart, target.selectionEnd] : null };
      requestAnimationFrame(() => { if (active) setInputTrace(previous => [...previous, JSON.stringify({ ...summary, active: document.activeElement?.tagName, activeRole: document.activeElement?.getAttribute("role"), dirty: handle.current?.isDirty() ?? false })].slice(-20)); });
    };
    for (const event of events) document.addEventListener(event, capture, true);
    return () => { active = false; for (const event of events) document.removeEventListener(event, capture, true); };
  }, [tracing]);
  window.__tableWorkspaceTest = { flush: () => handle.current?.flush() ?? Promise.resolve(true), dirty: () => handle.current?.isDirty() ?? false, refresh: () => setRefresh(value => value + 1), setDisabled, setInteractionBlocked: blocked => handle.current?.setInteractionBlocked(blocked), closed: window.__tableWorkspaceTest?.closed ?? 0, saved: window.__tableWorkspaceTest?.saved ?? 0 };
  return <main style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
    {!path && <><Button onClick={() => { void createTable({ requestId: createTableId("req"), tableId: createTableId("tbl"), parentPath: "notes", suggestedName: "表格原生验收", content: tableContent(fixture as TableFile) }).then(result => setPath(result.path), error => setMessage(String(error))); }}>创建隔离验收表</Button><p>{message || "原生验收请使用隔离 appIdentifier 和临时资料库。"}</p></>}
    {path && <TableWorkspace ref={handle} path={path} title="工作区测试" disabled={disabled} refreshToken={refresh} onClose={() => { window.__tableWorkspaceTest.closed++; setMessage("已离开工作区"); }} onSaved={() => { window.__tableWorkspaceTest.saved++; }} />}
    {message && <output>{message}</output>}
    {tracing && <pre aria-label="原生输入事件" style={{ flexShrink: 0, maxHeight: "35vh", overflow: "auto", whiteSpace: "pre-wrap", fontSize: "var(--text-meta)", padding: "var(--space-2)", borderTop: "1px solid var(--border)" }}>{inputTrace.join("\n") || "等待此隔离表中的文本输入事件…"}</pre>}
  </main>;
}
if (import.meta.env.DEV) {
  if (!isTauri() && new URLSearchParams(location.search).get("mock") === "1") installMock();
  const root = createRoot(document.getElementById("root")!); root.render(<Harness />);
  import.meta.hot?.dispose(() => root.unmount());
}
