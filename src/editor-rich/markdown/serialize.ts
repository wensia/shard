import type { JSONContent } from "@tiptap/core"
import { isTagBoundary } from "@shard/markdown/core"
import { getTagRanges } from "@shard/markdown/core"

import { joinFrontmatter } from "./frontmatter"

/** 标记嵌套顺序：靠前的在外层，`code` 单独处理不参与开闭配对。 */
const MARK_ORDER = ["link", "highlight", "bold", "italic", "underline", "strike"]

const MARK_DELIMITERS: Record<string, string> = {
  bold: "**",
  highlight: "==",
  italic: "*",
  strike: "~~",
}

const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"])
const AUTOLINKABLE = /^(?:https?:\/\/|www\.)\S+$/iu
const ENTITY_AT = /^&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/u
const WORD_CHAR = /[\p{L}\p{N}_]/u
const LINE_HORIZONTAL_RULE = /^(?:-{3,}|\*{3,}|_{3,})[ \t]*$/u
const LINE_SETEXT = /^(?:={1,}|-{1,})[ \t]*$/u

interface MarkSpec {
  type: string
  attrs?: Record<string, unknown>
}

interface InlineOptions {
  /** 表格单元格里管道符要转义，软换行折成空格。 */
  inTable?: boolean
}

export function serializeShardMarkdown(doc: JSONContent, frontmatter?: string | null): string {
  const body = serializeBlocks(doc.content ?? [], false)
  return joinFrontmatter(body, frontmatter ?? null)
}

// ---------------------------------------------------------------------------
// 块级
// ---------------------------------------------------------------------------

/**
 * `tightLists` 只在列表项内部为真：项内的嵌套列表紧跟在标题段落后面，
 * 中间不留空行，否则重新解析会得到松散列表、文件里多出一行空白。
 */
function serializeBlocks(nodes: JSONContent[], tightLists: boolean): string {
  const parts: string[] = []
  nodes.forEach((node, index) => {
    const text = serializeBlock(node)
    const previous = nodes[index - 1]
    const glue = previous && tightLists && LIST_TYPES.has(node.type ?? "") ? "\n" : "\n\n"
    if (parts.length === 0) parts.push(text)
    else parts.push(glue, text)
  })

  const joined = parts.join("")
  // 中间的空段落只是解析兜底，不该写回文件。
  return joined.replace(/\n{3,}/gu, "\n\n").replace(/^\s+|\s+$/gu, "")
}

function serializeBlock(node: JSONContent): string {
  switch (node.type) {
    case "paragraph":
      return serializeInline(node.content ?? [])
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)))
      const text = serializeInline(node.content ?? [])
      return `${"#".repeat(level)}${text ? ` ${text}` : ""}`
    }
    case "blockquote":
      return prefixLines(serializeBlocks(node.content ?? [], false), ">")
    case "bulletList":
      return serializeList(node, (_, index) => ({ marker: "- ", indent: 2, key: index }))
    case "orderedList": {
      const start = Number(node.attrs?.start ?? 1)
      return serializeList(node, (_, index) => {
        const marker = `${(Number.isFinite(start) ? start : 1) + index}. `
        return { marker, indent: marker.length, key: index }
      })
    }
    case "taskList": {
      // 有序任务从 1 起按位置重排序号；续行缩进对齐序号之后，与有序列表一致。
      const ordered = node.attrs?.ordered === true
      return serializeList(node, (item, index) => {
        const bullet = ordered ? `${index + 1}. ` : "- "
        return {
          marker: `${bullet}${item.attrs?.checked ? "[x] " : "[ ] "}`,
          indent: bullet.length,
          key: 0,
        }
      })
    }
    case "codeBlock": {
      const language = String(node.attrs?.language ?? "") || ""
      return fence(language, textOf(node.content ?? []))
    }
    case "shardBlock":
      return fence(String(node.attrs?.lang ?? ""), String(node.attrs?.source ?? ""))
    case "rawBlock":
      return String(node.attrs?.source ?? "")
    case "horizontalRule":
      return "---"
    case "csvEmbed":
      return `![[${String(node.attrs?.path ?? "")}]]`
    case "table":
      return serializeTable(node)
    default:
      return serializeInline(node.content ?? [])
  }
}

