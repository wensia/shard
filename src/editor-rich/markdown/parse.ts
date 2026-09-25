import type { JSONContent } from "@tiptap/core"
import { markdownParser } from "@shard/markdown/core"
import { getTagRanges, normalizeTag } from "@shard/markdown/core"

import { isShardBlockLanguage, normalizeShardBlockLanguage } from "@/editor-rich/blocks/registry"
import { isCsvWikilinkTarget, parseWikilinks } from "@/lib/wikilink"

import { splitFrontmatter } from "./frontmatter"

/** Lezer 语法树节点；由解析器返回类型推导，避免多引一个 `@lezer/common` 依赖。 */
type LezerNode = ReturnType<typeof markdownParser.parse>["topNode"]

export interface ShardMarkdownDocument {
  /** ProseMirror 文档 JSON，节点名与 `shardSchema` 一致。 */
  doc: JSONContent
  frontmatter: string | null
}

interface MarkSpec {
  type: string
  attrs?: Record<string, unknown>
}

interface AtomRange {
  from: number
  to: number
  /** csv 嵌入写法 `![[x.csv]]`，行内出现时 `!` 仍是普通字符。 */
  embed: boolean
  node: JSONContent
}

/** 行内扫描里不再识别标签与双链的区域：代码、转义、实体、原始 HTML、链接目标。 */
const PROTECTED_INLINE = new Set([
  "Autolink",
  "CodeMark",
  "CodeText",
  "Entity",
  "Escape",
  "HTMLTag",
  "InlineCode",
  "LinkLabel",
  "LinkTitle",
  "URL",
])

/** 结构标记：本身不产出内容，只把游标推过去。 */
const SKIPPED_INLINE = new Set(["CodeMark", "HeaderMark", "ListMark", "QuoteMark", "TaskMarker"])

const HEADING_PATTERN = /^ATXHeading([1-6])$/u
const SETEXT_PATTERN = /^SetextHeading([12])$/u
const CSV_EMBED_LINE_PATTERN = /^!\[\[([^\]\n|]+)\]\]$/u
const UNDERLINE_OPEN = /^<u\s*>$/iu
const UNDERLINE_CLOSE = /^<\/u\s*>$/iu

export function parseShardMarkdown(markdown: string): ShardMarkdownDocument {
  const { body, frontmatter } = splitFrontmatter(markdown)
  const tree = markdownParser.parse(body)
  const content = parseBlocks(childrenOf(tree.topNode), body)
  return {
    doc: { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] },
    frontmatter,
  }
}

function childrenOf(node: LezerNode): LezerNode[] {
  const children: LezerNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) children.push(child)
  return children
}

// ---------------------------------------------------------------------------
// 块级
// ---------------------------------------------------------------------------

function parseBlocks(nodes: LezerNode[], src: string): JSONContent[] {
  const blocks: JSONContent[] = []
  for (const node of nodes) {
    const block = parseBlock(node, src)
    if (Array.isArray(block)) blocks.push(...block)
    else if (block) blocks.push(block)
  }
  return blocks
}

function parseBlock(node: LezerNode, src: string): JSONContent | JSONContent[] | null {
  const name = node.name

  if (name === "Paragraph") return parseParagraph(node, src)
  if (name === "Blockquote") {
    const content = parseBlocks(childrenOf(node).filter((child) => child.name !== "QuoteMark"), src)
    return { type: "blockquote", content: content.length > 0 ? content : [{ type: "paragraph" }] }
  }
  if (name === "BulletList" || name === "OrderedList") return parseList(node, src)
  if (name === "FencedCode" || name === "CodeBlock") return parseCode(node, src)
  if (name === "HorizontalRule") return { type: "horizontalRule" }
  if (name === "Table") return parseTable(node, src)

  const heading = HEADING_PATTERN.exec(name) ?? SETEXT_PATTERN.exec(name)
  if (heading) {
    return {
      type: "heading",
      attrs: { level: Number(heading[1]) },
      content: parseInlineContainer(node, src),
    }
  }

  // 方言不认识的块级结构（HTML 块、注释、链接引用定义等）一律原样保留。
  return rawBlock(src.slice(node.from, node.to))
}

function rawBlock(source: string): JSONContent {
  return { type: "rawBlock", attrs: { source: source.replace(/\s+$/u, "") } }
}

function parseParagraph(node: LezerNode, src: string): JSONContent {
  const line = src.slice(node.from, node.to).trim()
  const csv = CSV_EMBED_LINE_PATTERN.exec(line)
  if (csv && isCsvWikilinkTarget(csv[1])) {
    return { type: "csvEmbed", attrs: { path: csv[1].trim() } }
  }

  const content = parseInlineContainer(node, src)
  return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" }
}

