import { useEffect, useRef, useState, type KeyboardEvent } from "react"

import { CalendarDaysIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Calendar, formatDay, isCompositionKey, todayDay } from "@/components/ui/calendar"
import { Dialog, DialogTrigger } from "@/components/ui/dialog"
import { PickerDialogContent } from "@/components/ui/picker-dialog"
import { cn } from "@/lib/utils"
import "./form-controls.css"

export type DatePickerProps = {
  value: string
  onValueChange(value: string): void
  disabled?: boolean
  id?: string
  className?: string
  "aria-label"?: string
  onOpenChange?(open: boolean): void
}

/**
 * 单日期字段：触发器是 Kiln 控件几何，点开是紧凑对话框（标题 + 已选摘要 + 月历）。
 * 翻月不写入；点日期即写入并关闭；「今天」「清空」同样写入并关闭。
 */
export function DatePicker({ value, onValueChange, disabled, id, className, onOpenChange, "aria-label": label = "选择日期" }: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const composing = useRef(false)

  useEffect(() => {
    if (disabled && open) { setOpen(false); onOpenChange?.(false) }
  }, [disabled, onOpenChange, open])

  function changeOpen(next: boolean) { setOpen(next); onOpenChange?.(next) }
  function choose(next: string) { onValueChange(next); changeOpen(false) }
  function protectComposition(event: KeyboardEvent) {
    if (isCompositionKey(event, composing.current) && (event.key === "Enter" || event.key === "Escape" || event.keyCode === 229)) {
      event.preventDefault(); event.stopPropagation()
    }
  }

  return <Dialog open={open && !disabled} onOpenChange={changeOpen}>
    <DialogTrigger id={id} disabled={disabled} aria-label={label} title={value || "选择日期"}
      data-slot="date-picker" className={cn("kiln-control-trigger", className)}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onKeyDownCapture={protectComposition} onKeyDown={event => {
        if (open || !["Tab", "Escape"].includes(event.key)) event.stopPropagation()
      }}>
      <span className="kiln-control-value">{value || "选择日期"}</span>
      <span className="kiln-control-icon"><CalendarDaysIcon /></span>
    </DialogTrigger>
    <PickerDialogContent slot="date-picker-content" title={label} summaryLabel="已选日期" summary={value} placeholder="未选择"
      initialFocus='.kiln-calendar-day[tabindex="0"]' onRequestClose={() => changeOpen(false)}
      footer={<>
        <Button type="button" variant="outline" size="sm" onClick={() => choose(formatDay(todayDay()))}>今天</Button>
        <Button type="button" variant="outline" size="sm" disabled={!value} onClick={() => choose("")}>清空</Button>
      </>}>
      <Calendar value={value} onValueChange={choose} />
    </PickerDialogContent>
  </Dialog>
}
