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
const WORD_CHAR = /[\p{L}\p{N}]/u
const LINE_HORIZONTAL_RULE = /^(?:-{3,}|\*{3,}|_{3,})[ \t]*$/u
const LINE_SETEXT = /^(?:={1,}|-{1,})[ \t]*$/u
const LINE_TABLE_DELIMITER = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/u

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
  if (!tightLists) return serializeLineBlocks(nodes)

  const parts: string[] = []
  nodes.forEach((node, index) => {
    const text = serializeBlock(node)
    const previous = nodes[index - 1]
    // An empty paragraph is one visible blank row, in addition to the normal
    // Markdown paragraph delimiter. Do not collapse it during serialization.
    const emptyParagraph = node.type === "paragraph" && text === ""
    const glue = emptyParagraph || (previous && tightLists && LIST_TYPES.has(node.type ?? "")) ? "\n" : "\n\n"
    if (parts.length === 0) parts.push(text)
    else parts.push(glue, text)
  })

  const joined = parts.join("")
  return joined.replace(/^\s+|\s+$/gu, "")
}

/**
 * 顶层文档与引用块：源码一行就是显示的一行。相邻两段用一个换行连接；
 * 有一侧是标题、列表等其他块时，中间留一个 Markdown 分隔空行。
 * 每个空段落再多写一个空行，读回来就是一行空白。与 parseLineBlocks 互逆。
 */
function serializeLineBlocks(nodes: JSONContent[]): string {
  const parts: string[] = []
  let previous: JSONContent | null = null
  let emptyRows = 0
  for (const node of nodes) {
    let text = serializeBlock(node)
    if (node.type === "paragraph") {
      // 行尾两个空格会被读成硬换行，把下一行并进这一段。
      text = text.replace(/[ \t]+$/u, "")
      if (!text.trim()) {
        if (previous) emptyRows += 1
        continue
      }
    }
    if (previous) {
      const bothParagraphs = previous.type === "paragraph" && node.type === "paragraph"
      parts.push(`${bothParagraphs ? "\n" : "\n\n"}${"\n".repeat(emptyRows)}`)
    }
    parts.push(text)
    previous = node
    emptyRows = 0
  }
  return parts.join("").replace(/^\s+|\s+$/gu, "")
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
      }, serializeTaskItemBody)
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
  marker: (item: JSONContent, index: number) => { marker: string; indent: number; key: number },
  body: (item: JSONContent) => string = (item) => serializeListItemBody(item.content ?? [])
) {
  const items = node.content ?? []
  return items
    .map((item, index) => {
      const { marker: prefix, indent } = marker(item, index)
      return indentBlock(prefix, body(item), indent)
    })
    .join("\n")
}

/**
 * 任务项正文：`reminder` 属性（解析时从标题行尾提升上来的提醒）写回标题第一行末尾，
 * 与 `liftTrailingReminder` 互逆——有标题时隔一个空格，空标题时整行就是提醒。
 */
