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
  /** 只处理落在这个元素里的拖放；不同区域各自订阅、按命中点互不抢。 */
  frameRef: RefObject<HTMLElement | null>
  accepts: (paths: string[], target: Element) => boolean
  onDrop: (paths: string[], target: Element) => void
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

    function hit(position: { x: number; y: number }) {
      const frame = frameRef.current
      if (!frame) return null
      const ratio = window.devicePixelRatio || 1
      const element = document.elementFromPoint(position.x / ratio, position.y / ratio)
      return element && frame.contains(element) ? element : null
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
        handlers.current.onDrop(payload.paths, element)
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
