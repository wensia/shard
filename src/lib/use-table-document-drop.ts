import { useEffect, useState, type RefObject } from "react"
import { isTauri } from "@tauri-apps/api/core"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { toast } from "sonner"

/** 旧 Excel 格式也拦截并提示另存，不再转换为正文表格。 */
const TABLE_DOCUMENT_EXTENSIONS = ["csv", "xls", "xlsb", "xlsm", "xlsx"]

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
}

/**
 * 正文不再创建另一套表格；拖入表格文件时引导到唯一的多维表格导入入口。
 *
 * Tauri 默认接管了 webview 的 HTML5 拖放，所以这里收的是窗口级的
 * drag-drop 事件——好处是直接给到文件路径，不用把整个文件塞过 IPC；
 * 代价是事件不分组件，得自己用坐标判断落点在不在本编辑器里。
 */
export function useTableDocumentDrop({
  enabled = true,
  frameRef,
}: TableDocumentDropOptions) {
  const [isDropTarget, setIsDropTarget] = useState(false)

  useEffect(() => {
    if (!enabled || !isTauri()) return

    let disposed = false
    let unlisten: (() => void) | null = null
    let containsTableDocument = false

    function handleEvent(event: { payload: DragDropPayload }) {
      if (disposed) return
      const payload = event.payload

      if (payload.type === "leave") {
        containsTableDocument = false
        setIsDropTarget(false)
        return
      }

      const frame = frameRef.current
      if (!frame) return

      if (payload.type === "enter" || payload.type === "over") {
        // over 不带 paths，enter 时才知道拖的是什么；两者都要求落点命中
        if (payload.type === "enter") {
          containsTableDocument = payload.paths.some(isTableDocumentPath)
        }
        setIsDropTarget(containsTableDocument && isInsideFrame(frame, payload.position))
        return
      }

      setIsDropTarget(false)
      containsTableDocument = false
      if (!isInsideFrame(frame, payload.position)) return

      const paths = payload.paths.filter(isTableDocumentPath)
      if (paths.length === 0) return

      const hasLegacyFormat = paths.some(path => !/\.(?:csv|xlsx)$/iu.test(path))
      toast.info(hasLegacyFormat
        ? "请先将旧 Excel 文件另存为 XLSX，再到资料库的“多维表格”菜单中选择“从 CSV / Excel 导入…”。"
        : "请在资料库的“多维表格”菜单中选择“从 CSV / Excel 导入…”，导入 CSV 或 XLSX 文件。")
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
    // 禅模式等覆盖层打开时，不能让背后的编辑器同时响应同一拖放。
    && frame.contains(document.elementFromPoint(x, y))
  )
}
