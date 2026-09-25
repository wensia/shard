import { Extension, type Editor } from "@tiptap/core"
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model"
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state"
import type { Mapping } from "@tiptap/pm/transform"
import { getTagRanges, normalizeTag } from "@shard/markdown/core"

import { parseWikilinks } from "@/lib/wikilink"

import { INLINE_LEAF_PLACEHOLDER } from "../suggestion/inline-match"
import { SLASH_SUGGESTION_KEY } from "./slash-suggestion"
import { TAG_SUGGESTION_KEY } from "./tag-suggestion"
import { WIKILINK_SUGGESTION_KEY } from "./wikilink-suggestion"

/**
 * 行内原子收敛：把用户手打出来的字面 `#标签` 与 `[[双链]]` 转成节点。
 *
 * 产品原则是「用户永远不需要输入语法」，但 `#词` 与 `[[x]]` 是用户已经养成的
 * 输入习惯，旧 CodeMirror 编辑器里它们本来就是标签与双链。富文本层如果放着
 * 字面文本不管，序列化会照实转义成 `\#词` / `\[\[x]]`，卡片再也认不出来。
 *
 * 规则复用转换层的同一份真相源：标签用 `getTagRanges` / `normalizeTag`，
 * 双链用 `parseWikilinks`，与 `markdown/parse.ts` 的 `scanAtoms` 口径一致；
 * 序列化侧不动，文本节点里残留的语法仍按现状转义。
 */

/**
 * 打上这个标记的事务不参与收敛：正文载入（`setContent`）与方言粘贴写进来的
 * 内容已经由转换层解析过，里面剩下的字面 `#词` 是源文件里的 `\#` 转义。
 */
export const SKIP_INLINE_CONVERGE = "shardSkipInlineConverge"

interface DocRange {
  from: number
  to: number
}

/**
 * 「本会话里用户编辑过的区间」。
 *
 * 收敛永远只改这些区间里的字面片段：打开一篇已有碎片，正文里原本就是 `\#不是标签`
 * 的转义文本从来没被编辑过，点进编辑器再点走、直接提交或宿主读正文都不该改写它。
 * 文档变更的事务把变化范围并进来，载入 / `setContent` / 方言粘贴（带
 * `SKIP_INLINE_CONVERGE`）的事务只做位置映射、不并入。
 */
const INLINE_DIRTY_KEY = new PluginKey<DocRange[]>("shardRichInlineDirty")

const EMPTY_RANGES: readonly DocRange[] = []

/** 脏区间上限：真实编辑会合并成少数几段，超限只出现在极端的全文批量改写里。 */
const MAX_DIRTY_RANGES = 200

/** 一次收敛的作用域：`dirty` 是硬边界，`touched` 只在增量路径上再收窄一层。 */
interface ConvergeScope {
  dirty: readonly DocRange[]
  /** 本次事务碰过的区间；兜底扫描传 `null` 表示不再额外收窄。 */
  touched: readonly DocRange[] | null
}

interface BlockRef {
  node: ProseMirrorNode
  /** 文本块自身的位置，正文起点是 `pos + 1`。 */
  pos: number
}

interface AtomReplacement extends DocRange {
  node: ProseMirrorNode
}

/** 三个建议插件都可能正占着一段文本，用户还在筛选时不抢先转换。 */
const SUGGESTION_KEYS = [
  TAG_SUGGESTION_KEY,
  WIKILINK_SUGGESTION_KEY,
  SLASH_SUGGESTION_KEY,
]

function overlaps(a: DocRange, b: DocRange) {
  return a.from < b.to && b.from < a.to
}

/** 合并重叠或首尾相接的区间；只留并集，不跨空隙拼接。 */
function mergeRanges(ranges: readonly DocRange[]): DocRange[] {
  if (ranges.length <= 1) return ranges.map((range) => ({ ...range }))
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to)
  const merged: DocRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.from <= last.to) {
      if (range.to > last.to) last.to = range.to
      continue
    }
    merged.push({ ...range })
  }
  return merged
}

