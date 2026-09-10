import type { ExchangeCommand, ExchangeResponse, ExchangeResult } from "./exchange-protocol"

export class TableExchangeClient {
  private worker = new Worker(new URL("../../workers/table-exchange.worker.ts", import.meta.url), { type: "module" })
  private sequence = 0
  private stopped = false
  private pending = new Map<number, { resolve: (value: ExchangeResult) => void; reject: (error: Error) => void }>()
  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<ExchangeResponse>) => {
      const waiter = this.pending.get(data.id); this.pending.delete(data.id)
      if (data.error) waiter?.reject(new Error(data.error))
      else if (data.value) waiter?.resolve(data.value)
      else waiter?.reject(new Error("后台没有返回导入导出结果"))
    }
    this.worker.onerror = event => { this.stopped = true; this.rejectPending(new Error(event.message || "导入导出后台任务中断")) }
  }
  request<T extends ExchangeResult>(command: ExchangeCommand): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("导入导出会话已关闭"))
    const id = ++this.sequence
    return new Promise<ExchangeResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.worker.postMessage({ id, command }) }
      catch (error) { this.pending.delete(id); reject(error) }
    }) as Promise<T>
  }
  private rejectPending(error: Error) { for (const waiter of this.pending.values()) waiter.reject(error); this.pending.clear() }
  dispose() { this.stopped = true; this.worker.terminate(); this.rejectPending(new Error("导入导出已取消")) }
}
