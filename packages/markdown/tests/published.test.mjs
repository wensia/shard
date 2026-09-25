import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import test from "node:test"
import * as core from "@shard/markdown/core"

test("the published core works without a DOM or a Shard runtime", () => {
  assert.equal(typeof document, "undefined")
  assert.deepEqual(core.parseMarkdownTable([
    "| 名称 | 数量 |",
    "| :--- | ---: |",
    "| A\\|B | 3 |",
  ], 0), {
    align: ["left", "right"],
    header: ["名称", "数量"],
    lineCount: 3,
    rows: [["A|B", "3"]],
  })
  assert.deepEqual(core.findInlineHighlights("`==源码==` ==有效=="), [
    { start: 9, end: 15, contentStart: 11, contentEnd: 13 },
  ])
  assert.deepEqual(core.parseMarkdownPreview("# 标题\n- [x] 完成\n**文本** #标签", 3), [
    { kind: "heading", level: 1, text: "标题" },
    { kind: "task", checked: true, text: "完成" },
    { kind: "text", text: "文本" },
  ])
})

test("a closed fence becomes one block while its lines stay addressable", async () => {
  const { parseMarkdownContent } = await import("../dist/parser.js")
  const { blocks, lastVisibleIndex } = parseMarkdownContent("前言\n```mindmap\n- 根\n  - 甲\n```\n结尾")
  assert.equal(blocks.length, 6)
  assert.equal(lastVisibleIndex, 5)
  assert.deepEqual(blocks.map(block => block.type), ["line", "fence", "line", "line", "line", "line"])
  const fence = blocks[1]
  assert.equal(fence.language, "mindmap")
  assert.equal(fence.code, "- 根\n  - 甲")
  assert.equal(fence.lineCount, 4)
  assert.equal(fence.lineIndex, 1)
  assert.equal(fence.source, "```mindmap")
  // Hosts that decline the fence render this line, so it must stay a normal parsed line.
  assert.equal(fence.line.type, "line")
  assert.equal(fence.line.display, "```mindmap")

  // Without a closing fence there is no block at all.
  const unclosed = parseMarkdownContent("```mindmap\n- 根")
  assert.deepEqual(unclosed.blocks.map(block => block.type), ["line", "line"])
})

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory)
    return entry.isDirectory() ? filesIn(path) : [path]
  }))).flat()
}

test("the compiled package has no Shard aliases, Tauri, or CodeMirror runtime imports", async () => {
  const directory = new URL("../dist/", import.meta.url)
  const scripts = (await filesIn(directory)).filter(path => path.pathname.endsWith(".js"))
  assert.ok(scripts.length > 0, "Build @shard/markdown before running its published tests")
  for (const path of scripts) {
    const source = await readFile(path, "utf8")
    assert.doesNotMatch(source, /(?:from\s*|import\s*\(?)\s*["'](?:@\/|@tauri-apps\/|@codemirror\/)/, fileURLToPath(path))
  }
})