function serializeList(
  node: JSONContent,
  marker: (item: JSONContent, index: number) => { marker: string; indent: number; key: number }
) {
  const items = node.content ?? []
  return items
    .map((item, index) => {
      const { marker: prefix, indent } = marker(item, index)
      return indentBlock(prefix, serializeListItemBody(item.content ?? []), indent)
    })
    .join("\n")
}

/**
 * 列表项正文。标题段为空而后面还有内容时（空标题的备忘卡片、只挂子列表的项），
 * 首行只留标记、正文从下一行起：serializeBlocks 会裁掉开头的空白，
 * 不在这里单独处理的话，后面的备注或子项就被顶上来当成了标题。
 */
function serializeListItemBody(content: JSONContent[]): string {
  const [first, ...rest] = content
  const emptyTitle =
    first?.type === "paragraph" && serializeInline(first.content ?? []) === "" && rest.length > 0
  if (!emptyTitle) return serializeBlocks(content, true)
  const glue = LIST_TYPES.has(rest[0].type ?? "") ? "\n" : "\n\n"
  return `${glue}${serializeBlocks(rest, true)}`
}

function indentBlock(marker: string, body: string, indent: number) {
  const pad = " ".repeat(indent)
  const lines = body.split("\n")
  return lines
    .map((line, index) => {
      if (index === 0) return `${marker}${line}`.replace(/\s+$/u, "")
      return line ? `${pad}${line}` : ""
    })
    .join("\n")
}

function prefixLines(body: string, prefix: string) {
  return body
    .split("\n")
    .map((line) => (line ? `${prefix} ${line}` : prefix))
    .join("\n")
}

