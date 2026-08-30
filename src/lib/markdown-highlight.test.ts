import { describe, expect, it } from "vitest"

import {
  findInlineHighlights,
  shardMarkdownParser,
} from "@/lib/markdown-highlight"

describe("findInlineHighlights", () => {
  it.each([
    ["==a==", [{ start: 0, end: 5, contentStart: 2, contentEnd: 3 }]],
    ["\\==a==", []],
    ["==a", []],
    ["`==a==`", []],
    ["==a\nb==", []],
    ["[==a==](u)", [{ start: 1, end: 6, contentStart: 3, contentEnd: 4 }]],
    ["**==a==**", [{ start: 2, end: 7, contentStart: 4, contentEnd: 5 }]],
    ["==**a**==", [{ start: 0, end: 9, contentStart: 2, contentEnd: 7 }]],
    ["====", []],
    ["==荧光==", [{ start: 0, end: 6, contentStart: 2, contentEnd: 4 }]],
    ["a==b==c", [{ start: 1, end: 6, contentStart: 3, contentEnd: 4 }]],
  ])("解析 %s", (text, expected) => {
    expect(findInlineHighlights(text)).toEqual(expected)
  })

  it.each([
    ["#tag", false],
    ["#汉字", false],
    ["# 标题", true],
  ])("ATX 标题边界：%s", (text, expected) => {
    const tree = shardMarkdownParser.parse(text)
    let hasAtxHeading = false
    const cursor = tree.cursor()
    do {
      if (cursor.name.startsWith("ATXHeading")) hasAtxHeading = true
    } while (cursor.next())
    expect(hasAtxHeading).toBe(expected)
  })
})
