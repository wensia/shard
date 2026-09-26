import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { addDays, formatDay, nextDayForKey, shiftMonth, todayDay, type CalendarDay } from "@/components/ui/calendar"
import { SidebarToggleButton } from "@/components/shard/sidebar-nav"
import { buildCalendarAgenda, type AgendaDay, type AgendaTodo } from "@/lib/calendar-agenda"
import type { Fragment } from "@/types"
import styles from "./calendar-workspace.module.css"

type Props = { fragments: Fragment[]; onOpenFragment(fragmentId: string): void; isSidebarCollapsed?: boolean; onToggleSidebar?(): void }
const weekdays = ["一", "二", "三", "四", "五", "六", "日"]
/** 每格最多画几条横幅；其余收进「+N」。行高按 6 行均分视口，三条恰好放得下。 */
const VISIBLE_BANNERS = 3

function summary(content: string): string {
  const line = content.split("\n").find((item) => item.trim()) ?? ""
  return line.replace(/^\s*(?:#{1,6}\s*|[-*+]\s+(?:\[[ xX]\]\s*)?)/u, "")
    .replace(/⏰ \d{4}-\d{2}-\d{2} \d{2}:\d{2}/gu, "")
    .replace(/!?\[\[([^\]]+)\]\]/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`~]/gu, "").trim() || "无标题碎片"
}

function localTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
}

type Banner =
  | { kind: "todo"; key: string; todo: AgendaTodo }
  | { kind: "fragment"; key: string; fragment: Fragment }

/** 一天的横幅：先待办（按提醒时间），再碎片（按记录时间）。 */
function bannersOf(day: AgendaDay | undefined): Banner[] {
  if (!day) return []
  return [
    ...day.todos.map((todo): Banner => ({ kind: "todo", key: `todo:${todo.fragment.id}:${todo.lineIndex}`, todo })),
    ...day.fragments.map((fragment): Banner => ({ kind: "fragment", key: `fragment:${fragment.id}`, fragment })),
  ]
}

function BannerItem({ banner, now, onOpenFragment }: { banner: Banner; now: number; onOpenFragment: Props["onOpenFragment"] }) {
  if (banner.kind === "fragment") {
    const text = summary(banner.fragment.content)
    const time = localTime(banner.fragment.createdAt)
    return <button type="button" className={styles.banner} data-kind="fragment" title={`${time} ${text}`}
      onClick={() => onOpenFragment(banner.fragment.id)}>
      <span className={styles.bannerText}>{text}</span>
    </button>
  }
  const { todo } = banner
  const state = todo.checked ? "done" : todo.dueAt <= now ? "due" : "upcoming"
  const text = todo.text || "未命名待办"
  const time = todo.at.slice(11)
  return <button type="button" className={styles.banner} data-kind="todo" data-state={state}
    title={`${time} ${text}${todo.checked ? "（已完成）" : state === "due" ? "（已到点）" : ""}`}
    onClick={() => onOpenFragment(todo.fragment.id)}>
    <span className={styles.bannerText}>{text}</span>
    <time className={styles.bannerTime}>{time}</time>
  </button>
}

/**
 * 日历页：整页只有月历格子。每格左上是日号（今天写「今」），下面把当天的待办与碎片
 * 画成横幅条——待办带提醒时间，到点未完成转警示色、完成后划线；碎片是安静的 muted 条。
 * 放不下的收进「+N」，点横幅跳回时间线定位对应碎片。
 */
export function CalendarWorkspace({ fragments, onOpenFragment, isSidebarCollapsed, onToggleSidebar }: Props) {
  const [displayMonth, setDisplayMonth] = useState<CalendarDay>(todayDay)
  const [focusedDay, setFocusedDay] = useState(() => formatDay(todayDay()))
  const [now] = useState(() => Date.now())
  const gridRef = useRef<HTMLDivElement>(null)
  const focusRequested = useRef(false)
  const cache = useRef(new Map())
  const agenda = useMemo(() => buildCalendarAgenda(fragments, cache.current), [fragments])
  const first = { ...displayMonth, day: 1 }
  const firstWeekday = (new Date(first.year, first.month - 1, 1).getDay() + 6) % 7
  const cells = Array.from({ length: 42 }, (_, index) => addDays(first, index - firstWeekday))
  const today = formatDay(todayDay())

  useEffect(() => {
    if (!focusRequested.current) return
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusedDay}"]`)?.focus()
    focusRequested.current = false
  }, [focusedDay, displayMonth])

  function focusByKey(event: KeyboardEvent<HTMLButtonElement>, date: CalendarDay) {
    const next = nextDayForKey(event.key, date, event.shiftKey)
    if (!next || next.year < 1 || next.year > 9999) return
    event.preventDefault()
    focusRequested.current = true
    setFocusedDay(formatDay(next))
    if (next.month !== displayMonth.month || next.year !== displayMonth.year) setDisplayMonth(next)
  }

  function goToday() {
    const next = todayDay()
    setDisplayMonth(next)
    setFocusedDay(formatDay(next))
  }

  return <div className={styles.workspace}>
    <header className={styles.header} data-tauri-drag-region="true">
      {isSidebarCollapsed && onToggleSidebar ? <SidebarToggleButton isCollapsed onToggleCollapsed={onToggleSidebar} /> : null}
      <h1 className={styles.month}>{String(displayMonth.year).padStart(4, "0")} 年 {displayMonth.month} 月</h1>
      <div className={styles.nav}>
        <Button type="button" variant="outline" size="icon" aria-label="上个月" onClick={() => setDisplayMonth(shiftMonth(displayMonth, -1))} disabled={displayMonth.year === 1 && displayMonth.month === 1}><ChevronLeftIcon /></Button>
        <Button type="button" variant="outline" size="icon" aria-label="下个月" onClick={() => setDisplayMonth(shiftMonth(displayMonth, 1))} disabled={displayMonth.year === 9999 && displayMonth.month === 12}><ChevronRightIcon /></Button>
        <Button type="button" variant="outline" onClick={goToday}>今天</Button>
      </div>
    </header>
    <div ref={gridRef} className={styles.grid} role="grid" aria-label={`${displayMonth.year}年${displayMonth.month}月`}>
      <div className={styles.weekdays} role="row">{weekdays.map((label) => <span role="columnheader" key={label}>{label}</span>)}</div>
      {Array.from({ length: 6 }, (_, week) => <div className={styles.week} role="row" key={week}>
        {cells.slice(week * 7, week * 7 + 7).map((date) => {
          const key = formatDay(date)
          const isToday = key === today
          const outside = date.month !== displayMonth.month || date.year !== displayMonth.year
          const banners = bannersOf(agenda.get(key))
          const hidden = banners.slice(VISIBLE_BANNERS)
          return <div role="gridcell" key={key} className={styles.cell} data-outside={outside}>
            <button type="button" className={styles.dayButton} data-date={key} aria-label={key}
              aria-current={isToday ? "date" : undefined} tabIndex={key === focusedDay ? 0 : -1}
              onFocus={() => setFocusedDay(key)} onKeyDown={(event) => focusByKey(event, date)}>
              <span className={isToday ? styles.today : styles.dayNumber}>{isToday ? "今" : date.day}</span>
            </button>
            {banners.length > 0 ? <div className={styles.banners}>
              {banners.slice(0, VISIBLE_BANNERS).map((banner) => <BannerItem key={banner.key} banner={banner} now={now} onOpenFragment={onOpenFragment} />)}
              {hidden.length > 0 ? <span className={styles.more}
                title={hidden.map((banner) => banner.kind === "todo" ? banner.todo.text : summary(banner.fragment.content)).join("\n")}>
                +{hidden.length}
              </span> : null}
            </div> : null}
          </div>
        })}
      </div>)}
    </div>
  </div>
}
