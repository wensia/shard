import { useEffect, useRef, useState, type RefObject } from "react"
import { isTauri } from "@tauri-apps/api/core"
import { getCurrentWebview } from "@tauri-apps/api/webview"

type DragDropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" }

interface NativeFileDropOptions {
  enabled?: boolean
  /**
   * 只处理落在这个元素里的拖放；不同区域各自订阅、按命中点互不抢。不传则整页
   * 都算（由 accepts 按落点元素自行筛选，禅模式这类挂在 body 上的浮层也能接住）。
   */
  frameRef?: RefObject<HTMLElement | null>
  accepts: (paths: string[], target: Element) => boolean
  /** `point` 是落点的页面坐标，交给编辑器换算文档位置。 */
  onDrop: (paths: string[], target: Element, point: { clientX: number; clientY: number }) => void
}

const IMAGE_PATH_PATTERN = /\.(?:avif|gif|heic|heif|jpe?g|png|svg|webp)$/iu

export function isImageFilePath(path: string) {
  return IMAGE_PATH_PATTERN.test(path)
}

/**
 * 从访达拖文件进窗口。Tauri 开着原生拖放时，DOM 的 drop 事件拿不到文件，只能从
 * webview 的拖放事件取路径与物理像素坐标；这里换算成页面坐标后找到落点元素，
 * 拖动途中把当前落点交给调用方做高亮。
 */
export function useNativeFileDrop({ enabled = true, frameRef, accepts, onDrop }: NativeFileDropOptions) {
  const [target, setTarget] = useState<Element | null>(null)
  const handlers = useRef({ accepts, onDrop })
  handlers.current = { accepts, onDrop }

  useEffect(() => {
    if (!enabled || !isTauri()) return
    let disposed = false
    let unlisten: (() => void) | null = null
    let paths: string[] = []

    function clientPoint(position: { x: number; y: number }) {
      const ratio = window.devicePixelRatio || 1
      return { clientX: position.x / ratio, clientY: position.y / ratio }
    }

    function hit(position: { x: number; y: number }) {
      const { clientX, clientY } = clientPoint(position)
      const element = document.elementFromPoint(clientX, clientY)
      if (!element) return null
      if (!frameRef) return element
      const frame = frameRef.current
      return frame?.contains(element) ? element : null
    }

    function handle(event: { payload: DragDropPayload }) {
      if (disposed) return
      const payload = event.payload
      if (payload.type === "leave") {
        paths = []
        setTarget(null)
        return
      }
      if (payload.type === "enter") paths = payload.paths
      const element = hit(payload.position)
      const accepted = element && handlers.current.accepts(paths, element) ? element : null
      if (payload.type !== "drop") {
        setTarget(accepted)
        return
      }
      setTarget(null)
      paths = []
      if (element && handlers.current.accepts(payload.paths, element)) {
        handlers.current.onDrop(payload.paths, element, clientPoint(payload.position))
      }
    }

    void (async () => {
      try {
        const dispose = await getCurrentWebview().onDragDropEvent(handle)
        if (disposed) dispose()
        else unlisten = dispose
      } catch {
        // 浏览器预览没有 webview 拖放事件。
      }
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [enabled, frameRef])

  return { target }
}
