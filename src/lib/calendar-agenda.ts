import { collectTaskItems, type TaskItem } from "@shard/markdown/core"
import { formatDateKey } from "@/lib/local-date"
import type { Fragment } from "@/types"

export type AgendaTodo = { fragment: Fragment; lineIndex: number; text: string; at: string; dueAt: number; checked: boolean }
export type AgendaDay = { todos: AgendaTodo[]; fragments: Fragment[] }
export type AgendaCache = Map<string, { content: string; items: TaskItem[] }>

export function buildCalendarAgenda(
  fragments: readonly Fragment[],
  cache: AgendaCache = new Map()
): Map<string, AgendaDay> {
  const agenda = new Map<string, AgendaDay>()
  const seen = new Set<string>()
  const dayFor = (key: string) => {
    let day = agenda.get(key)
    if (!day) { day = { todos: [], fragments: [] }; agenda.set(key, day) }
    return day
  }
  for (const fragment of fragments) {
    if (fragment.archived || fragment.lockbox || fragment.conflictOf) continue
    const createdAt = new Date(fragment.createdAt)
    if (Number.isFinite(createdAt.getTime())) dayFor(formatDateKey(createdAt)).fragments.push(fragment)
    if (!fragment.content.includes("⏰")) continue
    seen.add(fragment.id)
    let cached = cache.get(fragment.id)
    if (!cached || cached.content !== fragment.content) {
      cached = { content: fragment.content, items: collectTaskItems(fragment.content) }
      cache.set(fragment.id, cached)
    }
    for (const item of cached.items) dayFor(item.at.slice(0, 10)).todos.push({ fragment, ...item })
  }
  for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id)
  for (const day of agenda.values()) {
    day.todos.sort((a, b) => a.dueAt - b.dueAt)
    day.fragments.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }
  return agenda
}

export function agendaDayCounts(day: AgendaDay | undefined, now: number): { openTodos: number; overdue: boolean; fragments: number } {
  const todos = day?.todos ?? []
  return {
    openTodos: todos.filter((todo) => !todo.checked).length,
    overdue: todos.some((todo) => !todo.checked && todo.dueAt <= now),
    fragments: day?.fragments.length ?? 0,
  }
}
