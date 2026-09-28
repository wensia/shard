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

test("only Lezer backslash HardBreak markers disappear from content display", async () => {
  const { parseMarkdownContent, parseMarkdownDocument } = await import("../dist/parser.js")
  const slash = "\\"
  const examples = [
    { name: "line ending", source: `甲${slash}\n乙`, display: ["甲", "乙"] },
    { name: "slash-only row", source: `甲${slash}\n${slash}\n乙`, display: ["甲", "", "乙"] },
    { name: "multiple hard breaks", source: `甲${slash}\n${slash}\n${slash}\n乙`, display: ["甲", "", "", "乙"] },
    { name: "escaped literal", source: `甲${slash}${slash}\n乙`, display: [`甲${slash}${slash}`, "乙"] },
    { name: "final slash", source: `甲${slash}`, display: [`甲${slash}`] },
    { name: "paragraph end", source: `甲${slash}\n\n乙`, display: [`甲${slash}`, "", "乙"] },
    { name: "fenced code", source: `\`\`\`txt\n甲${slash}\n\`\`\``, display: ["```txt", `甲${slash}`, "```"] },
    { name: "indented code", source: `    甲${slash}\n    乙`, display: [`    甲${slash}`, "    乙"] },
    { name: "table", source: `| a${slash} | b |\n| --- | --- |\n| c | d |`, display: [`| a${slash} | b |`, "| --- | --- |", "| c | d |"] },
  ]
  for (const { name, source, display } of examples) {
    const parsed = parseMarkdownContent(source, { hideTags: true, compactParagraphs: true })
    const lines = parsed.blocks.map(block => block.type === "fence" ? block.line : block)
    assert.deepEqual(lines.map(line => line.display ?? line.source), display, name)
    assert.deepEqual(lines.map(line => line.source), source.split("\n"), `${name} source`)
  }
  const empty = parseMarkdownContent(`甲${slash}\n${slash}\n乙`, { hideTags: true })
  assert.equal(empty.blocks[1].hidden, false)
  assert.equal(empty.blocks[1].display, "")
  const tagged = parseMarkdownContent(`#密匣${slash}\n正文`, { hideTags: true })
  assert.equal(tagged.blocks[0].hidden, true)
  assert.equal(tagged.blocks[1].display, "正文")
  assert.deepEqual(parseMarkdownDocument(`甲${slash}\n乙`).blocks[0].inline.text, "甲 乙")
})

test("published preview removes hard breaks but preserves literal backslashes", () => {
  const slash = "\\"
  assert.deepEqual(core.parseMarkdownPreview(`甲${slash}\n${slash}\n乙${slash}${slash}\n末${slash}`), [
    { kind: "text", text: "甲" },
    { kind: "text", text: `乙${slash}${slash}` },
    { kind: "text", text: `末${slash}` },
  ])
})

test("bounded display projection leaves markers beyond its parse budget untouched", () => {
  const source = "甲\\\n乙\n\n丙\\\n丁"
  assert.equal(core.stripMarkdownHardBreaks(source, 5), "甲\n乙\n\n丙\\\n丁")
  assert.equal(core.stripMarkdownHardBreaks(source), "甲\n乙\n\n丙\n丁")
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
