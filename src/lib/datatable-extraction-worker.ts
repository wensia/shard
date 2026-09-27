import { datatableToDatasetExtraction, type DatatableSpec } from "@/lib/datatable"

type Extraction = ReturnType<typeof datatableToDatasetExtraction>

export function extractDatatableInWorker(spec: DatatableSpec): Promise<Extraction> {
  if (typeof Worker === "undefined") return Promise.resolve().then(() => datatableToDatasetExtraction(spec))

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/datatable-extraction.worker.ts", import.meta.url), { type: "module" })
    worker.onmessage = (event: MessageEvent<{ result: Extraction } | { error: string }>) => {
      worker.terminate()
      if ("error" in event.data) reject(new Error(event.data.error))
      else resolve(event.data.result)
    }
    worker.onerror = () => {
      worker.terminate()
      reject(new Error("数据表提取 worker 运行失败"))
    }
    worker.postMessage(spec)
  })
}
