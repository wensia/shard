import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { ChevronLeftIcon, ChevronRightIcon, ClockIcon, ListTodoIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { addDays, formatDay, nextDayForKey, shiftMonth, todayDay, type CalendarDay } from "@/components/ui/calendar"
import { Checkbox } from "@/components/ui/checkbox"
import { SidebarToggleButton } from "@/components/shard/sidebar-nav"
import { agendaDayCounts, buildCalendarAgenda, type AgendaTodo } from "@/lib/calendar-agenda"
import { useReminderDue } from "@/lib/use-reminder-due"
import type { Fragment } from "@/types"
import styles from "./calendar-workspace.module.css"

type Props = { fragments: Fragment[]; onToggleTask(fragment: Fragment, lineIndex: number): void; onOpenFragment(fragmentId: string): void; isSidebarCollapsed?: boolean; onToggleSidebar?(): void }
const weekdays = ["一", "二", "三", "四", "五", "六", "日"]
const fullWeekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]

function TaskRow({ todo, onToggleTask, onOpenFragment }: { todo: AgendaTodo; onToggleTask: Props["onToggleTask"]; onOpenFragment: Props["onOpenFragment"] }) {
  const due = useReminderDue(todo.at)
  return <li className={styles.taskRow}>
    <Checkbox checked={todo.checked} aria-label={`${todo.checked ? "标记为未完成" : "标记为完成"}：${todo.text}`} onCheckedChange={() => onToggleTask(todo.fragment, todo.lineIndex)} />
    <button type="button" className={styles.taskTitle} data-checked={todo.checked} onClick={() => onOpenFragment(todo.fragment.id)}>{todo.text || "未命名待办"}</button>
    <span className="shard-task-reminder-mark" data-state={todo.checked ? "done" : due ? "due" : "upcoming"} title={`提醒：${todo.at}`}><ClockIcon /><span>{todo.at.slice(11)}</span></span>
  </li>
}

