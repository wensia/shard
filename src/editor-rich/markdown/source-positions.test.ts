import { describe, expect, it } from "vitest"
import type { JSONContent } from "@tiptap/core"
import { toggleTaskLine } from "@/lib/editor-format"
import { parseShardMarkdown } from "./parse"

function tasks(node: JSONContent): JSONContent[] {
  return [ ...(node.type === "taskItem" ? [node] : []), ...(node.content ?? []).flatMap(tasks) ]
}

describe("shared read-only document source positions", () => {
  it("preserves invalid numeric entities without crashing cards or editors", () => {
    const source = "&#9999999; &#xFFFFFF;"
    expect(parseShardMarkdown(source).doc.content?.[0].content?.[0].text).toBe(source)
  })
  it("maps nested, empty and quoted tasks to original rows without treating code as tasks", () => {
    const lines = ["---", "title: source rows", "---", "", "", "# 标题", "", "```md", "- [ ] 假任务", "```", "", "- [ ] 父任务", "  - [x] 子任务", "- [ ]", "", "> - [ ] 引用任务"]
    const markdown = lines.join("\r\n")
    const parsed = parseShardMarkdown(markdown, { sourcePositions: true })
    expect(tasks(parsed.doc).map((node) => node.sourceLine)).toEqual([11, 12, 13, 15])
    expect(tasks(parseShardMarkdown(markdown).doc).every((node) => node.sourceLine === undefined)).toBe(true)
    expect(toggleTaskLine(lines.join("\n"), 15).split("\n")[15]).toBe("> - [x] 引用任务")
  })
})