function parseList(node: LezerNode, src: string): JSONContent[] {
  const ordered = node.name === "OrderedList"
  const items = childrenOf(node).filter((child) => child.name === "ListItem")
  const groups: { task: boolean; items: JSONContent[] }[] = []

  for (const item of items) {
    const children = childrenOf(item)
    const task = children.find((child) => child.name === "Task")
    const empty = task ? null : emptyTaskMarker(children, src)
    const isTask = Boolean(task) || empty !== null
    const parsed = task
      ? parseTaskItem(task, children, src)
      : empty
        ? parseEmptyTaskItem(empty, children, src)
        : parseListItem(children, src)
    const last = groups[groups.length - 1]
    if (last && last.task === isTask) last.items.push(parsed)
    else groups.push({ task: isTask, items: [parsed] })
  }

  return groups.map((group) => {
    if (group.task) {
      // 有序任务（`1. [ ] 事项`）保留序号语义；序号本身由序列化按位置重排。
      return ordered
        ? { type: "taskList", attrs: { ordered: true }, content: group.items }
        : { type: "taskList", content: group.items }
    }
    if (!ordered) return { type: "bulletList", content: group.items }
    return { type: "orderedList", attrs: { start: listStart(items[0], src) }, content: group.items }
  })
}

function listStart(item: LezerNode | undefined, src: string) {
  if (!item) return 1
  const marker = childrenOf(item).find((child) => child.name === "ListMark")
  const start = marker ? Number.parseInt(src.slice(marker.from, marker.to), 10) : Number.NaN
  return Number.isFinite(start) ? start : 1
}

function parseListItem(children: LezerNode[], src: string): JSONContent {
  const content = parseBlocks(children.filter((child) => child.name !== "ListMark"), src)
  return { type: "listItem", content: ensureLeadingParagraph(content) }
}

function parseTaskItem(task: LezerNode, children: LezerNode[], src: string): JSONContent {
  const marker = childrenOf(task).find((child) => child.name === "TaskMarker")
  const checked = marker ? /\[[xX]\]/u.test(src.slice(marker.from, marker.to)) : false
  const first = parseInlineContainer(task, src)
  const rest = parseBlocks(
    children.filter((child) => child.name !== "ListMark" && child.name !== "Task"),
    src
  )
  const head: JSONContent = first.length > 0 ? { type: "paragraph", content: first } : { type: "paragraph" }
  return { type: "taskItem", attrs: { checked }, content: [head, ...rest] }
}

/**
 * 标题为空的任务项：序列化写成 `- [ ]`（行尾不留空格），但 GFM 的 Task 语法要求
 * `[ ]` 后面跟空白，Lezer 因此把它读成正文恰好是 `[ ]` 的普通列表项。
 * 读回时不认它，编辑区就会露出字面的 `[ ]`——这里把它认回任务项。
 * 用户手打的字面 `[ ]` 会被序列化转义成 `\[ ]`，不会落进这条规则。
 */
function emptyTaskMarker(children: LezerNode[], src: string) {
  const first = children.find((child) => child.name !== "ListMark")
  if (!first || first.name !== "Paragraph") return null
  const match = /^\[([ xX])\]$/u.exec(src.slice(first.from, first.to).trim())
  return match ? { paragraph: first, checked: match[1] !== " " } : null
}

function parseEmptyTaskItem(
  empty: { paragraph: LezerNode; checked: boolean },
  children: LezerNode[],
  src: string
): JSONContent {
  const rest = parseBlocks(
    children.filter((child) => child.name !== "ListMark" && child !== empty.paragraph),
    src
  )
  return { type: "taskItem", attrs: { checked: empty.checked }, content: [{ type: "paragraph" }, ...rest] }
}

function ensureLeadingParagraph(content: JSONContent[]): JSONContent[] {
  if (content.length === 0) return [{ type: "paragraph" }]
  if (content[0].type === "paragraph") return content
  return [{ type: "paragraph" }, ...content]
}

function parseCode(node: LezerNode, src: string): JSONContent {
  const children = childrenOf(node)
  const info = children.find((child) => child.name === "CodeInfo")
  const language = info ? src.slice(info.from, info.to).trim() : ""
  const source = codeTextOf(node, children, src)

  if (language && isShardBlockLanguage(language)) {
    return { type: "shardBlock", attrs: { lang: normalizeShardBlockLanguage(language), source } }
  }

  const content = source ? [{ type: "text", text: source }] : undefined
  return { type: "codeBlock", attrs: { language: language || null }, ...(content ? { content } : {}) }
}

