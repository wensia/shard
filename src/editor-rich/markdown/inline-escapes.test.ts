import type { JSONContent } from "@tiptap/core"
import { describe, expect, it } from "vitest"

import { parseShardMarkdown } from "./parse"
import { serializeShardMarkdown } from "./serialize"

function normalize(markdown: string) {
  const parsed = parseShardMarkdown(markdown)
  return serializeShardMarkdown(parsed.doc, parsed.frontmatter)
}

function inline(markdown: string) {
  return parseShardMarkdown(markdown).doc.content?.[0]?.content
}

const LINK = { type: "link", attrs: { href: "https://e.com/p", target: null, rel: null, class: null, title: null } }
const WIKILINK: JSONContent = { type: "wikilink", attrs: { target: "笔记", alias: null } }

describe("方括号写回", () => {
  it.each([
    ["说完这句 [停顿] 再接", "说完这句 [停顿] 再接"],
    ["好的[停顿]", "好的[停顿]"],
    ["[00:12] 开场", "[00:12] 开场"],
    ["- [停顿] 列表里", "- [停顿] 列表里"],
    ["> [停顿] 引用里", "> [停顿] 引用里"],
    ["## [停顿] 标题里", "## [停顿] 标题里"],
    ["| 列 |\n| --- |\n| [停顿] |", "| 列 |\n| --- |\n| [停顿] |"],
    ["[**重点**] 后面", "[**重点**] 后面"],
    ["说 [==重点==] 完", "说 [==重点==] 完"],
    ["[[双链]] [停顿]", "[[双链]] [停顿]"],
    ["![不是图片] 后面", "![不是图片] 后面"],
    ["\\[停顿][笑]", "\\[停顿][笑]"],
  ])("字面方括号原样写回：%j", (input, expected) => {
    expect(normalize(input)).toBe(expected)
    expect(normalize(expected)).toBe(expected)
  })

  it.each([
    // 会拼成语法的位置照旧转义。
    ["\\[a](b)", "\\[a](b)"],
    ["\\[a][b]", "\\[a][b]"],
    ["\\[\\[不是双链]]", "\\[\\[不是双链]]"],
    ["- \\[ ] 不是任务", "- \\[ ] 不是任务"],
    ["- \\[x] 不是任务", "- \\[x] 不是任务"],
    ["\\[a]: https://example.com", "\\[a]: https://example.com"],
  ])("会成语法的方括号保留转义：%j", (input, expected) => {
    expect(normalize(input)).toBe(expected)
    expect(normalize(expected)).toBe(expected)
  })

  it("标记跨过方括号时保留转义", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "前[a" },
            { type: "text", text: "b]c", marks: [{ type: "bold" }] },
            { type: "text", text: " 后" },
          ],
        },
      ],
    }
    const markdown = serializeShardMarkdown(doc)
    expect(markdown).toBe("前\\[a**b]c** 后")
    expect(parseShardMarkdown(markdown).doc).toEqual(doc)
  })

  it.each<[string, JSONContent[], string]>([
    [
      "`!` 紧跟链接",
      [{ type: "text", text: "Wow!" }, { type: "text", text: "链接", marks: [LINK] }],
      "Wow\\![链接](https://e.com/p)",
    ],
    [
      "`![[笔记]]` 紧跟链接",
      [{ type: "text", text: "看!" }, WIKILINK, { type: "text", text: "链接", marks: [LINK] }],
      "看\\![[笔记]][链接](https://e.com/p)",
    ],
    ["单独的 `![[笔记]]` 不动", [{ type: "text", text: "看!" }, WIKILINK, { type: "text", text: " 完" }], "看![[笔记]] 完"],
    ["`[` 紧跟双链", [{ type: "text", text: "前[" }, WIKILINK, { type: "text", text: "]" }], "前\\[[[笔记]]]"],
    [
      "高亮后紧跟 `=`",
      [{ type: "text", text: "重点", marks: [{ type: "highlight" }] }, { type: "text", text: "=号" }],
      "==重点==\\=号",
    ],
    [
      "`~` 后紧跟删除线",
      [{ type: "text", text: "约~" }, { type: "text", text: "删掉", marks: [{ type: "strike" }] }],
      "约\\~~~删掉~~",
    ],
  ])("与相邻语法粘连时转义：%s", (_, content, expected) => {
    const doc: JSONContent = { type: "doc", content: [{ type: "paragraph", content }] }
    const markdown = serializeShardMarkdown(doc)
    expect(markdown).toBe(expected)
    expect(parseShardMarkdown(markdown).doc).toEqual(doc)
  })

  it("方括号里的格式照常解析", () => {
    expect(inline("[**重点**] 后面")).toEqual([
      { type: "text", text: "[" },
      { type: "text", text: "重点", marks: [{ type: "bold" }] },
      { type: "text", text: "] 后面" },
    ])
  })

  it("没有目标的 `![文本]` 不是图片", () => {
    expect(inline("![图]")).toEqual([{ type: "text", text: "![图]" }])
    expect(inline("![图]()")?.[0]?.type).toBe("image")
  })

  it("方括号里的裸网址不当成链接目标", () => {
    const link = { type: "link", attrs: { href: "www.example.com", target: null, rel: null, class: null, title: null } }
    expect(inline("[见 www.example.com]")).toEqual([
      { type: "text", text: "[见 " },
      { type: "text", text: "www.example.com", marks: [link] },
      { type: "text", text: "]" },
    ])
    expect(normalize("[见 www.example.com](https://example.org)")).toBe(
      "[见 www.example.com](https://example.org)"
    )
  })

  it("链接文字里的方括号转义，链接不被截断", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "a]b [c] d",
              marks: [{ type: "link", attrs: { href: "https://e.com", target: null, rel: null, class: null, title: null } }],
            },
          ],
        },
      ],
    }
    const markdown = serializeShardMarkdown(doc)
    expect(markdown).toBe("[a\\]b \\[c\\] d](https://e.com)")
    expect(parseShardMarkdown(markdown).doc).toEqual(doc)
  })
})

