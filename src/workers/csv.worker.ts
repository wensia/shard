import {
  parseCsvBytes,
  inspectCsvImport,
  type CsvWorkerRequest,
  type CsvWorkerResponse,
} from "@/lib/csv"

self.onmessage = (event: MessageEvent<CsvWorkerRequest>) => {
  const request = event.data
  if (request.type !== "parse" && request.type !== "inspect") return

  try {
    const document = parseCsvBytes(request.bytes)
    if (request.type === "inspect") document.importInspection = inspectCsvImport(document.records)
    postMessage({
      document,
      requestId: request.requestId,
      type: "parsed",
    } satisfies CsvWorkerResponse)
  } catch (error) {
    postMessage({
      error: String(error).replace(/^Error:\s*/u, ""),
      requestId: request.requestId,
      type: "error",
    } satisfies CsvWorkerResponse)
  }
}
