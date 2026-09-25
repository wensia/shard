import { Popover } from "@base-ui/react/popover"
import { useEffect, useRef, useState, type KeyboardEvent } from "react"

import { ClockIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import "./form-controls.css"

const pad = (value: number) => String(value).padStart(2, "0")
const hours = Array.from({ length: 24 }, (_, index) => pad(index))
const minutes = Array.from({ length: 12 }, (_, index) => pad(index * 5))
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
 * 弹层是小时、分钟两列（分钟 5 分步进），顶部输入框可直接手输任意分钟。
 * 点小时只改小时并保持打开；点分钟即完成选择并关闭。
 */
export function TimePicker({ value, onValueChange, disabled, id, className, onOpenChange, "aria-label": label = "选择时间" }: TimePickerProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const hourListRef = useRef<HTMLDivElement>(null)
  const minuteListRef = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const current = parts(value)
  const draftValid = draft.trim() === "" || normalizeTime(draft) !== null

  useEffect(() => {
    if (disabled && open) { setOpen(false); onOpenChange?.(false) }
  }, [disabled, onOpenChange, open])

  useEffect(() => {
    if (!open) return
    // 打开时把已选的小时、分钟滚到列中间；只动列自己的 scrollTop，不牵动外层滚动容器。
    const frame = requestAnimationFrame(() => {
      for (const list of [hourListRef.current, minuteListRef.current]) {
        const selected = list?.querySelector<HTMLElement>("[aria-pressed='true']")
        if (list && selected) list.scrollTop = selected.offsetTop - (list.clientHeight - selected.offsetHeight) / 2
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  function changeOpen(next: boolean) {
    if (next) setDraft(value)
    setOpen(next); onOpenChange?.(next)
  }
  function choose(next: string, close: boolean) {
    onValueChange(next); setDraft(next)
    if (close) changeOpen(false)
  }
  function protectComposition(event: KeyboardEvent) {
    if ((composing.current || event.nativeEvent.isComposing || event.keyCode === 229) && (event.key === "Enter" || event.key === "Escape" || event.keyCode === 229)) {
      event.preventDefault(); event.stopPropagation()
    }
  }

  return <Popover.Root open={open && !disabled} onOpenChange={changeOpen}>
    <Popover.Trigger id={id} disabled={disabled} aria-label={label} title={value || "选择时间"}
      data-slot="time-picker" className={cn("kiln-control-trigger", className)}
      onKeyDownCapture={protectComposition} onKeyDown={event => {
        if (open || !["Tab", "Escape"].includes(event.key)) event.stopPropagation()
      }}>
      <span className="kiln-control-value">{value || "选择时间"}</span>
      <span className="kiln-control-icon"><ClockIcon /></span>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner sideOffset={4} collisionPadding={8} align="start"
        className="kiln-control-positioner click-outside-ignore" onKeyDown={event => event.stopPropagation()}>
        <Popover.Popup aria-label={label} className="kiln-time-popup" data-slot="time-picker-content"
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDownCapture={protectComposition}
          onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); changeOpen(false) } }}>
          <Input aria-label="输入时间" className="kiln-time-input" inputMode="numeric" placeholder="HH:mm" value={draft}
            aria-invalid={!draftValid}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key !== "Enter") return
              event.preventDefault()
              const next = normalizeTime(draft)
              if (next) choose(next, true)
            }} />
          <div className="kiln-time-columns">
            <div ref={hourListRef} className="kiln-time-column" role="group" aria-label="小时">
              {hours.map(hour => <Button key={hour} type="button" variant="ghost" size="sm" className="kiln-time-option"
                aria-pressed={current?.hour === hour}
                onClick={() => choose(`${hour}:${current?.minute ?? "00"}`, false)}>{hour}</Button>)}
            </div>
            <div ref={minuteListRef} className="kiln-time-column" role="group" aria-label="分钟">
              {minutes.map(minute => <Button key={minute} type="button" variant="ghost" size="sm" className="kiln-time-option"
                aria-pressed={current?.minute === minute}
                onClick={() => choose(`${current?.hour ?? "00"}:${minute}`, true)}>{minute}</Button>)}
            </div>
          </div>
          <div className="kiln-date-footer">
            <Button type="button" variant="outline" size="sm" disabled={!value} onClick={() => choose("", true)}>清空</Button>
            <Popover.Close render={<Button type="button" variant="outline" size="sm" />}>关闭</Popover.Close>
          </div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
}
