import { readCsvFile, readMindMap } from "@/lib/api"
import { parseCsvBytesInWorker } from "@/lib/csv-worker"
import { layoutMindMap, type MindMapLayout } from "@/lib/mind-map-layout"
import { readCanvas } from "@/features/canvas/api"

export type LibraryPreview =
  | { kind: "text"; lines: string[] }
  | { kind: "mindmap"; layout: MindMapLayout }
  | { kind: "table"; rows: string[][] }
  | { kind: "canvas"; nodes: { id: string; x: number; y: number; width: number; height: number }[]; edges: { source: string; target: string }[] }

export interface LibraryPreviewEntry {
  kind: "csv" | "directory" | "file" | "image" | "markdown" | "mindmap" | "table" | "canvas" | "flowchart"
  mindMapId?: string
  modifiedAt: string
  path: string
}

const previewCache = new Map<string, LibraryPreview>()
const pendingPreviews = new Map<string, Promise<LibraryPreview | null>>()

export async function loadLibraryPreview(
  entry: LibraryPreviewEntry
): Promise<LibraryPreview | null> {
  if (entry.kind !== "mindmap" && entry.kind !== "csv" && entry.kind !== "canvas" && entry.kind !== "flowchart") return null

  const cacheKey = `${entry.path}::${entry.modifiedAt}`
  const cached = previewCache.get(cacheKey)
  if (cached) return cached
  const pending = pendingPreviews.get(cacheKey)
  if (pending) return pending

  const request = (async () => {
    try {
      let preview: LibraryPreview

      if (entry.kind === "canvas" || entry.kind === "flowchart") {
        const result = await readCanvas(entry.path)
        preview = { kind: "canvas", nodes: result.file.nodes.slice(0, 80).map(node => ({ id: node.id, x: node.x, y: node.y, width: node.width ?? 180, height: node.height ?? 80 })), edges: result.file.edges.slice(0, 160) }
      } else if (entry.kind === "mindmap") {
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
