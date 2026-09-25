import { describe, expect, it } from "vitest"

import { getTagMarker, getTagRanges, type TagRange } from "@/lib/editor-format"

describe("getTagRanges golden cases", () => {
  it.each<[string, TagRange[]]>([
    ["#tag", [{ end: 4, start: 0, text: "#tag" }]],
    ["汉字#tag", [{ end: 6, start: 2, text: "#tag" }]],
    ["# 标题", []],
    ["http://x/#frag", []],
    ["```\n#x\n```", [{ end: 6, start: 4, text: "#x" }]],
    ["#a#b", [{ end: 2, start: 0, text: "#a" }]],
    ["#tag，", [{ end: 4, start: 0, text: "#tag" }]],
    ["#tag ", [{ end: 4, start: 0, text: "#tag" }]],
    ["(#tag)", [{ end: 5, start: 1, text: "#tag" }]],
    ["==#tag==", []],
    ["- [ ] #tag", [{ end: 10, start: 6, text: "#tag" }]],
    ["", []],
  ])("锁定 %#", (input, expected) => {
    expect(getTagRanges(input)).toEqual(expected)
  })
})

describe("getTagMarker", () => {
  it.each([
    ["", "#"],
    [" ", "#"],
    ["，", "#"],
    ["(", "#"],
    ["文", " #"],
    ["a", " #"],
    ["匣", " #"],
  ])("在 %j 之后插入标签写下 %j", (previous, expected) => {
    expect(getTagMarker(previous)).toBe(expected)
  })
})
