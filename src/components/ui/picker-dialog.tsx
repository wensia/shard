import { useRef, type KeyboardEvent, type ReactNode } from "react"

import { isCompositionKey } from "@/components/ui/calendar"
import { DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import "./form-controls.css"

/**
 * 浮层豁免类名：卡片行内编辑的失焦判定（fragment-editor）与表格编辑器的外部点击判定
 * （table-workspace / table-settings-popover）都认这两个类，焦点或点击落在对话框
 * 及其遮罩上不算离开编辑。
 */
const CONTROL_LAYER = "kiln-control-positioner click-outside-ignore"

export type PickerDialogContentProps = {
  title: string
  summaryLabel: string
  /** 摘要值；空串或 null 时显示 placeholder。 */
  summary: ReactNode
  placeholder: string
  footer: ReactNode
  children: ReactNode
  /** 弹层的 `data-slot`。 */
  slot: string
  className?: string
  /** Escape 关闭本层：键盘事件不再冒泡，父对话框、表格编辑器与外层快捷键都收不到。 */
  onRequestClose(): void
  /** 打开时聚焦的元素选择器（在弹层内查询），缺省走 base-ui 的首个可聚焦元素。 */
  initialFocus?: string
}

/**
 * 共享选择器对话框（kiln Date / Time Picker 的 Dialog 形态）：紧凑对话框，
 * 头部只有标题，下面是「选择摘要」，再下面是选择器本体，底部是动作。
 * 桌面 `sm:max-w-sm`（可由 className 放宽），窄屏走底部抽屉姿态。
 */
export function PickerDialogContent({ title, summaryLabel, summary, placeholder, footer, children, slot, className, onRequestClose, initialFocus }: PickerDialogContentProps) {
  const popupRef = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const empty = summary === null || summary === ""

  function protectComposition(event: KeyboardEvent) {
    if (isCompositionKey(event, composing.current) && (event.key === "Enter" || event.key === "Escape" || event.keyCode === 229)) {
      event.preventDefault(); event.stopPropagation()
    }
  }

  return <DialogContent ref={popupRef} data-slot={slot}
    className={cn(CONTROL_LAYER, "kiln-picker-dialog top-auto bottom-0 translate-y-0 rounded-b-none sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2 sm:rounded-b-[var(--shard-surface-radius)] sm:max-w-sm", className)}
    overlayProps={{
      className: CONTROL_LAYER,
      // 嵌在父对话框里也渲染遮罩：点遮罩只关本层，父对话框保留。
      forceRender: true,
      // 指针优先：按下遮罩不把焦点甩到 body 上（否则行内卡片会先触发失焦提交），关闭后焦点回到触发器。
      onMouseDown: event => event.preventDefault(),
    }}
    initialFocus={initialFocus ? () => popupRef.current?.querySelector<HTMLElement>(initialFocus) ?? true : undefined}
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
    onKeyDownCapture={protectComposition}
    onKeyDown={event => {
      // 弹层挂在 body 上，但 React 事件仍沿组件树冒泡到触发器的祖先；这里截住。
      event.stopPropagation()
      if (event.key === "Escape") { event.preventDefault(); onRequestClose() }
    }}>
    <DialogTitle className="kiln-picker-title">{title}</DialogTitle>
    <div className="kiln-picker-summary" data-slot="picker-summary">
      <span className="kiln-picker-summary-label">{summaryLabel}</span>
      <span className="kiln-picker-summary-value" data-placeholder={empty || undefined}>{empty ? placeholder : summary}</span>
    </div>
    {children}
    <DialogFooter className="kiln-picker-footer">{footer}</DialogFooter>
  </DialogContent>
}
