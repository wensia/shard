import { parseMarkdownTable, parseMarkdownTableRow, type MarkdownTable } from "./core/table.js"
import {
  getTagRanges,
  isMarkdownHorizontalRuleLine,
  parseMarkdownImageLine,
  type MarkdownImage,
} from "./core/text.js"

export const ASYNC_MARKDOWN_THRESHOLD = 32_000
export const INLINE_HIGHLIGHT_FALLBACK_PATTERN = /==(.+?)==/g

const TASK_MARKER_PATTERN = /^(\s*)((?:[-*+]|\d+[.)])\s+)(\[([ xX])\]\s*)(.*)$/
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/
const ORDERED_LIST_PATTERN = /^\s*\d+[.)]\s+(.+)$/
const UNORDERED_LIST_PATTERN = /^\s*[-*+]\s+(.+)$/
const QUOTE_PATTERN = /^>\s?(.*)$/
const FENCE_PATTERN = /^```(\S*)\s*$/
// The document renderer historically accepts exactly three rule markers.
const DOCUMENT_RULE_PATTERN = /^\s*(?:---|\*\*\*|___)\s*$/
const INLINE_PATTERN = /(\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)]+\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g

export type MarkdownInlineToken =
  | { type: "text" | "code" | "strong" | "em"; text: string }
  | { type: "link"; text: string; href: string }

export interface MarkdownInlineText {
  text: string
  tokens: MarkdownInlineToken[]
}

export type MarkdownDocumentBlock =
  | { type: "heading"; level: number; inline: MarkdownInlineText }
  | { type: "list"; items: MarkdownInlineText[]; ordered: boolean }
  | { type: "paragraph" | "quote"; inline: MarkdownInlineText }
  | { type: "code"; code: string; language: string }
  | { type: "rule" }

export interface MarkdownContentLine {
  type: "line"
  source: string
  lineIndex: number
  display: string
  hidden: boolean
  image: MarkdownImage | null
  rule: boolean
  task: {
    indentation: string
    listMarker: string
    ordered: boolean
    checked: boolean
    body: string
  } | null
}

/** Row storage is shared across table candidates, so overlapping delimiters remain linear in memory. */
export interface MarkdownContentTable extends MarkdownTable {
  rowStart: number
  rowEnd: number
}

export type MarkdownContentBlock = MarkdownContentLine | {
  type: "table"
  source: string
  lineIndex: number
  table: MarkdownContentTable
}

export interface ParsedMarkdownContent {
  kind: "content"
  blocks: MarkdownContentBlock[]
  lastVisibleIndex: number
}

export interface ParsedMarkdownDocument {
  kind: "document"
  blocks: MarkdownDocumentBlock[]
}

export type ParsedMarkdown = ParsedMarkdownContent | ParsedMarkdownDocument
export type MarkdownParseRequest =
  | { kind: "document"; content: string }
  | { kind: "content"; content: string; hideTags?: boolean; renderImages?: boolean }

export function parseMarkdown(request: MarkdownParseRequest): ParsedMarkdown {
  return request.kind === "document"
    ? parseMarkdownDocument(request.content)
    : parseMarkdownContent(request.content, request)
}

export function parseMarkdownDocument(content: string): ParsedMarkdownDocument {
  const lines = content.replace(/\r\n?/g, "\n").split("\n")
  const blocks: MarkdownDocumentBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      index += 1
      continue
    }
    const fenceMatch = line.match(FENCE_PATTERN)
    if (fenceMatch) {
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !FENCE_PATTERN.test(lines[index])) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ type: "code", code: codeLines.join("\n"), language: fenceMatch[1] ?? "" })
      continue
    }
    const heading = line.match(HEADING_PATTERN)
    if (heading) {
      blocks.push({ type: "heading", level: Math.min(heading[1].length, 4), inline: parseInline(heading[2].trim()) })
      index += 1
      continue
    }
    if (DOCUMENT_RULE_PATTERN.test(line)) {
      blocks.push({ type: "rule" })
      index += 1
      continue
    }
    const quote = line.match(QUOTE_PATTERN)
    if (quote) {
      const quoteLines = [quote[1]]
      index += 1
      while (index < lines.length) {
        const next = lines[index].match(QUOTE_PATTERN)
        if (!next) break
        quoteLines.push(next[1])
        index += 1
      }
      blocks.push({ type: "quote", inline: parseInline(quoteLines.join(" ")) })
      continue
    }
    const ordered = line.match(ORDERED_LIST_PATTERN)
    const unordered = line.match(UNORDERED_LIST_PATTERN)
    if (ordered || unordered) {
      const pattern = ordered ? ORDERED_LIST_PATTERN : UNORDERED_LIST_PATTERN
      const items: MarkdownInlineText[] = []
      while (index < lines.length) {
        const next = lines[index].match(pattern)
        if (!next) break
        items.push(parseInline(next[1].trim()))
        index += 1
      }
      blocks.push({ type: "list", ordered: Boolean(ordered), items })
      continue
    }
    const paragraphLines = [trimmed]
    index += 1
    while (index < lines.length && isParagraphContinuation(lines[index])) {
      paragraphLines.push(lines[index].trim())
      index += 1
    }
    blocks.push({ type: "paragraph", inline: parseInline(paragraphLines.join(" ")) })
  }
  return { kind: "document", blocks }
}

export function parseMarkdownContent(
  content: string,
  options: { hideTags?: boolean; renderImages?: boolean } = {}
): ParsedMarkdownContent {
  const lines = content.split("\n")
  const blocks: MarkdownContentBlock[] = []
  let lastVisibleIndex = -1
  // Lex each row once. Every table candidate references this shared array instead
  // of reparsing/copying its entire suffix (delimiter-only tables may overlap).
  const rows = lines.map(parseMarkdownTableRow)
  const rowEnds: number[] = []
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = rows[index].length > 1 || /^\s*\|/.test(lines[index])
    rowEnds[index] = candidate && lines[index].trim() ? (rowEnds[index + 1] ?? index + 1) : index
  }
  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index]
    const line = parseContentLine(source, index, options)
    if (!line.hidden) lastVisibleIndex = index
    const header = index + 1 < lines.length
      ? parseMarkdownTable([source, lines[index + 1]], 0) : null
    if (header) {
      const rowStart = index + 2
      const rowEnd = rowEnds[rowStart] ?? rowStart
      blocks.push({ type: "table", source, lineIndex: index,
        table: { ...header, rows, rowStart, rowEnd, lineCount: rowEnd - index } })
    } else {
      blocks.push(line)
    }
  }
  return { kind: "content", blocks, lastVisibleIndex }
}

function parseContentLine(
  source: string,
  lineIndex: number,
  options: { hideTags?: boolean; renderImages?: boolean }
): MarkdownContentLine {
  const image = options.renderImages ? parseMarkdownImageLine(source) : null
  const display = options.hideTags && !image ? stripTagsFromLine(source) : source
  const hidden = options.hideTags && !image && display.length === 0 && source.length > 0
  const taskMatch = display.match(TASK_MARKER_PATTERN)
  return {
    type: "line", source, lineIndex, display, hidden: Boolean(hidden), image,
    rule: isMarkdownHorizontalRuleLine(display),
    task: taskMatch ? {
      indentation: taskMatch[1], listMarker: taskMatch[2],
      ordered: /^\d+[.)]\s+$/.test(taskMatch[2]),
      checked: taskMatch[4].toLowerCase() === "x", body: taskMatch[5] ?? "",
    } : null,
  }
}

/** Cheap block-layout hint. Large content is conservatively block-level without parsing on the UI thread. */
export function containsMarkdownBlocks(content: string, isEmbed?: (line: string) => boolean): boolean {
  if (content.length > ASYNC_MARKDOWN_THRESHOLD) return true
  const lines = content.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    if (isEmbed?.(lines[index])) return true
    // Detection only needs the header and delimiter; never parse all following rows.
    if (index + 1 < lines.length && parseMarkdownTable([lines[index], lines[index + 1]], 0)) return true
  }
  return false
}

export function stripTagsFromLine(line: string): string {
  const ranges = getTagRanges(line)
  if (ranges.length === 0) return line
  const parts: string[] = []
  let cursor = 0
  for (const range of ranges) {
    parts.push(line.slice(cursor, range.start))
    cursor = range.end
  }
  parts.push(line.slice(cursor))
  return parts.join("").replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+|[ \t]+$/g, "")
}

function isParagraphContinuation(line: string) {
  return line.trim().length > 0 && !FENCE_PATTERN.test(line) && !HEADING_PATTERN.test(line)
    && !ORDERED_LIST_PATTERN.test(line) && !UNORDERED_LIST_PATTERN.test(line)
    && !QUOTE_PATTERN.test(line) && !DOCUMENT_RULE_PATTERN.test(line)
}

function parseInline(text: string): MarkdownInlineText {
  const tokens: MarkdownInlineToken[] = []
  let cursor = 0
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const token = match[0]
    const start = match.index ?? 0
    if (start > cursor) tokens.push({ type: "text", text: text.slice(cursor, start) })
    if (token.startsWith("`")) tokens.push({ type: "code", text: token.slice(1, -1) })
    else if (token.startsWith("**") || token.startsWith("__")) tokens.push({ type: "strong", text: token.slice(2, -2) })
    else if (token.startsWith("*") || token.startsWith("_")) tokens.push({ type: "em", text: token.slice(1, -1) })
    else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      tokens.push(link ? { type: "link", text: link[1], href: link[2] } : { type: "text", text: token })
    }
    cursor = start + token.length
  }
  if (cursor < text.length) tokens.push({ type: "text", text: text.slice(cursor) })
  return { text, tokens }
}