function codeTextOf(node: LezerNode, children: LezerNode[], src: string) {
  const texts = children.filter((child) => child.name === "CodeText")
  if (texts.length === 0) return ""

  const from = texts[0].from
  const to = texts[texts.length - 1].to
  const quotes: LezerNode[] = []
  collectNamed(node, "QuoteMark", quotes)

  let result = ""
  let cursor = from
  for (const quote of quotes) {
    if (quote.from < from || quote.to > to) continue
    result += src.slice(cursor, quote.from)
    // 引用块里的围栏：去掉 `>` 以及紧随其后的一个空格。
    cursor = src[quote.to] === " " ? quote.to + 1 : quote.to
  }
  result += src.slice(cursor, to)

  if (node.name !== "CodeBlock") return result
  // 缩进代码块：除首行外每行去掉最多 4 个前导空格。
  return result
    .split("\n")
    .map((line, index) => (index === 0 ? line : line.replace(/^ {1,4}/u, "")))
    .join("\n")
}

function collectNamed(node: LezerNode, name: string, out: LezerNode[]) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) out.push(child)
    else collectNamed(child, name, out)
  }
}

function parseTable(node: LezerNode, src: string): JSONContent {
  const children = childrenOf(node)
  const delimiter = children.find((child) => child.name === "TableDelimiter" && child.to - child.from > 1)
  const align = delimiter ? parseAlignments(src.slice(delimiter.from, delimiter.to)) : []
  const rows: JSONContent[] = []

  for (const child of children) {
    if (child.name !== "TableHeader" && child.name !== "TableRow") continue
    const header = child.name === "TableHeader"
    const cells = childrenOf(child)
      .filter((cell) => cell.name === "TableCell")
      .map((cell, index) => {
        const content = parseInlineContainer(cell, src)
        return {
          type: header ? "tableHeader" : "tableCell",
          attrs: { colspan: 1, rowspan: 1, colwidth: null, align: align[index] ?? null },
          content: [content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" }],
        }
      })
    rows.push({ type: "tableRow", content: cells })
  }

  return { type: "table", content: rows }
}

function parseAlignments(row: string): (string | null)[] {
  return row
    .split("|")
    .slice(1, -1)
    .map((cell) => {
      const trimmed = cell.trim()
      const left = trimmed.startsWith(":")
      const right = trimmed.endsWith(":")
      if (left && right) return "center"
      if (right) return "right"
      if (left) return "left"
      return null
    })
}

// ---------------------------------------------------------------------------
// 行内
// ---------------------------------------------------------------------------

class InlineBuilder {
  readonly out: JSONContent[] = []
  private atLineStart = true

  pushText(text: string, marks: MarkSpec[], literal = false) {
    if (!text) return
    let buffer = ""
    if (literal) {
      buffer = text
      this.atLineStart = false
    } else {
      for (const char of text) {
        if (this.atLineStart && (char === " " || char === "\t")) continue
        this.atLineStart = char === "\n"
        buffer += char
      }
    }
    if (!buffer) return

    const previous = this.out[this.out.length - 1]
    if (previous?.type === "text" && sameMarks(previous.marks as MarkSpec[] | undefined, marks)) {
      previous.text = `${previous.text ?? ""}${buffer}`
      return
    }
    this.out.push({ type: "text", text: buffer, ...(marks.length > 0 ? { marks: cloneMarks(marks) } : {}) })
  }

  pushNode(node: JSONContent, marks: MarkSpec[]) {
    this.atLineStart = false
    this.out.push(marks.length > 0 ? { ...node, marks: cloneMarks(marks) } : node)
  }

  pushLineBreak(node: JSONContent) {
    this.out.push(node)
    this.atLineStart = true
  }

  finish(): JSONContent[] {
    const last = this.out[this.out.length - 1]
    if (last?.type === "text") {
      last.text = (last.text ?? "").replace(/\s+$/u, "")
      if (!last.text) this.out.pop()
    }
    return this.out
  }
}

function cloneMarks(marks: MarkSpec[]) {
  return marks.map((mark) => ({ type: mark.type, ...(mark.attrs ? { attrs: { ...mark.attrs } } : {}) }))
}

function sameMarks(a: MarkSpec[] | undefined, b: MarkSpec[]) {
  const left = a ?? []
  if (left.length !== b.length) return false
  return left.every((mark, index) => JSON.stringify(mark) === JSON.stringify(cloneMarks(b)[index]))
}

function parseInlineContainer(node: LezerNode, src: string): JSONContent[] {
  const protectedRanges: [number, number][] = []
  collectProtected(node, protectedRanges)
  const atoms = scanAtoms(src, node.from, node.to, protectedRanges)
  const builder = new InlineBuilder()
  emitRange(node, node.from, node.to, [], src, atoms, builder)
  return builder.finish()
}

function collectProtected(node: LezerNode, out: [number, number][]) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (PROTECTED_INLINE.has(child.name)) out.push([child.from, child.to])
    else collectProtected(child, out)
  }
}

