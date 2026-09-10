import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { parseTableFile, type TableContent, type TableReadResult } from "@/features/tables/model";
import type { TableWorkerCommand, TableWorkerMessage, TableWorkerRequest } from "@/features/tables/worker-protocol";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function session() {
  const messages: TableWorkerMessage[] = [];
  const endpoint = { postMessage: (message: TableWorkerMessage) => messages.push(structuredClone(message)), onmessage: (_: { data: TableWorkerRequest }) => {} };
  vi.stubGlobal("self", endpoint);
  await import("@/workers/table.worker");
  const file = parseTableFile(readFileSync(new URL("../../tests/fixtures/tables/valid/six-types.json", import.meta.url), "utf8"));
  const viewId = file.viewOrder[0]; const fieldId = file.fieldOrder[3];
  const field = file.fields[fieldId]; if (field.type !== "select") throw new Error("fixture type");
  file.views[viewId].groupBy = fieldId;
  for (const [index, id] of file.recordOrder.entries()) {
    file.records[id].values[file.primaryFieldId] = ["A", "B", "C", "D"][index];
    file.records[id].values[fieldId] = field.options[index % 2].id;
  }
  const initial: TableReadResult = { file, path: "notes/分组.shardtable.json", title: "分组", revision: file.revision, contentHash: "a".repeat(64) };
  let nextId = 0;
  async function request(command: TableWorkerCommand) {
    const id = ++nextId; endpoint.onmessage({ data: { id, command } });
    await vi.waitFor(() => expect(messages.some(message => message.type === "result" && message.id === id)).toBe(true));
    return messages.find(message => message.type === "result" && message.id === id) as Extract<TableWorkerMessage, { type: "result" }>;
  }
  const snapshot = () => (messages.filter(message => message.type === "snapshot").slice(-1)[0] as Extract<TableWorkerMessage, { type: "snapshot" }>).snapshot;
  const stamp = () => { const projection = snapshot().projection; return { viewId, generation: projection.generation, displayRevision: projection.displayRevision }; };
  const draft = async () => (await request({ type: "draft" })).value as TableContent;
  await request({ type: "open", initial });
  return { file, viewId, fieldId, messages, request, snapshot, stamp, draft };
}

it("folds only the session display, keeps counts and full projection, and rejects obsolete grid coordinates", async () => {
  const test = await session(); const before = await test.draft(); const stamp = test.stamp();
  const expanded = test.snapshot().projection; const key = expanded.groups[0].key;
  expect(expanded.gridRows).toHaveLength(6);
  await test.request({ type: "setGroupCollapsed", viewId: test.viewId, key, collapsed: true });
  const folded = test.snapshot().projection;
  expect(test.snapshot().selectionReset).toBe(true);
  expect(folded.generation).toBe(expanded.generation);
  expect(folded.displayRevision).toBeGreaterThan(expanded.displayRevision);
  expect(folded.recordIds).toEqual(expanded.recordIds);
  expect(folded.gridRows).toEqual([
    { kind: "group", key }, { kind: "group", key: expanded.groups[1].key },
    { kind: "record", recordId: test.file.recordOrder[1] }, { kind: "record", recordId: test.file.recordOrder[3] },
  ]);
  expect(folded.groups[0]).toMatchObject({ collapsed: true, count: 2 });
  expect(await test.draft()).toEqual(before);
  expect(test.snapshot().history.canUndo).toBe(false);
  expect(test.messages.filter(message => message.type === "state").slice(-1)[0]).toMatchObject({ state: { dirty: false } });
  expect(test.messages.some(message => message.type === "rpc")).toBe(false);
  for (const command of [
    { type: "copy" as const, selection: { x: 0, y: 1, width: 1, height: 1 } },
    { type: "clearCells" as const, selection: { x: 0, y: 1, width: 1, height: 1 } },
    { type: "paste" as const, column: 0, row: 1, values: [["stale"]] },
  ]) expect(await test.request({ ...command, ...stamp })).toMatchObject({ error: { code: "STALE_BASE" } });
  await test.request({ type: "setGroupCollapsed", viewId: test.viewId, collapsed: true });
  expect(test.snapshot().projection.gridRows.every(row => row.kind === "group")).toBe(true);
  await test.request({ type: "setGroupCollapsed", viewId: test.viewId, collapsed: false });
  expect(test.snapshot().projection.gridRows).toEqual(expanded.gridRows);
});

