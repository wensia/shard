import { describe, expect, it } from "vitest"

import { formatSyncedAgo } from "@/lib/relative-time"

const NOW = Date.parse("2026-09-02T12:00:00.000Z")
const ago = (ms: number) => formatSyncedAgo(NOW - ms, NOW)

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe("formatSyncedAgo", () => {
  it("一分钟内都算刚刚", () => {
    expect(ago(0)).toBe("刚刚同步")
    expect(ago(59 * SECOND)).toBe("刚刚同步")
  })

  it("分钟档", () => {
    expect(ago(MINUTE)).toBe("1 分钟前同步")
    expect(ago(59 * MINUTE)).toBe("59 分钟前同步")
  })

  it("小时档", () => {
    expect(ago(HOUR)).toBe("1 小时前同步")
    expect(ago(23 * HOUR)).toBe("23 小时前同步")
  })

  it("天档", () => {
    expect(ago(DAY)).toBe("1 天前同步")
    expect(ago(9 * DAY)).toBe("9 天前同步")
  })

  it("时钟回拨导致的未来时间戳按刚刚处理，不出现负数", () => {
    expect(formatSyncedAgo(NOW + 5 * MINUTE, NOW)).toBe("刚刚同步")
  })
})
