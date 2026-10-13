import { isTauri } from "@tauri-apps/api/core"
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react"

import { ChevronLeftIcon } from "@/components/icons"
import { ToolbarIconButton } from "@/components/ui/toolbar-icon-button"
import { setWindowControlsHidden } from "@/lib/api"
import { formatSaveState, type SaveState } from "@/lib/save-state"

import styles from "./zen-surface.module.css"

/** 停笔多久后操作条淡回来。 */
const BAR_REVEAL_DELAY_MS = 1500

/**
 * 文字类禅模式的顶部操作条。坐在标题栏带里，只放「我在写什么、存了没有、
 * 怎么出去」：格式与插入走 `/` 命令和选区浮动条，这里不再放按钮。
 */
export interface ZenBar {
  /** 当前内容的名字，随正文实时变化。 */
  title: string
  /** 保存态；只读内容传 "readOnly"。保存失败时操作条常驻，不随打字淡出。 */
  saveState: SaveState | "readOnly"
  /** 字数等统计，靠右。 */
  meta?: ReactNode
  /** 类型专属的动作或提示（大纲/导图切换、密匣去向），在统计左侧。 */
  actions?: ReactNode
}

export interface ZenSurfaceProps {
  ariaLabel: string
  /** 不传则只留标题栏拖拽带：画布与数据集的禅模式自带工具条。 */
  bar?: ZenBar
  children: ReactNode
  onRequestClose: () => void
}

export function ZenSurface({
  ariaLabel,
  bar,
  children,
  onRequestClose,
}: ZenSurfaceProps) {
  const hasBar = bar !== undefined
  const [isTyping, setIsTyping] = useState(false)
  const revealTimerRef = useRef<number | null>(null)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isComposing =
        event.isComposing || event.key === "Process" || event.keyCode === 229
      if (
        isComposing ||
        event.defaultPrevented ||
        event.repeat ||
        event.key !== "Escape"
      ) {
        return
      }

      event.preventDefault()
      onRequestClose()
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onRequestClose])

  // 操作条的退出按钮占了红绿灯的位置：文字类禅模式整窗只留正文。
  useEffect(() => {
    if (!hasBar || !isTauri()) return

    void setWindowControlsHidden(true).catch((error) => {
      console.warn("Unable to hide window controls for zen surface", error)
    })
    return () => {
      void setWindowControlsHidden(false).catch((error) => {
        console.warn("Unable to restore window controls", error)
      })
    }
  }, [hasBar])

  useEffect(() => {
    if (!hasBar) return

    function handlePointerMove(event: PointerEvent) {
      // 正文换行会让浏览器补发零位移的 pointermove，那不是用户动了鼠标。
      if (Math.abs(event.movementX) + Math.abs(event.movementY) < 2) return
      clearRevealTimer()
      setIsTyping(false)
    }

    window.addEventListener("pointermove", handlePointerMove)
    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      clearRevealTimer()
    }
  }, [hasBar])

  function clearRevealTimer() {
    if (revealTimerRef.current === null) return
    window.clearTimeout(revealTimerRef.current)
    revealTimerRef.current = null
  }

  function handleKeyDownCapture(event: ReactKeyboardEvent<HTMLElement>) {
    if (!hasBar || !isWritingKey(event)) return
    if (
      event.target instanceof Element &&
      event.target.closest("[data-zen-bar]")
    ) {
      return
    }

    setIsTyping(true)
    clearRevealTimer()
    revealTimerRef.current = window.setTimeout(() => {
      revealTimerRef.current = null
      setIsTyping(false)
    }, BAR_REVEAL_DELAY_MS)
  }

  return (
    <section
      aria-label={ariaLabel}
      className={styles.surface}
      data-focus-scope
      onKeyDownCapture={handleKeyDownCapture}
    >
      {bar ? (
        <header
          className={styles.bar}
          data-hidden={isTyping && bar.saveState !== "error"}
          data-tauri-drag-region
          data-zen-bar
        >
          <ToolbarIconButton
            className={styles.exit}
            label="退出禅模式"
            onClick={onRequestClose}
            type="button"
            variant="ghost"
          >
            <ChevronLeftIcon />
          </ToolbarIconButton>
          <div className={styles.heading} data-tauri-drag-region>
            <span
              className={styles.title}
              data-tauri-drag-region
              data-zen-title
              title={bar.title}
            >
              {bar.title}
            </span>
            <span
              className={styles.status}
              data-state={bar.saveState}
              data-tauri-drag-region
              data-zen-save-state
            >
              {bar.saveState === "readOnly"
                ? "只读"
                : formatSaveState(bar.saveState)}
            </span>
          </div>
          {bar.actions || bar.meta ? (
            <div className={styles.trailing} data-tauri-drag-region>
              {bar.actions}
              {bar.meta ? (
                <span className={styles.meta} data-tauri-drag-region>
                  {bar.meta}
                </span>
              ) : null}
            </div>
          ) : null}
        </header>
      ) : (
        <div
          aria-hidden="true"
          className={styles.dragRegion}
          data-tauri-drag-region
        />
      )}
      <div className={styles.content}>{children}</div>
    </section>
  )
}

/** 会往正文里写东西的按键：字符、换行、删除与输入法组字。组合键不算写字。 */
function isWritingKey(event: ReactKeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  const { key } = event
  return (
    key.length === 1 ||
    key === "Enter" ||
    key === "Backspace" ||
    key === "Delete" ||
    key === "Tab" ||
    key === "Process" ||
    event.nativeEvent.isComposing
  )
}