function fence(language: string, source: string) {
  const longest = [...source.matchAll(/`{3,}/gu)].reduce((max, match) => Math.max(max, match[0].length), 2)
  const ticks = "`".repeat(Math.max(3, longest + 1))
  return `${ticks}${language}\n${source}\n${ticks}`
}

function textOf(nodes: JSONContent[]) {
  return nodes.map((node) => node.text ?? "").join("")
}

function serializeTable(node: JSONContent) {
  const rows = node.content ?? []
  if (rows.length === 0) return ""

  const cellRows = rows.map((row) =>
    (row.content ?? []).map((cell) => serializeInline(cell.content?.[0]?.content ?? [], { inTable: true }))
  )
  const align = (rows[0].content ?? []).map((cell) => String(cell.attrs?.align ?? "") || null)
  const delimiter = align.map((value) => {
    if (value === "center") return ":-:"
    if (value === "right") return "--:"
    if (value === "left") return ":--"
    return "---"
  })

  const lines = [toTableRow(cellRows[0]), toTableRow(delimiter), ...cellRows.slice(1).map(toTableRow)]
  return lines.join("\n")
}

function toTableRow(cells: string[]) {
  return `| ${cells.join(" | ")} |`
}

// ---------------------------------------------------------------------------
// 行内
// ---------------------------------------------------------------------------

class InlineWriter {
  private output = ""
  private lineStart = true

  constructor(private readonly options: InlineOptions) {}

  get text() {
    return this.output
  }

  private get lastChar() {
    return this.output.length > 0 ? this.output[this.output.length - 1] : ""
  }

  raw(value: string) {
    if (!value) return
    this.output += value
    this.lineStart = value.endsWith("\n")
  }

  text_(value: string) {
    if (!value) return
    const source = this.options.inTable ? value.replace(/\n/gu, " ") : value
    const lines = source.split("\n")
    lines.forEach((line, index) => {
      if (index > 0) {
        this.output += "\n"
        this.lineStart = true
      }
      if (!line) return
      this.output += escapeLine(line, this.lineStart, this.lastChar, Boolean(this.options.inTable))
      this.lineStart = false
    })
  }

  /** 标签写回时保证前后都是边界，否则重新解析会粘成另一个标签。 */
  tag(name: string) {
    const previous = this.lastChar
    if (previous && !isTagBoundary(previous)) this.raw(" ")
    this.output += `#${name}`
    this.lineStart = false
  }
}

function serializeInline(nodes: JSONContent[], options: InlineOptions = {}): string {
  const writer = new InlineWriter(options)
  const prepared = nodes.map(collapseAutolink)
  let active: MarkSpec[] = []

  const closeTo = (keep: number) => {
    for (let index = active.length - 1; index >= keep; index -= 1) {
      writer.raw(closeMark(active[index]))
    }
    active = active.slice(0, keep)
  }

  for (let index = 0; index < prepared.length; index += 1) {
    const { node, autolink } = prepared[index]
    const marks = autolink ? [] : reorderMarks(sortMarks((node.marks ?? []) as MarkSpec[]), active)
    let keep = 0
    while (keep < active.length && keep < marks.length && sameMark(active[keep], marks[keep])) keep += 1
    closeTo(keep)
    for (let markIndex = keep; markIndex < marks.length; markIndex += 1) {
      writer.raw(openMark(marks[markIndex]))
      active.push(marks[markIndex])
    }
    writeInlineNode(node, writer, prepared[index + 1]?.node, autolink)
  }
  closeTo(0)

  return writer.text
}

function writeInlineNode(
  node: JSONContent,
  writer: InlineWriter,
  next: JSONContent | undefined,
  autolink: boolean
) {
  if (node.type === "text") {
    const marks = (node.marks ?? []) as MarkSpec[]
    const text = node.text ?? ""
    if (autolink) {
      writer.raw(text)
      return
    }
    if (marks.some((mark) => mark.type === "code")) {
      writer.raw(inlineCode(text))
      return
    }
    writer.text_(text)
    return
  }

  if (node.type === "hardBreak") {
    writer.raw("\\\n")
    return
  }

  if (node.type === "tag") {
    writer.tag(String(node.attrs?.name ?? ""))
    const following = next?.type === "text" ? (next.text ?? "") : ""
    const head = following.charAt(0)
    if (head && head !== "#" && !isTagBoundary(head)) writer.raw(" ")
    return
  }

  if (node.type === "wikilink") {
    const target = String(node.attrs?.target ?? "")
    const alias = node.attrs?.alias ? String(node.attrs.alias) : ""
    writer.raw(alias ? `[[${target}|${alias}]]` : `[[${target}]]`)
    return
  }

  if (node.type === "image") {
    const alt = node.attrs?.alt ? String(node.attrs.alt) : ""
    const title = node.attrs?.title ? String(node.attrs.title) : ""
    const src = destination(String(node.attrs?.src ?? ""))
    writer.raw(title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`)
    return
  }

  writer.text_(node.text ?? "")
}

/** 文本与目标相同的链接写回裸 URL，保持 GFM autolink 的原貌。 */
function collapseAutolink(node: JSONContent): { node: JSONContent; autolink: boolean } {
  const marks = (node.marks ?? []) as MarkSpec[]
  if (node.type !== "text" || marks.length !== 1 || marks[0].type !== "link") return { node, autolink: false }
  if (marks[0].attrs?.title) return { node, autolink: false }
  const href = String(marks[0].attrs?.href ?? "")
  if (href !== node.text || !AUTOLINKABLE.test(href)) return { node, autolink: false }
  return { node, autolink: true }
}

function sortMarks(marks: MarkSpec[]): MarkSpec[] {
  return marks
    .filter((mark) => mark.type !== "code")
    .slice()
    .sort((a, b) => markRank(a.type) - markRank(b.type))
}

/**
 * 已经打开的标记优先保持原有嵌套顺序：只按固定 rank 排序时，
 * `**粗体 ==高亮==**` 会被拆成 `**粗体 **==**高亮**==`，语义和文本都变了。
 */
function reorderMarks(marks: MarkSpec[], active: MarkSpec[]): MarkSpec[] {
  const kept = marks
    .filter((mark) => active.some((open) => sameMark(open, mark)))
    .sort(
      (a, b) =>
        active.findIndex((open) => sameMark(open, a)) - active.findIndex((open) => sameMark(open, b))
    )
  const added = marks.filter((mark) => !active.some((open) => sameMark(open, mark)))
  return [...kept, ...added]
}

function markRank(type: string) {
  const index = MARK_ORDER.indexOf(type)
  return index < 0 ? MARK_ORDER.length : index
}

function sameMark(a: MarkSpec, b: MarkSpec) {
  return a.type === b.type && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {})
}

function openMark(mark: MarkSpec) {
  if (mark.type === "link") return "["
  if (mark.type === "underline") return "<u>"
  return MARK_DELIMITERS[mark.type] ?? ""
}

function closeMark(mark: MarkSpec) {
  if (mark.type === "link") {
    const href = destination(String(mark.attrs?.href ?? ""))
    const title = mark.attrs?.title ? String(mark.attrs.title) : ""
    return title ? `](${href} "${title}")` : `](${href})`
  }
  if (mark.type === "underline") return "</u>"
  return MARK_DELIMITERS[mark.type] ?? ""
}

function destination(href: string) {
  if (!href) return ""
  if (/[\s<>]/u.test(href)) return `<${href.replace(/([<>])/gu, "\\$1")}>`
  return href.replace(/([()])/gu, "\\$1")
}

function inlineCode(text: string) {
  const longest = [...text.matchAll(/`+/gu)].reduce((max, match) => Math.max(max, match[0].length), 0)
  const ticks = "`".repeat(longest + 1)
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : ""
  return `${ticks}${pad}${text}${pad}${ticks}`
}

