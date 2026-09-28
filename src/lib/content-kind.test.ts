import { describe, expect, it } from "vitest"

import {
  applyTypeTag,
  countPlainTextCharacters,
  deriveDocumentDigest,
  deriveKind,
  deriveNoteTitle,
  isStreamKind,
  isTypeTag,
  stripProtectedTypeTags,
  TYPE_TAGS,
} from "@/lib/content-kind"

describe("content kind", () => {
  it("type 标签顺序与后端冲突优先级一致", () => {
    expect(TYPE_TAGS).toEqual(["note", "outline", "flowchart", "document"])
    expect(isTypeTag("note")).toBe(true)
    expect(isTypeTag("outline")).toBe(true)
    expect(isTypeTag("flowchart")).toBe(true)
    expect(isTypeTag("document")).toBe(true)
    expect(isTypeTag("project")).toBe(false)
  })

  it("从 tags 派生内容类型，缺省为碎片", () => {
    expect(deriveKind([])).toBe("fragment")
    expect(deriveKind(["inbox", "灵感"])).toBe("fragment")
    expect(deriveKind(["inbox", "note", "灵感"])).toBe("note")
    expect(deriveKind(["inbox", "outline"])).toBe("outline")
    expect(deriveKind(["inbox", "flowchart"])).toBe("flowchart")
    expect(deriveKind(["inbox", "document"])).toBe("document")
    expect(deriveKind(["document", "flowchart", "note"])).toBe("note")
  })

  it("受保护类型只由当前专用类型保留", () => {
    expect(stripProtectedTypeTags(["inbox", "outline", "flowchart"], "fragment"))
      .toEqual(["inbox"])
    expect(stripProtectedTypeTags(["document", "outline"], "document"))
      .toEqual([])
    expect(stripProtectedTypeTags(["note", "flowchart", "topic"], "outline"))
      .toEqual(["topic", "outline"])
    expect(stripProtectedTypeTags(["outline", "document", "topic"], "flowchart"))
      .toEqual(["topic", "flowchart"])
  })

  it("type 是单值：写入一个 type 标签会摘掉其余 type 标签", () => {
    expect(applyTypeTag(["inbox", "灵感"], "outline")).toEqual([
      "inbox",
      "灵感",
      "outline",
    ])
    expect(applyTypeTag(["inbox", "outline", "灵感"], "document")).toEqual([
      "inbox",
      "灵感",
      "document",
    ])
    // 同一个 type 重复写入不会留下两份。
    expect(applyTypeTag(["inbox", "document"], "document")).toEqual([
      "inbox",
      "document",
    ])
  })

  it("碎片流承载碎片、大纲与文档，资料库笔记除外", () => {
    expect(isStreamKind("fragment")).toBe(true)
    expect(isStreamKind("outline")).toBe(true)
    expect(isStreamKind("flowchart")).toBe(true)
    expect(isStreamKind("document")).toBe(true)
    expect(isStreamKind("note")).toBe(false)
  })
})

describe("deriveDocumentDigest", () => {
  it("标题取首个标题行，摘要是标题之后的纯文本", () => {
    expect(
      deriveDocumentDigest("# 季度复盘\n\n**第一条**结论\n- 第二条结论")
    ).toEqual({ summary: "第一条结论 第二条结论", title: "季度复盘" })
  })

  it("没有标题行时用首行前 40 字作标题，余下作摘要", () => {
    const firstLine = "甲".repeat(52)
    expect(deriveDocumentDigest(`${firstLine}\n第二行`)).toEqual({
      summary: "第二行",
      title: `${"甲".repeat(40)}…`,
    })
  })

  it("摘要截到 120 字，围栏源码不进摘要", () => {
    const digest = deriveDocumentDigest(
      ["# 标题", "", "```js", "const a = 1", "```", "正文".repeat(100)].join("\n")
    )
    expect(digest.title).toBe("标题")
    expect(digest.summary).not.toContain("const a")
    expect(digest.summary).toBe(`${"正文".repeat(60)}…`)
  })

  it("空正文返回空标题与空摘要", () => {
    expect(deriveDocumentDigest(" \n\t")).toEqual({ summary: "", title: "" })
  })

  it("摘要隐藏硬换行标记但保留字面反斜杠", () => {
    expect(deriveDocumentDigest("# 标题\n正文\\\n下文\n字面\\\\\\\\")).toEqual({
      title: "标题",
      summary: "正文 下文 字面\\\\\\\\",
    })
  })
})

describe("deriveNoteTitle", () => {
  it("使用正文中首个 H1，并清理可选的闭合井号", () => {
    expect(
      deriveNoteTitle("开场\n\n## 二级标题\n# 笔记标题 #\n# 后续标题")
    ).toBe("笔记标题")
  })

  it("没有 H1 时回退到首个非空行", () => {
    expect(deriveNoteTitle("\n\n  一条简短的首行  \n第二行")).toBe(
      "一条简短的首行"
    )
  })

  it("把过长的回退标题截断到现有摘要长度", () => {
    const firstLine = "甲".repeat(52)
    expect(deriveNoteTitle(`${firstLine}\n第二行`)).toBe(
      `${"甲".repeat(48)}…`
    )
  })

  it("空内容返回空标题", () => {
    expect(deriveNoteTitle(" \n\t")).toBe("")
  })

  it("回退标题不显示硬换行标记", () => {
    expect(deriveNoteTitle("首行\\\n次行")).toBe("首行")
  })
})

describe("countPlainTextCharacters", () => {
  it("只数正文字符：标记、空白与换行都不计", () => {
    expect(
      countPlainTextCharacters("## 季度复盘\n\n**第一条**结论\n- 第二条")
    ).toBe(4 + 5 + 3)
  })

  it("围栏里的源码整段跳过", () => {
    expect(
      countPlainTextCharacters(["正文", "```js", "const a = 1", "```", "收尾"].join("\n"))
    ).toBe(4)
  })

  it("双链与图片按可见文字计数", () => {
    expect(countPlainTextCharacters("看 [[目标笔记]] 与 ![图](a.png)")).toBe(6)
  })

  it("空正文是零", () => {
    expect(countPlainTextCharacters(" \n\t")).toBe(0)
  })
})
