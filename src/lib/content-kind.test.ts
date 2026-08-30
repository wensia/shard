import { describe, expect, it } from "vitest"

import {
  deriveKind,
  deriveNoteTitle,
  isTypeTag,
  TYPE_TAGS,
} from "@/lib/content-kind"

describe("content kind", () => {
  it("首期只把 note 识别为保留类型标签", () => {
    expect(TYPE_TAGS).toEqual(["note"])
    expect(isTypeTag("note")).toBe(true)
    expect(isTypeTag("project")).toBe(false)
  })

  it("从 tags 派生内容类型，缺省为碎片", () => {
    expect(deriveKind([])).toBe("fragment")
    expect(deriveKind(["inbox", "灵感"])).toBe("fragment")
    expect(deriveKind(["inbox", "note", "灵感"])).toBe("note")
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
})
