import { useEffect, useRef, useState, type KeyboardEvent } from "react"

import { ClockIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { isCompositionKey } from "@/components/ui/calendar"
import { Dialog, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { PickerDialogContent } from "@/components/ui/picker-dialog"
import { TimeColumns } from "@/components/ui/time-columns"
import { cn } from "@/lib/utils"
import "./form-controls.css"

const pad = (value: number) => String(value).padStart(2, "0")
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/u

/** 接受 `9:05`、`0905`、`09:05`，统一成 `HH:mm`；不合法返回 null。 */
function normalizeTime(text: string): string | null {
  const trimmed = text.trim()
  const match = /^(\d{1,2}):?(\d{2})$/u.exec(trimmed)
  if (!match) return null
  const value = `${pad(Number(match[1]))}:${match[2]}`
  return TIME_PATTERN.test(value) ? value : null
}

function parts(value: string): { hour: string; minute: string } | null {
  const match = TIME_PATTERN.exec(value)
  return match ? { hour: match[1], minute: match[2] } : null
}

export type TimePickerProps = {
  /** `HH:mm`，空串表示未选。 */
  value: string
  onValueChange(value: string): void
  disabled?: boolean
  id?: string
  className?: string
  "aria-label"?: string
  onOpenChange?(open: boolean): void
}

/**
 * 单个时间字段（kiln Date / Time Picker 的时间变体）：触发器与 DatePicker 同一套几何，
 * 点开是同形态的紧凑对话框：手输框（回车确认）+ 小时、分钟两列（分钟 5 分步进）。
 * 点小时只改小时并保持打开；点分钟即完成选择并关闭。
 */
export function TimePicker({ value, onValueChange, disabled, id, className, onOpenChange, "aria-label": label = "选择时间" }: TimePickerProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const composing = useRef(false)
  const current = parts(value)
  const draftValid = draft.trim() === "" || normalizeTime(draft) !== null

  useEffect(() => {
    if (disabled && open) { setOpen(false); onOpenChange?.(false) }
  }, [disabled, onOpenChange, open])

  function changeOpen(next: boolean) {
    if (next) setDraft(value)
    setOpen(next); onOpenChange?.(next)
  }
  function choose(next: string, close: boolean) {
    onValueChange(next); setDraft(next)
    if (close) changeOpen(false)
  }
  function protectComposition(event: KeyboardEvent) {
    if (isCompositionKey(event, composing.current) && (event.key === "Enter" || event.key === "Escape" || event.keyCode === 229)) {
      event.preventDefault(); event.stopPropagation()
    }
  }

  return <Dialog open={open && !disabled} onOpenChange={changeOpen}>
    <DialogTrigger id={id} disabled={disabled} aria-label={label} title={value || "选择时间"}
      data-slot="time-picker" className={cn("kiln-control-trigger", className)}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onKeyDownCapture={protectComposition} onKeyDown={event => {
        if (open || !["Tab", "Escape"].includes(event.key)) event.stopPropagation()
      }}>
      <span className="kiln-control-value">{value || "选择时间"}</span>
      <span className="kiln-control-icon"><ClockIcon /></span>
    </DialogTrigger>
    <PickerDialogContent slot="time-picker-content" title={label} summaryLabel="已选时间" summary={value} placeholder="未选择"
      onRequestClose={() => changeOpen(false)}
      footer={<Button type="button" variant="outline" size="sm" disabled={!value} onClick={() => choose("", true)}>清空</Button>}>
      <Input aria-label="输入时间" className="kiln-time-input" inputMode="numeric" placeholder="HH:mm" value={draft}
        aria-invalid={!draftValid}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key !== "Enter") return
          event.preventDefault()
          const next = normalizeTime(draft)
          if (next) choose(next, true)
        }} />
      <TimeColumns className="kiln-time-dialog-columns" hour={current?.hour ?? null} minute={current?.minute ?? null}
        onHourChange={hour => choose(`${hour}:${current?.minute ?? "00"}`, false)}
        onMinuteChange={minute => choose(`${current?.hour ?? "00"}:${minute}`, true)} />
    </PickerDialogContent>
  </Dialog>
}
