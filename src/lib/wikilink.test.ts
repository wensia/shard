import { describe, expect, it } from "vitest"

import { buildCsvWikilinkCandidates, parseWikilinks } from "@/lib/wikilink"

describe("parseWikilinks", () => {
  it("解析目标与别名", () => {
    expect(parseWikilinks("见 [[项目计划]] 和 [[碎片-42|原始记录]]。"))
      .toEqual([
        { from: 2, target: "项目计划", to: 10 },
        { alias: "原始记录", from: 13, target: "碎片-42", to: 27 },
      ])
  })

  it("保留每一次重复出现及其精确范围", () => {
    const content = "[[同一页]] / [[同一页]]"

    expect(parseWikilinks(content)).toEqual([
      { from: 0, target: "同一页", to: 7 },
      { from: 10, target: "同一页", to: 17 },
    ])
  })

  it("支持文件名并裁剪目标和别名两侧空白", () => {
    expect(parseWikilinks("[[ notes/roadmap.md | 路线图 ]]"))
      .toEqual([
        {
          alias: "路线图",
          from: 0,
          target: "notes/roadmap.md",
          to: 28,
        },
      ])
  })

  it.each([
    "[[ ]]",
    "[[target| ]]",
    "[[未闭合",
    "[单括号]",
  ])("忽略无效语法：%s", (content) => {
    expect(parseWikilinks(content)).toEqual([])
  })

  it("只把带 ! 前缀的 CSV wikilink 识别为嵌入", () => {
    expect(parseWikilinks("![[data/report.csv]] 和 [[data/report.csv]] 与 ![[note.md]]"))
      .toEqual([
        { embed: true, from: 0, target: "data/report.csv", to: 20 },
        { from: 23, target: "data/report.csv", to: 42 },
        { from: 46, target: "note.md", to: 57 },
      ])
  })
})

describe("buildCsvWikilinkCandidates", () => {
  it("用相对路径消歧，同时允许文件名匹配", () => {
    expect(buildCsvWikilinkCandidates([{ name: "report.csv", path: "data/report.csv" }]))
      .toEqual([
        {
          kind: "csv",
          label: "report.csv",
          matchKeys: ["data/report.csv", "report.csv"],
          path: "data/report.csv",
          target: "data/report.csv",
        },
      ])
  })
})
