import { describe, expect, it } from "vitest"

import {
  SLASH_COMMANDS,
  filterSlashCommands,
  getActiveSlashCommand,
  isContentTypeSlashCommand,
  isDocumentTierSlashCommand,
} from "@/lib/slash-commands"

describe("getActiveSlashCommand", () => {
  it.each([
    ["/", 1, 0, ""],
    ["/dt", 3, 0, "dt"],
    ["今天想写 /biao", 10, 5, "biao"],
    ["第一行\n/table", 10, 4, "table"],
  ])("行首或空白之后触发：%j", (value, cursor, slashStart, query) => {
    expect(getActiveSlashCommand(value, cursor)).toEqual({ query, slashStart })
  })

  it.each([
    ["https://example.com", 19],
    ["a/b", 3],
    ["/大纲 导图", 6],
    ["纯文本", 3],
  ])("路径、含空白 query 与无斜杠都不触发：%j", (value, cursor) => {
    expect(getActiveSlashCommand(value, cursor)).toBeNull()
  })

  it("query 超过 24 字符后放弃当作命令", () => {
    const value = `/${"a".repeat(25)}`
    expect(getActiveSlashCommand(value, value.length)).toBeNull()
    expect(getActiveSlashCommand(value.slice(0, 25), 25)).toEqual({
      query: "a".repeat(24),
      slashStart: 0,
    })
  })

  it("光标之前的斜杠才算数，忽略光标之后的文本", () => {
    expect(getActiveSlashCommand("/d 后面还有 /x", 2)).toEqual({
      query: "d",
      slashStart: 0,
    })
  })
})

describe("filterSlashCommands", () => {
  it("空 query 返回固定顺序的 18 项", () => {
    expect(filterSlashCommands("").map((command) => command.id)).toEqual([
      "mindmap",
      "task",
      "unordered",
      "ordered",
      "table",
      "divider",
      "tag",
      "image",
      "memo",
      "outline",
      "flowchart",
      "document",
      "heading1",
      "heading2",
      "heading3",
      "heading4",
      "quote",
      "codeblock",
    ])
    expect(SLASH_COMMANDS).toHaveLength(18)
  })

  it.each([
    ["dt", ["mindmap"]],
    ["导图", ["mindmap"]],
    ["导图块", ["mindmap"]],
    ["TABLE", ["table"]],
    ["bg", ["table"]],
    ["fgx", ["divider"]],
    ["bq", ["tag"]],
    ["tp", ["image"]],
    ["bwkp", ["memo"]],
    ["备忘", ["memo"]],
    ["memo", ["memo"]],
    ["card", ["memo"]],
    ["文档", ["document"]],
    ["wd", ["document"]],
    ["doc", ["document"]],
    // 围栏块改名「导图块」之后，`大纲` / `outline` / `dg` 只命中内容类型命令。
    ["大纲", ["outline"]],
    ["outline", ["outline"]],
    ["dg", ["outline"]],
    ["流程图", ["flowchart"]],
    ["lct", ["flowchart"]],
    ["flowchart", ["flowchart"]],
    ["标题", ["heading1", "heading2", "heading3", "heading4"]],
    ["h2", ["heading2"]],
    ["bt3", ["heading3"]],
    ["引用", ["quote"]],
    ["quote", ["quote"]],
    ["代码", ["codeblock"]],
    ["code", ["codeblock"]],
  ])("中英文与拼音首字母都能命中：%j", (query, ids) => {
    expect(filterSlashCommands(query).map((command) => command.id)).toEqual(ids)
  })

  it("无匹配时返回空数组", () => {
    expect(filterSlashCommands("zzz")).toEqual([])
  })
})

describe("isContentTypeSlashCommand", () => {
  it("大纲、流程图与文档是切换宿主创建模式的内容类型命令", () => {
    expect(isContentTypeSlashCommand("outline")).toBe(true)
    expect(isContentTypeSlashCommand("flowchart")).toBe(true)
    expect(isContentTypeSlashCommand("document")).toBe(true)
    expect(isContentTypeSlashCommand("image")).toBe(false)
  })
})

describe("isDocumentTierSlashCommand", () => {
  it("标题、引用、代码块只属于文档档", () => {
    expect(isDocumentTierSlashCommand("heading1")).toBe(true)
    expect(isDocumentTierSlashCommand("heading4")).toBe(true)
    expect(isDocumentTierSlashCommand("quote")).toBe(true)
    expect(isDocumentTierSlashCommand("codeblock")).toBe(true)
    expect(isDocumentTierSlashCommand("table")).toBe(false)
    expect(isDocumentTierSlashCommand("task")).toBe(false)
  })
})
