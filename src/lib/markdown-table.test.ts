import { describe, expect, it } from "vitest"

import { getFirstEditableTableOffset } from "@/lib/markdown-table"

describe("getFirstEditableTableOffset", () => {
  it("返回标题后第一张可编辑表格的字符偏移", () => {
    const markdown = [
      "## 采单安排",
      "",
      "| 日期 | 学校 |",
      "| --- | --- |",
      "| 2026-08-24 | 行知中学 |",
    ].join("\n")

    expect(getFirstEditableTableOffset(markdown)).toBe(markdown.indexOf("| 日期"))
  })

  it("没有表格时返回 null", () => {
    expect(getFirstEditableTableOffset("## 普通正文\n\n没有表格")).toBeNull()
  })
})