function summary(content: string): string {
  const line = content.split("\n").find((item) => item.trim()) ?? ""
  return line.replace(/^\s*(?:#{1,6}\s*|[-*+]\s+(?:\[[ xX]\]\s*)?)/u, "")
    .replace(/⏰ \d{4}-\d{2}-\d{2} \d{2}:\d{2}/gu, "")
    .replace(/!?\[\[([^\]]+)\]\]/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`~]/gu, "").trim() || "无标题碎片"
}

export function CalendarWorkspace({ fragments, onToggleTask, onOpenFragment, isSidebarCollapsed, onToggleSidebar }: Props) {
  const [selectedDay, setSelectedDay] = useState<CalendarDay>(todayDay)
  const [displayMonth, setDisplayMonth] = useState<CalendarDay>(todayDay)
  const [focusedDay, setFocusedDay] = useState(() => formatDay(todayDay()))
  const [now] = useState(() => Date.now())
  const gridRef = useRef<HTMLDivElement>(null)
  const focusRequested = useRef(false)
  const cache = useRef(new Map())
  const agenda = useMemo(() => buildCalendarAgenda(fragments, cache.current), [fragments])
  const selectedKey = formatDay(selectedDay)
  const day = agenda.get(selectedKey)
  const first = { ...displayMonth, day: 1 }
  const firstWeekday = (new Date(first.year, first.month - 1, 1).getDay() + 6) % 7
  const cells = Array.from({ length: 42 }, (_, index) => addDays(first, index - firstWeekday))
  const today = formatDay(todayDay())
  const heading = `${selectedDay.month}月${selectedDay.day}日 ${fullWeekdays[new Date(selectedDay.year, selectedDay.month - 1, selectedDay.day).getDay()]}`

  useEffect(() => {
    if (!focusRequested.current) return
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusedDay}"]`)?.focus()
    focusRequested.current = false
  }, [focusedDay, displayMonth])

  function focusByKey(event: KeyboardEvent<HTMLButtonElement>, date: CalendarDay) {
    const next = nextDayForKey(event.key, date, event.shiftKey)
    if (!next || next.year < 1 || next.year > 9999) return
    event.preventDefault()
    const key = formatDay(next)
    focusRequested.current = true
    setFocusedDay(key)
    if (next.month !== displayMonth.month || next.year !== displayMonth.year) setDisplayMonth(next)
  }

  function select(date: CalendarDay) {
    setSelectedDay(date)
    setFocusedDay(formatDay(date))
    if (date.month !== displayMonth.month || date.year !== displayMonth.year) setDisplayMonth(date)
  }

  return <div className={styles.workspace}>
    <header className={styles.header} data-tauri-drag-region="true">
      {isSidebarCollapsed && onToggleSidebar ? <SidebarToggleButton isCollapsed onToggleCollapsed={onToggleSidebar} /> : null}
      <h1 className={styles.month}>{String(displayMonth.year).padStart(4, "0")} 年 {displayMonth.month} 月</h1>
      <div className={styles.nav}>
        <Button type="button" variant="outline" size="icon" aria-label="上个月" onClick={() => setDisplayMonth(shiftMonth(displayMonth, -1))} disabled={displayMonth.year === 1 && displayMonth.month === 1}><ChevronLeftIcon /></Button>
        <Button type="button" variant="outline" size="icon" aria-label="下个月" onClick={() => setDisplayMonth(shiftMonth(displayMonth, 1))} disabled={displayMonth.year === 9999 && displayMonth.month === 12}><ChevronRightIcon /></Button>
        <Button type="button" variant="outline" onClick={() => { const next = todayDay(); setDisplayMonth(next); select(next) }}>今天</Button>
      </div>
    </header>
    <div className={styles.scroll}>
      <div ref={gridRef} className={styles.grid} role="grid" aria-label={`${displayMonth.year}年${displayMonth.month}月`}>
        <div className={styles.week} role="row">{weekdays.map((label) => <span role="columnheader" key={label}>{label}</span>)}</div>
        {Array.from({ length: 6 }, (_, week) => <div className={styles.week} role="row" key={week}>
          {cells.slice(week * 7, week * 7 + 7).map((date) => {
            const key = formatDay(date)
            const counts = agendaDayCounts(agenda.get(key), now)
            const isToday = key === today
            return <div role="gridcell" key={key} className={styles.cell}>
              <button type="button" className={styles.dayButton} data-date={key} data-outside={date.month !== displayMonth.month || date.year !== displayMonth.year} aria-label={key} aria-pressed={key === selectedKey} aria-current={isToday ? "date" : undefined} tabIndex={key === focusedDay ? 0 : -1} onFocus={() => setFocusedDay(key)} onKeyDown={(event) => focusByKey(event, date)} onClick={() => select(date)}>
                <span className={isToday ? styles.today : styles.dayNumber}>{isToday ? "今" : date.day}</span>
                <span className={styles.meta}>{counts.openTodos > 0 ? <span className={styles.todoCount} data-overdue={counts.overdue}><ListTodoIcon />{counts.openTodos}</span> : null}{counts.fragments > 0 ? <span className={styles.fragmentCount}>•{counts.fragments}</span> : null}</span>
              </button>
            </div>
          })}
        </div>)}
      </div>
      <section className={styles.agenda} aria-label={`${selectedDay.month}月${selectedDay.day}日 待办与记录`}>
        <h2 className={styles.dayHeading}>{heading}</h2>
        {!day?.todos.length && !day?.fragments.length ? <p className={styles.empty}>这天没有待办，也没有记录。</p> : <div className={styles.columns}>
          <div><h3 className={styles.columnHeading}>待办 {day?.todos.length ?? 0}</h3><ul className={styles.list}>{day?.todos.map((todo) => <TaskRow key={`${todo.fragment.id}:${todo.lineIndex}`} todo={todo} onToggleTask={onToggleTask} onOpenFragment={onOpenFragment} />)}</ul></div>
          <div><h3 className={styles.columnHeading}>碎片 {day?.fragments.length ?? 0}</h3><ul className={styles.list}>{day?.fragments.map((fragment) => <li key={fragment.id}><button type="button" className={styles.fragmentRow} onClick={() => onOpenFragment(fragment.id)}><time>{new Date(fragment.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time><span>{summary(fragment.content)}</span></button></li>)}</ul></div>
        </div>}
      </section>
    </div>
  </div>
}
