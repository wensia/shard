import {
  getTagRanges,
  isTagBoundary,
  normalizeTag,
  normalizeTagList,
} from "@shard/markdown/core"

import {
  createMarkdownTable,
  serializeMarkdownTable,
} from "@/lib/markdown-table"

export {
  getTagRanges,
  isMarkdownHorizontalRuleLine,
  isTagBoundary,
  normalizeTag,
  normalizeTagList,
  parseMarkdownImageLine,
} from "@shard/markdown/core"
export type { MarkdownImage, TagRange } from "@shard/markdown/core"

export interface TextEdit {
  content: string
  selectionEnd: number
  selectionStart: number
}

export interface ActiveTag {
  hashStart: number
  query: string
}

export type InlineFormat = "bold" | "highlight" | "underline"
export type LineFormat = "ordered" | "task" | "unordered"
export type TaskMarkerDeletionKey = "Backspace" | "Delete"

const LIST_MARKER_PATTERN =
  /^(\s*)(?:[-*+]\s+\[[ xX]\]\s*|\d+[.)]\s+\[[ xX]\]\s*|[-*+]\s+|\d+[.)]\s+)/
const ORDERED_LIST_MARKER_PATTERN =
  /^(\s*)(\d+[.)])\s+(?:\[[ xX]\]\s*)?/
const UNORDERED_LIST_MARKER_PATTERN =
  /^(\s*)([-*+])\s+(?:\[[ xX]\]\s*)?/
const TASK_LINE_MARKER_PATTERN =
  /^(\s*)((?:[-*+]|\d+[.)])\s+)(\[[ xX]\]\s*)/
const ORDERED_LIST_PREFIX_PATTERN = /^\d+[.)]\s+$/

const INLINE_FORMATS: Record<InlineFormat, { close: string; open: string }> = {
  bold: { close: "**", open: "**" },
  highlight: { close: "==", open: "==" },
  underline: { close: "</u>", open: "<u>" },
}

