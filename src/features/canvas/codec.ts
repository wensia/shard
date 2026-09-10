let worker: Worker | undefined
let sequence = 0
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()

function transform(operation: "encode" | "decode", value: unknown): Promise<unknown> {
  if (!worker) {
    worker = new Worker(new URL("./codec.worker.ts", import.meta.url), { type: "module" })
    worker.onmessage = ({ data }: MessageEvent<{ id: number; value?: unknown; error?: string }>) => {
      const waiter = pending.get(data.id)
      pending.delete(data.id)
      if (data.error) waiter?.reject(new Error(data.error)); else waiter?.resolve(data.value)
    }
    worker.onerror = (event) => {
      const error = new Error(event.message || "画布文件编码任务中断")
      for (const waiter of pending.values()) waiter.reject(error)
      pending.clear(); worker?.terminate(); worker = undefined
    }
  }
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try { worker!.postMessage({ id, operation, value }, operation === "decode" && value instanceof ArrayBuffer ? [value] : []) }
    catch (error) { pending.delete(id); reject(error) }
  })
}

export const encodeCanvasRequest = (value: unknown) => transform("encode", value) as Promise<Uint8Array>
export const decodeCanvasResponse = <T>(value: ArrayBuffer) => transform("decode", value) as Promise<T>
