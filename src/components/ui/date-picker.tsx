import { Popover } from "@base-ui/react/popover"
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"

import { CalendarDaysIcon, ChevronLeftIcon, ChevronRightIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SelectControl } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import "./form-controls.css"

type Day = { year: number; month: number; day: number }
const weekdays = ["一", "二", "三", "四", "五", "六", "日"]
const months = Array.from({ length: 12 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 月` }))
const pad = (value: number, length = 2) => String(value).padStart(length, "0")
const format = (date: Day) => `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`
function asDate(date: Day) {
  const result = new Date(0)
  result.setUTCFullYear(date.year, date.month - 1, date.day)
  return result
}
function fromDate(date: Date): Day { return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() } }
function today(): Day { const date = new Date(); return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() } }
function parse(value: string): Day | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined
  const [year, month, day] = value.split("-").map(Number)
  const date = { year, month, day }
  return year >= 1 && year <= 9999 && format(fromDate(asDate(date))) === value ? date : undefined
}
function addDays(date: Day, amount: number): Day { const result = asDate(date); result.setUTCDate(result.getUTCDate() + amount); return fromDate(result) }
function shiftMonth(date: Day, amount: number): Day {
  const first = fromDate(asDate({ ...date, month: date.month + amount, day: 1 }))
  const end = fromDate(asDate({ ...first, month: first.month + 1, day: 0 }))
  return { ...first, day: Math.min(date.day, end.day) }
}
const inRange = (date: Day) => date.year >= 1 && date.year <= 9999

export type DatePickerProps = {
  value: string
  onValueChange(value: string): void
  disabled?: boolean
  id?: string
  className?: string
  "aria-label"?: string
  onOpenChange?(open: boolean): void
}

/** Single-date field. Browsing months never writes a date; only selecting or clearing does. */
export function DatePicker({ value, onValueChange, disabled, id, className, onOpenChange, "aria-label": label = "选择日期" }: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const [display, setDisplay] = useState<Day>(() => parse(value) ?? today())
  const [focusedDay, setFocusedDay] = useState(() => format(parse(value) ?? today()))
  const [yearText, setYearText] = useState(String(display.year))
  const daysRef = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const focusRequested = useRef(false)
  const yearErrorId = useId()
  const validYear = /^\d{1,4}$/u.test(yearText) && Number(yearText) >= 1 && Number(yearText) <= 9999
  const first = { ...display, day: 1 }
  const start = addDays(first, -((asDate(first).getUTCDay() + 6) % 7))
  const days = Array.from({ length: 42 }, (_, index) => addDays(start, index))

  useEffect(() => {
    if (disabled && open) { setOpen(false); onOpenChange?.(false) }
  }, [disabled, onOpenChange, open])

  useEffect(() => {
    if (open && focusRequested.current) {
      daysRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusedDay}"]`)?.focus()
      focusRequested.current = false
    }
  }, [display, focusedDay, open])

  function changeOpen(next: boolean) {
    if (next) {
      const initial = parse(value) ?? today()
      setDisplay(initial); setFocusedDay(format(initial)); setYearText(String(initial.year))
    }
    setOpen(next); onOpenChange?.(next)
  }
  function browse(date: Day, focus = false) {
    if (!inRange(date)) return
    setDisplay(date); setYearText(String(date.year)); setFocusedDay(format(date)); focusRequested.current = focus
  }
  function choose(next: string) { onValueChange(next); changeOpen(false) }
  function moveDay(event: KeyboardEvent, date: Day) {
    if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return
    let next: Day | undefined
    const offset = (asDate(date).getUTCDay() + 6) % 7
    if (event.key === "ArrowLeft") next = addDays(date, -1)
    if (event.key === "ArrowRight") next = addDays(date, 1)
    if (event.key === "ArrowUp") next = addDays(date, -7)
    if (event.key === "ArrowDown") next = addDays(date, 7)
    if (event.key === "Home") next = addDays(date, -offset)
    if (event.key === "End") next = addDays(date, 6 - offset)
    if (event.key === "PageUp") next = shiftMonth(date, event.shiftKey ? -12 : -1)
    if (event.key === "PageDown") next = shiftMonth(date, event.shiftKey ? 12 : 1)
    if (next) { event.preventDefault(); browse(next, true) }
  }
  function protectComposition(event: KeyboardEvent) {
    if ((composing.current || event.nativeEvent.isComposing || event.keyCode === 229) && (event.key === "Enter" || event.key === "Escape" || event.keyCode === 229)) {
      event.preventDefault(); event.stopPropagation()
    }
  }
  return <Popover.Root open={open && !disabled} onOpenChange={changeOpen}>
    <Popover.Trigger id={id} disabled={disabled} aria-label={label} title={value || "选择日期"}
      data-slot="date-picker" className={cn("kiln-control-trigger", className)}
      onKeyDownCapture={protectComposition} onKeyDown={event => {
        if (open || !["Tab", "Escape"].includes(event.key)) event.stopPropagation()
      }}>
      <span className="kiln-control-value">{value || "选择日期"}</span>
      <span className="kiln-control-icon"><CalendarDaysIcon /></span>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner sideOffset={4} collisionPadding={8} align="start"
        className="kiln-control-positioner click-outside-ignore" onKeyDown={event => event.stopPropagation()}>
        <Popover.Popup aria-label={label} className="kiln-date-popup" data-slot="date-picker-content"
          initialFocus={() => daysRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusedDay}"]`) ?? true}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDownCapture={protectComposition}
          onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); changeOpen(false) } }}>
          <div className="kiln-date-heading">
            <Button type="button" size="icon-sm" variant="outline" aria-label="上个月"
              disabled={display.year === 1 && display.month === 1} onClick={() => browse(shiftMonth(display, -1))}><ChevronLeftIcon /></Button>
            <Input className="kiln-date-year" aria-label="年份" inputMode="numeric" value={yearText}
              aria-invalid={!validYear} aria-describedby={!validYear ? yearErrorId : undefined}
              onChange={event => {
                const draft = event.target.value
                setYearText(draft)
                if (/^\d{1,4}$/u.test(draft) && Number(draft) >= 1 && Number(draft) <= 9999) {
                  const next = shiftMonth(display, (Number(draft) - display.year) * 12)
                  setDisplay(next); setFocusedDay(format(next))
                }
              }}
              onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (validYear) browse(display, true) } }} />
            <SelectControl aria-label="月份" className="kiln-date-month" value={String(display.month)} options={months}
              onValueChange={month => browse(shiftMonth(display, Number(month) - display.month))} />
            <Button type="button" size="icon-sm" variant="outline" aria-label="下个月"
              disabled={display.year === 9999 && display.month === 12} onClick={() => browse(shiftMonth(display, 1))}><ChevronRightIcon /></Button>
          </div>
          {!validYear ? <p id={yearErrorId} className="kiln-date-error">年份须为 1 至 9999</p> : null}
          <div className="kiln-date-grid" role="row" aria-label="星期">{weekdays.map(day => <span key={day} role="columnheader" className="kiln-date-weekday">{day}</span>)}</div>
          <div ref={daysRef} role="grid" aria-label={`${display.year} 年 ${display.month} 月`}>
            {Array.from({ length: 6 }, (_, week) => <div role="row" className="kiln-date-grid" key={week}>
              {days.slice(week * 7, week * 7 + 7).map(date => {
                const stamp = format(date)
                return <div role="gridcell" key={stamp}><Button type="button" className="kiln-date-day" variant="ghost"
                  data-date={stamp} data-outside={date.month !== display.month} disabled={!inRange(date)}
                  aria-label={stamp} aria-pressed={stamp === value} tabIndex={stamp === focusedDay ? 0 : -1}
                  onFocus={() => setFocusedDay(stamp)} onKeyDown={event => moveDay(event, date)} onClick={() => choose(stamp)}>{date.day}</Button></div>
              })}
            </div>)}
          </div>
          <div className="kiln-date-footer">
            <Button type="button" variant="outline" size="sm" onClick={() => choose(format(today()))}>今天</Button>
            <Button type="button" variant="outline" size="sm" disabled={!value} onClick={() => choose("")}>清空</Button>
            <Popover.Close render={<Button type="button" variant="outline" size="sm" />}>关闭</Popover.Close>
          </div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
}
