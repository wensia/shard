import { describe, expect, it } from "vitest"

import {
  collectReminderDueTimes,
  formatReminderLabel,
  isReminderDue,
  reminderQuickOptions,
  splitReminderAt,
} from "@/lib/reminders"
import type { Fragment } from "@/types"

function fragment(id: string, content: string, patch: Partial<Fragment> = {}): Fragment {
  return {
    id,
    content,
    kind: "fragment",
    createdAt: "2026-09-25T00:00:00Z",
    updatedAt: "2026-09-25T00:00:00Z",
    tags: [],
    category: null,
    path: `fragments/${id}.md`,
    gitStatus: "saved",
    error: null,
    archived: false,
    lockbox: false,
    pinned: false,
    ...patch,
  }
}

const local = (month: number, day: number, hour: number) => new Date(2026, month - 1, day, hour, 0).getTime()

describe("提醒展示辅助", () => {
  it("今年省略年份，跨年带年份", () => {
    const now = new Date(2026, 8, 25)
    expect(formatReminderLabel("2026-10-01 09:00", now)).toBe("10月1日 09:00")
    expect(formatReminderLabel("2027-01-02 18:30", now)).toBe("2027年1月2日 18:30")
  })

  it.each([
    [new Date(2026, 8, 25, 10), "2026-09-25 18:00", "2026-09-26 09:00", "2026-09-28 09:00"],
    [new Date(2026, 8, 28, 10), "2026-09-28 18:00", "2026-09-29 09:00", "2026-10-05 09:00"],
    [new Date(2026, 8, 27, 10), "2026-09-27 18:00", "2026-09-28 09:00", "2026-09-28 09:00"],
    [new Date(2026, 11, 31, 10), "2026-12-31 18:00", "2027-01-01 09:00", "2027-01-04 09:00"],
  ])("快捷项：%s", (now, today, tomorrow, monday) => {
    expect(reminderQuickOptions(now).map((option) => option.at)).toEqual([today, tomorrow, monday])
  })

  it("拆分日期与时间，非法值返回空", () => {
    expect(splitReminderAt("2026-10-01 09:00")).toEqual({ date: "2026-10-01", time: "09:00" })
    expect(splitReminderAt("2026-02-30 09:00")).toEqual({ date: "", time: "" })
    expect(splitReminderAt(null)).toEqual({ date: "", time: "" })
  })

  it("到点判定", () => {
    expect(isReminderDue("2026-10-01 09:00", local(10, 1, 9))).toBe(true)
    expect(isReminderDue("2026-10-01 09:00", local(10, 1, 8))).toBe(false)
    expect(isReminderDue("非法", local(10, 1, 9))).toBe(false)
  })
})

describe("collectReminderDueTimes", () => {
  it("只汇总公开、未归档、非冲突副本里的未勾选提醒，并按时间排序", () => {
    const fragments = [
      fragment("a", "- [ ] 甲 ⏰ 2026-10-03 09:00\n- [x] 乙 ⏰ 2026-10-01 09:00"),
      fragment("b", "- [ ] 丙 ⏰ 2026-10-02 09:00"),
      fragment("locked", "- [ ] 密 ⏰ 2026-10-01 09:00", { lockbox: true }),
      fragment("trash", "- [ ] 废 ⏰ 2026-10-01 09:00", { archived: true }),
      fragment("copy", "- [ ] 丙 ⏰ 2026-10-02 09:00", { conflictOf: "b" }),
      fragment("plain", "没有提醒"),
    ]
    expect(collectReminderDueTimes(fragments)).toEqual([local(10, 2, 9), local(10, 3, 9)])
  })

  it("按正文缓存解析结果，内容变化后重新解析、删除后清理", () => {
    const cache = new Map<string, { content: string; dueAt: number[] }>()
    collectReminderDueTimes([fragment("a", "- [ ] 甲 ⏰ 2026-10-03 09:00")], cache)
    expect(cache.get("a")?.dueAt).toEqual([local(10, 3, 9)])

    expect(collectReminderDueTimes([fragment("a", "- [x] 甲 ⏰ 2026-10-03 09:00")], cache)).toEqual([])
    expect(cache.get("a")?.dueAt).toEqual([])

    collectReminderDueTimes([], cache)
    expect(cache.size).toBe(0)
  })
})
