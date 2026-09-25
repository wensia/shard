import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { Node } from "@tiptap/pm/model"
import { describe, expect, it } from "vitest"

import { shardSchema } from "@/editor-rich/schema"

import { parseShardMarkdown } from "./parse"
import { serializeShardMarkdown } from "./serialize"

const GOLDEN_DIR = path.dirname(fileURLToPath(import.meta.url)) + "/golden"

/** golden 文件按普通文本文件保存（末尾一个换行），契约上的正文不含末尾换行。 */
function readCase(name: string, file: "input.md" | "expected.md") {
  return readFileSync(path.join(GOLDEN_DIR, name, file), "utf8").replace(/\n$/u, "")
}

const cases = readdirSync(GOLDEN_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

describe("Shard Markdown 方言往返", () => {
  it("golden 用例目录不为空且覆盖方言元素", () => {
    expect(cases.length).toBeGreaterThanOrEqual(22)
  })

  for (const name of cases) {
    describe(name, () => {
      const input = readCase(name, "input.md")
      const expected = readCase(name, "expected.md")

      it("input 序列化成规范化输出", () => {
        const parsed = parseShardMarkdown(input)
        expect(serializeShardMarkdown(parsed.doc, parsed.frontmatter)).toBe(expected)
      })

      it("规范化输出幂等", () => {
        const parsed = parseShardMarkdown(expected)
        expect(serializeShardMarkdown(parsed.doc, parsed.frontmatter)).toBe(expected)
      })

      it("规范化前后文档 JSON 相同", () => {
        expect(parseShardMarkdown(expected).doc).toEqual(parseShardMarkdown(input).doc)
      })

      it("文档 JSON 符合方言 schema", () => {
        const node = Node.fromJSON(shardSchema, parseShardMarkdown(input).doc)
        expect(() => node.check()).not.toThrow()
      })
    })
  }
})