function scanAtoms(
  src: string,
  from: number,
  to: number,
  protectedRanges: [number, number][]
): AtomRange[] {
  const atoms: AtomRange[] = []
  const sorted = [...protectedRanges].sort((a, b) => a[0] - b[0])
  let cursor = from

  const scanSegment = (start: number, end: number) => {
    if (end <= start) return
    // 多带一个前置字符，让 getTagRanges 的边界判断和整行扫描一致。
    const offset = start > from ? 1 : 0
    const segment = src.slice(start - offset, end)
    const links = parseWikilinks(segment)

    for (const link of links) {
      if (link.from < offset) continue
      const embed = link.embed === true
      atoms.push({
        from: start - offset + link.from,
        to: start - offset + link.to,
        embed,
        node: {
          type: "wikilink",
          attrs: { target: link.target, alias: link.alias ?? null },
        },
      })
    }

    for (const range of getTagRanges(segment)) {
      if (range.start < offset) continue
      const absoluteFrom = start - offset + range.start
      const absoluteTo = start - offset + range.end
      if (links.some((link) => absoluteFrom < start - offset + link.to && start - offset + link.from < absoluteTo)) {
        continue
      }
      const name = normalizeTag(range.text)
      if (!name) continue
      atoms.push({ from: absoluteFrom, to: absoluteTo, embed: false, node: { type: "tag", attrs: { name } } })
    }
  }

  for (const [start, end] of sorted) {
    if (start > cursor) scanSegment(cursor, Math.min(start, to))
    cursor = Math.max(cursor, end)
    if (cursor >= to) break
  }
  if (cursor < to) scanSegment(cursor, to)

  return atoms.sort((a, b) => a.from - b.from)
}

function emitRange(
  parent: LezerNode,
  from: number,
  to: number,
  marks: MarkSpec[],
  src: string,
  atoms: AtomRange[],
  builder: InlineBuilder
) {
  const children = childrenOf(parent).filter(
    (child) => child.to > from && child.from < to && !atoms.some((atom) => child.from < atom.to && atom.from < child.to)
  )

  let position = from
  let index = 0
  while (position < to) {
    const atom = atoms.find((candidate) => candidate.from === position)
    if (atom) {
      emitAtom(atom, marks, builder)
      position = atom.to
      while (index < children.length && children[index].from < position) index += 1
      continue
    }

    const child = index < children.length ? children[index] : null
    if (child && child.from <= position) {
      index += 1
      if (child.to <= position) continue

      // `<u>…</u>` 是方言里唯一的行内 HTML，成对出现时升级为下划线标记。
      if (child.name === "HTMLTag" && UNDERLINE_OPEN.test(src.slice(child.from, child.to))) {
        const closeIndex = children.findIndex(
          (candidate, candidateIndex) =>
            candidateIndex >= index &&
            candidate.name === "HTMLTag" &&
            UNDERLINE_CLOSE.test(src.slice(candidate.from, candidate.to))
        )
        if (closeIndex >= 0) {
          const close = children[closeIndex]
          emitRange(parent, child.to, close.from, [...marks, { type: "underline" }], src, atoms, builder)
          index = closeIndex + 1
          position = close.to
          continue
        }
      }

      emitChild(child, marks, src, atoms, builder)
      position = child.to
      continue
    }

    const nextAtom = atoms.find((candidate) => candidate.from > position)
    const stop = Math.min(
      to,
      child ? child.from : to,
      nextAtom && nextAtom.from < to ? nextAtom.from : to
    )
    builder.pushText(src.slice(position, Math.max(stop, position)), marks)
    if (stop <= position) break
    position = stop
  }
}

function emitAtom(atom: AtomRange, marks: MarkSpec[], builder: InlineBuilder) {
  // 行内出现的 `![[x.csv]]` 不是块级嵌入，`!` 退回普通字符。
  if (atom.embed) builder.pushText("!", marks, true)
  builder.pushNode(atom.node, marks)
}