/**
 * 超过上限时合并间隔最小的两段，换取固定的扫描成本。
 * 只会把两处真实编辑之间的小空隙算进来，不会凭空把整篇变脏。
 */
function capRanges(ranges: DocRange[]): DocRange[] {
  while (ranges.length > MAX_DIRTY_RANGES) {
    let index = 0
    let gap = Number.POSITIVE_INFINITY
    for (let i = 0; i + 1 < ranges.length; i += 1) {
      const candidate = ranges[i + 1].from - ranges[i].to
      if (candidate < gap) {
        gap = candidate
        index = i
      }
    }
    ranges.splice(index, 2, { from: ranges[index].from, to: ranges[index + 1].to })
  }
  return ranges
}

/** 把旧区间搬到新文档坐标；整段被替换掉（如 `setContent`）的直接丢弃。 */
function mapRanges(ranges: readonly DocRange[], mapping: Mapping): DocRange[] {
  const mapped: DocRange[] = []
  for (const range of ranges) {
    // 边界向内收：插入点紧贴旧区间时，新插进来的内容另行计脏，不被旧区间吞掉。
    const from = mapping.mapResult(range.from, 1)
    const to = mapping.mapResult(range.to, -1)
    // 两端都落在被删除的内容里：整篇 `setContent` 或整段删除，这段脏区间没了。
    if (from.deleted && to.deleted) continue
    if (to.pos < from.pos) continue
    mapped.push({ from: from.pos, to: to.pos })
  }
  return mapped
}

/** 一次事务真正改写到的新文档区间。 */
function stepRanges(transaction: Transaction): DocRange[] {
  const ranges: DocRange[] = []
  const { mapping } = transaction
  mapping.maps.forEach((map, index) => {
    const rest = mapping.slice(index + 1)
    map.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      ranges.push({ from: rest.map(newFrom, -1), to: rest.map(newTo, 1) })
    })
  })
  return ranges
}

function dirtyRanges(state: EditorState): readonly DocRange[] {
  return INLINE_DIRTY_KEY.getState(state) ?? EMPTY_RANGES
}

function activeSuggestionRanges(state: EditorState): DocRange[] {
  const ranges: DocRange[] = []
  for (const key of SUGGESTION_KEYS) {
    const pluginState = key.getState(state) as
      | { active?: boolean; range?: DocRange }
      | undefined
    if (pluginState?.active && pluginState.range) ranges.push(pluginState.range)
  }
  return ranges
}

/**
 * 一个文本块里可以就地收敛的字面片段。
 *
 * 块内偏移与 `textBetween` 的字符下标严格一一对应：行内叶子节点的 nodeSize
 * 恒为 1，占位字符也恰好 1 个字符（与 `suggestion/inline-match.ts` 同理）。
 */
