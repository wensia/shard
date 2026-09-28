import { describe, expect, it } from "vitest"

import {
  collectTagTopicBacklinks,
  collectTagTopicFragments,
  collectTagTopicPropertyColumns,
  countTagTopicKinds,
  formatTagTopicPropertyValue,
  sortTagTopicFragments,
} from "@/lib/tag-topic"
import type { Fragment, FragmentProperty, PropertyRegistry } from "@/types"

const registry: PropertyRegistry["properties"] = {
  日期: { type: "date" },
  完成: { type: "checkbox" },
  客户: { type: "text" },
  链接: { type: "link" },
  提醒: { type: "datetime" },
  清单: { type: "list" },
  金额: { type: "number" },
}

function fragment(
  id: string,
  properties: FragmentProperty[] = [],
  tags: string[] = ["inbox", "项目"]
): Fragment {
  return {
    archived: false,
    category: null,
    content: id,
    createdAt: `2026-09-${id.padStart(2, "0")}T08:00:00.000Z`,
    error: null,
    gitStatus: "committed",
    id,
    kind: tags.includes("document") ? "document" : tags.includes("outline") ? "outline" : tags.includes("flowchart") ? "flowchart" : "fragment",
    lockbox: false,
    path: `fragments/${id}.md`,
    pinned: false,
    properties,
    related: [],
    tags,
    updatedAt: `2026-09-${id.padStart(2, "0")}T09:00:00.000Z`,
  }
}

describe("标签主题页数据", () => {
  it("只收集公开未删除的标签内容并统计四种类型", () => {
    const items = [
      fragment("01"),
      fragment("02", [], ["inbox", "项目", "outline"]),
      fragment("03", [], ["inbox", "项目", "flowchart"]),
      fragment("04", [], ["inbox", "项目", "document"]),
      { ...fragment("05"), archived: true },
      { ...fragment("06"), lockbox: true },
      fragment("07", [], ["inbox", "别的标签"]),
    ]

    const topic = collectTagTopicFragments(items, "项目")
    expect(topic.map((item) => item.id)).toEqual(["01", "02", "03", "04"])
    expect(countTagTopicKinds(topic)).toEqual({
      document: 1,
      flowchart: 1,
      fragment: 1,
      outline: 1,
    })
  })

  it("属性列按出现次数降序、同次数按键名排序", () => {
    const items = [
      fragment("01", [
        { key: "客户", value: { kind: "text", text: "甲" }, editable: true },
        { key: "金额", value: { kind: "number", text: "2" }, editable: true },
      ]),
      fragment("02", [
        { key: "客户", value: { kind: "text", text: "乙" }, editable: true },
        { key: "日期", value: { kind: "text", text: "2026-09-28" }, editable: true },
      ]),
      fragment("03", [
        { key: "金额", value: { kind: "number", text: "10" }, editable: true },
        { key: "完成", value: { kind: "bool", value: true }, editable: true },
      ]),
    ]

    expect(collectTagTopicPropertyColumns(items, registry)).toEqual([
      { count: 2, key: "金额", type: "number" },
      { count: 2, key: "客户", type: "text" },
      { count: 1, key: "日期", type: "date" },
      { count: 1, key: "完成", type: "checkbox" },
    ])
  })

  it("格式化文本、数字、勾选、列表、other 与空值", () => {
    expect(formatTagTopicPropertyValue({ kind: "text", text: "甲" })).toEqual({ kind: "text", text: "甲" })
    expect(formatTagTopicPropertyValue({ kind: "number", text: "1.50" })).toEqual({ kind: "number", text: "1.50" })
    expect(formatTagTopicPropertyValue({ kind: "bool", value: true })).toEqual({ checked: true, kind: "checkbox", text: "已勾选" })
    expect(formatTagTopicPropertyValue({ kind: "list", items: ["甲", "乙"] })).toEqual({ items: ["甲", "乙"], kind: "list", text: "甲、乙" })
    expect(formatTagTopicPropertyValue({ kind: "other", raw: "nested: true" })).toEqual({ kind: "other", text: "nested: true" })
    expect(formatTagTopicPropertyValue(undefined)).toEqual({ kind: "empty", text: "" })
  })

  it("数字精确排序，类型不符与缺值始终排在最后", () => {
    const items = [
      fragment("01", [{ key: "金额", value: { kind: "number", text: "12345678901234567890" }, editable: true }]),
      fragment("02", [{ key: "金额", value: { kind: "number", text: "2" }, editable: true }]),
      fragment("03", [{ key: "金额", value: { kind: "text", text: "9" }, editable: true }]),
      fragment("04"),
    ]

    expect(sortTagTopicFragments(items, { key: "property:金额", direction: "asc" }, registry).map((item) => item.id)).toEqual(["02", "01", "03", "04"])
    expect(sortTagTopicFragments(items, { key: "property:金额", direction: "desc" }, registry).map((item) => item.id)).toEqual(["01", "02", "03", "04"])
  })

  it("日期、日期时间、勾选、列表、链接与文本列按登记类型排序", () => {
    const items = [
      fragment("01", [
        { key: "日期", value: { kind: "text", text: "2026-09-29" }, editable: true },
        { key: "提醒", value: { kind: "text", text: "2026-09-28T10:00:30.000+08:00" }, editable: true },
        { key: "完成", value: { kind: "bool", value: true }, editable: true },
        { key: "清单", value: { kind: "list", items: ["乙"] }, editable: true },
        { key: "客户", value: { kind: "text", text: "乙" }, editable: true },
        { key: "链接", value: { kind: "text", text: "[[乙]]" }, editable: true },
      ]),
      fragment("02", [
        { key: "日期", value: { kind: "text", text: "2026-09-28" }, editable: true },
        { key: "提醒", value: { kind: "text", text: "2026-09-28T09:00:15Z" }, editable: true },
        { key: "完成", value: { kind: "bool", value: false }, editable: true },
        { key: "清单", value: { kind: "list", items: ["甲"] }, editable: true },
        { key: "客户", value: { kind: "text", text: "甲" }, editable: true },
        { key: "链接", value: { kind: "text", text: "[[甲]]" }, editable: true },
      ]),
    ]

    for (const key of ["日期", "提醒", "完成", "清单", "客户", "链接"]) {
      expect(sortTagTopicFragments(items, { key: `property:${key}`, direction: "asc" }, registry).map((item) => item.id)).toEqual(["02", "01"])
    }
  })

  it("聚合不带主题标签的公开 wikilink 引用者并去重", () => {
    const target = fragment("01")
    const relation = {
      createdAt: "2026-09-28T10:00:00.000Z",
      origin: "wikilink" as const,
      targetId: target.id,
    }
    const noteSource = {
      ...fragment("02", [], ["note", "资料"]),
      related: [relation, relation],
    }
    const taggedSource = { ...fragment("03"), related: [relation] }
    const manualSource = {
      ...fragment("04", [], ["inbox", "资料"]),
      related: [{ ...relation, origin: "manual" as const }],
    }
    const archivedSource = {
      ...fragment("05", [], ["inbox", "资料"]),
      archived: true,
      related: [relation],
    }

    expect(collectTagTopicBacklinks(
      [target, noteSource, taggedSource, manualSource, archivedSource],
      [target],
      "项目"
    ).map((item) => item.id)).toEqual(["02"])
  })
})
