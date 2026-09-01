import { readCsvFile, readMindMap } from "@/lib/api"
import { parseCsvBytesInWorker } from "@/lib/csv-worker"
import { layoutMindMap, type MindMapLayout } from "@/lib/mind-map-layout"

export type LibraryPreview =
  | { kind: "text"; lines: string[] }
  | { kind: "mindmap"; layout: MindMapLayout }
  | { kind: "table"; rows: string[][] }

export interface LibraryPreviewEntry {
  kind: "csv" | "directory" | "file" | "image" | "markdown" | "mindmap"
  mindMapId?: string
  modifiedAt: string
  path: string
}

const previewCache = new Map<string, LibraryPreview>()
const pendingPreviews = new Map<string, Promise<LibraryPreview | null>>()

export async function loadLibraryPreview(
  entry: LibraryPreviewEntry
): Promise<LibraryPreview | null> {
  if (entry.kind !== "mindmap" && entry.kind !== "csv") return null

  const cacheKey = `${entry.path}::${entry.modifiedAt}`
  const cached = previewCache.get(cacheKey)
  if (cached) return cached
  const pending = pendingPreviews.get(cacheKey)
  if (pending) return pending

  const request = (async () => {
    try {
      let preview: LibraryPreview

      if (entry.kind === "mindmap") {
        if (!entry.mindMapId) return null
        const result = await readMindMap(entry.mindMapId)
        preview = { kind: "mindmap", layout: layoutMindMap(result.file) }
      } else {
        const bytes = await readCsvFile(entry.path)
        const document = await parseCsvBytesInWorker(Uint8Array.from(bytes))
        preview = {
          kind: "table",
          rows: document.records.slice(0, 4).map((row) => row.slice(0, 4)),
        }
      }

      previewCache.set(cacheKey, preview)
      return preview
    } catch {
      return null
    } finally {
      pendingPreviews.delete(cacheKey)
    }
  })()

  pendingPreviews.set(cacheKey, request)
  return request
}
