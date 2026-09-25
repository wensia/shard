import {
  getTagRanges,
  isTagBoundary,
  normalizeTagList,
} from "@shard/markdown/core"

export {
  getTagRanges,
  isMarkdownHorizontalRuleLine,
  isTagBoundary,
  normalizeTag,
  normalizeTagList,
  parseMarkdownImageLine,
} from "@shard/markdown/core"
export type { MarkdownImage, TagRange } from "@shard/markdown/core"

export interface ActiveTag {
  hashStart: number
  query: string
}

/** 工具栏的行内格式与行格式入口，富文本编辑器句柄按同名命令执行。 */
export type InlineFormat = "bold" | "highlight" | "underline"
export type LineFormat = "ordered" | "task" | "unordered"

// 插入 `#` 时要不要补一个前置空格，判断标准和 isTagBoundary 不同：
// isTagBoundary 为了识别中文里紧贴汉字写的标签（`今天想说#灵感`），
// 把汉字也算作边界；插入时若沿用它，在 `#密匣` 后面插入就会得到
// `#密匣#`，两个标签粘在一起。这里只把空白和开括号、成对标点视为
// 天然分隔，汉字、字母、数字之后一律补空格。
const TAG_MARKER_NEEDS_NO_SPACE = /[\s([{<"'“‘，。！？；：、,.!?;:]/u

/** 在 `previous` 这个字符后面插入标签时应写下的标记：`#` 或 ` #`。 */
export function getTagMarker(previous: string) {
  return previous && !TAG_MARKER_NEEDS_NO_SPACE.test(previous) ? " #" : "#"
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

export function getMarkdownImageAlt(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "image"
}
