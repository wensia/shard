import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { parseTableFile, tableContent, type TableReadResult } from "@/features/tables/model";
import { applyTableMutations, type ApplyTableMutationsResult } from "@/features/tables/mutations";
import type { TableWorkerMessage, TableWorkerRequest } from "@/features/tables/worker-protocol";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("Worker transport keeps later edits, advances hashes serially, and undoes one whole gesture", async () => {
  const messages: TableWorkerMessage[] = [];
  const endpoint = { postMessage: (message: TableWorkerMessage) => messages.push(structuredClone(message)), onmessage: (_: { data: TableWorkerRequest }) => {} };
  vi.stubGlobal("self", endpoint);
  await import("@/workers/table.worker");
  const file = parseTableFile(readFileSync(new URL("../../tests/fixtures/tables/valid/six-types.json", import.meta.url), "utf8"));
  let disk: TableReadResult = { file, path: "notes/测试.shardtable.json", title: "测试", revision: file.revision, contentHash: "a".repeat(64) };
  const send = (data: TableWorkerRequest) => endpoint.onmessage({ data });
  const result = async (id: number) => { await vi.waitFor(() => expect(messages.some((message) => message.type === "result" && message.id === id)).toBe(true)); return messages.find((message) => message.type === "result" && message.id === id); };
  const edit = (value: string) => ({ type: "mutate" as const, operations: [{ type: "setCells" as const, cells: [{ recordId: file.recordOrder[0], fieldId: file.primaryFieldId, value }] }] });
  const acknowledge = (message: Extract<TableWorkerMessage, { type: "rpc"; method: "apply" }>, hash: string) => {
    const stamp = "2030-01-01T00:00:00.000Z";
    const content = applyTableMutations(tableContent(disk.file), message.request.operations, stamp);
    const revision = disk.revision + 1;
    const reply: ApplyTableMutationsResult = { tableId: file.id, path: disk.path, mutationId: message.request.mutationId, baseRevision: disk.revision, revision, contentHash: hash.repeat(64), updatedAt: stamp,
      changedRecords: Object.values(content.records), deletedRecordIds: [], changedFields: [], deletedFieldIds: [], changedViews: [], deletedViewIds: [] };
    disk = { ...disk, file: { ...disk.file, ...content, revision, updatedAt: stamp, lastMutationId: message.request.mutationId, lastMutationHash: "f".repeat(64) }, revision, contentHash: reply.contentHash };
    send({ type: "rpcResult", id: message.id, value: reply });
  };
  send({ id: 1, command: { type: "open", initial: disk } }); await result(1);
  send({ id: 2, command: edit("A") }); await result(2);
  send({ id: 3, command: { type: "flush" } });
  await vi.waitFor(() => expect(messages.filter((message) => message.type === "rpc")).toHaveLength(1));
  send({ id: 4, command: edit("B") }); await result(4);
  const first = messages.find((message) => message.type === "rpc") as Extract<TableWorkerMessage, { type: "rpc"; method: "apply" }>;
  expect(first.request.expectedHash).toBe("a".repeat(64));
  acknowledge(first, "b");
  await vi.waitFor(() => expect(messages.filter((message) => message.type === "rpc")).toHaveLength(2));
  const second = messages.filter((message) => message.type === "rpc")[1] as typeof first;
  expect(second.request.expectedHash).toBe("b".repeat(64));
  acknowledge(second, "c"); await result(3);
  send({ id: 5, command: { type: "draft" } });
  expect(await result(5)).toMatchObject({ value: { records: { [file.recordOrder[0]]: { values: { [file.primaryFieldId]: "B" } } } } });
  send({ id: 6, command: { type: "undo" } }); await result(6);
  send({ id: 7, command: { type: "draft" } });
  expect(await result(7)).toMatchObject({ value: { records: { [file.recordOrder[0]]: { values: { [file.primaryFieldId]: "A" } } } } });
  expect(messages.filter((message) => message.type === "state").slice(-1)[0]).toMatchObject({ state: { dirty: true } });
});
