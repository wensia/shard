import { describe, expect, it } from "vitest"
import { agendaDayCounts, buildCalendarAgenda, type AgendaCache } from "@/lib/calendar-agenda"
import type { Fragment } from "@/types"

function fragment(id: string, content: string, patch: Partial<Fragment> = {}): Fragment {
  return { id, content, kind: "fragment", createdAt: "2026-09-25T08:00:00", updatedAt: "2026-09-25T08:00:00", tags: [], category: null, path: `fragments/${id}.md`, gitStatus: "saved", error: null, archived: false, lockbox: false, pinned: false, ...patch }
}

describe("calendar agenda", () => {
  it("按创建日和提醒日分别分桶、排序，并排除私有与副本", () => {
    const agenda = buildCalendarAgenda([
      fragment("late", "- [ ] 晚 ⏰ 2026-09-26 19:00", { createdAt: "2026-09-25T19:00:00" }),
      fragment("early", "- [x] 早 ⏰ 2026-09-26 08:00", { createdAt: "2026-09-25T06:00:00" }),
      fragment("locked", "- [ ] 密 ⏰ 2026-09-26 07:00", { lockbox: true }),
      fragment("trash", "- [ ] 废 ⏰ 2026-09-26 07:00", { archived: true }),
      fragment("copy", "- [ ] 副 ⏰ 2026-09-26 07:00", { conflictOf: "late" }),
    ])
    expect(agenda.get("2026-09-25")?.fragments.map((item) => item.id)).toEqual(["early", "late"])
    expect(agenda.get("2026-09-26")?.todos.map((item) => item.text)).toEqual(["早", "晚"])
    expect(agendaDayCounts(agenda.get("2026-09-26"), new Date(2026, 8, 26, 19).getTime())).toEqual({ openTodos: 1, overdue: true, fragments: 0 })
    expect(agendaDayCounts(agenda.get("2026-09-26"), new Date(2026, 8, 26, 18).getTime()).overdue).toBe(false)
  })

  it("按正文复用缓存，改动及移除后更新", () => {
    const cache: AgendaCache = new Map()
    const source = fragment("a", "- [ ] 甲 ⏰ 2026-09-26 09:00")
    buildCalendarAgenda([source], cache)
    const items = cache.get("a")?.items
    buildCalendarAgenda([source], cache)
    expect(cache.get("a")?.items).toBe(items)
    buildCalendarAgenda([{ ...source, content: "- [x] 甲 ⏰ 2026-09-26 09:00" }], cache)
    expect(cache.get("a")?.items).not.toBe(items)
    buildCalendarAgenda([], cache)
    expect(cache.size).toBe(0)
  })
})
