import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import type { JSONContent } from "@tiptap/core"
import { describe, expect, it } from "vitest"

import { migrateLegacyParagraphGaps } from "./migrate"
import { paragraphLineBlocks, parseShardMarkdown } from "./parse"

const GOLDEN_DIR = path.dirname(fileURLToPath(import.meta.url)) + "/golden"

/** 旧方言的文档按 v2 的方式把段内软换行拆成一行一段，得到「看起来一样」的 v2 文档。 */
function flattenLines(node: JSONContent): JSONContent {
  const content = node.content?.map(flattenLines)
  if (!content) return node
  if (node.type !== "doc" && node.type !== "blockquote") return { ...node, content }
  return {
    ...node,
    content: content.flatMap((child) => (child.type === "paragraph" ? paragraphLineBlocks(child.content ?? []) : [child])),
  }
}

/** 迁移只允许删掉空白和 `>`：新文本必须是旧文本的子序列，删掉的字符全是空白或 `>`。 */
function onlyRemovedGapCharacters(before: string, after: string) {
  let cursor = 0
  let removed = ""
  for (const char of before) {
    if (after[cursor] === char) cursor += 1
    else removed += char
  }
  return cursor === after.length && /^[\s>]*$/u.test(removed)
}

function expectSameDisplay(legacy: string) {
  const migrated = migrateLegacyParagraphGaps(legacy)
  expect(parseShardMarkdown(migrated).doc).toEqual(flattenLines(parseShardMarkdown(legacy, { legacyParagraphs: true }).doc))
  expect(parseShardMarkdown(migrated).frontmatter).toEqual(parseShardMarkdown(legacy).frontmatter)
  expect(onlyRemovedGapCharacters(legacy, migrated)).toBe(true)
  return migrated
}

describe("旧方言迁移到 v2：显示不变，只删块之间的空行", () => {
  it.each([
    ["相邻的两行", "甲\n\n乙", "甲\n乙"],
    ["中间一行空白", "甲\n\n\n乙", "甲\n\n乙"],
    ["中间两行空白", "甲\n\n\n\n乙", "甲\n\n\n乙"],
    ["段内软换行不动", "甲\n乙\n\n丙", "甲\n乙\n丙"],
    ["标题后旧方言不显示的空行", "# 标题\n\n\n甲", "# 标题\n\n甲"],
    ["标题与段落之间", "# 标题\n\n甲\n\n乙", "# 标题\n\n甲\n乙"],
    ["引用块里的段落", "> 甲\n>\n> 乙", "> 甲\n> 乙"],
    ["列表项内部不动", "- 甲\n\n  乙\n\n- 丙", "- 甲\n\n  乙\n\n- 丙"],
    ["代码块内部不动", "甲\n\n```\n一\n\n\n二\n```", "甲\n\n```\n一\n\n\n二\n```"],
    ["csv 嵌入前后", "甲\n\n![[data/large.csv]]\n\n乙", "甲\n\n![[data/large.csv]]\n\n乙"],
    ["csv 嵌入前有空白", "甲\n\n\n![[data/large.csv]]", "甲\n\n\n![[data/large.csv]]"],
    ["列表里的引用块", "- 甲\n\n  > 乙\n  >\n  > 丙", "- 甲\n\n  > 乙\n  > 丙"],
    ["frontmatter 原样保留", "---\nid: x\ntags: [a]\n---\n\n甲\n\n乙\n", "---\nid: x\ntags: [a]\n---\n\n甲\n乙\n"],
    ["硬换行", "甲\\\n乙\n\n丙", "甲\\\n乙\n丙"],
    ["分隔线前后", "甲\n\n---\n\n乙", "甲\n\n---\n\n乙"],
  ])("%s", (_, legacy, expected) => {
    expect(expectSameDisplay(legacy)).toBe(expected)
  })

  it("CRLF 原样返回", () => {
    expect(migrateLegacyParagraphGaps("甲\r\n\r\n乙")).toBe("甲\r\n\r\n乙")
  })

  describe("golden 用例：旧方言的输入与规范化输出迁移后显示都不变", () => {
    for (const name of readdirSync(GOLDEN_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      for (const file of ["input.md", "expected.md"]) {
        const source = path.join(GOLDEN_DIR, name.name, file)
        it(`${name.name}/${file}`, () => {
          expectSameDisplay(readFileSync(source, "utf8"))
        })
      }
    }
  })
})
