import { useEffect, useState, type RefObject } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { toast } from "sonner"

const TABLE_DOCUMENT_EXTENSIONS = ["csv", "xls", "xlsb", "xlsm", "xlsx"]

export function isTableDocumentPath(path: string) {
  return TABLE_DOCUMENT_EXTENSIONS.includes(path.split(".").pop()?.toLowerCase() ?? "")
}

type DragDropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" }

interface TableDocumentDropOptions {
  enabled?: boolean
  allowCsv?: boolean
  frameRef: RefObject<HTMLElement | null>
  onCsv: (file: { name: string; bytes: Uint8Array }) => void
}

type DropKind = "csv" | "excel" | null

function kindFor(paths: string[]): DropKind {
  if (paths.some((path) => /\.csv$/iu.test(path))) return "csv"
  if (paths.some(isTableDocumentPath)) return "excel"
  return null
}

/** Tauri supplies native paths; browser drag and drop supplies File objects. */
export function useTableDocumentDrop({ enabled = true, allowCsv = true, frameRef, onCsv }: TableDocumentDropOptions) {
  const [dropKind, setDropKind] = useState<DropKind>(null)

  useEffect(() => {
    if (!enabled) return
    const frame = frameRef.current
    if (!frame) return
    let disposed = false
    let unlisten: (() => void) | null = null
    let nativeKind: DropKind = null

    async function handlePaths(paths: string[]) {
      const path = paths.find((item) => /\.csv$/iu.test(item))
      if (!path) { toast.info("请先另存为 CSV 再导入"); return }
      if (!allowCsv) { toast.error("私密碎片不支持数据集"); return }
      try {
        const bytes = await invoke<number[]>("read_import_csv_file", { path })
        if (!disposed) onCsv({ name: path.split(/[\\/]/u).pop() ?? "数据集.csv", bytes: new Uint8Array(bytes) })
      } catch (error) {
        if (!disposed) toast.error(`读取 CSV 失败：${String(error).replace(/^Error:\s*/u, "")}`)
      }
    }

    function handleNative(event: { payload: DragDropPayload }) {
      if (disposed) return
      const payload = event.payload
      if (payload.type === "leave") { nativeKind = null; setDropKind(null); return }
      if (payload.type === "enter") nativeKind = kindFor(payload.paths)
      if (payload.type === "enter" || payload.type === "over") {
        setDropKind(nativeKind && isInsideFrame(frame!, payload.position) ? nativeKind : null)
        return
      }
      setDropKind(null)
      if (isInsideFrame(frame!, payload.position) && kindFor(payload.paths)) void handlePaths(payload.paths)
      nativeKind = null
    }

    function handleDrag(event: DragEvent) {
      const files = Array.from(event.dataTransfer?.files ?? [])
      const kind = kindFor(files.map((file) => file.name))
      if (!kind) return
      event.preventDefault()
      setDropKind(kind)
    }
    function handleLeave(event: DragEvent) {
      if (event.relatedTarget instanceof Node && frame!.contains(event.relatedTarget)) return
      setDropKind(null)
    }
    async function handleDrop(event: DragEvent) {
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (!kindFor(files.map((file) => file.name))) return
      event.preventDefault()
      event.stopPropagation()
      setDropKind(null)
      const file = files.find((item) => /\.csv$/iu.test(item.name))
      if (!file) { toast.info("请先另存为 CSV 再导入"); return }
      if (!allowCsv) { toast.error("私密碎片不支持数据集"); return }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (!disposed) onCsv({ name: file.name, bytes })
      } catch (error) {
        if (!disposed) toast.error(`读取 CSV 失败：${String(error)}`)
      }
    }

    frame.addEventListener("dragenter", handleDrag)
    frame.addEventListener("dragover", handleDrag)
    frame.addEventListener("dragleave", handleLeave)
    frame.addEventListener("drop", handleDrop)
    if (isTauri()) {
      void (async () => {
        try {
          const dispose = await getCurrentWebview().onDragDropEvent(handleNative)
          if (disposed) dispose()
          else unlisten = dispose
        } catch {
          // 浏览器测试及无 Webview 的预览宿主仍可使用 HTML 拖放。
        }
      })()
    }
    return () => {
      disposed = true
      unlisten?.()
      frame.removeEventListener("dragenter", handleDrag)
      frame.removeEventListener("dragover", handleDrag)
      frame.removeEventListener("dragleave", handleLeave)
      frame.removeEventListener("drop", handleDrop)
    }
  }, [enabled, allowCsv, frameRef, onCsv])

  return { dropKind }
}

function isInsideFrame(frame: HTMLElement, position: { x: number; y: number }) {
  const ratio = window.devicePixelRatio || 1
  const x = position.x / ratio
  const y = position.y / ratio
  const rect = frame.getBoundingClientRect()
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    && frame.contains(document.elementFromPoint(x, y))
}
