import { Extension, type Editor } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

import { normalizeSearchText } from "@/lib/search-normalize"

import {
  appendText,
  atomSearchText,
  findTermRanges,
  type TextSegment,
} from "./search-highlight"

/**
 * 文档内查找（Cmd+F）。
 *
 * 与全局搜索的定位高亮（search-highlight.ts）分开：那边是一次性的定位结果，
 * 文档一改就作废；这里是用户开着的查找条，边改边跟——编辑后先把旧位置映射过去，
 * 停手（且不在组合输入中）再整篇重算。
 *
 * 匹配口径与全局搜索一致：大小写、全角半角折叠（normalizeSearchText），查询词
 * 按字面整串匹配，不拆空格。代码块照常查；标签、双链、提醒这类行内原子按显示
 * 文字整体命中；大纲、流程图、数据表、CSV 嵌入等块级原子不进查找。
 */

export interface DocumentFindMatch {
  from: number
  to: number
  /** 行内原子（标签、双链、提醒）整体命中，定位时选中整个节点。 */
  node: boolean
}

export interface DocumentFindState {
  query: string
  matches: readonly DocumentFindMatch[]
  /** 当前命中的下标；没有命中时为 -1。 */
  activeIndex: number
  decorations: DecorationSet
  /** 文档改过、匹配只是映射来的旧位置，等停手后整篇重算。 */
  stale: boolean
}

export type DocumentFindMeta =
  | { type: "search"; query: string; anchor: number }
  | { type: "refresh" }
  | { type: "step"; direction: 1 | -1 }
  | { type: "clear" }

const SEARCHABLE_INLINE_ATOMS = new Set(["tag", "wikilink", "reminder"])
const REFRESH_DELAY_MS = 150

export const DOCUMENT_FIND_QUERY_MAX_LENGTH = 256

const EMPTY_STATE: DocumentFindState = {
  activeIndex: -1,
  decorations: DecorationSet.empty,
  matches: [],
  query: "",
  stale: false,
}

export const DOCUMENT_FIND_KEY = new PluginKey<DocumentFindState>("shardDocumentFind")

export function findDocumentMatches(doc: ProseMirrorNode, query: string): DocumentFindMatch[] {
  const term = normalizeSearchText(query)
  if (!term.trim()) return []
  const matches: DocumentFindMatch[] = []

  doc.descendants((node, position) => {
    if (node.isAtom && !node.isInline) return false
    if (!node.isTextblock) return true

    let segment: TextSegment = { normalized: "", positions: [] }
    const flush = () => {
      for (const range of findTermRanges(segment, [term])) matches.push({ ...range, node: false })
      segment = { normalized: "", positions: [] }
    }

    node.descendants((child, childPosition) => {
      const start = position + 1 + childPosition
      if (child.isText) {
        appendText(segment, child.text ?? "", start)
        return false
      }
      if (child.isAtom) {
        // 原子把一行切成两段：匹配不跨过标签、换行这类节点。
        flush()
        if (
          SEARCHABLE_INLINE_ATOMS.has(child.type.name) &&
          normalizeSearchText(atomSearchText(child)).includes(term)
        ) {
          matches.push({ from: start, to: start + child.nodeSize, node: true })
        }
        return false
      }
      return true
    })
    flush()
    return false
  })

  return matches
}

function pickActiveIndex(matches: readonly DocumentFindMatch[], anchor: number) {
  if (matches.length === 0) return -1
  const index = matches.findIndex((match) => match.from >= anchor)
  return index < 0 ? 0 : index
}

function decorationsFor(
  doc: ProseMirrorNode,
  matches: readonly DocumentFindMatch[],
  activeIndex: number
) {
  return DecorationSet.create(
    doc,
    matches.map((match, index) => {
      const active = index === activeIndex
      const attrs = {
        class: active
          ? "shard-rich-search-hit shard-rich-search-hit--active"
          : "shard-rich-search-hit",
        "data-find-hit": active ? "active" : "match",
      }
      return match.node
        ? Decoration.node(match.from, match.to, attrs)
        : Decoration.inline(match.from, match.to, attrs)
    })
  )
}

function searched(
  doc: ProseMirrorNode,
  query: string,
  anchor: number
): DocumentFindState {
  const matches = findDocumentMatches(doc, query)
  const activeIndex = pickActiveIndex(matches, anchor)
  return {
    activeIndex,
    decorations: decorationsFor(doc, matches, activeIndex),
    matches,
    query,
    stale: false,
  }
}