// ---------------------------------------------------------------------------
// 转义：只在会被重新解析成语法的位置加反斜杠，卡片按字面渲染源码，多转义即可见噪音。
// ---------------------------------------------------------------------------

function escapeLine(line: string, atLineStart: boolean, previousChar: string, inTable: boolean) {
  let out = ""
  let index = 0

  if (atLineStart) {
    const consumed = escapeLineStart(line)
    if (consumed) {
      out += consumed.text
      index = consumed.length
    }
  }

  for (; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1] ?? ""
    const previous = out.length > 0 ? out[out.length - 1] : previousChar

    if (char === "\\" || char === "`" || char === "*" || char === "[") {
      out += `\\${char}`
      continue
    }
    if (char === "_") {
      const before = index > 0 ? line[index - 1] : ""
      out += WORD_CHAR.test(before) && WORD_CHAR.test(next) ? "_" : "\\_"
      continue
    }
    if (char === "<" && /[A-Za-z/!?]/u.test(next)) {
      out += "\\<"
      continue
    }
    if (char === "&" && ENTITY_AT.test(line.slice(index))) {
      out += "\\&"
      continue
    }
    if ((char === "~" || char === "=") && next === char) {
      out += `\\${char}`
      continue
    }
    if (char === "|" && inTable) {
      out += "\\|"
      continue
    }
    if (char === "#" && (!previous || isTagBoundary(previous))) {
      const ranges = getTagRanges(line.slice(index))
      out += ranges.length > 0 && ranges[0].start === 0 ? "\\#" : "#"
      continue
    }
    out += char
  }

  return out
}

function escapeLineStart(line: string): { text: string; length: number } | null {
  if (LINE_HORIZONTAL_RULE.test(line) || LINE_SETEXT.test(line)) {
    return { text: `\\${line[0]}`, length: 1 }
  }
  const heading = /^#{1,6}(?:[ \t]|$)/u.exec(line)
  if (heading) return { text: "\\#", length: 1 }
  const bullet = /^[-+](?:[ \t]|$)/u.exec(line)
  if (bullet) return { text: `\\${line[0]}`, length: 1 }
  const ordered = /^(\d{1,9})([.)])(?:[ \t]|$)/u.exec(line)
  if (ordered) return { text: `${ordered[1]}\\${ordered[2]}`, length: ordered[1].length + 1 }
  if (line.startsWith(">")) return { text: "\\>", length: 1 }
  return null
}