function emitChild(
  node: LezerNode,
  marks: MarkSpec[],
  src: string,
  atoms: AtomRange[],
  builder: InlineBuilder
) {
  const name = node.name
  if (SKIPPED_INLINE.has(name)) return

  if (name === "StrongEmphasis") return emitWithMark(node, marks, "bold", src, atoms, builder)
  if (name === "Emphasis") return emitWithMark(node, marks, "italic", src, atoms, builder)
  if (name === "Strikethrough") return emitWithMark(node, marks, "strike", src, atoms, builder)
  if (name === "Highlight") return emitWithMark(node, marks, "highlight", src, atoms, builder)

  if (name === "InlineCode") {
    const marksInside = childrenOf(node).filter((child) => child.name === "CodeMark")
    const start = marksInside[0]?.to ?? node.from
    const end = marksInside[marksInside.length - 1]?.from ?? node.to
    builder.pushText(src.slice(start, end), [...marks, { type: "code" }], true)
    return
  }

  if (name === "Escape") {
    builder.pushText(src.slice(node.from + 1, node.to), marks, true)
    return
  }

  if (name === "Entity") {
    builder.pushText(decodeEntity(src.slice(node.from, node.to)), marks, true)
    return
  }

  if (name === "HardBreak") {
    builder.pushLineBreak({ type: "hardBreak" })
    return
  }

  if (name === "Image") {
    const parts = linkParts(node, src)
    builder.pushNode(
      {
        type: "image",
        attrs: {
          src: parts.href,
          alt: src.slice(parts.textFrom, parts.textTo) || null,
          title: parts.title,
          width: null,
          height: null,
        },
      },
      marks
    )
    return
  }

  if (name === "Link") {
    const parts = linkParts(node, src)
    if (!parts.href) {
      // 没有目标的 `[文本]` 是未定义的引用式链接，退回字面文本。
      builder.pushText(src.slice(node.from, node.to), marks, true)
      return
    }
    const linkMark: MarkSpec = { type: "link", attrs: { href: parts.href, target: null, rel: null, class: null, title: parts.title } }
    emitRange(node, parts.textFrom, parts.textTo, [...marks, linkMark], src, atoms, builder)
    return
  }

  if (name === "Autolink" || name === "URL") {
    const url = name === "URL" ? node : childrenOf(node).find((child) => child.name === "URL")
    const href = url ? src.slice(url.from, url.to) : src.slice(node.from, node.to)
    const linkMark: MarkSpec = { type: "link", attrs: { href, target: null, rel: null, class: null, title: null } }
    builder.pushText(href, [...marks, linkMark], true)
    return
  }

  // 行内 HTML：`<u>` 升级为下划线标记，其余标签降级为字面文本。
  if (name === "HTMLTag") {
    builder.pushText(src.slice(node.from, node.to), marks, true)
    return
  }

  builder.pushText(src.slice(node.from, node.to), marks, true)
}

function emitWithMark(
  node: LezerNode,
  marks: MarkSpec[],
  type: string,
  src: string,
  atoms: AtomRange[],
  builder: InlineBuilder
) {
  const inner = childrenOf(node).filter((child) => child.name.endsWith("Mark"))
  const from = inner[0]?.to ?? node.from
  const to = inner[inner.length - 1]?.from ?? node.to
  emitRange(node, from, to, [...marks, { type }], src, atoms, builder)
}

interface LinkParts {
  href: string
  title: string | null
  textFrom: number
  textTo: number
}

function linkParts(node: LezerNode, src: string): LinkParts {
  const children = childrenOf(node)
  const marks = children.filter((child) => child.name === "LinkMark")
  const url = children.find((child) => child.name === "URL")
  const title = children.find((child) => child.name === "LinkTitle")
  return {
    href: url ? decodeLinkDestination(src.slice(url.from, url.to)) : "",
    title: title ? src.slice(title.from + 1, title.to - 1) : null,
    textFrom: marks[0]?.to ?? node.from,
    textTo: marks[1]?.from ?? node.to,
  }
}

function decodeLinkDestination(value: string) {
  const trimmed = value.trim()
  const unwrapped = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed
  return unwrapped.replace(/\\([\\()<>[\]])/gu, "$1")
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
}

function decodeEntity(raw: string) {
  const body = raw.slice(1, -1)
  if (body.startsWith("#x") || body.startsWith("#X")) {
    const code = Number.parseInt(body.slice(2), 16)
    return Number.isFinite(code) ? String.fromCodePoint(code) : raw
  }
  if (body.startsWith("#")) {
    const code = Number.parseInt(body.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : raw
  }
  return NAMED_ENTITIES[body] ?? raw
}
