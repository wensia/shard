import { useEffect, useRef, type KeyboardEvent } from "react"

import { MindMapFenceWidget } from "@/components/shard/mind-map-fence-widget"

import styles from "./outline-composer.module.css"

/** 幕布式大纲的根节点输入框；进入大纲态后焦点直接落在这里。 */
const ROOT_INPUT_SELECTOR =
  '[data-outline-node][data-root="true"] textarea[data-outline-field="text"]'
/** NodeView 由 React 渲染，首帧未必已经落地，按帧重试若干次后放弃。 */
const FOCUS_RETRY_FRAMES = 10

interface OutlineComposerProps {
  /** 大纲正文：纯缩进列表，不含围栏标记（产品框架 §2）。 */
  code: string
  onChange: (code: string) => void
  /** Escape：退出大纲态，回到普通速记。 */
  onExit: () => void
  onSubmit: () => void
}

/**
 * 大纲态下速记框的正文区（产品框架 §2、§6）。
 *
 * 会话树、写回与外部改动重建的全部逻辑复用 `MindMapFenceWidget`——它和碎片正文里
 * 的 ```mindmap 围栏共用同一个组件与同一套序列化规则，这里只补两件宿主的事：
 * 进入时把焦点交给根节点，以及在大纲编辑器吃掉 Enter 之前接住 Cmd/Ctrl+Enter 提交。
 */
export function OutlineComposer({
  code,
  onChange,
  onExit,
  onSubmit,
}: OutlineComposerProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let attempts = 0
    let frame = 0
    const focusRoot = () => {
      const target = containerRef.current?.querySelector<HTMLTextAreaElement>(
        ROOT_INPUT_SELECTOR
      )
      if (!target) {
        attempts += 1
        if (attempts < FOCUS_RETRY_FRAMES) frame = requestAnimationFrame(focusRoot)
        return
      }

      target.focus()
      const end = target.value.length
      target.setSelectionRange(end, end)
    }

    frame = requestAnimationFrame(focusRoot)
    return () => cancelAnimationFrame(frame)
  }, [])

  /**
   * 捕获阶段拦 Cmd/Ctrl+Enter：大纲编辑器对 Enter 一律 `stopPropagation`
   * （Cmd+Enter 在它那里是「离开输入框」），冒泡阶段等不到这个键。
   */
  function handleKeyDownCapture(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter") return
    if (!event.metaKey && !event.ctrlKey) return
    if (event.nativeEvent.isComposing) return

    event.preventDefault()
    event.stopPropagation()
    onSubmit()
  }

  return (
    <div
      className={styles.outline}
      data-capture-outline="editor"
      onKeyDownCapture={handleKeyDownCapture}
      ref={containerRef}
    >
      <MindMapFenceWidget
        code={code}
        onChange={onChange}
        onExit={onExit}
        readOnly={false}
        sourceStart={0}
      />
    </div>
  )
}
