import {
  parseCsvBytes,
  inspectCsvImport,
  type CsvDocument,
  type CsvWorkerRequest,
  type CsvWorkerResponse,
} from "@/lib/csv"

interface PendingParse {
  reject: (error: Error) => void
  resolve: (document: CsvDocument) => void
}

let worker: Worker | null = null
let nextRequestId = 0
const pending = new Map<string, PendingParse>()

export function parseCsvBytesInWorker(bytes: Uint8Array, inspect = false) {
  if (typeof Worker === "undefined") {
    const document = parseCsvBytes(bytes)
    if (inspect) document.importInspection = inspectCsvImport(document.records)
    return Promise.resolve(document)
  }

  const activeWorker = getWorker()
  const requestId = `csv:${nextRequestId + 1}`
  nextRequestId += 1

  return new Promise<CsvDocument>((resolve, reject) => {
    pending.set(requestId, { reject, resolve })
    activeWorker.postMessage({ bytes, requestId, type: inspect ? "inspect" : "parse" } satisfies CsvWorkerRequest)
  })
}

function getWorker() {
  if (worker) return worker

  worker = new Worker(new URL("../workers/csv.worker.ts", import.meta.url), {
    type: "module",
  })
  worker.onmessage = (event: MessageEvent<CsvWorkerResponse>) => {
    const response = event.data
    const request = pending.get(response.requestId)
    if (!request) return
    pending.delete(response.requestId)
    if (response.type === "error") request.reject(new Error(response.error))
    else request.resolve(response.document)
  }
  worker.onerror = () => {
    for (const request of pending.values()) {
      request.reject(new Error("CSV 解析 worker 运行失败"))
    }
    pending.clear()
    worker?.terminate()
    worker = null
  }

  return worker
}
