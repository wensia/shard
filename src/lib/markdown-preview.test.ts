import { describe, expect, it } from "vitest"

import {
  parseMarkdownPreview,
  stripInlineMarkdown,
} from "@/lib/markdown-preview"

describe("stripInlineMarkdown", () => {
  it("剥掉强调、高亮、行内代码与删除线，只留要读的字", () => {
    expect(stripInlineMarkdown("**粗** *斜* ==高亮== `代码` ~~删~~")).toBe(
      "粗 斜 高亮 代码 删"
    )
  })

  it("链接与 wikilink 只留显示文字", () => {
    expect(stripInlineMarkdown("看 [文档](https://x.dev) 和 [[项目笔记]]")).toBe(
      "看 文档 和 项目笔记"
    )
    expect(stripInlineMarkdown("[[项目笔记|计划]]")).toBe("计划")
  })

  it("剥掉标签", () => {
    expect(stripInlineMarkdown("整理会议纪要 #工作 #待办")).toBe("整理会议纪要")
  })

  it("下划线出现在词中间时不当作强调", () => {
    expect(stripInlineMarkdown("文件名 my_file_name.md")).toBe(
      "文件名 my_file_name.md"
    )
  })
})

describe("parseMarkdownPreview", () => {
  it("标题不再带 # 号，并保留层级", () => {
    expect(parseMarkdownPreview("# 未命名\n## 小节")).toEqual([
      { kind: "heading", level: 1, text: "未命名" },
      { kind: "heading", level: 2, text: "小节" },
    ])
  })

  it("认得任务、列表与引用", () => {
    expect(
      parseMarkdownPreview("- [ ] 待办\n- [x] 已完成\n- 普通项\n> 引用")
    ).toEqual([
      { checked: false, kind: "task", text: "待办" },
      { checked: true, kind: "task", text: "已完成" },
      { kind: "bullet", text: "普通项" },
      { kind: "quote", text: "引用" },
    ])
  })

  it("剥掉 frontmatter 与空行", () => {
    expect(
      parseMarkdownPreview("---\ntitle: 计划\n---\n\n正文\n\n\n第二段")
    ).toEqual([
      { kind: "text", text: "正文" },
      { kind: "text", text: "第二段" },
    ])
  })

  it("代码围栏折成一个块，不把代码逐行铺开", () => {
    expect(
      parseMarkdownPreview("```ts\nconst a = 1\nconst b = 2\n```\n收尾")
    ).toEqual([
      { kind: "code", label: "ts" },
      { kind: "text", text: "收尾" },
    ])
  })

  it("连续表格行只记一个表格块", () => {
    expect(
      parseMarkdownPreview("| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |")
    ).toEqual([{ kind: "table" }])
  })

  it("按 limit 封顶", () => {
    expect(parseMarkdownPreview("一\n二\n三\n四", 2)).toEqual([
      { kind: "text", text: "一" },
      { kind: "text", text: "二" },
    ])
  })

  it("内容为空时返回空数组", () => {
    expect(parseMarkdownPreview("\n  \r\n")).toEqual([])
  })
})
