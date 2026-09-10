import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyTableMutations, readTable } from "@/features/tables/api";
import { parseTableFile, type TableReadResult } from "@/features/tables/model";
import type { ApplyTableMutationsResult } from "@/features/tables/mutations";
import { TableWorkerClient } from "@/features/tables/worker-client";
import type { TableWorkerMessage, TableWorkerRequest } from "@/features/tables/worker-protocol";

vi.mock("@/features/tables/api", async importOriginal => ({ ...await importOriginal<typeof import("@/features/tables/api")>(), applyTableMutations: vi.fn(), readTable: vi.fn() }));
const instances: FakeWorker[] = [];
class FakeWorker {
  sent: TableWorkerRequest[] = [];
  onmessage?: (event: { data: TableWorkerMessage }) => void;
  onerror?: (event: { message: string }) => void;
  constructor() { instances.push(this); }
  postMessage(message: TableWorkerRequest) { this.sent.push(message); }
  terminate() {}
  receive(data: TableWorkerMessage) { this.onmessage?.({ data }); }
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function snapshot(): TableReadResult {
  const file = parseTableFile(readFileSync(new URL("../../tests/fixtures/tables/valid/six-types.json", import.meta.url), "utf8"));
  return { file, path: "notes/test.shardtable.json", title: "test", revision: file.revision, contentHash: "a".repeat(64) };
}
function crashDuringWrite(initial: TableReadResult) {
  const write = deferred<ApplyTableMutationsResult>();
  vi.mocked(applyTableMutations).mockReturnValueOnce(write.promise);
  const client = new TableWorkerClient({ onSnapshot() {}, onState() {}, onError() {} });
  const oldWorker = instances[0];
  oldWorker.receive({ type: "rpc", id: 91, method: "apply", request: { path: initial.path, tableId: initial.file.id,
    expectedRevision: initial.revision, expectedHash: initial.contentHash, mutationId: "mut_00000000000000000000000000000001", operations: [] } });
  oldWorker.onerror?.({ message: "crashed during native write" });
  return { client, oldWorker, write };
}
function acknowledgeOpen(worker: FakeWorker) {
  const request = worker.sent[0];
  if (!("command" in request) || request.command.type !== "open") throw new Error("Expected a fresh open");
  worker.receive({ type: "state", state: { status: "saved", dirty: false, generation: 0, savedGeneration: 0, pendingCount: 0, error: null } });
  worker.receive({ type: "result", id: request.id });
  return request.command.initial;
}
beforeEach(() => { instances.length = 0; vi.stubGlobal("Worker", FakeWorker); });
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

it.each(["success", "unknown outcome"])("fatal reload waits for a native write with %s, then reads fresh without replay", async outcome => {
  const initial = snapshot(); const current = structuredClone(initial);
  current.revision++; current.file.revision++; current.contentHash = "b".repeat(64);
  current.file.records[current.file.recordOrder[0]].values[current.file.fieldOrder[0]] = "committed while Worker was dead";
  const { client, oldWorker, write } = crashDuringWrite(initial);
  vi.mocked(readTable).mockResolvedValue(current);
  const first = client.request({ type: "acceptExternal", snapshot: initial });
  const duplicate = client.request({ type: "acceptExternal", snapshot: initial });
  await Promise.resolve();
  expect(readTable).not.toHaveBeenCalled(); expect(instances).toHaveLength(1); expect(client.isDirty()).toBe(true);
  if (outcome === "success") write.resolve({} as ApplyTableMutationsResult);
  else write.reject({ code: "IO_ERROR", message: "reply lost after commit" });
  await vi.waitFor(() => expect(instances).toHaveLength(2));
  expect(acknowledgeOpen(instances[1])).toEqual(current);
  await Promise.all([first, duplicate]);
  expect(readTable).toHaveBeenCalledTimes(1); expect(applyTableMutations).toHaveBeenCalledTimes(1);
  expect(oldWorker.sent).toEqual([]); expect(client.isDirty()).toBe(false);
  client.dispose();
});

it("a failed read after an unknown write preserves fatal state until a later explicit read succeeds", async () => {
  const initial = snapshot(); const { client, write } = crashDuringWrite(initial);
  vi.mocked(readTable).mockRejectedValueOnce({ code: "IO_ERROR", message: "read unavailable" }).mockResolvedValueOnce(initial);
  const reload = client.request({ type: "acceptExternal", snapshot: initial });
  const rejected = expect(reload).rejects.toMatchObject({ message: "read unavailable" });
  write.reject({ code: "IO_ERROR", message: "unknown write result" });
  await rejected;
  expect(client.isDirty()).toBe(true); expect(instances).toHaveLength(1);
  await expect(client.request({ type: "draft" })).rejects.toThrow("crashed during native write");
  const retriedRead = client.request({ type: "acceptExternal", snapshot: initial });
  await vi.waitFor(() => expect(instances).toHaveLength(2)); acknowledgeOpen(instances[1]); await retriedRead;
  expect(readTable).toHaveBeenCalledTimes(2); expect(applyTableMutations).toHaveBeenCalledTimes(1);
  client.dispose();
});

it("disposing a crashed session while its native write is pending never starts a replacement Worker", async () => {
  const initial = snapshot(); const { client, write } = crashDuringWrite(initial);
  const reload = client.request({ type: "acceptExternal", snapshot: initial });
  const rejected = expect(reload).rejects.toThrow("已关闭");
  client.dispose(); write.reject({ code: "IO_ERROR", message: "unknown outcome" });
  await rejected; await client.settleInFlightWrites();
  expect(readTable).not.toHaveBeenCalled(); expect(instances).toHaveLength(1); expect(applyTableMutations).toHaveBeenCalledTimes(1);
});
