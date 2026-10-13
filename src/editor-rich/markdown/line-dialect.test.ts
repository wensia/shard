import { Node } from "@tiptap/pm/model"
import type { JSONContent } from "@tiptap/core"
import { describe, expect, it } from "vitest"

import { shardSchema } from "@/editor-rich/schema"

import { parseShardMarkdown } from "./parse"
import { serializeShardMarkdown } from "./serialize"

const text = (value: string, marks?: JSONContent["marks"]): JSONContent =>
  marks ? { type: "text", text: value, marks } : { type: "text", text: value }
const p = (...content: JSONContent[]): JSONContent =>
  content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" }
const line = (value: string) => p(text(value))
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content })

function parse(markdown: string) {
  return parseShardMarkdown(markdown).doc
}

function roundtrip(value: JSONContent) {
  const markdown = serializeShardMarkdown(value)
  expect(parse(markdown)).toEqual(value)
  expect(() => Node.fromJSON(shardSchema, value).check()).not.toThrow()
  return markdown
}

describe("方言 v2：源码一行显示一行，空一行显示一行空白", () => {
  it("段内软换行拆成一行一段，写回仍是相邻的行", () => {
    expect(parse("第一行\n第二行\n第三行")).toEqual(doc(line("第一行"), line("第二行"), line("第三行")))
    expect(roundtrip(doc(line("第一行"), line("第二行")))).toBe("第一行\n第二行")
  })

  it("标准 Markdown 的段落空行显示为一行空白，字节往返不变", () => {
    expect(parse("甲\n\n乙")).toEqual(doc(line("甲"), p(), line("乙")))
    expect(parse("甲\n\n\n乙")).toEqual(doc(line("甲"), p(), p(), line("乙")))
    expect(roundtrip(doc(line("甲"), p(), line("乙")))).toBe("甲\n\n乙")
  })

  it("硬换行不拆段", () => {
    const hard = doc(p(text("甲"), { type: "hardBreak" }, text("乙")))
    expect(parse("甲\\\n乙")).toEqual(hard)
    expect(parse("甲  \n乙")).toEqual(hard)
    expect(roundtrip(hard)).toBe("甲\\\n乙")
  })

  it("行尾空格写盘时去掉，不会被读成硬换行", () => {
    expect(serializeShardMarkdown(doc(line("甲  "), line("乙")))).toBe("甲\n乙")
  })

  it("跨行的行内标记拆到各行，行内代码里的换行不拆", () => {
    const bold = [{ type: "bold" }]
    expect(parse("**甲\n乙**")).toEqual(doc(p(text("甲", bold)), p(text("乙", bold))))
    expect(parse("`甲\n乙`")).toEqual(doc(p(text("甲\n乙", [{ type: "code" }]))))
  })

  it("段落与其他块之间：第一个空行是分隔符，多出来的才是空白行", () => {
    const heading = { type: "heading", attrs: { level: 1 }, content: [text("标题")] }
    const list = {
      type: "bulletList",
      content: [{ type: "listItem", content: [line("事项")] }],
    }
    expect(parse("甲\n\n# 标题")).toEqual(doc(line("甲"), heading))
    expect(parse("甲\n# 标题")).toEqual(doc(line("甲"), heading))
    expect(roundtrip(doc(line("甲"), p(), heading))).toBe("甲\n\n\n# 标题")
    expect(roundtrip(doc(heading, p(), line("甲")))).toBe("# 标题\n\n\n甲")
    expect(roundtrip(doc(heading, p(), list))).toBe("# 标题\n\n\n- 事项")
    expect(roundtrip(doc(heading, p(), p(), list))).toBe("# 标题\n\n\n\n- 事项")
    expect(roundtrip(doc(heading, list))).toBe("# 标题\n\n- 事项")
  })

  it("首尾的空白行不写盘", () => {
    expect(serializeShardMarkdown(doc(p(), line("甲"), p()))).toBe("甲")
  })

  it("引用块内部同样一行一段、空行显示", () => {
    const quote = (...content: JSONContent[]) => ({ type: "blockquote", content })
    expect(parse("> 甲\n> 乙")).toEqual(doc(quote(line("甲"), line("乙"))))
    expect(parse("> 甲\n>\n> 乙")).toEqual(doc(quote(line("甲"), p(), line("乙"))))
    expect(roundtrip(doc(quote(line("甲"), p(), line("乙"))))).toBe("> 甲\n>\n> 乙")
  })

  it("列表项内部保持原规则：懒续行仍是同一段里的换行", () => {
    expect(parse("- 甲\n  乙")).toEqual(
      doc({ type: "bulletList", content: [{ type: "listItem", content: [line("甲\n乙")] }] })
    )
  })

  it("单独一行的 csv 双链是嵌入块，与上一行相邻也一样", () => {
    const embed = { type: "csvEmbed", attrs: { path: "data/large.csv" } }
    expect(parse("下面是一张表：\n![[data/large.csv]]")).toEqual(doc(line("下面是一张表："), embed))
    expect(roundtrip(doc(line("下面是一张表："), embed))).toBe("下面是一张表：\n\n![[data/large.csv]]")
    expect(roundtrip(doc(line("下面是一张表："), p(), embed))).toBe("下面是一张表：\n\n\n![[data/large.csv]]")
  })

  describe("相邻的段落行不会拼成别的语法", () => {
    const tricky = [
      "---",
      "===",
      "- 事项",
      "+ 事项",
      "* 事项",
      "1. 事项",
      "1) 事项",
      "# 标题",
      "> 引用",
      "```",
      "~~~",
      "<div>",
      "<!-- 注释 -->",
      "| --- |",
      "|---|---|",
      "--- | ---",
      ":-- | --:",
      ":-:",
      "[a]: 目标",
      "[a]: <目标>",
    ]
    for (const second of tricky) {
      it(`第二行是 ${second}`, () => {
        roundtrip(doc(line("| 甲 | 乙 |"), line(second)))
        roundtrip(doc(line("普通的一行"), line(second)))
      })
    }
  })
})
