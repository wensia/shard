import { describe, expect, it } from "vitest"

import { extractTextPreview } from "@/lib/library-preview"

describe("extractTextPreview", () => {
  it("剥离文首 frontmatter", () => {
    expect(
      extractTextPreview(
        "---\ntitle: 项目计划\ntags:\n  - 工作\n---\n# 项目计划\n第一步"
      )
    ).toEqual(["# 项目计划", "第一步"])
  })

  it("跳过空行、截断超长行并将行数封顶为六行", () => {
    const longLine = "一".repeat(41)
    expect(
      extractTextPreview(
        ["", "第一行", "   ", longLine, "第三行", "第四行", "第五行", "第六行", "第七行"].join(
          "\n"
        )
      )
    ).toEqual([
      "第一行",
      "一".repeat(40),
      "第三行",
      "第四行",
      "第五行",
      "第六行",
    ])
  })

  it("内容为空时返回空数组", () => {
    expect(extractTextPreview("\n  \r\n")).toEqual([])
  })
})
