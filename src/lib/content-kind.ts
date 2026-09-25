/**
 * type 是受保护的单值标签，缺省即碎片（产品框架 §2）。
 *
 * - `note`：资料库笔记的历史值，文件落在 `notes/`，不在碎片流里。
 * - `outline`：大纲，整篇正文是一棵树，存为纯缩进列表（不加围栏）。
 * - `document`：文档，任意 Markdown，卡片只给标题与摘要。
 *
 * 顺序即 `deriveKind` 的判定顺序：一个碎片只能有一个 type，多写时取第一个。
 */
export const TYPE_TAGS = ["note", "outline", "document"] as const

export type TypeTag = (typeof TYPE_TAGS)[number]

export type ContentKind = "fragment" | TypeTag

export const OUTLINE_TYPE_TAG: TypeTag = "outline"
export const DOCUMENT_TYPE_TAG: TypeTag = "document"

/** 中文显示名：卡片徽标、速记框徽标与提示共用这一份，不各写各的。 */
export const CONTENT_KIND_LABELS: Record<ContentKind, string> = {
  document: "文档",
  fragment: "碎片",
  note: "笔记",
  outline: "大纲",
}

const NOTE_TITLE_MAX_LENGTH = 48
const DOCUMENT_TITLE_MAX_LENGTH = 40
const DOCUMENT_SUMMARY_MAX_LENGTH = 120
const HEADING_PATTERN = /^ {0,3}#{1,6}\s+(.+?)\s*$/u
const FENCE_PATTERN = /^\s*(?:```|~~~)/u

export function isTypeTag(tag: string) {
  return (TYPE_TAGS as readonly string[]).includes(tag)
}

export function deriveKind(tags: readonly string[]): ContentKind {
  return TYPE_TAGS.find((tag) => tags.includes(tag)) ?? "fragment"
}

/**
 * type 是单值：写入一个 type 标签前先摘掉其余 type 标签，
 * 保证「一个碎片只能有一个 type」在提取与规范化两侧一致。
 */
export function applyTypeTag(tags: readonly string[], typeTag: TypeTag): string[] {
  return [...tags.filter((tag) => !isTypeTag(tag)), typeTag]
}

/**
 * 碎片流承载碎片、大纲、文档三种类型（产品框架 §3「只有一条时间线」）；
 * 资料库笔记仍由资料库负责，不进碎片流。
 */
export function isStreamKind(kind: ContentKind) {
  return kind !== "note"
}

export function deriveNoteTitle(content: string) {
  const lines = content.split(/\r?\n/u)
  const heading = lines
    .map((line) => line.match(/^ {0,3}#\s+(.+?)\s*$/u)?.[1] ?? "")
    .find((title) => title.trim().length > 0)

  if (heading) {
    return heading
      .replace(/\s+#+\s*$/u, "")
      .trim()
  }

  const firstLine = lines.find((line) => line.trim().length > 0)?.trim() ?? ""
  if (firstLine.length <= NOTE_TITLE_MAX_LENGTH) return firstLine

  return `${firstLine.slice(0, NOTE_TITLE_MAX_LENGTH).trimEnd()}…`
}

export interface DocumentDigest {
  title: string
  summary: string
}

/**
 * 文档卡片的标题与摘要（产品框架 §2「标题 + 摘要」）：标题取正文首个标题行，
 * 没有标题行就取首行前 40 字；摘要是去掉标题那一行之后的前 120 字纯文本。
 * 卡片不渲染全文，所以这里必须把 Markdown 标记去干净。
 */
export function deriveDocumentDigest(content: string): DocumentDigest {
  const lines = content.split(/\r?\n/u)
  const headingIndex = lines.findIndex((line) => HEADING_PATTERN.test(line))

  if (headingIndex >= 0) {
    const heading = (HEADING_PATTERN.exec(lines[headingIndex])?.[1] ?? "")
      .replace(/\s+#+\s*$/u, "")
      .trim()
    return {
      summary: summarizeLines(lines.filter((_, index) => index !== headingIndex)),
      title: truncate(toPlainText(heading), DOCUMENT_TITLE_MAX_LENGTH),
    }
  }

  const firstIndex = lines.findIndex((line) => line.trim().length > 0)
  if (firstIndex < 0) return { summary: "", title: "" }

  return {
    summary: summarizeLines(lines.slice(firstIndex + 1)),
    title: truncate(toPlainText(lines[firstIndex]), DOCUMENT_TITLE_MAX_LENGTH),
  }
}

/**
 * 文档档禅模式角落的字数（产品框架 §2「文档……目录、字数」）。
 *
 * 统计的是正文纯文本：Markdown 标记不算字，围栏里的源码整段跳过，空白与换行
 * 也不计——与禅模式既有的「字数不计空格与换行」口径一致，只是这里先把语法去掉。
 */
export function countPlainTextCharacters(content: string): number {
  let inFence = false
  let total = 0

  for (const line of content.split(/\r?\n/u)) {
    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    total += Array.from(toPlainText(line).replace(/\s/gu, "")).length
  }

  return total
}

/** 围栏内的源码不是摘要素材，整段跳过；其余行去掉块级与行内标记后拼接。 */
function summarizeLines(lines: readonly string[]) {
  const parts: string[] = []
  let inFence = false

  for (const line of lines) {
    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const text = toPlainText(line)
    if (!text) continue
    parts.push(text)
    if (parts.join(" ").length > DOCUMENT_SUMMARY_MAX_LENGTH) break
  }

  return truncate(parts.join(" "), DOCUMENT_SUMMARY_MAX_LENGTH)
}

function toPlainText(line: string) {
  return line
    .replace(/^\s*>+\s?/u, "")
    .replace(/^ {0,3}#{1,6}\s+/u, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, "")
    .replace(/^\[[ xX]\]\s*/u, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu, (_match, target: string, alias?: string) =>
      alias ?? target
    )
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<\/?u>/gu, "")
    .replace(/\*\*|==|`|~~/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
}

function truncate(text: string, maxLength: number) {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength).trimEnd()}…`
}
