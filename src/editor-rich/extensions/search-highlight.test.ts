import { describe, expect, it } from "vitest"

import { parseShardMarkdown } from "@/editor-rich/markdown"
import { shardSchema } from "@/editor-rich/schema"

import { projectSearchHighlights } from "./search-highlight"

function doc(markdown: string) {
  return shardSchema.nodeFromJSON(parseShardMarkdown(markdown).doc)
}

describe("ProseMirror search highlight projection", () => {
  it("reveal_matches_across_inline_marks", () => {
    const result = projectSearchHighlights(
      doc("开头 **共同**词 结尾"),
      ["共同词"]
    )

    expect(result.matches).toHaveLength(1)
    const match = result.matches[0]
    expect(doc("开头 **共同**词 结尾").textBetween(match.from, match.to)).toBe(
      "共同词"
    )
  })

  it("reveal_does_not_cross_cells_or_atoms", () => {
    const table = doc([
      "| 第一列 | 第二列 |",
      "| --- | --- |",
      "| 共 | 同词 |",
    ].join("\n"))
    const atom = shardSchema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "共" },
            { type: "tag", attrs: { name: "边界" } },
            { type: "text", text: "同词" },
          ],
        },
      ],
    })

    expect(projectSearchHighlights(table, ["共同词"]).matches).toEqual([])
    expect(projectSearchHighlights(atom, ["共同词"]).matches).toEqual([])
  })

  it("code_and_embed_return_document_only", () => {
    const code = doc("```text\n只在代码块命中\n```")
    const embed = doc("![[数据.csv]]")

    expect(projectSearchHighlights(code, ["代码块命中"])).toMatchObject({
      excludedReason: "codeBlock",
      matches: [],
    })
    expect(projectSearchHighlights(embed, ["数据.csv"])).toMatchObject({
      excludedReason: "embed",
      matches: [],
    })
  })

  it("keeps normalized full-width and emoji offsets in PM coordinates", () => {
    const source = doc("前ＡＢＣ😀后")
    const result = projectSearchHighlights(source, ["abc😀"])

    expect(result.matches).toHaveLength(1)
    expect(source.textBetween(result.matches[0].from, result.matches[0].to)).toBe(
      "ＡＢＣ😀"
    )
  })

  it("keeps adjacent occurrences as separate navigation targets", () => {
    expect(projectSearchHighlights(doc("词词"), ["词"]).matches).toHaveLength(2)
  })
})