describe("下划线", () => {
  it.each([
    ["snake_case", "snake_case"],
    ["a__b", "a__b"],
    ["__init__.py", "\\_\\_init\\_\\_.py"],
    ["前 _斜_ 后", "前 \\_斜\\_ 后"],
  ])("按整串判断：%j", (text, expected) => {
    const doc: JSONContent = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
    const markdown = serializeShardMarkdown(doc)
    expect(markdown).toBe(expected)
    expect(parseShardMarkdown(markdown).doc).toEqual(doc)
  })
})

describe("标签后的标点", () => {
  it.each([
    ["(#骑行)", "(#骑行)"],
    ["#骑行] 后", "#骑行] 后"],
    ["见 #骑行。", "见 #骑行。"],
  ])("结尾标点不会被读进标签，不补空格：%j", (input, expected) => {
    expect(normalize(input)).toBe(expected)
  })

  it("紧跟的文字会被读进标签时仍补空格", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "tag", attrs: { name: "骑行" } },
            { type: "text", text: "，今天" },
          ],
        },
      ],
    }
    const markdown = serializeShardMarkdown(doc)
    expect(markdown).toBe("#骑行 ，今天")
    expect(inline(markdown)?.[0]).toEqual({ type: "tag", attrs: { name: "骑行" } })
  })
})

// ---------------------------------------------------------------------------
// 随机往返：方括号与各种语法拼在一起，写出去再读回来必须一模一样。
// ---------------------------------------------------------------------------

function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TOKENS = ["停顿", "a", "x", "X", " ", "[", "[", "]", "]", "(", ")", "!", ":", "\\", "*", "_", "=", "~", "1", "，", "-", ">"]
const MARKS = [[{ type: "bold" }], [{ type: "italic" }], [{ type: "highlight" }], [{ type: "strike" }], [LINK]]
const ATOMS: JSONContent[] = [
  WIKILINK,
  { type: "image", attrs: { src: "a.png", alt: "图", title: null, width: null, height: null } },
]
const CONTAINERS = ["占位", "## 占位", "- 占位", "- [ ] 占位", "> 占位", "| 头 |\n| --- |\n| 占位 |"]

function plainText(next: () => number) {
  let text = ""
  const length = 1 + Math.floor(next() * 6)
  for (let index = 0; index < length; index += 1) text += TOKENS[Math.floor(next() * TOKENS.length)]
  return text
}

/** 带标记的一段首尾都是字：标记符号贴着标点或空白本来就不成格式，与方括号无关。 */
function markedText(next: () => number) {
  return `a${plainText(next)}a`
}

function inlineContent(next: () => number): JSONContent[] {
  const nodes: JSONContent[] = []
  const count = 1 + Math.floor(next() * 5)
  for (let index = 0; index < count; index += 1) {
    const roll = next()
    if (roll < 0.5) nodes.push({ type: "text", text: plainText(next) })
    else if (roll < 0.8) {
      // 两段带标记的文字之间隔一段普通文字，避免 `**a***b*` 这类本来就有歧义的拼接。
      if (nodes.length > 0 && nodes[nodes.length - 1].marks) nodes.push({ type: "text", text: "中" })
      nodes.push({ type: "text", text: markedText(next), marks: MARKS[Math.floor(next() * MARKS.length)] })
    } else nodes.push(ATOMS[Math.floor(next() * ATOMS.length)])
  }
  // 行首空白、行尾空白本来就不保留。
  const merged: JSONContent[] = []
  for (const node of nodes) {
    const previous = merged[merged.length - 1]
    if (previous?.type === "text" && node.type === "text" && JSON.stringify(previous.marks) === JSON.stringify(node.marks)) {
      previous.text = `${previous.text}${node.text}`
    } else merged.push(node.type === "text" ? { ...node } : node)
  }
  const first = merged[0]
  if (first?.type === "text") first.text = `中${first.text}`
  const last = merged[merged.length - 1]
  if (last?.type === "text") last.text = `${last.text}中`
  return merged
}

function placeIn(container: string, content: JSONContent[]): JSONContent {
  const doc = structuredClone(parseShardMarkdown(container).doc)
  const visit = (node: JSONContent): boolean => {
    if (node.content?.length === 1 && node.content[0].type === "text" && node.content[0].text === "占位") {
      node.content = content
      return true
    }
    return (node.content ?? []).some(visit)
  }
  visit(doc)
  return doc
}

describe("随机往返", () => {
  it("2000 篇随机拼接的文档往返不变", () => {
    const next = random(20261014)
    const failures: string[] = []
    for (let round = 0; round < 2000; round += 1) {
      const doc = placeIn(CONTAINERS[round % CONTAINERS.length], inlineContent(next))
      const markdown = serializeShardMarkdown(doc)
      const back = parseShardMarkdown(markdown).doc
      if (JSON.stringify(back) !== JSON.stringify(doc)) failures.push(markdown)
    }
    expect(failures.slice(0, 10)).toEqual([])
  })
})