// 插入 `#` 时要不要补一个前置空格，判断标准和 isTagBoundary 不同：
// isTagBoundary 为了识别中文里紧贴汉字写的标签（`今天想说#灵感`），
// 把汉字也算作边界；插入时若沿用它，在 `#密匣` 后面插入就会得到
// `#密匣#`，两个标签粘在一起。这里只把空白和开括号、成对标点视为
// 天然分隔，汉字、字母、数字之后一律补空格。
const TAG_MARKER_NEEDS_NO_SPACE = /[\s([{<"'“‘，。！？；：、,.!?;:]/u

export function insertTagMarker(value: string, cursor: number): TextEdit {
  const previous = cursor > 0 ? value[cursor - 1] : ""
  const marker =
    previous && !TAG_MARKER_NEEDS_NO_SPACE.test(previous) ? " #" : "#"
  const nextCursor = cursor + marker.length

  return {
    content: value.slice(0, cursor) + marker + value.slice(cursor),
    selectionEnd: nextCursor,
    selectionStart: nextCursor,
  }
}

export function applyTagCompletion(
  value: string,
  targetTag: ActiveTag,
  fallbackTag: string
): TextEdit | null {
  // 标签内容止于光标（query），不吞掉光标后紧跟的正文。中文无空格时若一路
  // 吃到行尾（旧的 getTagInputEnd 行为），整行会变成一个超长标签、光标跳到末尾。
  // fallbackTag（用户选中的建议）优先于已输入文本，确保点选建议能正确补全。
  const tagEnd = targetTag.hashStart + 1 + targetTag.query.length
  const nextTag = normalizeTag(fallbackTag || targetTag.query)
  if (!nextTag) return null

  const before = value.slice(0, targetTag.hashStart)
  const after = value.slice(tagEnd)
  const hasInlineSeparator = /^[^\S\r\n]/u.test(after)
  const separator = hasInlineSeparator ? "" : " "
  const nextContent = `${before}#${nextTag}${separator}${after}`
  const nextCursor = before.length + nextTag.length + 2

  return {
    content: nextContent,
    selectionEnd: nextCursor,
    selectionStart: nextCursor,
  }
}

export function applyLineFormat(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  format: LineFormat
): TextEdit {
  const lineStart =
    selectionStart === 0 ? 0 : value.lastIndexOf("\n", selectionStart - 1) + 1
  const selectedThroughLineBreak =
    selectionEnd > selectionStart && value[selectionEnd - 1] === "\n"
  const effectiveSelectionEnd = selectedThroughLineBreak
    ? selectionEnd - 1
    : selectionEnd
  const nextLineBreak = value.indexOf("\n", effectiveSelectionEnd)
  const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak
  const selectedBlock = value.slice(lineStart, lineEnd)
  const formattedBlock = selectedBlock
    .split("\n")
    .map((line, index) => formatLine(line, format, index))
    .join("\n")

  const nextContent =
    value.slice(0, lineStart) + formattedBlock + value.slice(lineEnd)

  if (selectionStart === selectionEnd) {
    const nextCursor =
      selectionStart + formattedBlock.length - selectedBlock.length

    return {
      content: nextContent,
      selectionEnd: nextCursor,
      selectionStart: nextCursor,
    }
  }

  return {
    content: nextContent,
    selectionEnd: lineStart + formattedBlock.length,
    selectionStart: lineStart,
  }
}

export function applyInlineFormat(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  format: InlineFormat
): TextEdit {
  const markers = INLINE_FORMATS[format]
  const selected = value.slice(selectionStart, selectionEnd)
  const nextText = `${markers.open}${selected}${markers.close}`
  const content =
    value.slice(0, selectionStart) + nextText + value.slice(selectionEnd)

  if (selectionStart === selectionEnd) {
    const cursor = selectionStart + markers.open.length
    return {
      content,
      selectionEnd: cursor,
      selectionStart: cursor,
    }
  }

  return {
    content,
    selectionEnd: selectionEnd + markers.open.length + markers.close.length,
    selectionStart,
  }
}

export function insertHorizontalRule(
  value: string,
  selectionStart: number,
  selectionEnd: number
): TextEdit {
  const rangeStart = Math.min(selectionStart, selectionEnd)
  const rangeEnd = Math.max(selectionStart, selectionEnd)
  const before = value.slice(0, rangeStart)
  const after = value.slice(rangeEnd)
  const markdown = `${getHorizontalRulePrefix(before)}---${getHorizontalRuleSuffix(
    after
  )}`
  const cursor = before.length + markdown.length

  return {
    content: before + markdown + after,
    selectionEnd: cursor,
    selectionStart: cursor,
  }
}

export function insertMarkdownTable(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  columns: number,
  rows: number
): TextEdit {
  const rangeStart = Math.min(selectionStart, selectionEnd)
  const rangeEnd = Math.max(selectionStart, selectionEnd)
  const before = value.slice(0, rangeStart)
  const after = value.slice(rangeEnd)
  // 表格和分割线一样是块级结构：前后各留一个空行，免得贴上一段正文。
  const prefix = getHorizontalRulePrefix(before)
  const suffix = getHorizontalRuleSuffix(after)
  const markdown = serializeMarkdownTable(createMarkdownTable(columns, rows))
  const tableStart = before.length + prefix.length
  // 光标落进第一个表头单元格，插完就能直接打字。
  const cursor = tableStart + markdown.indexOf("|") + 2

  return {
    content: before + prefix + markdown + suffix + after,
    selectionEnd: cursor,
    selectionStart: cursor,
  }
}

/**
 * 把一整块 Markdown（导入的表格、多张表加小标题等）插进光标处，
 * 前后各留一个空行——和分割线、表格用的是同一套块级间距规则。
 */
export function insertMarkdownBlock(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  markdown: string
): TextEdit {
  const rangeStart = Math.min(selectionStart, selectionEnd)
  const rangeEnd = Math.max(selectionStart, selectionEnd)
  const before = value.slice(0, rangeStart)
  const after = value.slice(rangeEnd)
  const body = markdown.trim()
  const prefix = getHorizontalRulePrefix(before)
  const suffix = getHorizontalRuleSuffix(after)
  const cursor = before.length + prefix.length + body.length

  return {
    content: before + prefix + body + suffix + after,
    selectionEnd: cursor,
    selectionStart: cursor,
  }
}

export function insertMarkdownImage(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  fileName: string,
  path: string
): TextEdit {
  const selected = value.slice(selectionStart, selectionEnd).trim()
  const alt = selected || getMarkdownImageAlt(fileName)
  const prefix = shouldPrefixWithLineBreak(value, selectionStart) ? "\n" : ""
  const suffix = shouldSuffixWithLineBreak(value, selectionEnd) ? "\n" : ""
  const markdown = `${prefix}![${alt}](${path})${suffix}`
  const content =
    value.slice(0, selectionStart) + markdown + value.slice(selectionEnd)
  const cursor = selectionStart + markdown.length

  return {
    content,
    selectionEnd: cursor,
    selectionStart: cursor,
  }
}

export function applyTaskMarkerDeletion(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  key: TaskMarkerDeletionKey
): TextEdit | null {
  const rangeStart = Math.min(selectionStart, selectionEnd)
  const rangeEnd = Math.max(selectionStart, selectionEnd)
  const lineStart =
    rangeStart === 0 ? 0 : value.lastIndexOf("\n", rangeStart - 1) + 1
  const nextLineBreak = value.indexOf("\n", lineStart)
  const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak
  const line = value.slice(lineStart, lineEnd)
  const markerMatch = line.match(TASK_LINE_MARKER_PATTERN)
  if (!markerMatch) return null

  const [, indentation, listMarker, taskMarker] = markerMatch
  const markerStart = lineStart + indentation.length
  const taskMarkerStart = markerStart + listMarker.length
  const markerEnd = taskMarkerStart + taskMarker.length
  const isOrderedTask = ORDERED_LIST_PREFIX_PATTERN.test(listMarker)
  const deleteStart = isOrderedTask ? taskMarkerStart : markerStart
  const deleteEnd = markerEnd

  if (rangeStart !== rangeEnd) {
    if (rangeStart >= markerEnd || rangeEnd <= markerStart) return null

    const nextSelection = Math.min(rangeStart, deleteStart)
    const nextDeleteStart = Math.min(rangeStart, deleteStart)
    const nextDeleteEnd = Math.max(rangeEnd, deleteEnd)

    return {
      content: value.slice(0, nextDeleteStart) + value.slice(nextDeleteEnd),
      selectionEnd: nextSelection,
      selectionStart: nextSelection,
    }
  }

  const isDeletingTaskMarker =
    key === "Backspace"
      ? rangeStart > markerStart && rangeStart <= markerEnd
      : rangeStart >= markerStart && rangeStart < markerEnd

  if (!isDeletingTaskMarker) return null

  return {
    content: value.slice(0, deleteStart) + value.slice(deleteEnd),
    selectionEnd: deleteStart,
    selectionStart: deleteStart,
  }
}

export function applyTaskLineBreak(
  value: string,
  selectionStart: number,
  selectionEnd: number
): TextEdit | null {
  if (selectionStart !== selectionEnd) return null

  const lineStart =
    selectionStart === 0 ? 0 : value.lastIndexOf("\n", selectionStart - 1) + 1
  const nextLineBreak = value.indexOf("\n", selectionStart)
  const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak
  const line = value.slice(lineStart, lineEnd)
  const markerMatch = line.match(TASK_LINE_MARKER_PATTERN)
  if (!markerMatch) return null

  const [, indentation, listMarker, taskMarker] = markerMatch
  const bodyStart =
    lineStart + indentation.length + listMarker.length + taskMarker.length
  if (selectionStart < bodyStart) return null

  const nextLinePrefix = `${indentation}${getNextTaskListMarker(listMarker)}[ ] `
  const nextCursor = selectionStart + 1 + nextLinePrefix.length

  return {
    content:
      value.slice(0, selectionStart) +
      "\n" +
      nextLinePrefix +
      value.slice(selectionEnd),
    selectionEnd: nextCursor,
    selectionStart: nextCursor,
  }
}

export function toggleTaskLine(value: string, lineIndex: number) {
  const lines = value.split("\n")
  const currentLine = lines[lineIndex]
  if (currentLine === undefined) return value

  const nextLine = currentLine.replace(
    /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s*)/,
    (_, prefix: string, marker: string, suffix: string) =>
      `${prefix}${marker.toLowerCase() === "x" ? " " : "x"}${suffix}`
  )

  if (nextLine === currentLine) return value

  lines[lineIndex] = nextLine
  return lines.join("\n")
}

export function extractTags(value: string) {
  return normalizeTagList(
    getTagRanges(value).map((range) => range.text.slice(1))
  )
}

export function getActiveTag(value: string, cursor: number): ActiveTag | null {
  const beforeCursor = value.slice(0, cursor)
  const hashStart = beforeCursor.lastIndexOf("#")
  if (hashStart < 0) return null

  const previous = hashStart > 0 ? value[hashStart - 1] : ""
  if (previous && !isTagBoundary(previous)) return null

  const query = beforeCursor.slice(hashStart + 1)
  if (/\s|#/.test(query)) return null

  return { hashStart, query }
}

function formatLine(line: string, format: LineFormat, index: number) {
  const indentation = line.match(/^\s*/)?.[0] ?? ""
  const orderedMarker = line.match(ORDERED_LIST_MARKER_PATTERN)?.[2]
  const unorderedMarker = line.match(UNORDERED_LIST_MARKER_PATTERN)?.[2]
  const contentWithoutMarker = line.replace(
    LIST_MARKER_PATTERN,
    (_, currentIndentation: string) => currentIndentation
  )
  const body = contentWithoutMarker.slice(indentation.length)

  if (format === "task") {
    const marker = orderedMarker ?? unorderedMarker ?? "-"
    return `${indentation}${marker} [ ] ${body}`
  }

  return `${indentation}${getLinePrefix(format, index)}${body}`
}

function getLinePrefix(format: LineFormat, index: number) {
  switch (format) {
    case "ordered":
      return `${index + 1}. `
    case "task":
      return "- [ ] "
    case "unordered":
    default:
      return "- "
  }
}

function getNextTaskListMarker(listMarker: string) {
  const orderedMarker = listMarker.match(/^(\d+)([.)])(\s+)$/)
  if (!orderedMarker) return listMarker

  const [, number, delimiter, spacing] = orderedMarker
  return `${Number(number) + 1}${delimiter}${spacing}`
}

export function getMarkdownImageAlt(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "image"
}

function getHorizontalRulePrefix(before: string) {
  if (before.length === 0 || before.endsWith("\n\n")) return ""
  if (before.endsWith("\n")) return "\n"
  return "\n\n"
}

function getHorizontalRuleSuffix(after: string) {
  if (after.startsWith("\n\n")) return ""
  if (after.startsWith("\n")) return "\n"
  return "\n\n"
}

function shouldPrefixWithLineBreak(value: string, selectionStart: number) {
  return selectionStart > 0 && value[selectionStart - 1] !== "\n"
}

function shouldSuffixWithLineBreak(value: string, selectionEnd: number) {
  return selectionEnd < value.length && value[selectionEnd] !== "\n"
}
