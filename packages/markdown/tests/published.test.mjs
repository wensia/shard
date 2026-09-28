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

test("the published core collects task reminders", () => {
  const reminders = core.collectTaskReminders("- [ ] 买菜 ⏰ 2026-10-01 09:00\n- [x] 完成 ⏰ 2026-10-02 10:00")
  assert.deepEqual(reminders.map(item => [item.at, item.checked]), [
    ["2026-10-01 09:00", false],
    ["2026-10-02 10:00", true],
  ])
  assert.equal(reminders[0].dueAt, new Date(2026, 9, 1, 9, 0).getTime())
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

test("paragraph compaction is opt-in and leaves source rows addressable", async () => {
  const { parseMarkdownContent } = await import("../dist/parser.js")
  const source = "始于欲望\n\n终究要为它赎罪"
  const original = parseMarkdownContent(source)
  assert.deepEqual(original.blocks.map(block => block.hidden), [false, false, false])

  const compact = parseMarkdownContent(source, { compactParagraphs: true })
  assert.deepEqual(compact.blocks.map(block => block.hidden), [false, true, false])
  assert.deepEqual(compact.blocks.map(block => block.lineIndex), [0, 1, 2])
  assert.equal(compact.blocks.map(block => block.source).join("\n"), source)
  assert.equal(compact.lastVisibleIndex, 2)
})

test("paragraph compaction preserves additional blank rows and single newlines", async () => {
  const { parseMarkdownContent } = await import("../dist/parser.js")
  const compact = parseMarkdownContent("第一段\n\n\n\n第二段", { compactParagraphs: true })
  assert.deepEqual(compact.blocks.map(block => block.hidden), [false, true, false, false, false])
  assert.equal(compact.blocks.filter(block => !block.hidden).map(block => block.source).join("\n"),
    "第一段\n\n\n第二段")

  const single = parseMarkdownContent("第一行\n第二行", { compactParagraphs: true })
  assert.deepEqual(single.blocks.map(block => block.hidden), [false, false])
  assert.equal(single.blocks.map(block => block.source).join("\n"), "第一行\n第二行")
})

test("paragraph compaction preserves spacing around structured blocks and media", async () => {
  const { parseMarkdownContent } = await import("../dist/parser.js")
  const examples = [
    ["fenced code", "前言\n\n```text\n代码甲\n\n代码乙\n```\n\n结尾"],
    ["unordered list", "前言\n\n- 第一项\n\n- 第二项\n\n结尾"],
    ["ordered list", "前言\n\n1. 第一项\n\n2. 第二项\n\n结尾"],
    ["table", "前言\n\n| 名称 | 数量 |\n| --- | --- |\n| A | 1 |\n\n结尾"],
    ["standalone image", "前言\n\n![照片](photo.png)\n\n结尾"],
    ["CSV embed", "前言\n\n![[data.csv]]\n\n结尾"],
  ]
  for (const [name, source] of examples) {
    const original = parseMarkdownContent(source, { renderImages: true })
    const compact = parseMarkdownContent(source, { renderImages: true, compactParagraphs: true })
    assert.deepEqual(compact, original, name)
  }
})

test("paragraph compaction retains a following task's original source line index", async () => {
  const { parseMarkdownContent } = await import("../dist/parser.js")
  const source = "第一段\n\n第二段\n\n- [ ] 待办\n- [x] 已完成"
  const parsed = parseMarkdownContent(source, { compactParagraphs: true })
  assert.deepEqual(parsed.blocks.filter(block => block.type === "line" && block.hidden)
    .map(block => block.lineIndex), [1])
  assert.deepEqual(parsed.blocks.filter(block => block.type === "line" && block.task)
    .map(block => [block.lineIndex, block.task.checked, block.task.body]), [
    [4, false, "待办"],
    [5, true, "已完成"],
  ])
  assert.equal(parsed.blocks.map(block => block.source).join("\n"), source)
  assert.equal(parsed.lastVisibleIndex, 5)
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
