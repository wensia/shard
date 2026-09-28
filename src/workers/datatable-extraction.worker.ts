import { datatableToDatasetExtraction, type DatatableSpec } from "@/lib/datatable"

self.onmessage = (event: MessageEvent<DatatableSpec>) => {
  try {
    postMessage({ result: datatableToDatasetExtraction(event.data) })
  } catch (error) {
    postMessage({ error: String(error).replace(/^Error:\s*/u, "") })
  }
}