it("copies and clears visible records across title rows while folded records remain unchanged", async () => {
  const test = await session(); const [a, b, c, d] = test.file.recordOrder;
  const before = await test.draft();
  const selection = { x: 0, y: 0, width: 1, height: 6 };
  const copied = await test.request({ type: "copy", ...test.stamp(), selection });
  expect(copied.value).toEqual(["A", "C", "B", "D"].map(data => [{ kind: "text", data, displayData: data, allowOverlay: false }]));
  await test.request({ type: "setGroupCollapsed", viewId: test.viewId, key: test.snapshot().projection.groups[0].key, collapsed: true });
  const onlyTitle = await test.request({ type: "copy", ...test.stamp(), selection: { ...selection, height: 1 } });
  expect(onlyTitle.value).toEqual([]);
  expect(await test.request({ type: "clearCells", ...test.stamp(), selection: { ...selection, height: 4 } })).not.toHaveProperty("error");
  const after = await test.draft();
  expect([a, c].map(id => after.records[id].values[test.file.primaryFieldId])).toEqual(["A", "C"]);
  expect([b, d].map(id => after.records[id].values[test.file.primaryFieldId])).toEqual([undefined, undefined]);
  await test.request({ type: "undo" });
  const undone = await test.draft();
  expect(test.file.recordOrder.map(id => undone.records[id].values)).toEqual(test.file.recordOrder.map(id => before.records[id].values));
});

it("pastes across group titles in one undo step, rejects a title start, and leaves collapsed rows intact", async () => {
  const test = await session(); const [a, b, c, d] = test.file.recordOrder; const field = test.file.primaryFieldId;
  expect(await test.request({ type: "paste", ...test.stamp(), column: 0, row: 0, values: [["title"]] })).toMatchObject({ error: { code: "INVALID_VALUE", message: expect.stringContaining("分组标题") } });
  expect(await test.request({ type: "paste", ...test.stamp(), column: 0, row: 1, values: [["one"], ["two"], ["three"], ["four"]] })).not.toHaveProperty("error");
  let after = await test.draft();
  expect([a, c, b, d].map(id => after.records[id].values[field])).toEqual(["one", "two", "three", "four"]);
  await test.request({ type: "undo" });
  expect(test.snapshot().history.canUndo).toBe(false);
  await test.request({ type: "setGroupCollapsed", viewId: test.viewId, key: test.snapshot().projection.groups[0].key, collapsed: true });
  expect(await test.request({ type: "paste", ...test.stamp(), column: 0, row: 2, values: [["visible one"], ["visible two"], ["new record"]] })).toMatchObject({ value: { insertedCount: 1, hiddenInsertedCount: 0 } });
  after = await test.draft();
  expect([a, c, b, d].map(id => after.records[id].values[field])).toEqual(["A", "C", "visible one", "visible two"]);
  expect(after.recordOrder).toHaveLength(5);
  await test.request({ type: "undo" });
  expect((await test.draft()).recordOrder).toEqual(test.file.recordOrder);
});

