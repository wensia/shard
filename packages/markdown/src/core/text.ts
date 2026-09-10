/** Pure text rules shared by document rendering, previews, and editors. */

export interface TagRange {
  end: number
  start: number
  text: string
}

export interface MarkdownImage {
  alt: string
  path: string
}

const MARKDOWN_IMAGE_LINE_PATTERN = /^\s*!\[([^\]\n]*)\]\(([^)\n]+)\)\s*$/

const MARKDOWN_HORIZONTAL_RULE_LINE_PATTERN =
  /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/

const TRAILING_TAG_PUNCTUATION = /[),.?!;:，。！？；：、\]}>"'”’]+$/g

const TRAILING_TAG_PUNCTUATION_CHAR = /[),.?!;:，。！？；：、\]}>"'”’]/u

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

export function parseMarkdownImageLine(line: string): MarkdownImage | null {
  const match = line.match(MARKDOWN_IMAGE_LINE_PATTERN)
  if (!match) return null

  const [, alt, rawPath] = match
  const path = normalizeMarkdownImagePath(rawPath)
  if (!path) return null

  return {
    alt: alt.trim(),
    path,
  }
}

function normalizeMarkdownImagePath(rawPath: string) {
  let path = rawPath.trim()
  if (!path) return ""

  if (path.startsWith("<")) {
    const end = path.indexOf(">")
    path = end > 0 ? path.slice(1, end) : path.slice(1)
  } else {
    const titleStart = path.search(/\s+["']/u)
    if (titleStart > 0) {
      path = path.slice(0, titleStart)
    }
  }

  return path.replace(/\\([\\()])/g, "$1").trim()
}

export function isMarkdownHorizontalRuleLine(line: string) {
  return MARKDOWN_HORIZONTAL_RULE_LINE_PATTERN.test(line)
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
