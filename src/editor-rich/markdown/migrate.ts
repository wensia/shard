import { markdownParser } from "@shard/markdown/core"

import { isCsvWikilinkTarget } from "@/lib/wikilink"

import { splitFrontmatter } from "./frontmatter"

type LezerNode = ReturnType<typeof markdownParser.parse>["topNode"]

interface GapEdit {
  from: number
  to: number
  text: string
}

const CSV_EMBED_LINE_PATTERN = /^!\[\[([^\]\n|]+)\]\]$/u

/**
 * 把旧方言（v1）的正文改写成方言 v2，显示效果不变，只调整块与块之间的换行数量，
 * 其余字节一律不动（不经过 serialize，免得顺带改掉转义、列表符号等）。
 *
 * - 旧方言里段落之间的一个空行只是分隔符，不显示；v2 里它显示为一行空白，所以删掉一个。
 * - 旧方言只在段落与段落之间识别空段落；其他块之间多出来的空行不显示，压成一个分隔空行。
 * - 引用块里段落之间的 `>` 空行旧方言不显示，删掉。
 * - 列表项内部、代码块内部不动；段内软换行旧方言显示为换行，v2 是相邻两段，显示相同，也不动。
 *
 * 不是幂等的：同一份内容只能迁移一次，由资料库的格式版本标记保证。
 */
export function migrateLegacyParagraphGaps(markdown: string): string {
  // 方言只认 `\n`；CRLF 文件 Shard 本来就不读写，原样返回。
  if (markdown.includes("\r")) return markdown
  const { body } = splitFrontmatter(markdown)
  const prefix = markdown.slice(0, markdown.length - body.length)
  const tree = markdownParser.parse(body)
  const edits: GapEdit[] = []

  planGaps(childrenOf(tree.topNode), body, true, edits)
  for (const quote of collectBlockquotes(tree.topNode)) {
    planGaps(
      childrenOf(quote).filter((child) => child.name !== "QuoteMark"),
      body,
      false,
      edits
    )
  }

  let next = body
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    next = next.slice(0, edit.from) + edit.text + next.slice(edit.to)
  }
  return prefix + next
}

/**
 * `topLevel` 为真时沿用旧方言在顶层的规则：段落与段落之间多出来的空行是空段落。
 * 引用块里旧方言从不识别空段落（相邻段落之间隔着 `>` 标记）。
 */
function planGaps(nodes: LezerNode[], src: string, topLevel: boolean, edits: GapEdit[]) {
  for (let index = 1; index < nodes.length; index += 1) {
    const previous = nodes[index - 1]
    const node = nodes[index]
    const gap = src.slice(previous.to, node.from)
    if (!/^[\s>]*$/u.test(gap)) continue

    const segments = gap.split("\n")
    const newlines = segments.length - 1
    const legacyParagraphs = previous.name === "Paragraph" && node.name === "Paragraph"
    const legacyRows = topLevel && legacyParagraphs && /^\s+$/u.test(gap) ? Math.max(0, newlines - 2) : 0

    // v2 按解析出的块判断两侧是不是段落：单独一行的 csv 双链是嵌入块。
    const bothParagraphs =
      previous.name === "Paragraph" &&
      node.name === "Paragraph" &&
      !isCsvEmbedLine(lastLine(previous, src)) &&
      !isCsvEmbedLine(firstLine(node, src))
    const target = bothParagraphs ? legacyRows + 1 : legacyRows > 0 ? legacyRows + 2 : Math.min(newlines, 2)
    if (target >= newlines) continue

    // 保留首尾两段（上一块行尾、下一块行首的缩进与 `>`），只删中间的空行。
    const kept = [segments[0], ...segments.slice(1, target), segments[segments.length - 1]]
    edits.push({ from: previous.to, to: node.from, text: kept.join("\n") })
  }
}

function firstLine(node: LezerNode, src: string) {
  return stripQuote(src.slice(node.from, node.to).split("\n")[0])
}

function lastLine(node: LezerNode, src: string) {
  const lines = src.slice(node.from, node.to).split("\n")
  return stripQuote(lines[lines.length - 1])
}

function stripQuote(line: string) {
  return line.replace(/^[\s>]*/u, "").trim()
}

function isCsvEmbedLine(line: string) {
  const match = CSV_EMBED_LINE_PATTERN.exec(line)
  return Boolean(match && isCsvWikilinkTarget(match[1]))
}

function childrenOf(node: LezerNode): LezerNode[] {
  const children: LezerNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) children.push(child)
  return children
}

function collectBlockquotes(node: LezerNode, out: LezerNode[] = []): LezerNode[] {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "Blockquote") out.push(child)
    if (child.name !== "FencedCode" && child.name !== "CodeBlock") collectBlockquotes(child, out)
  }
  return out
}
