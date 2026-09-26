import { describe, expect, it } from "vitest"
import { addDays, daysBetween, formatDateKey, startOfLocalDay } from "@/lib/local-date"
import { nextDayForKey } from "@/components/ui/calendar"

describe("本地日期工具", () => {
  it("跨夏令时仍按日推进，热力图日期键保持本地日", () => {
    const start = new Date(2026, 2, 28, 23, 30)
    expect(formatDateKey(startOfLocalDay(start))).toBe("2026-03-28")
    expect(formatDateKey(addDays(startOfLocalDay(start), 2))).toBe("2026-03-30")
    expect(daysBetween(startOfLocalDay(start), addDays(startOfLocalDay(start), 2))).toBe(2)
  })

  it("月历键盘移动沿用日历控件计算", () => {
    expect(nextDayForKey("ArrowRight", { year: 2026, month: 9, day: 30 }, false)).toEqual({ year: 2026, month: 10, day: 1 })
    expect(nextDayForKey("PageDown", { year: 2026, month: 1, day: 31 }, false)).toEqual({ year: 2026, month: 2, day: 28 })
    expect(nextDayForKey("Enter", { year: 2026, month: 9, day: 30 }, false)).toBeUndefined()
  })
})