function blockReplacements(
  block: ProseMirrorNode,
  blockStart: number,
  schema: Schema,
  keepRanges: readonly DocRange[],
  scope: ConvergeScope
): AtomReplacement[] {
  const tagType = schema.nodes.tag
  const wikilinkType = schema.nodes.wikilink
  if (!tagType || !wikilinkType) return []
  // 代码块按字面保存，行内代码同理：语法在这里就是内容。
  if (!block.isTextblock || block.type.spec.code) return []

  const text = block.textBetween(
    0,
    block.content.size,
    undefined,
    INLINE_LEAF_PLACEHOLDER
  )
  if (!text.includes("#") && !text.includes("[[")) return []

  // 已经成型的行内节点与行内代码不再参与识别。
  const guarded: DocRange[] = []
  block.forEach((child, offset) => {
    if (child.isText && !child.marks.some((mark) => mark.type.name === "code")) return
    guarded.push({ from: offset, to: offset + child.nodeSize })
  })

  const isFree = (from: number, to: number) => {
    const range = { from, to }
    if (guarded.some((guard) => overlaps(range, guard))) return false
    const docRange = { from: blockStart + from, to: blockStart + to }
    if (keepRanges.some((keep) => overlaps(docRange, keep))) return false
    // 硬边界：只改本会话里用户真的编辑过的片段。同一段里别处的字面 `#`（来自
    // `\#` 转义）不因为邻居被编辑就跟着变节点，所以这里要求真交叠——手打出来的
    // `#词` 每个字符都进过脏区间，紧挨着旧字面打字却只是首尾相接。
    if (!scope.dirty.some((range_) => overlaps(docRange, range_))) return false
    // 增量收敛再收窄一层，只管这次事务碰过的地方。
    // 首尾相接算碰过——空格正是打在标签后面的。
    if (!scope.touched) return true
    return scope.touched.some(
      (range_) => docRange.from <= range_.to && range_.from <= docRange.to
    )
  }

  const replacements: AtomReplacement[] = []
  const links = parseWikilinks(text)

  for (const link of links) {
    // `![[a.csv]]` 是块级嵌入，不能就地变成行内节点；留给转换层。
    if (link.embed) continue
    if (!isFree(link.from, link.to)) continue
    replacements.push({
      from: blockStart + link.from,
      to: blockStart + link.to,
      node: wikilinkType.create({ target: link.target, alias: link.alias ?? null }),
    })
  }

  for (const range of getTagRanges(text)) {
    // 与 parse.ts 一致：和双链重叠的 `#` 归双链。
    if (links.some((link) => range.start < link.to && link.from < range.end)) continue
    if (!isFree(range.start, range.end)) continue
    const name = normalizeTag(range.text)
    if (!name) continue
    replacements.push({
      from: blockStart + range.start,
      to: blockStart + range.end,
      node: tagType.create({ name }),
    })
  }

  return replacements
}

function clamp(position: number, max: number) {
  return Math.max(0, Math.min(position, max))
}

function textblocksIn(doc: ProseMirrorNode, ranges: readonly DocRange[]): BlockRef[] {
  const seen = new Set<number>()
  const blocks: BlockRef[] = []
  const max = doc.content.size

  for (const range of ranges) {
    const from = clamp(range.from, max)
    const to = clamp(Math.max(range.to, range.from), max)
    doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return true
      if (!seen.has(pos)) {
        seen.add(pos)
        blocks.push({ node, pos })
      }
      return false
    })
  }

  return blocks
}

/**
 * 只扫「这次事务碰过的地方」：变化区间、以及事务前后的光标所在块。
 * 光标离开一个词也要收敛，所以纯选区事务同样要看旧光标那一块。
 */
function touchedRanges(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState
): DocRange[] {
  const ranges: DocRange[] = []

  const start = oldState.doc.content.findDiffStart(newState.doc.content)
  if (start !== null) {
    const end = oldState.doc.content.findDiffEnd(newState.doc.content)
    ranges.push({ from: start, to: Math.max(end ? end.b : start, start) })
  }

  let head = oldState.selection.head
  for (const transaction of transactions) head = transaction.mapping.map(head)
  ranges.push({ from: head, to: head })
  ranges.push({ from: newState.selection.from, to: newState.selection.to })

  return ranges
}

function buildConvergeTransaction(
  state: EditorState,
  blocks: readonly BlockRef[],
  keepRanges: readonly DocRange[],
  scope: ConvergeScope
): Transaction | null {
  const replacements: AtomReplacement[] = []
  for (const block of blocks) {
    replacements.push(
      ...blockReplacements(block.node, block.pos + 1, state.schema, keepRanges, scope)
    )
  }
  if (replacements.length === 0) return null

  // 从后往前替换，前面片段的位置不受影响，不用维护映射。
  replacements.sort((a, b) => b.from - a.from)
  const tr = state.tr
  for (const replacement of replacements) {
    tr.replaceWith(replacement.from, replacement.to, replacement.node)
  }
  return tr
}

/**
 * 兜底收敛，忽略建议菜单占用的那一段。
 * 用在明确的「写完了」时刻：提交、失焦、`getMarkdown()` 之前。
 *
 * 范围是本会话的脏区间，不是整篇：没被编辑过的字面转义永远不动。
 */
