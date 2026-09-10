import { getTagRanges } from "./text.js"

/**
 * Markdown 预览的共享解析规则：把源文本读成语义块，并把行内标记剥干净。
 *
 * 资料库缩略图和碎片分享图都吃这一份——两处都是「把 Markdown 变成给人看的
 * 一小片内容」，规则分家迟早漂移（缩略图曾经把 `# 标题` `**粗体**` `==高亮==`
 * 原样吐在格子里，就是因为它自己另写了一套只会 trim 的提取）。
 */

export type MarkdownPreviewBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "task"; checked: boolean; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "text"; text: string }
  | { kind: "divider" }
  | { kind: "code"; label: string }
  | { kind: "table" }
  | { kind: "image"; alt: string }

/**
 * 剥掉行内标记，只留下人要读的字：强调、高亮、行内代码、删除线、链接、
 * 图片语法、wikilink 与 #标签。留下的是纯文本，交给渲染层决定字重字号。
 */
export function stripInlineMarkdown(line: string): string {
  let text = stripTags(line)

  text = text
    // 图片先于链接处理，否则 ![alt](src) 会被链接规则啃掉一半
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    // [[wikilink|别名]] 显示别名，否则显示目标名
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^\]]+)\]\]/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/~~([^~]+)~~/gu, "$1")
    .replace(/==([^=]+)==/gu, "$1")
    .replace(/\*\*\*([^*]+)\*\*\*/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/gu, "$1")
    .replace(/(?<![\w_])__([^_\n]+)__(?![\w_])/gu, "$1")
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/gu, "$1")

  return text.replace(/[ \t]{2,}/gu, " ").trim()
}

/**
 * 解析成预览块。limit 是块数上限——预览位置都很小，读满就够了，
 * 不为了一个 80×80 的格子去解析整篇文档。
 */
export function parseMarkdownPreview(
  content: string,
  limit = 8
): MarkdownPreviewBlock[] {
  const lines = stripFrontmatter(
    content.replace(/\r\n?/gu, "\n").split("\n")
  )
  const blocks: MarkdownPreviewBlock[] = []
  let inFence = false
  let fenceLabel = ""

  for (const raw of lines) {
    if (blocks.length >= limit) break

    const line = raw.trim()
    const fence = line.match(/^(?:```|~~~)\s*(\S*)/u)
    if (fence) {
      if (inFence) {
        inFence = false
        continue
      }
      inFence = true
      fenceLabel = fence[1] ?? ""
      blocks.push({ kind: "code", label: fenceLabel })
      continue
    }
    // 围栏里的内容整体折成一个 code 块，不逐行铺开
    if (inFence) continue
    if (line.length === 0) continue

    if (/^([-*_])(?:\s*\1){2,}$/u.test(line)) {
      blocks.push({ kind: "divider" })
      continue
    }

    // 表格只标记存在，行列留给渲染层按自己的尺寸决定怎么示意
    if (/^\|.*\|$/u.test(line)) {
      if (blocks[blocks.length - 1]?.kind !== "table") {
        blocks.push({ kind: "table" })
      }
      continue
    }

    const image = line.match(/^!\[([^\]]*)\]\([^)]*\)$/u)
    if (image) {
      blocks.push({ kind: "image", alt: stripInlineMarkdown(image[1] ?? "") })
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/u)
    if (heading) {
      const text = stripInlineMarkdown(heading[2] ?? "")
      if (text) blocks.push({ kind: "heading", level: heading[1].length, text })
      continue
    }

    const task = line.match(/^(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s*(.*)$/u)
    if (task) {
      blocks.push({
        checked: task[1].toLowerCase() === "x",
        kind: "task",
        text: stripInlineMarkdown(task[2] ?? ""),
      })
      continue
    }

    const bullet = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/u)
    if (bullet) {
      const text = stripInlineMarkdown(bullet[1] ?? "")
      if (text) blocks.push({ kind: "bullet", text })
      continue
    }

    const quote = line.match(/^>\s*(.*)$/u)
    if (quote) {
      const text = stripInlineMarkdown(quote[1] ?? "")
      if (text) blocks.push({ kind: "quote", text })
      continue
    }

    const text = stripInlineMarkdown(line)
    if (text) blocks.push({ kind: "text", text })
  }

  return blocks
}

function stripTags(line: string): string {
  const ranges = getTagRanges(line)
  if (ranges.length === 0) return line

  let result = ""
  let cursor = 0
  for (const range of ranges) {
    result += line.slice(cursor, range.start)
    cursor = range.end
  }
  return result + line.slice(cursor)
}

function stripFrontmatter(lines: string[]) {
  if (lines[0]?.trim() !== "---") return lines

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---"
  )
  return closingIndex < 0 ? lines : lines.slice(closingIndex + 1)
}
