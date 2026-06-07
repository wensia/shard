export interface TextEdit {
  content: string
  selectionEnd: number
  selectionStart: number
}

export interface TagRange {
  end: number
  start: number
  text: string
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
const TRAILING_TAG_PUNCTUATION = /[),.?!;:，。！？；：、\]}>"'”’]+$/g
const TRAILING_TAG_PUNCTUATION_CHAR = /[),.?!;:，。！？；：、\]}>"'”’]/u

const INLINE_FORMATS: Record<InlineFormat, { close: string; open: string }> = {
  bold: { close: "**", open: "**" },
  highlight: { close: "==", open: "==" },
  underline: { close: "</u>", open: "<u>" },
}

export function insertTagMarker(value: string, cursor: number): TextEdit {
  const previous = cursor > 0 ? value[cursor - 1] : ""
  const marker = previous && !isTagBoundary(previous) ? " #" : "#"
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
  const tagEnd = getTagInputEnd(value, targetTag.hashStart)
  const rawTag = value.slice(targetTag.hashStart + 1, tagEnd)
  const nextTag = normalizeTag(rawTag || fallbackTag || targetTag.query)
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

export function insertMarkdownImage(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  fileName: string,
  path: string
): TextEdit {
  const selected = value.slice(selectionStart, selectionEnd).trim()
  const alt = selected || getImageAlt(fileName)
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

export function getTagRanges(value: string): TagRange[] {
  const ranges: TagRange[] = []

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "#") continue

    const previous = index > 0 ? value[index - 1] : ""
    if (previous && !isTagBoundary(previous)) continue

    const contentStart = index + 1
    let contentEnd = contentStart
    while (
      contentEnd < value.length &&
      !/\s/u.test(value[contentEnd]) &&
      value[contentEnd] !== "#" &&
      value[contentEnd] !== "\n" &&
      value[contentEnd] !== "\r"
    ) {
      contentEnd += 1
    }

    let tagEnd = contentEnd
    if (
      value[contentEnd] === "#" ||
      value[contentEnd] === "\n" ||
      value[contentEnd] === "\r"
    ) {
      tagEnd = trimTrailingWhitespace(value, contentStart, tagEnd)
    }
    tagEnd = trimTrailingTagPunctuation(value, contentStart, tagEnd)

    const text = value.slice(index, tagEnd)
    if (normalizeTag(text.slice(1))) {
      ranges.push({
        end: tagEnd,
        start: index,
        text,
      })
    }
  }

  return ranges
}

export function normalizeTagList(tags: string[]) {
  const seen = new Set<string>()
  const normalizedTags: string[] = []

  for (const tag of tags) {
    const normalized = normalizeTag(tag)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    normalizedTags.push(normalized)
  }

  return normalizedTags
}

export function normalizeTag(tag: string) {
  return tag
    .trim()
    .replace(/^#+/, "")
    .replace(TRAILING_TAG_PUNCTUATION, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function isTagBoundary(char: string) {
  return /[\s([{<"'“‘，。！？；：、,.!?;:]|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
    char
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

function getTagInputEnd(value: string, hashStart: number) {
  let end = hashStart + 1

  while (
    end < value.length &&
    !/\s/u.test(value[end]) &&
    value[end] !== "#"
  ) {
    end += 1
  }

  return end
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

function getImageAlt(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "image"
}

function trimTrailingWhitespace(value: string, start: number, end: number) {
  let nextEnd = end
  while (nextEnd > start && /\s/u.test(value[nextEnd - 1] ?? "")) {
    nextEnd -= 1
  }
  return nextEnd
}

function trimTrailingTagPunctuation(value: string, start: number, end: number) {
  let nextEnd = end
  while (
    nextEnd > start &&
    TRAILING_TAG_PUNCTUATION_CHAR.test(value[nextEnd - 1] ?? "")
  ) {
    nextEnd -= 1
  }
  return nextEnd
}

function shouldPrefixWithLineBreak(value: string, selectionStart: number) {
  return selectionStart > 0 && value[selectionStart - 1] !== "\n"
}

function shouldSuffixWithLineBreak(value: string, selectionEnd: number) {
  return selectionEnd < value.length && value[selectionEnd] !== "\n"
}
