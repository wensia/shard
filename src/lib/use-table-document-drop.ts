import { useEffect, useRef, useState, type RefObject } from "react"
import { isTauri } from "@tauri-apps/api/core"
import { getCurrentWebview } from "@tauri-apps/api/webview"

/** 和 Rust 侧 TABLE_DOCUMENT_EXTENSIONS 保持一致 */
const TABLE_DOCUMENT_EXTENSIONS = ["csv", "xls", "xlsb", "xlsm", "xlsx"]

export const TABLE_DOCUMENT_FILTER = {
  extensions: TABLE_DOCUMENT_EXTENSIONS,
  name: "表格文档",
}

export function isTableDocumentPath(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() ?? ""
  return TABLE_DOCUMENT_EXTENSIONS.includes(extension)
}

type DragDropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" }

interface TableDocumentDropOptions {
  enabled?: boolean
  /** 拖到这个元素范围内才算数 */
  frameRef: RefObject<HTMLElement | null>
  onDrop: (paths: string[]) => void | Promise<void>
}

/**
 * 表格文档拖进编辑器。
 *
 * Tauri 默认接管了 webview 的 HTML5 拖放，所以这里收的是窗口级的
 * drag-drop 事件——好处是直接给到文件路径，不用把整个文件塞过 IPC；
 * 代价是事件不分组件，得自己用坐标判断落点在不在本编辑器里。
 */
export function useTableDocumentDrop({
  enabled = true,
  frameRef,
  onDrop,
}: TableDocumentDropOptions) {
  const [isDropTarget, setIsDropTarget] = useState(false)
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop

  useEffect(() => {
    if (!enabled || !isTauri()) return

    let disposed = false
    let unlisten: (() => void) | null = null

    function handleEvent(event: { payload: DragDropPayload }) {
      const payload = event.payload

      if (payload.type === "leave") {
        setIsDropTarget(false)
        return
      }

      const frame = frameRef.current
      if (!frame) return

      if (payload.type === "enter" || payload.type === "over") {
        // over 不带 paths，enter 时才知道拖的是什么；两者都要求落点命中
        const paths = "paths" in payload ? payload.paths : []
        const acceptable =
          payload.type === "over" || paths.some(isTableDocumentPath)
        setIsDropTarget(acceptable && isInsideFrame(frame, payload.position))
        return
      }

      setIsDropTarget(false)
      if (!isInsideFrame(frame, payload.position)) return

      const paths = payload.paths.filter(isTableDocumentPath)
      if (paths.length === 0) return

      void onDropRef.current(paths)
    }

    // 订阅失败不能拖垮编辑器：webview API 在非桌面宿主（浏览器预览、
    // 测试环境）里根本不存在，拿不到就是没有拖放，其余功能照常。
    void (async () => {
      try {
        const dispose = await getCurrentWebview().onDragDropEvent(handleEvent)
        if (disposed) dispose()
        else unlisten = dispose
      } catch {
        // 没有 webview 就没有拖放
      }
    })()

    return () => {
      disposed = true
      unlisten?.()
      setIsDropTarget(false)
    }
  }, [enabled, frameRef])

  return { isDropTarget }
}

/** drag-drop 事件给的是物理像素，得换算回 CSS 像素才能和 rect 比。 */
function isInsideFrame(frame: HTMLElement, position: { x: number; y: number }) {
  const ratio = window.devicePixelRatio || 1
  const x = position.x / ratio
  const y = position.y / ratio
  const rect = frame.getBoundingClientRect()

  return (
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  )
}
