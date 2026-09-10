import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { parseTableFile } from "@/features/tables/model";
import { readTable } from "@/features/tables/api";
import { TableWorkerClient } from "@/features/tables/worker-client";
import type { TableWorkerMessage, TableWorkerRequest } from "@/features/tables/worker-protocol";

vi.mock("@/features/tables/api", async importOriginal => ({ ...await importOriginal<typeof import("@/features/tables/api")>(), readTable: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("a crashed Worker rejects pending and future work promptly, then explicit reload starts a fresh session", async () => {
  const instances: FakeWorker[] = [];
  class FakeWorker {
    sent: TableWorkerRequest[] = [];
    onmessage?: (event: { data: TableWorkerMessage }) => void;
    onerror?: (event: { message: string }) => void;
    constructor() { instances.push(this); }
    postMessage(message: TableWorkerRequest) { this.sent.push(message); }
    terminate() {}
  }
  vi.stubGlobal("Worker", FakeWorker);
  const client = new TableWorkerClient({ onSnapshot() {}, onState() {}, onError() {} });
  const pending = client.request({ type: "draft" });
  const rejected = expect(pending).rejects.toThrow("test crash");
  instances[0].onerror?.({ message: "test crash" });
  await rejected;
  await expect(client.request({ type: "identity" })).rejects.toThrow("test crash");
  await expect(client.flush()).resolves.toBe(false);
  expect(client.isDirty()).toBe(true);
  const file = parseTableFile(readFileSync(new URL("../../tests/fixtures/tables/valid/six-types.json", import.meta.url), "utf8"));
  const snapshot = { file, path: "notes/test.shardtable.json", title: "test", revision: file.revision, contentHash: "a".repeat(64) };
  vi.mocked(readTable).mockResolvedValue(snapshot);
  const reloaded = client.request({ type: "acceptExternal", snapshot });
  await vi.waitFor(() => expect(instances).toHaveLength(2));
  expect(readTable).toHaveBeenCalledWith({ path: snapshot.path, expectedTableId: file.id });
  const request = instances[1].sent[0];
  if (!("command" in request)) throw new Error("Expected open request");
  expect(request.command.type).toBe("open");
  // A late event from the old instance cannot clear dirty or satisfy the new session.
  instances[0].onmessage?.({ data: { type: "result", id: request.id, error: { code: "IO_ERROR", message: "old" } } });
  instances[1].onmessage?.({ data: { type: "state", state: { status: "saved", dirty: false, generation: 0, savedGeneration: 0, pendingCount: 0, error: null } } });
  instances[1].onmessage?.({ data: { type: "result", id: request.id } });
  await expect(reloaded).resolves.toBeUndefined();
  expect(client.isDirty()).toBe(false);
  client.dispose();
  await expect(client.request({ type: "draft" })).rejects.toThrow("已关闭");
});

it("counts a bulk edit as dirty before its first Worker state, but keeps display-only folding clean", async () => {
  let worker!: FakeWorker;
  class FakeWorker {
    sent: TableWorkerRequest[] = [];
    onmessage?: (event: { data: TableWorkerMessage }) => void;
    constructor() { worker = this; }
    postMessage(message: TableWorkerRequest) { this.sent.push(message); }
    terminate() {}
  }
  vi.stubGlobal("Worker", FakeWorker);
  const client = new TableWorkerClient({ onSnapshot() {}, onState() {}, onError() {} });
  const bulk = client.request({ type: "bulkSetField", recordIds: ["rec_00000000000000000000000000000001"], fieldId: "fld_00000000000000000000000000000001", value: "changed" });
  expect(client.isDirty()).toBe(true);
  worker.onmessage?.({ data: { type: "state", state: { status: "saved", dirty: false, generation: 0, savedGeneration: 0, pendingCount: 0, error: null } } });
  expect(client.isDirty()).toBe(true);
  const bulkRequest = worker.sent[0]; if (!("command" in bulkRequest)) throw new Error("Expected bulk request");
  worker.onmessage?.({ data: { type: "result", id: bulkRequest.id } });
  await bulk;
  expect(client.isDirty()).toBe(false);
  const fold = client.request({ type: "setGroupCollapsed", viewId: "view_00000000000000000000000000000001", collapsed: true });
  expect(client.isDirty()).toBe(false);
  const foldRequest = worker.sent[1]; if (!("command" in foldRequest)) throw new Error("Expected display request");
  worker.onmessage?.({ data: { type: "result", id: foldRequest.id } });
  await fold;
  client.dispose();
});
