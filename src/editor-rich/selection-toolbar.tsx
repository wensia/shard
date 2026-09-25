import { isTextSelection, posToDOMRect, type Editor } from "@tiptap/core"
import { AllSelection } from "@tiptap/pm/state"
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

import { BoldIcon, HighlighterIcon, UnderlineIcon } from "@/components/icons"
import { ToolbarIconButton } from "@/components/ui/toolbar-icon-button"

import { applyRichInlineFormat, type ShardRichInlineFormat } from "./commands"

interface SelectionToolbarState {
  anchor: { bottom: number; left: number; right: number; top: number }
  active: Record<ShardRichInlineFormat, boolean>
}

const FORMAT_ITEMS: { format: ShardRichInlineFormat; icon: ReactNode; label: string }[] = [
  { format: "bold", icon: <BoldIcon />, label: "粗体" },
  { format: "underline", icon: <UnderlineIcon />, label: "下划线" },
  { format: "highlight", icon: <HighlighterIcon />, label: "荧光笔" },
]

interface SelectionToolbarProps {
  editor: Editor
  /** 标签、`/`、`[[` 建议菜单开着时让位，两个浮层不叠在一起。 */
  suppressed: boolean
}

/**
 * 选区浮动条：只在选中了一段正文时出现在选区上方。
 *
 * 能用 `/` 命令完成的插入与块级转换全部交给命令菜单，固定工具栏不再承载；
 * 这里只放必须先有选区才成立的行内格式。与建议菜单同理挂 `document.body` +
 * fixed 定位，避开编辑器视口的 overflow 裁切。
 */
export function SelectionToolbar({ editor, suppressed }: SelectionToolbarProps) {
  const [state, setState] = useState<SelectionToolbarState | null>(null)
  const elementRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // 拖选途中不弹：松开指针后再按最终选区定位，免得浮层跟着指针抖动。
    let pointerSelecting = false
    let frame = 0

    const update = () => {
      if (editor.isDestroyed) return
      setState(readSelectionToolbarState(editor, pointerSelecting))
    }
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }
    const hide = () => setState(null)
    const onPointerDown = () => {
      pointerSelecting = true
      hide()
    }
    const onPointerUp = () => {
      if (!pointerSelecting) return
      pointerSelecting = false
      scheduleUpdate()
    }

    const dom = editor.view.dom
    editor.on("transaction", update)
    editor.on("focus", update)
    editor.on("blur", hide)
    dom.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("pointerup", onPointerUp)
    // 祖先容器滚动或窗口尺寸变化时跟着选区重新定位。
    window.addEventListener("scroll", scheduleUpdate, true)
    window.addEventListener("resize", scheduleUpdate)
    return () => {
      cancelAnimationFrame(frame)
      editor.off("transaction", update)
      editor.off("focus", update)
      editor.off("blur", hide)
      dom.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("pointerup", onPointerUp)
      window.removeEventListener("scroll", scheduleUpdate, true)
      window.removeEventListener("resize", scheduleUpdate)
    }
  }, [editor])

  const visible = state !== null && !suppressed

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element || !state) return

    const { height, width } = element.getBoundingClientRect()
    const gap = 8
    const margin = 8
    const { anchor } = state
    // 默认在选区上方；顶部放不下就翻到选区下方。全选长文时两头都可能出屏，钳回视口内。
    const preferred =
      anchor.top - gap - height >= margin ? anchor.top - gap - height : anchor.bottom + gap
    const top = Math.max(margin, Math.min(preferred, window.innerHeight - height - margin))
    const center = (anchor.left + anchor.right) / 2
    const left = Math.max(
      margin,
      Math.min(center - width / 2, window.innerWidth - width - margin)
    )

    element.style.top = `${top}px`
    element.style.left = `${left}px`
  }, [state, visible])

  if (!visible) return null

  return createPortal(
    <div
      aria-label="文本格式"
      className="shard-rich-selection-toolbar"
      data-shard-selection-toolbar=""
      // 点在浮层空白处也不能把焦点从编辑器抢走，否则选区一丢浮层就收起。
      onMouseDown={(event) => event.preventDefault()}
      ref={elementRef}
      role="toolbar"
    >
      {FORMAT_ITEMS.map((item) => (
        <ToolbarIconButton
          aria-pressed={state.active[item.format]}
          key={item.format}
          label={item.label}
          onMouseDown={(event) => {
            event.preventDefault()
            applyRichInlineFormat(editor, item.format)
          }}
          style={{
            borderRadius: "var(--shard-radius-control)",
            color: state.active[item.format]
              ? "var(--accent-foreground)"
              : "var(--muted-foreground)",
          }}
          type="button"
          variant={state.active[item.format] ? "secondary" : "ghost"}
        >
          {item.icon}
        </ToolbarIconButton>
      ))}
    </div>,
    document.body
  )
}

function readSelectionToolbarState(
  editor: Editor,
  pointerSelecting: boolean
): SelectionToolbarState | null {
  const { state, view } = editor
  const { selection } = state
  if (pointerSelecting || view.composing || !editor.isEditable || !view.hasFocus()) return null
  // 只认文本选区与全选：图片、围栏块这类节点选区与表格的单元格选区都不弹。
  if (!(isTextSelection(selection) || selection instanceof AllSelection) || selection.empty) {
    return null
  }
  // 代码块里不允许行内格式。
  if (selection.$from.parent.type.spec.code || selection.$to.parent.type.spec.code) return null
  if (!state.doc.textBetween(selection.from, selection.to, " ", " ").trim()) return null

  const rect = posToDOMRect(view, selection.from, selection.to)
  return {
    // 格式名就是 mark 名。
    active: {
      bold: editor.isActive("bold"),
      highlight: editor.isActive("highlight"),
      underline: editor.isActive("underline"),
    },
    anchor: { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top },
  }
}
