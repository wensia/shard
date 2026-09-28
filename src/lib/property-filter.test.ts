import { describe, expect, it } from "vitest"

import {
  compareDecimalText,
  matchesPropertyFilter,
  validatePropertyFilter,
  type PropertyFilter,
  type PropertyTypeEntries,
} from "./property-filter"
import type { Fragment, FragmentProperty } from "@/types"

const registry: PropertyTypeEntries = {
  文本: { type: "text" },
  链接: { type: "link" },
  数字: { type: "number" },
  日期: { type: "date" },
  时间: { type: "datetime" },
  勾选: { type: "checkbox" },
  未勾选: { type: "checkbox" },
  列表: { type: "list" },
  错配数字: { type: "number" },
  复杂: { type: "text" },
}

const properties: FragmentProperty[] = [
  { key: "文本", value: { kind: "text", text: "Alpha 张三" }, editable: true },
  { key: "链接", value: { kind: "text", text: "[[Project Alpha]]" }, editable: true },
  { key: "数字", value: { kind: "number", text: "5.00" }, editable: true },
  { key: "日期", value: { kind: "text", text: "2026-09-28" }, editable: true },
  { key: "时间", value: { kind: "text", text: "2026-09-28T09:30+08:00" }, editable: true },
  { key: "勾选", value: { kind: "bool", value: true }, editable: true },
  { key: "未勾选", value: { kind: "bool", value: false }, editable: true },
  { key: "列表", value: { kind: "list", items: ["甲", "乙项"] }, editable: true },
  { key: "空文本", value: { kind: "text", text: "" }, editable: true },
  { key: "空列表", value: { kind: "list", items: [] }, editable: true },
  { key: "空值", value: { kind: "null" }, editable: true },
  { key: "错配数字", value: { kind: "text", text: "abc" }, editable: true },
  { key: "复杂", value: { kind: "other", raw: "nested: true" }, editable: false },
]

const fragment: Fragment = {
  id: "property-fragment",
  content: "属性筛选样本",
  kind: "fragment",
  createdAt: "2026-09-28T08:00:00Z",
  updatedAt: "2026-09-28T08:00:00Z",
  tags: ["inbox", "样本"],
  category: null,
  path: "fragments/2026/09/property-fragment.md",
  gitStatus: "saved",
  error: null,
  archived: false,
  lockbox: false,
  pinned: true,
  properties,
}

function matches(filter: PropertyFilter) {
  return matchesPropertyFilter(fragment, filter, registry)
}

