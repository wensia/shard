import { applyTableMutations, readTable, tableError } from "./api";
import type { TableReadResult } from "./model";
import type { TableSaveState } from "./save-queue";
import type { TableWorkerCommand, TableWorkerMessage, TableWorkerRequest, TableWorkerSnapshot, TableWorkerValue } from "./worker-protocol";

export interface TableWorkerEvents { onSnapshot(snapshot: TableWorkerSnapshot): void; onState(state: TableSaveState): void; onError(error: unknown): void }

/** Construct in an effect/controller, never during rendering. Dispose only after a successful flush. */
export class TableWorkerClient {
  private worker = new Worker(new URL("../../workers/table.worker.ts", import.meta.url), { type: "module" });
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: TableWorkerValue) => void; reject: (error: unknown) => void }>();
  private inFlightWrites = new Set<Promise<unknown>>();
  private recovery: Promise<TableWorkerValue> | undefined;
  private dirty = false;
  private pendingEdits = 0;
  private fatalError: Error | undefined;
  private disposed = false;
  private lastState: TableSaveState = { status: "saved", generation: 0, savedGeneration: 0, dirty: false, pendingCount: 0, error: null };
  constructor(private readonly events: TableWorkerEvents) {
    this.attach();
  }
  private attach() {
    const worker = this.worker;
    worker.onmessage = ({ data }: MessageEvent<TableWorkerMessage>) => {
      if (this.worker !== worker || this.disposed || this.fatalError) return;
      if (data.type === "rpc") {
        const operation = data.method === "apply" ? applyTableMutations(data.request) : readTable(data.request);
        if (data.method === "apply") {
          // Native writes outlive the Worker that requested them. Keep their
          // completion boundary even if that Worker can no longer read replies.
          this.inFlightWrites.add(operation);
          void operation.then(() => this.inFlightWrites.delete(operation), () => this.inFlightWrites.delete(operation));
        }
        const reply = (message: TableWorkerRequest) => { if (this.worker === worker && !this.disposed && !this.fatalError) worker.postMessage(message); };
        void operation.then((value) => reply({ type: "rpcResult", id: data.id, value }), (error: unknown) => reply({ type: "rpcResult", id: data.id, error: tableError(error) }));
      } else if (data.type === "state") { this.lastState = data.state; this.dirty = data.state.dirty; this.events.onState(data.state); }
      else if (data.type === "snapshot") this.events.onSnapshot(data.snapshot);
      else { const waiter = this.pending.get(data.id); this.pending.delete(data.id); if (data.error) waiter?.reject(data.error); else waiter?.resolve(data.value); }
    };
    worker.onerror = (event) => {
      if (this.worker !== worker || this.disposed) return;
      const error = new Error(event.message || "数据表后台任务中断");
      this.fatalError = error; worker.terminate();
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear(); this.dirty = true;
      this.lastState = { ...this.lastState, status: "error", dirty: true, error: tableError(error) };
      this.events.onState(this.lastState); this.events.onError(error);
    };
  }
  private send(message: TableWorkerRequest) { this.worker.postMessage(message); }
  isDirty() { return this.dirty || this.pendingEdits > 0 || this.inFlightWrites.size > 0; }
  async settleInFlightWrites(): Promise<void> {
    while (this.inFlightWrites.size) await Promise.allSettled([...this.inFlightWrites]);
  }
  private async recover(snapshot: TableReadResult): Promise<TableWorkerValue> {
    await this.settleInFlightWrites();
    if (this.disposed) throw new Error("数据表会话已关闭");
    // The supplied snapshot may predate a native write whose reply was lost.
    // Resolve that uncertainty by reading after it settles, never by replaying it.
    const initial = await readTable({ path: snapshot.path, expectedTableId: snapshot.file.id });
    if (this.disposed) throw new Error("数据表会话已关闭");
    this.worker = new Worker(new URL("../../workers/table.worker.ts", import.meta.url), { type: "module" });
    this.fatalError = undefined; this.attach();
    return this.open(initial);
  }
  open(initial: TableReadResult) { return this.request({ type: "open", initial }); }
  async request(command: TableWorkerCommand): Promise<TableWorkerValue> {
    if (this.disposed) throw new Error("数据表会话已关闭");
    if (this.fatalError) {
      // acceptExternal is the explicit discard/reload boundary; no edit is replayed.
      if (command.type !== "acceptExternal") throw this.fatalError;
      this.recovery ??= this.recover(command.snapshot).finally(() => { this.recovery = undefined; });
      return this.recovery;
    }
    const id = ++this.sequence;
    const edit = ["mutate", "undo", "redo", "paste", "clearCells", "bulkSetField"].includes(command.type);
    if (edit) this.pendingEdits++;
    try {
      return await new Promise<TableWorkerValue>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        try { this.send({ id, command }); } catch (error) { this.pending.delete(id); reject(error); }
      });
    } finally { if (edit) this.pendingEdits--; }
  }
  async flush(): Promise<boolean> { try { await this.request({ type: "flush" }); return !this.isDirty(); } catch (error) { this.events.onError(error); return false; } }
  dispose() { this.disposed = true; this.worker.terminate(); for (const waiter of this.pending.values()) waiter.reject(new Error("数据表会话已关闭")); this.pending.clear(); }
}