it("isolates fold state per view and grouping field while retaining it when returning", async () => {
  const test = await session(); const view = test.file.views[test.viewId];
  await test.request({ type: "setGroupCollapsed", viewId: test.viewId, collapsed: true });
  const secondId = "view_00000000000000000000000000000002";
  await test.request({ type: "mutate", operations: [{ type: "putView", view: { ...view, id: secondId, name: "第二视图" }, beforeViewId: null }] });
  await test.request({ type: "selectView", viewId: secondId });
  expect(test.snapshot().projection.groups.every(group => !group.collapsed)).toBe(true);
  await test.request({ type: "selectView", viewId: test.viewId });
  expect(test.snapshot().projection.groups.every(group => group.collapsed)).toBe(true);
  await test.request({ type: "mutate", operations: [{ type: "putView", view: { ...view, groupBy: test.file.primaryFieldId }, beforeViewId: null }] });
  expect(test.snapshot().projection.groups.every(group => !group.collapsed)).toBe(true);
  await test.request({ type: "undo" });
  expect(test.snapshot().projection.groups.every(group => group.collapsed)).toBe(true);
});

it("bulk field changes use stable IDs, validate atomically, and form one undo step", async () => {
  const test = await session(); const [a, b, c, d] = test.file.recordOrder; const number = test.file.fieldOrder[1];
  const before = await test.draft(); const oldStamp = test.stamp();
  expect(await test.request({ type: "bulkSetField", recordIds: [a, b], fieldId: number, value: "invalid" })).toMatchObject({ error: { code: "INVALID_VALUE" } });
  expect(await test.request({ type: "bulkSetField", recordIds: [a, "rec_ffffffffffffffffffffffffffffffff"], fieldId: number, value: 12 })).toHaveProperty("error");
  expect(await test.request({ type: "bulkSetField", recordIds: [a, a], fieldId: number, value: 12 })).toHaveProperty("error");
  expect(await test.draft()).toEqual(before);
  expect(test.snapshot().history.canUndo).toBe(false);
  expect(await test.request({ type: "bulkSetField", recordIds: [d, a], fieldId: number, value: 12 })).not.toHaveProperty("error");
  const after = await test.draft();
  expect(test.snapshot().selectionReset).toBe(false);
  expect([a, d].map(id => after.records[id].values[number])).toEqual([12, 12]);
  expect([b, c].map(id => after.records[id])).toEqual([before.records[b], before.records[c]]);
  expect(test.snapshot().projection.displayRevision).toBeGreaterThan(oldStamp.displayRevision);
  expect(await test.request({ type: "clearCells", ...oldStamp, selection: { x: 0, y: 1, width: 1, height: 1 } })).toMatchObject({ error: { code: "STALE_BASE" } });
  await test.request({ type: "undo" });
  const undone = await test.draft();
  expect(test.file.recordOrder.map(id => undone.records[id].values)).toEqual(test.file.recordOrder.map(id => before.records[id].values));
  expect(test.snapshot().history.canUndo).toBe(false);
  await test.request({ type: "redo" });
  expect([a, d].map(id => test.snapshot().records[id]?.values[number])).toEqual([12, 12]);
});

it("invalidates selections only when grid coordinates change, including visible columns and sorted rows", async () => {
  const test = await session(); const number = test.file.fieldOrder[1];
  const updateView = async (changes: Partial<TableContent["views"][string]>) => {
    const content = await test.draft();
    await test.request({ type: "mutate", operations: [{ type: "putView", view: { ...content.views[test.viewId], ...changes }, beforeViewId: null }] });
  };
  await updateView({ columnWidths: { [number]: 160 } });
  expect(test.snapshot().selectionReset).toBe(false);
  await updateView({ hiddenFieldIds: [number] });
  expect(test.snapshot().selectionReset).toBe(true);
  await updateView({ name: "同一视图" });
  expect(test.snapshot().selectionReset).toBe(false);
  await updateView({ sorts: [{ fieldId: test.file.primaryFieldId, direction: "desc" }] });
  expect(test.snapshot().selectionReset).toBe(true);
  await test.request({ type: "bulkSetField", recordIds: [test.file.recordOrder[0]], fieldId: test.file.primaryFieldId, value: "Z" });
  expect(test.snapshot().selectionReset).toBe(true);
});
