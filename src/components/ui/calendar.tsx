import { useEffect, useRef, useState, type KeyboardEvent } from "react"

import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import "./form-controls.css"

/** 日历里的一天；年份范围 0001–9999，全部按 UTC 计算，避开时区与夏令时。 */
export type CalendarDay = { year: number; month: number; day: number }

const weekdays = ["一", "二", "三", "四", "五", "六", "日"]
const pad = (value: number, length = 2) => String(value).padStart(length, "0")

export const formatDay = (date: CalendarDay) => `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`
function asDate(date: CalendarDay) {
  const result = new Date(0)
  result.setUTCFullYear(date.year, date.month - 1, date.day)
  return result
}
function fromDate(date: Date): CalendarDay { return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() } }
export function todayDay(): CalendarDay { const date = new Date(); return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() } }
/** 只接受真实存在的 `YYYY-MM-DD`（含闰日），其余返回 undefined。 */
export function parseDay(value: string): CalendarDay | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined
  const [year, month, day] = value.split("-").map(Number)
  const date = { year, month, day }
  return year >= 1 && year <= 9999 && formatDay(fromDate(asDate(date))) === value ? date : undefined
}
export function addDays(date: CalendarDay, amount: number): CalendarDay { const result = asDate(date); result.setUTCDate(result.getUTCDate() + amount); return fromDate(result) }
export function shiftMonth(date: CalendarDay, amount: number): CalendarDay {
  const first = fromDate(asDate({ ...date, month: date.month + amount, day: 1 }))
  const end = fromDate(asDate({ ...first, month: first.month + 1, day: 0 }))
  return { ...first, day: Math.min(date.day, end.day) }
}
const inRange = (date: CalendarDay) => date.year >= 1 && date.year <= 9999

export function nextDayForKey(key: string, date: CalendarDay, shiftKey: boolean): CalendarDay | undefined {
  const offset = (asDate(date).getUTCDay() + 6) % 7
  if (key === "ArrowLeft") return addDays(date, -1)
  if (key === "ArrowRight") return addDays(date, 1)
  if (key === "ArrowUp") return addDays(date, -7)
  if (key === "ArrowDown") return addDays(date, 7)
  if (key === "Home") return addDays(date, -offset)
  if (key === "End") return addDays(date, 6 - offset)
  if (key === "PageUp") return shiftMonth(date, shiftKey ? -12 : -1)
  if (key === "PageDown") return shiftMonth(date, shiftKey ? 12 : 1)
  return undefined
}

/** 输入法组合中的按键（含 Safari 的 keyCode 229）不能当作确认或关闭。 */
export function isCompositionKey(event: KeyboardEvent, composing: boolean) {
  return composing || event.nativeEvent.isComposing || event.keyCode === 229
}

export type CalendarProps = {
  /** 已选日期 `YYYY-MM-DD`，空串表示未选。 */
  value: string
  onValueChange(value: string): void
  className?: string
}

/**
 * 共享内联日历（kiln Date / Time Picker 的月历部分）。
 * 挂载时显示已选日期所在月份（未选则为今天）；翻月只改变浏览位置，不写入日期。
 * 日期按钮用 roving tabIndex，方向键 / Home / End / PageUp / PageDown（加 Shift 跳一年）移动焦点。
 */
export function Calendar({ value, onValueChange, className }: CalendarProps) {
  const [display, setDisplay] = useState<CalendarDay>(() => parseDay(value) ?? todayDay())
  const [focusedDay, setFocusedDay] = useState(() => formatDay(parseDay(value) ?? todayDay()))
  const daysRef = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const focusRequested = useRef(false)
  const first = { ...display, day: 1 }
  const start = addDays(first, -((asDate(first).getUTCDay() + 6) % 7))
  const days = Array.from({ length: 42 }, (_, index) => addDays(start, index))
  const monthLabel = `${pad(display.year, 4)} 年 ${display.month} 月`

  useEffect(() => {
    if (!focusRequested.current) return
    daysRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusedDay}"]`)?.focus()
    focusRequested.current = false
  }, [display, focusedDay])

  function browse(date: CalendarDay, focus = false) {
    if (!inRange(date)) return
    setDisplay(date); setFocusedDay(formatDay(date)); focusRequested.current = focus
  }
  function moveDay(event: KeyboardEvent, date: CalendarDay) {
    if (isCompositionKey(event, composing.current)) return
    const next = nextDayForKey(event.key, date, event.shiftKey)
    if (next) { event.preventDefault(); browse(next, true) }
  }
  function choose(date: CalendarDay) {
    // 点了相邻月份的日期：浏览位置跟过去，已选日期才看得见。
    if (date.month !== display.month || date.year !== display.year) setDisplay(date)
    setFocusedDay(formatDay(date))
    onValueChange(formatDay(date))
  }

  const today = formatDay(todayDay())
  return <div className={cn("kiln-calendar", className)} data-slot="calendar"
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}>
    <div className="kiln-calendar-nav">
      <Button type="button" size="icon" variant="outline" aria-label="上个月"
        disabled={display.year === 1 && display.month === 1} onClick={() => browse(shiftMonth(display, -1))}><ChevronLeftIcon /></Button>
      <span className="kiln-calendar-month" aria-live="polite">{monthLabel}</span>
      <Button type="button" size="icon" variant="outline" aria-label="下个月"
        disabled={display.year === 9999 && display.month === 12} onClick={() => browse(shiftMonth(display, 1))}><ChevronRightIcon /></Button>
    </div>
    {/* 今天格写「今」、挂 aria-current（kiln 上游 Calendar grid 规范）：读屏名仍是完整日期，
        只换可见字形；它与选中同为实心主色，靠字形区分，不代表已选。 */}
    <div ref={daysRef} className="kiln-calendar-grid" role="grid" aria-label={monthLabel}>
      <div className="kiln-calendar-row" role="row">{weekdays.map(day => <span key={day} role="columnheader" className="kiln-calendar-weekday">{day}</span>)}</div>
      {Array.from({ length: 6 }, (_, week) => <div role="row" className="kiln-calendar-row" key={week}>
        {days.slice(week * 7, week * 7 + 7).map(date => {
          const stamp = formatDay(date)
          const isToday = stamp === today
          return <div role="gridcell" key={stamp}><Button type="button" className="kiln-calendar-day" variant="ghost"
            data-date={stamp} data-outside={date.month !== display.month} disabled={!inRange(date)}
            aria-label={stamp} aria-pressed={stamp === value} aria-current={isToday ? "date" : undefined}
            tabIndex={stamp === focusedDay ? 0 : -1}
            onFocus={() => setFocusedDay(stamp)} onKeyDown={event => moveDay(event, date)} onClick={() => choose(date)}>{isToday ? "今" : date.day}</Button></div>
        })}
      </div>)}
    </div>
  </div>
}