describe("property filters", () => {
  it("handles every common operator without treating missing as empty", () => {
    expect(matches({ key: "文本", op: "exists" })).toBe(true)
    expect(matches({ key: "缺少", op: "exists" })).toBe(false)
    expect(matches({ key: "缺少", op: "missing" })).toBe(true)
    expect(matches({ key: "文本", op: "missing" })).toBe(false)
    for (const key of ["空文本", "空列表", "空值"]) {
      expect(matches({ key, op: "empty" })).toBe(true)
      expect(matches({ key, op: "notEmpty" })).toBe(false)
    }
    expect(matches({ key: "文本", op: "empty" })).toBe(false)
    expect(matches({ key: "文本", op: "notEmpty" })).toBe(true)
    expect(matches({ key: "缺少", op: "notEmpty" })).toBe(false)
    expect(matches({ key: "复杂", op: "exists" })).toBe(true)
    expect(matches({ key: "复杂", op: "notEmpty" })).toBe(true)
  })

  it("matches text and links while only contains ignores case", () => {
    expect(matches({ key: "文本", op: "equals", value: "Alpha 张三" })).toBe(true)
    expect(matches({ key: "文本", op: "equals", value: "alpha 张三" })).toBe(false)
    expect(matches({ key: "文本", op: "contains", value: "ALPHA" })).toBe(true)
    expect(matches({ key: "文本", op: "contains", value: "李四" })).toBe(false)
    expect(matches({ key: "链接", op: "equals", value: "[[Project Alpha]]" })).toBe(true)
    expect(matches({ key: "链接", op: "contains", value: "project" })).toBe(true)
    expect(matches({ key: "链接", op: "contains", value: "missing" })).toBe(false)
  })

  it("compares decimals exactly for every numeric operator", () => {
    const cases: Array<[PropertyFilter["op"], PropertyFilter["value"], boolean, PropertyFilter["value"]]> = [
      ["eq", "5.0", true, "5.1"],
      ["gt", "4.999", true, "5"],
      ["gte", "5.00", true, "5.01"],
      ["lt", "5.01", true, "5"],
      ["lte", "5.0", true, "4.99"],
      ["between", ["4.5", "5.0"], true, ["5.01", "6"]],
    ]
    for (const [op, value, expected, mismatch] of cases) {
      expect(matches({ key: "数字", op, value })).toBe(expected)
      expect(matches({ key: "数字", op, value: mismatch })).toBe(false)
    }
    expect(compareDecimalText("0.1", "0.10")).toBe(0)
    expect(compareDecimalText("-10.25", "-2.5")).toBeLessThan(0)
    expect(compareDecimalText("12345678901234567890", "12345678901234567889")).toBeGreaterThan(0)
    expect(compareDecimalText("1e3", "1000")).toBeNull()
    expect(matches({ key: "错配数字", op: "eq", value: "0" })).toBe(false)
    expect(matches({ key: "数字", op: "eq", value: "1e3" })).toBe(false)
  })

  it("matches date operators and inclusive ranges", () => {
    expect(matches({ key: "日期", op: "on", value: "2026-09-28" })).toBe(true)
    expect(matches({ key: "日期", op: "on", value: "2026-09-27" })).toBe(false)
    expect(matches({ key: "日期", op: "before", value: "2026-09-29" })).toBe(true)
    expect(matches({ key: "日期", op: "before", value: "2026-09-28" })).toBe(false)
    expect(matches({ key: "日期", op: "after", value: "2026-09-27" })).toBe(true)
    expect(matches({ key: "日期", op: "after", value: "2026-09-28" })).toBe(false)
    expect(matches({ key: "日期", op: "between", value: ["2026-09-28", "2026-09-30"] })).toBe(true)
    expect(matches({ key: "日期", op: "between", value: ["2026-09-29", "2026-09-30"] })).toBe(false)
  })

  it("compares datetimes by their literal minute prefix", () => {
    expect(matches({ key: "时间", op: "before", value: "2026-09-28T09:31" })).toBe(true)
    expect(matches({ key: "时间", op: "before", value: "2026-09-28T09:30" })).toBe(false)
    expect(matches({ key: "时间", op: "after", value: "2026-09-28T09:29" })).toBe(true)
    expect(matches({ key: "时间", op: "after", value: "2026-09-28T09:30" })).toBe(false)
    expect(matches({ key: "时间", op: "between", value: ["2026-09-28T09:30", "2026-09-28T10:00"] })).toBe(true)
    expect(matches({ key: "时间", op: "between", value: ["2026-09-28T08:00", "2026-09-28T09:29"] })).toBe(false)
    const invalid = { ...fragment, properties: [{ key: "时间", value: { kind: "text" as const, text: "2026-13-40T99:99+08:00" }, editable: true }] }
    expect(matchesPropertyFilter(invalid, { key: "时间", op: "before", value: "2027-01-01T00:00" }, registry)).toBe(false)
  })

  it("matches checkbox and list operators with exact list items", () => {
    expect(matches({ key: "勾选", op: "isTrue" })).toBe(true)
    expect(matches({ key: "勾选", op: "isFalse" })).toBe(false)
    expect(matches({ key: "未勾选", op: "isFalse" })).toBe(true)
    expect(matches({ key: "未勾选", op: "isTrue" })).toBe(false)
    expect(matches({ key: "列表", op: "includes", value: "乙项" })).toBe(true)
    expect(matches({ key: "列表", op: "includes", value: "乙" })).toBe(false)
  })

  it("keeps other and mismatched values out of typed comparisons", () => {
    expect(matches({ key: "复杂", op: "equals", value: "nested: true" })).toBe(false)
    expect(matches({ key: "错配数字", op: "gt", value: "0" })).toBe(false)
    expect(matchesPropertyFilter(fragment, { key: "数字", op: "equals", value: "5.00" }, {})).toBe(false)
  })

  it("rejects incomplete, reversed, and malformed filter operands", () => {
    expect(validatePropertyFilter({ key: "数字", op: "between", value: ["", "5"] }, "number")).toBe("请填写完整的范围。")
    expect(validatePropertyFilter({ key: "数字", op: "between", value: ["6", "5"] }, "number")).toBe("范围下限不能晚于或大于上限。")
    expect(validatePropertyFilter({ key: "数字", op: "eq", value: "1e3" }, "number")).toBe("数字格式无效。")
    expect(validatePropertyFilter({ key: "日期", op: "on", value: "2026-02-30" }, "date")).toBe("日期格式无效。")
    expect(validatePropertyFilter({ key: "时间", op: "after", value: "2026-09-28T25:00" }, "datetime")).toBe("日期时间格式无效。")
    expect(validatePropertyFilter({ key: "复杂", op: "equals", value: "x" }, "number")).toBe("当前属性类型不支持该运算。")
  })
})