function mapped(transaction: Transaction, previous: DocumentFindState): DocumentFindState {
  const active = previous.matches[previous.activeIndex]
  let activeIndex = -1
  const matches: DocumentFindMatch[] = []
  for (const match of previous.matches) {
    const from = transaction.mapping.map(match.from, 1)
    const to = transaction.mapping.map(match.to, -1)
    if (to <= from) continue
    if (match === active) activeIndex = matches.length
    matches.push({ ...match, from, to })
  }
  if (activeIndex < 0 && matches.length > 0) {
    activeIndex = Math.min(Math.max(previous.activeIndex, 0), matches.length - 1)
  }
  return {
    activeIndex,
    decorations: previous.decorations.map(transaction.mapping, transaction.doc),
    matches,
    query: previous.query,
    stale: true,
  }
}

function applyMeta(
  transaction: Transaction,
  previous: DocumentFindState,
  meta: DocumentFindMeta
): DocumentFindState {
  if (meta.type === "clear") return EMPTY_STATE
  if (meta.type === "search") return searched(transaction.doc, meta.query, meta.anchor)
  if (meta.type === "refresh") {
    if (!previous.query) return previous
    // 重算后尽量停在原来那一处：从当前命中的位置往后找第一个。
    const anchor = previous.matches[previous.activeIndex]?.from ?? 0
    return searched(transaction.doc, previous.query, anchor)
  }
  if (previous.matches.length === 0) return previous
  const count = previous.matches.length
  const activeIndex = (previous.activeIndex + meta.direction + count) % count
  return {
    ...previous,
    activeIndex,
    decorations: decorationsFor(transaction.doc, previous.matches, activeIndex),
  }
}

export function getDocumentFindState(editor: Editor): DocumentFindState {
  if (editor.isDestroyed) return EMPTY_STATE
  return DOCUMENT_FIND_KEY.getState(editor.state) ?? EMPTY_STATE
}

function dispatchFind(editor: Editor, meta: DocumentFindMeta) {
  if (editor.isDestroyed) return
  editor.view.dispatch(
    editor.state.tr.setMeta(DOCUMENT_FIND_KEY, meta).setMeta("addToHistory", false)
  )
}

/** 按新查询词整篇查找，当前命中取 `anchor` 之后的第一处。 */
export function searchDocument(editor: Editor, query: string, anchor: number) {
  dispatchFind(editor, { type: "search", query, anchor })
}

export function stepDocumentFind(editor: Editor, direction: 1 | -1) {
  const state = getDocumentFindState(editor)
  // 编辑后还没重算：先按当前文档重算一次再走，计数和位置才可靠。
  if (state.stale) dispatchFind(editor, { type: "refresh" })
  dispatchFind(editor, { type: "step", direction })
}

export function clearDocumentFind(editor: Editor) {
  if (getDocumentFindState(editor).query) dispatchFind(editor, { type: "clear" })
}

/** 关闭查找条时把选区落到当前命中，回到正文就能接着改。 */
export function selectActiveDocumentFindMatch(editor: Editor) {
  if (editor.isDestroyed) return false
  const state = getDocumentFindState(editor)
  const match = state.matches[state.activeIndex]
  if (!match) return false
  const { doc } = editor.state
  if (match.to > doc.content.size) return false
  const selection = match.node
    ? NodeSelection.create(doc, match.from)
    : TextSelection.create(doc, match.from, match.to)
  editor.view.dispatch(editor.state.tr.setSelection(selection).setMeta("addToHistory", false))
  return true
}

export function createDocumentFindPlugin() {
  return new Plugin<DocumentFindState>({
    key: DOCUMENT_FIND_KEY,
    state: {
      init: () => EMPTY_STATE,
      apply(transaction, previous) {
        const meta = transaction.getMeta(DOCUMENT_FIND_KEY) as DocumentFindMeta | undefined
        if (meta) return applyMeta(transaction, previous, meta)
        if (transaction.docChanged && previous.query) return mapped(transaction, previous)
        return previous
      },
    },
    props: {
      decorations: (state) =>
        DOCUMENT_FIND_KEY.getState(state)?.decorations ?? DecorationSet.empty,
    },
    view: (view) => {
      let timer: number | undefined
      const refreshLater = () => {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => {
          if (view.isDestroyed) return
          // 组合输入中整篇重算会改动拼音所在段的装饰，打断输入法；等它结束。
          if (view.composing) {
            refreshLater()
            return
          }
          if (!DOCUMENT_FIND_KEY.getState(view.state)?.stale) return
          view.dispatch(
            view.state.tr
              .setMeta(DOCUMENT_FIND_KEY, { type: "refresh" } satisfies DocumentFindMeta)
              .setMeta("addToHistory", false)
          )
        }, REFRESH_DELAY_MS)
      }
      return {
        update(updated, previousState) {
          if (!DOCUMENT_FIND_KEY.getState(updated.state)?.stale) return
          if (updated.state.doc !== previousState.doc) refreshLater()
        },
        destroy() {
          window.clearTimeout(timer)
        },
      }
    },
  })
}

export const ShardDocumentFind = Extension.create({
  name: "shardDocumentFind",

  addProseMirrorPlugins() {
    return [createDocumentFindPlugin()]
  },
})
