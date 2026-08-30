import {
  parseCsvBytes,
  type CsvWorkerRequest,
  type CsvWorkerResponse,
} from "@/lib/csv"

self.onmessage = (event: MessageEvent<CsvWorkerRequest>) => {
  const request = event.data
  if (request.type !== "parse") return

  try {
    postMessage({
      document: parseCsvBytes(request.bytes),
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