export function convergeShardInlineAtoms(editor: Editor | null | undefined) {
  if (!editor || editor.isDestroyed || !editor.isEditable) return false
  const view = editor.view
  // 组合输入期间文档里是拼音串，绝不能动。
  if (!view || view.composing) return false

  const { state } = view
  const dirty = dirtyRanges(state)
  if (dirty.length === 0) return false

  const tr = buildConvergeTransaction(state, textblocksIn(state.doc, dirty), [], {
    dirty,
    touched: null,
  })
  if (!tr) return false
  view.dispatch(tr)
  return true
}

/**
 * 收敛预览：返回「兜底收敛之后」的文档，但不派发事务、不动编辑器。
 *
 * 自动保存用它取值：用户停顿时手打的 `#标签` 可能还要接着打，
 * 不能因为一次定时落盘就把它变成芯片；落盘内容却必须是收敛后的形态，
 * 否则序列化会把字面 `#词` 转义成 `\#词`。组合输入期间返回 `null`，
 * 由调用方退回最近一次报给宿主的值。
 */
export function previewConvergedDoc(
  editor: Editor | null | undefined
): ProseMirrorNode | null {
  if (!editor || editor.isDestroyed) return null
  const view = editor.view
  if (!view || view.composing) return null

  const { state } = view
  if (!editor.isEditable) return state.doc
  const dirty = dirtyRanges(state)
  if (dirty.length === 0) return state.doc

  const tr = buildConvergeTransaction(state, textblocksIn(state.doc, dirty), [], {
    dirty,
    touched: null,
  })
  return tr ? tr.doc : state.doc
}

/**
 * 边界触发的收敛。
 *
 * 用 `appendTransaction` 而不是 InputRule：一来输入法整段上屏、测试桥的
 * `type` 与粘贴都不走 input rules；二来 `enableInputRules` 是白名单
 * （见 `ShardRichEditor` 的 `FRAGMENT_TIER_INPUT_RULES`），新扩展的规则根本
 * 不会注册。事务追加天然覆盖空格、标点、回车、光标移开与 Esc 退出菜单。
 */
export const ShardInlineConverge = Extension.create({
  name: "shardInlineConverge",

  addProseMirrorPlugins() {
    const { editor } = this

    return [
      new Plugin<DocRange[]>({
        key: INLINE_DIRTY_KEY,
        state: {
          init: () => [],
          apply: (tr, value) => {
            if (!tr.docChanged) return value
            const mapped = mapRanges(value, tr.mapping)
            // 载入与方言粘贴写进来的正文按转换层的解析结果为准：那里的字面
            // `#词` 来自 `\#` 转义，不能因为「刚被写进文档」就算用户编辑过。
            if (tr.getMeta(SKIP_INLINE_CONVERGE) === true) return mergeRanges(mapped)
            return capRanges(mergeRanges([...mapped, ...stepRanges(tr)]))
          },
        },
      }),
      new Plugin({
        key: new PluginKey("shardRichInlineConverge"),
        appendTransaction: (transactions, oldState, newState) => {
          if (!editor.isEditable || editor.view?.composing) return null
          if (transactions.some((tr) => tr.getMeta(SKIP_INLINE_CONVERGE) === true)) {
            return null
          }

          const dirty = dirtyRanges(newState)
          if (dirty.length === 0) return null
          const touched = touchedRanges(transactions, oldState, newState)
          const blocks = textblocksIn(newState.doc, touched)
          if (blocks.length === 0) return null
          return buildConvergeTransaction(
            newState,
            blocks,
            activeSuggestionRanges(newState),
            { dirty, touched }
          )
        },
        props: {
          handleDOMEvents: {
            // 失焦是最后一道边界：菜单还开着时用户点走，也要落成节点。
            blur: () => {
              convergeShardInlineAtoms(editor)
              return false
            },
          },
        },
      }),
    ]
  },
})
