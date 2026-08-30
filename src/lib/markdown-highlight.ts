import { shardMarkdownParser } from "@/editor/extensions/markdown"

export { shardMarkdownParser }

export interface InlineHighlightRange {
  contentEnd: number
  contentStart: number
  end: number
  start: number
}

/** 编辑器与只读卡片识别 `==荧光==` 的唯一真相源。 */
export function findInlineHighlights(text: string): InlineHighlightRange[] {
  const ranges: InlineHighlightRange[] = []
  const cursor = shardMarkdownParser.parse(text).cursor()

  do {
    if (cursor.name !== "Highlight") continue

    const node = cursor.node
    const openMark = node.firstChild
    const closeMark = node.lastChild
    if (
      openMark?.name !== "HighlightMark" ||
      closeMark?.name !== "HighlightMark" ||
      openMark.to >= closeMark.from
    ) {
      continue
    }

    ranges.push({
      contentEnd: closeMark.from,
      contentStart: openMark.to,
      end: node.to,
      start: node.from,
    })
  } while (cursor.next())

  return ranges
}
