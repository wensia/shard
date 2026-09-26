import { describe, expect, it } from "vitest"

import {
  collectTaskReminders,
  collectTaskItems,
  findReminderRanges,
  formatReminder,
  parseReminderAt,
  REMINDER_PATTERN,
  splitTaskReminder,
} from "@shard/markdown/core"
import { toggleTaskLine } from "@/lib/editor-format"

const local = (year: number, month: number, day: number, hour: number, minute: number) =>
  new Date(year, month - 1, day, hour, minute).getTime()

describe("提醒写法解析", () => {
  it("按本地时区解析 YYYY-MM-DD HH:mm", () => {
    expect(parseReminderAt("2026-10-01 09:00")).toBe(local(2026, 10, 1, 9, 0))
    expect(parseReminderAt("2024-02-29 23:59")).toBe(local(2024, 2, 29, 23, 59))
  })

  it.each([
    "2026-02-30 09:00",
    "2026-13-01 09:00",
    "2026-00-10 09:00",
    "2026-10-01 24:00",
    "2026-10-01 09:60",
    "2026-10-1 09:00",
    "2026-10-01T09:00",
    "0000-01-01 00:00",
  ])("非法日期返回 null：%s", (text) => {
    expect(parseReminderAt(text)).toBeNull()
  })

  it("formatReminder 与 parseReminderAt 互逆", () => {
    const date = new Date(2026, 0, 5, 7, 3)
    expect(formatReminder(date)).toBe("2026-01-05 07:03")
    expect(parseReminderAt(formatReminder(date))).toBe(date.getTime())
  })

  it("只认单个半角空格分隔，非法日期不产出范围", () => {
    expect(REMINDER_PATTERN.test("⏰ 2026-10-01 09:00")).toBe(true)
    expect(findReminderRanges("⏰\t2026-10-01 09:00")).toEqual([])
    expect(findReminderRanges("⏰ 2026-10-01\n09:00")).toEqual([])
    const text = "a ⏰ 2026-02-30 09:00 b ⏰ 2026-10-01 09:00 c"
    const start = text.lastIndexOf("⏰")
    expect(findReminderRanges(text)).toEqual([
      { start, end: start + "⏰ 2026-10-01 09:00".length, at: "2026-10-01 09:00" },
    ])
  })
})

describe("collectTaskReminders", () => {
  it("返回首行标题和可用于勾选的真实行号", () => {
    const source = [
      "前置段落",
      "",
      "- [ ] 父项 ⏰ 2026-10-01 09:00",
      "  - [ ] 子项 ⏰ 2026-10-02 10:00",
      "- [x] 已完成 ⏰ 2026-10-03 11:00",
    ].join("\n")
    const items = collectTaskItems(source)
    expect(items.map(({ lineIndex, text, checked }) => ({ lineIndex, text, checked }))).toEqual([
      { lineIndex: 2, text: "父项", checked: false },
      { lineIndex: 3, text: "子项", checked: false },
      { lineIndex: 4, text: "已完成", checked: true },
    ])
    expect(toggleTaskLine(source, items[1].lineIndex).split("\n")[3]).toContain("- [x] 子项")
  })

  it("区分勾选与未勾选", () => {
    const source = [
      "- [ ] 买菜 ⏰ 2026-10-01 09:00",
      "  番茄、鸡蛋、葱",
      "- [x] 交房租 ⏰ 2026-09-01 10:30",
    ].join("\n")
    expect(collectTaskReminders(source)).toEqual([
      { at: "2026-10-01 09:00", dueAt: local(2026, 10, 1, 9, 0), checked: false },
      { at: "2026-09-01 10:30", dueAt: local(2026, 9, 1, 10, 30), checked: true },
    ])
  })

  it("嵌套子任务各自计数，父任务不重复计入子任务的提醒", () => {
    const source = [
      "- [ ] 父任务",
      "  - [ ] 子任务 ⏰ 2026-10-02 08:00",
      "- [ ] 另一项 ⏰ 2026-10-03 08:00",
      "  - [x] 已完成子项 ⏰ 2026-10-04 08:00",
    ].join("\n")
    expect(collectTaskReminders(source).map((item) => [item.at, item.checked])).toEqual([
      ["2026-10-02 08:00", false],
      ["2026-10-03 08:00", false],
      ["2026-10-04 08:00", true],
    ])
  })

  it("非法日期、非任务项、代码与标签里的写法都不算", () => {
    const source = [
      "⏰ 2026-10-01 09:00 普通段落",
      "- 普通列表 ⏰ 2026-10-01 09:00",
      "- [ ] 非法 ⏰ 2026-02-30 09:00",
      "- [ ] 代码 `⏰ 2026-10-01 09:00`",
      "- [ ] 标签 #x⏰ 2026-10-01 09:00",
      "- [ ] 双链 [[⏰ 2026-10-01 09:00]]",
    ].join("\n")
    expect(collectTaskReminders(source)).toEqual([])
  })

  it("多张卡片与细节段落：只认标题段里的提醒，每张卡片只取第一个", () => {
    const source = [
      "- [ ] 卡片一 ⏰ 2026-10-01 09:00 ⏰ 2026-10-05 09:00",
      "",
      "  细节里的 ⏰ 2026-12-01 09:00 不算",
      "- [ ] 卡片二 ⏰ 2026-10-06 18:00",
      "  续行细节",
    ].join("\n")
    expect(collectTaskReminders(source).map((item) => item.at)).toEqual([
      "2026-10-01 09:00",
      "2026-10-06 18:00",
    ])
  })

  it("引用块内的任务项", () => {
    const source = "> - [ ] 引用里的任务 ⏰ 2026-10-01 09:00\n> - [X] 完成 ⏰ 2026-10-02 09:00"
    expect(collectTaskReminders(source).map((item) => [item.at, item.checked])).toEqual([
      ["2026-10-01 09:00", false],
      ["2026-10-02 09:00", true],
    ])
  })

  it("有序任务项", () => {
    expect(collectTaskReminders("1. [ ] 有序 ⏰ 2026-10-01 09:00")).toHaveLength(1)
  })

  it("没有 ⏰ 时不解析", () => {
    expect(collectTaskReminders("- [ ] 普通任务")).toEqual([])
  })
})

describe("splitTaskReminder", () => {
  it("拆出行尾提醒，连同分隔空格一起去掉", () => {
    expect(splitTaskReminder("去银行 ⏰ 2026-09-28 10:30")).toEqual({ body: "去银行", at: "2026-09-28 10:30" })
    expect(splitTaskReminder("⏰ 2026-09-28 10:30")).toEqual({ body: "", at: "2026-09-28 10:30" })
  })

  it("句中的提醒只留一个空格", () => {
    expect(splitTaskReminder("甲 ⏰ 2026-09-28 10:30 乙")).toEqual({ body: "甲 乙", at: "2026-09-28 10:30" })
  })

  it("非法日期、行内代码里的写法不拆", () => {
    expect(splitTaskReminder("非法 ⏰ 2026-02-30 09:00")).toBeNull()
    expect(splitTaskReminder("代码 `⏰ 2026-09-28 10:30`")).toBeNull()
    expect(splitTaskReminder("没有提醒")).toBeNull()
  })
})
