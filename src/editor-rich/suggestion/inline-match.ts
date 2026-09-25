import type { ResolvedPos } from "@tiptap/pm/model"
import type { SuggestionMatch } from "@tiptap/suggestion"

import { getActiveTag } from "@/lib/editor-format"
import { getActiveSlashCommand } from "@/lib/slash-commands"

/**
 * 行内原子节点（标签、双链、图片）在 `textBetween` 里用一个占位字符代表。
 * 行内叶子节点的 nodeSize 恒为 1，占位字符也恰好 1 个字符，于是
 * 「块内文本下标」与「块内偏移」严格一一对应，可以直接换算回文档位置。
 */
export const INLINE_LEAF_PLACEHOLDER = "￼"

interface BlockTextBeforeCursor {
  /** 文本块正文起点的文档位置。 */
  blockStart: number
  /** 块起点到光标之间的纯文本，长度等于 `$position.parentOffset`。 */
  text: string
}

function blockTextBeforeCursor($position: ResolvedPos): BlockTextBeforeCursor | null {
  const parent = $position.parent
  if (!parent.isTextblock) return null

  return {
    blockStart: $position.start(),
    text: parent.textBetween(
      0,
      $position.parentOffset,
      undefined,
      INLINE_LEAF_PLACEHOLDER
    ),
  }
}

/**
 * `#标签` 的触发规则复用 `getActiveTag`：`#` 前必须是标签边界（含汉字），
 * query 不含空白与第二个 `#`。这样编辑器与卡片渲染共用同一套边界定义。
 */
export function findTagSuggestionMatch({
  $position,
}: {
  $position: ResolvedPos
}): SuggestionMatch {
  const block = blockTextBeforeCursor($position)
  if (!block) return null

  const active = getActiveTag(block.text, block.text.length)
  if (!active) return null

  return {
    range: { from: block.blockStart + active.hashStart, to: $position.pos },
    query: active.query,
    text: `#${active.query}`,
  }
}

/**
 * `/` 命令的触发规则复用 `getActiveSlashCommand`：行首或空白之后才算触发点，
 * query 不含空白且不超过 24 字符，`http://`、`a/b` 这类写法不会误弹菜单。
 */
export function findSlashSuggestionMatch({
  $position,
}: {
  $position: ResolvedPos
}): SuggestionMatch {
  const block = blockTextBeforeCursor($position)
  if (!block) return null

  const active = getActiveSlashCommand(block.text, block.text.length)
  if (!active) return null

  return {
    range: { from: block.blockStart + active.slashStart, to: $position.pos },
    query: active.query,
    text: `/${active.query}`,
  }
}

/**
 * `[[目标` 的触发规则复用 CM6 补全的 `[[` 前缀语义
 * （旧 CodeMirror 双链补全的 `matchBefore(/\[\[[^\]|]*$/u)`）：
 * `[[` 之后到光标之间不能出现 `]`、`|` 与换行，空格允许——笔记标题里有空格。
 *
 * 与 CM6 的唯一差别：查询里也不允许再出现 `[`，这样 `[[甲[[乙` 命中的是最靠近
 * 光标的那一对括号，而不是最外层。
 */
const WIKILINK_TRIGGER = /\[\[([^[\]|\n]*)$/u

export function findWikilinkSuggestionMatch({
  $position,
}: {
  $position: ResolvedPos
}): SuggestionMatch {
  const block = blockTextBeforeCursor($position)
  if (!block) return null

  const match = WIKILINK_TRIGGER.exec(block.text)
  if (!match || match.index === undefined) return null

  return {
    range: { from: block.blockStart + match.index, to: $position.pos },
    query: match[1],
    text: match[0],
  }
}

/** 光标紧随其后的一个字符，用于判断标签后面要不要补空格。 */
export function characterAfter($position: ResolvedPos) {
  const parent = $position.parent
  if (!parent.isTextblock) return ""

  return parent.textBetween(
    $position.parentOffset,
    Math.min($position.parentOffset + 1, parent.content.size),
    undefined,
    INLINE_LEAF_PLACEHOLDER
  )
}

/** 光标之前的一个字符，用于判断插入 `#` 要不要先补空格。 */
export function characterBefore($position: ResolvedPos) {
  const parent = $position.parent
  if (!parent.isTextblock || $position.parentOffset === 0) return ""

  return parent.textBetween(
    $position.parentOffset - 1,
    $position.parentOffset,
    undefined,
    INLINE_LEAF_PLACEHOLDER
  )
}