function serializeTaskItemBody(item: JSONContent): string {
  const content = item.content ?? []
  const at = item.attrs?.reminder ? String(item.attrs.reminder) : ""
  if (!at) return serializeListItemBody(content)

  const token = `⏰ ${at}`
  const [first, ...rest] = content
  const title = first?.type === "paragraph" ? serializeInline(first.content ?? []) : ""
  if (!title) {
    if (rest.length === 0) return token
    const glue = LIST_TYPES.has(rest[0].type ?? "") ? "\n" : "\n\n"
    return `${token}${glue}${serializeBlocks(rest, true)}`
  }

  // 行尾空白在 Markdown 里无意义，去掉后恰好一个空格分隔，重新读取才会再次提升。
  const body = serializeListItemBody(content)
  const lineEnd = body.indexOf("\n")
  const line = (lineEnd < 0 ? body : body.slice(0, lineEnd)).replace(/[ \t]+$/u, "")
  return `${line} ${token}${lineEnd < 0 ? "" : body.slice(lineEnd)}`
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

/** 正文里先写成 `\[` 的方括号，整段写完后由 settleBrackets 决定反斜杠去留。 */
interface PendingBracket {
  /** 反斜杠在输出里的位置。 */
  at: number
  /** 这一行文字写到哪为止：配对的 `]` 不在这段里，说明方括号跨过了别的节点。 */
  end: number
  /** 写下时打开着几层标记。 */
  depth: number
}

/** 每写一个标记符号后的位置与打开着的层数。 */
interface MarkStep {
  at: number
  depth: number
}

class InlineWriter {
  private output = ""
  private lineStart = true
  private depth = 0
  private readonly brackets: PendingBracket[] = []
  private readonly steps: MarkStep[] = []
  /** 最近一段正文写到哪为止，用来判断末尾字符是不是正文写的。 */
  private textEnd = -1

  constructor(private readonly options: InlineOptions) {}

  get text() {
    return settleBrackets(this.output, this.brackets, this.steps)
  }

  private get lastChar() {
    return this.output.length > 0 ? this.output[this.output.length - 1] : ""
  }

  raw(value: string) {
    if (!value) return
    this.output += value
    this.lineStart = value.endsWith("\n")
  }

  /**
   * 紧跟着要写语法符号时，正文末尾那个字符若会和它粘成别的语法就转义掉：`!` 贴着
   * 链接的 `[` 成了图片；`=`、`~` 贴着高亮、删除线符号成了分不清的 `===`、`~~~`。
   */
  guardTextEnd(symbol: string) {
    const end = this.output.length
    if (this.textEnd !== end) return
    const last = this.lastChar
    const sticks = symbol === "[" ? last === "!" : (last === "=" || last === "~") && symbol.startsWith(last)
    if (!sticks || isEscaped(this.output, end - 1)) return
    this.output = `${this.output.slice(0, -1)}\\${last}`
    for (const bracket of this.brackets) if (bracket.end === end) bracket.end += 1
  }

  /** 标记的开合符号：`delta` 为 1 是打开、-1 是关上。 */
  mark(value: string, delta: 1 | -1) {
    this.guardTextEnd(value)
    this.raw(value)
    this.depth += delta
    this.steps.push({ at: this.output.length, depth: this.depth })
  }

  /** `inLink`：链接文字里的方括号一律转义，`]` 也要转义，否则会提前截断链接。 */
  text_(value: string, inLink = false) {
    if (!value) return
    const source = this.options.inTable ? value.replace(/\n/gu, " ") : value
    const lines = source.split("\n")
    lines.forEach((line, index) => {
      if (index > 0) {
        this.output += "\n"
        this.lineStart = true
      }
      if (!line) return
      const brackets: number[] = []
      const escaped = escapeLine(line, this.lineStart, this.lastChar, {
        brackets: inLink ? null : brackets,
        inLink,
        inTable: Boolean(this.options.inTable),
      })
      const start = this.output.length
      this.output += escaped
      for (const offset of brackets) {
        this.brackets.push({ at: start + offset, depth: this.depth, end: this.output.length })
      }
      this.lineStart = false
      this.textEnd = this.output.length
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
      writer.mark(closeMark(active[index]), -1)
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
      writer.mark(openMark(marks[markIndex]), 1)
      active.push(marks[markIndex])
    }
    writeInlineNode(node, writer, prepared[index + 1]?.node, autolink, index + 2 >= prepared.length)
  }
  closeTo(0)

  return writer.text
}

function writeInlineNode(
  node: JSONContent,
  writer: InlineWriter,
  next: JSONContent | undefined,
  autolink: boolean,
  nextIsLast: boolean
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
    writer.text_(text, marks.some((mark) => mark.type === "link"))
    return
  }

  if (node.type === "hardBreak") {
    writer.raw("\\\n")
    return
  }

  if (node.type === "tag") {
    const name = String(node.attrs?.name ?? "")
    writer.tag(name)
    if (next?.type === "text") {
      if (tagSwallows(name, node, next, nextIsLast)) writer.raw(" ")
    }
    // 标签一直吃到空白为止，紧跟的提醒不隔开就会被读成标签的一部分。
    else if (next?.type === "reminder") writer.raw(" ")
    return
  }

  if (node.type === "reminder") {
    // 原样写回 `⏰ YYYY-MM-DD HH:mm`；前后空白属于相邻文本节点，这里不增不减，保证往返字节不变。
    writer.raw(`⏰ ${String(node.attrs?.at ?? "")}`)
    return
  }

  if (node.type === "wikilink") {
    const target = String(node.attrs?.target ?? "")
    const alias = node.attrs?.alias ? String(node.attrs.alias) : ""
    // `![[笔记]]` 后面紧跟 `[`、`(` 时整段会被读成图片，把后面的链接吞掉；
    // 只在这种时候转义 `!`，单独的 `![[笔记]]` 保持原样。
    const head = next?.type === "text" ? (next.text ?? "").charAt(0) : ""
    const opensLink = next?.type === "text" && (next.marks ?? []).some((mark) => mark.type === "link")
    if (head === "[" || head === "(" || opensLink) writer.guardTextEnd("[")
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

/**
 * 标签后面紧跟的文字会不会被读进标签。标签一直吃到空白或下一个 `#`，再去掉结尾
 * 标点，`(#骑行)` 的 `)` 不算标签、`#骑行，今天` 却整串都是。能看到停止位置时
 * （同样的标记、后面写到空白，或者就是行内最后一段）直接拿 getTagRanges 试读；
 * 中间夹着标记符号时沿用按首字符判断的旧规则。
 */
function tagSwallows(name: string, tag: JSONContent, next: JSONContent, nextIsLast: boolean) {
  const following = next.text ?? ""
  const plain = (tag.marks ?? []).length === 0
  const sameMarks = JSON.stringify(tag.marks ?? []) === JSON.stringify(next.marks ?? [])
  if (sameMarks && (/[\s#]/u.test(following) || (nextIsLast && plain))) {
    const written = `#${name}`
    const range = getTagRanges(`${written}${following}`)[0]
    return range?.start !== 0 || range.end !== written.length
  }
  const head = following.charAt(0)
  return Boolean(head) && head !== "#" && !isTagBoundary(head)
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

interface EscapeContext {
  inTable: boolean
  inLink: boolean
  /** 收集正文 `[` 转义处的反斜杠位置，交给 settleBrackets；为 null 时一律保留转义。 */
  brackets: number[] | null
}

function escapeLine(line: string, atLineStart: boolean, previousChar: string, context: EscapeContext) {
  const { inTable, inLink, brackets } = context
  let out = ""
  let index = 0

  if (atLineStart) {
    const consumed = escapeLineStart(line, inTable)
    if (consumed) {
      out += consumed.text
      index = consumed.length
    }
  }

  for (; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1] ?? ""
    const previous = out.length > 0 ? out[out.length - 1] : previousChar

    if (char === "[") {
      brackets?.push(out.length)
      out += "\\["
      continue
    }
    if (char === "]" && inLink) {
      out += "\\]"
      continue
    }
    if (char === "\\" || char === "`" || char === "*") {
      out += `\\${char}`
      continue
    }
    if (char === "_") {
      // `_` 按连续的一串看：整串夹在字母数字中间才不会成强调（snake_case），否则整串
      // 转义——`__init__` 只转义头尾各一个，剩下的 `_init_` 会被读成斜体。
      let runEnd = index
      while (line[runEnd] === "_") runEnd += 1
      const before = index > 0 ? line[index - 1] : ""
      const intraword = WORD_CHAR.test(before) && WORD_CHAR.test(line[runEnd] ?? "")
      out += (intraword ? "_" : "\\_").repeat(runEnd - index)
      index = runEnd - 1
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
    // 成对的 `==`、`~~` 是高亮、删除线；紧接在同样的符号后面也会粘成一串。
    if ((char === "~" || char === "=") && (next === char || (out.length === 0 && previousChar === char))) {
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

function escapeLineStart(line: string, inTable: boolean): { text: string; length: number } | null {
  if (LINE_HORIZONTAL_RULE.test(line) || LINE_SETEXT.test(line)) {
    return { text: `\\${line[0]}`, length: 1 }
  }
  // 段落行之间只隔一个换行，长得像表格分隔行的一行会把上一行变成表头。
  if (!inTable && /[|:]/u.test(line) && LINE_TABLE_DELIMITER.test(line)) {
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

/**
 * 正文里的 `[` 写的时候一律先转义，整段写完再回头放行：读回来确定还是字面方括号的
 * 去掉反斜杠，`[停顿]` 这类写法保存后原样不动。解析器把没有目标的 `[文本]` 读回字面
 * 方括号（里面照常解析），所以只要拼不出真正的语法就能放行：
 * - 后面有配对的 `]`，中间没有别的 `[`、换行和提醒；跨过别的节点时，中间打开的
 *   标记要在方括号里关上、外层标记不能中途关掉，也不能夹着标签、行内代码、网址；
 * - `]` 后面不是 `(`、`[`：否则是行内链接、图片、引用式链接；没有目标的 `![文本]`
 *   同样读回字面；
 * - 前面不是 `[`（双链）或反斜杠；前面的 `]` 无妨，上一对方括号后面紧跟 `[` 时
 *   自己就不放行，这个 `]` 关不上任何东西；
 * - 在行首时不是任务框 `[ ]`、`[x]`，也不是引用定义 `[文本]:`。
 * 链接文字里的方括号不经过这里，始终转义。
 */
function settleBrackets(output: string, brackets: readonly PendingBracket[], steps: readonly MarkStep[]) {
  if (brackets.length === 0) return output
  let settled = ""
  let cursor = 0
  let firstStep = 0
  for (const bracket of brackets) {
    // 方括号按位置先后排列：在它之前的标记符号以后都用不上。
    while (firstStep < steps.length && steps[firstStep].at <= bracket.at) firstStep += 1
    if (!isLiteralBracket(output, bracket, steps, firstStep)) continue
    settled += output.slice(cursor, bracket.at)
    cursor = bracket.at + 1
  }
  return settled + output.slice(cursor)
}

/** 下一个方括号或换行：只找到这里为止，一段里再多 `[` 也是线性扫描。 */
const NEXT_BRACKET = /[[\]\n]/gu

function isLiteralBracket(
  output: string,
  bracket: PendingBracket,
  steps: readonly MarkStep[],
  firstStep: number
) {
  const { at, depth, end } = bracket
  const before = output[at - 1] ?? ""
  if (before === "[" || before === "\\") return false
  NEXT_BRACKET.lastIndex = at + 2
  const close = NEXT_BRACKET.exec(output)?.index ?? -1
  if (close < 0 || output[close] !== "]") return false
  const label = output.slice(at + 2, close)
  if (label.includes("⏰")) return false
  if (close >= end && (/[#`]|:\/\/|www\./iu.test(label) || !staysAtDepth(steps, firstStep, close, depth))) {
    return false
  }
  const after = output[close + 1] ?? ""
  if (after === "(" || after === "[" || (after === "\\" && output[close + 2] === "[")) return false
  const lineStart = at === 0 || before === "\n"
  if (lineStart && (after === ":" || /^[ xX]$/u.test(label))) return false
  return true
}

/** 从 `firstStep` 起到 `to` 为止打开的标记都在这一段里关上，外层的标记也没有中途关掉。 */
function staysAtDepth(steps: readonly MarkStep[], firstStep: number, to: number, depth: number) {
  let current = depth
  for (let index = firstStep; index < steps.length && steps[index].at <= to; index += 1) {
    if (steps[index].depth < depth) return false
    current = steps[index].depth
  }
  return current === depth
}

/** `index` 处的字符前面有奇数个反斜杠，已经是转义过的字面字符。 */
function isEscaped(output: string, index: number) {
  let count = 0
  for (let cursor = index - 1; cursor >= 0 && output[cursor] === "\\"; cursor -= 1) count += 1
  return count % 2 === 1
}
