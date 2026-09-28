import {
  GFM,
  parser as commonmarkParser,
  type MarkdownConfig,
  type MarkdownParser,
} from "@lezer/markdown"

const HighlightDelimiter = {
  mark: "HighlightMark",
}

/** Shard 的 `==荧光==` 行内语法；定界规则与 Lezer Strikethrough 保持一致。 */
export const ShardHighlight: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight" },
    { name: "HighlightMark" },
  ],
  parseInline: [
    {
      name: "Highlight",
      parse(context, next, position) {
        if (
          next !== 61 ||
          context.char(position + 1) !== 61 ||
          context.char(position + 2) === 61
        ) {
          return -1
        }

        const before = context.slice(position - 1, position)
        const after = context.slice(position + 2, position + 3)
        const whitespaceBefore = /\s|^$/u.test(before)
        const whitespaceAfter = /\s|^$/u.test(after)
        const punctuationBefore = /[!-/:-@[-`{-~\p{P}\p{S}]/u.test(before)
        const punctuationAfter = /[!-/:-@[-`{-~\p{P}\p{S}]/u.test(after)

        const canOpen =
          !whitespaceAfter &&
          (!punctuationAfter || whitespaceBefore || punctuationBefore)
        const canClose =
          !whitespaceBefore &&
          (!punctuationBefore || whitespaceAfter || punctuationAfter)
        const openingIndex = canClose
          ? context.findOpeningDelimiter(HighlightDelimiter)
          : null
        const opening =
          openingIndex === null ? null : context.getDelimiterAt(openingIndex)

        // Markdown 的 paragraph inline stream 可跨软换行；Shard 的荧光语法不跨行。
        if (
          openingIndex !== null &&
          opening &&
          opening.to < position &&
          !context.slice(opening.to, position).includes("\n")
        ) {
          const content = context.takeContent(openingIndex)
          return context.addElement(
            context.elt("Highlight", opening.from, position + 2, [
              context.elt("HighlightMark", opening.from, opening.to),
              ...content,
              context.elt("HighlightMark", position, position + 2),
            ]),
          )
        }

        return canOpen
          ? context.addDelimiter(
              HighlightDelimiter,
              position,
              position + 2,
              true,
              false,
            )
          : -1
      },
      after: "Emphasis",
    },
  ],
}

/** CommonMark + GFM (tasks, tables, strikethrough, autolinks) + ==highlight==. */
export const markdownParser: MarkdownParser = commonmarkParser.configure([
  GFM,
  ShardHighlight,
])

/** Only a Lezer backslash HardBreak is display syntax; literal slashes stay intact. */
export function hardBreakMarkerOffsets(
  content: string,
  tree: ReturnType<typeof markdownParser.parse> = markdownParser.parse(content),
): number[] {
  const offsets: number[] = []
  tree.iterate({
    enter(node) {
      if (node.name === "HardBreak" && content.slice(node.from, node.to) === "\\\n") {
        offsets.push(node.from)
      }
    },
  })
  return offsets
}

/** Project Markdown into visible text without changing its stored source.
 * A bounded caller parses only complete source lines; remaining text is unchanged.
 */
export function stripMarkdownHardBreaks(content: string, maxParseLength = content.length): string {
  const end = content.length <= maxParseLength
    ? content.length
    : content.lastIndexOf("\n", maxParseLength - 1) + 1
  const prefix = content.slice(0, end)
  if (!prefix.includes("\\\n")) return content
  const offsets = hardBreakMarkerOffsets(prefix)
  if (offsets.length === 0) return content
  let visible = ""
  let from = 0
  for (const offset of offsets) {
    visible += content.slice(from, offset)
    from = offset + 1
  }
  return visible + content.slice(from)
}

/** Compatibility name for existing Shard consumers. */
export { markdownParser as shardMarkdownParser }
