import { Extension, type Editor } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"

import type {
  RevealPlan,
  RevealResult,
  SearchRevealHandle,
} from "@/lib/search-contract"
import { normalizeSearchText } from "@/lib/search-normalize"

export interface SearchHighlightMatch {
  from: number
  to: number
}

interface RevealIdentity {
  requestId: string
  targetKey: string
  revision: string
}

interface SearchHighlightState {
  activeIndex: number
  decorations: DecorationSet
  identity: RevealIdentity | null
  matches: readonly SearchHighlightMatch[]
  sourceDoc: ProseMirrorNode | null
  staleReason: "revisionChanged" | "privacyChanged" | null
  uiEpoch: number
}

type SearchHighlightMeta =
  | {
      type: "show"
      activeIndex: number
      identity: RevealIdentity
      matches: readonly SearchHighlightMatch[]
      sourceDoc: ProseMirrorNode
      uiEpoch: number
    }
  | { type: "step"; activeIndex: number }
  | {
      type: "clear"
      identity: RevealIdentity | null
      staleReason: SearchHighlightState["staleReason"]
      uiEpoch: number
    }

interface SearchProjection {
  matches: SearchHighlightMatch[]
  excludedReason: "codeBlock" | "embed" | null
}

interface TextPosition {
  from: number
  to: number
}

interface TextSegment {
  normalized: string
  positions: TextPosition[]
}

const EMPTY_STATE: SearchHighlightState = {
  activeIndex: -1,
  decorations: DecorationSet.empty,
  identity: null,
  matches: [],
  sourceDoc: null,
  staleReason: null,
  uiEpoch: -1,
}

const CODE_BLOCKS = new Set(["codeBlock"])
const EMBED_ATOMS = new Set([
  "csvEmbed",
  "horizontalRule",
  "image",
  "rawBlock",
  "shardBlock",
  "tag",
  "wikilink",
])

export const SEARCH_HIGHLIGHT_KEY = new PluginKey<SearchHighlightState>(
  "shardSearchHighlight"
)

function identityOf(plan: RevealPlan): RevealIdentity {
  return {
    requestId: plan.requestId,
    revision: plan.revision,
    targetKey: plan.target.key,
  }
}

function resultIdentity(identity: RevealIdentity) {
  return {
    requestId: identity.requestId,
    revision: identity.revision,
    targetKey: identity.targetKey,
  }
}

function decorationsFor(
  doc: ProseMirrorNode,
  matches: readonly SearchHighlightMatch[],
  activeIndex: number
) {
  return DecorationSet.create(
    doc,
    matches.map((match, index) =>
      Decoration.inline(match.from, match.to, {
        class:
          index === activeIndex
            ? "shard-rich-search-hit shard-rich-search-hit--active"
            : "shard-rich-search-hit",
        "data-search-hit": index === activeIndex ? "active" : "match",
      })
    )
  )
}

function applyMeta(
  transaction: Transaction,
  previous: SearchHighlightState,
  meta: SearchHighlightMeta
): SearchHighlightState {
  if (meta.type === "show") {
    return {
      activeIndex: meta.activeIndex,
      decorations: decorationsFor(transaction.doc, meta.matches, meta.activeIndex),
      identity: meta.identity,
      matches: meta.matches,
      sourceDoc: meta.sourceDoc,
      staleReason: null,
      uiEpoch: meta.uiEpoch,
    }
  }

  if (meta.type === "step") {
    return {
      ...previous,
      activeIndex: meta.activeIndex,
      decorations: decorationsFor(transaction.doc, previous.matches, meta.activeIndex),
    }
  }

  return {
    ...EMPTY_STATE,
    identity: meta.identity,
    staleReason: meta.staleReason,
    uiEpoch: meta.uiEpoch,
  }
}

function clearMeta(
  state: SearchHighlightState,
  staleReason: SearchHighlightState["staleReason"] = null
): SearchHighlightMeta {
  return {
    type: "clear",
    identity: state.identity,
    staleReason,
    uiEpoch: state.uiEpoch,
  }
}

function dispatchMeta(editor: Editor, meta: SearchHighlightMeta) {
  if (editor.isDestroyed) return
  editor.view.dispatch(
    editor.state.tr
      .setMeta(SEARCH_HIGHLIGHT_KEY, meta)
      .setMeta("addToHistory", false)
  )
}

function appendText(segment: TextSegment, text: string, start: number) {
  let offset = 0
  for (const character of text) {
    const width = character.length
    const normalized = normalizeSearchText(character)
    segment.normalized += normalized
    for (let index = 0; index < normalized.length; index += 1) {
      segment.positions.push({ from: start + offset, to: start + offset + width })
    }
    offset += width
  }
}

function findTermRanges(segment: TextSegment, terms: readonly string[]) {
  const ranges: SearchHighlightMatch[] = []
  for (const term of terms) {
    if (!term) continue
    let start = 0
    while (start <= segment.normalized.length - term.length) {
      const found = segment.normalized.indexOf(term, start)
      if (found < 0) break
      const first = segment.positions[found]
      const last = segment.positions[found + term.length - 1]
      if (first && last) ranges.push({ from: first.from, to: last.to })
      start = found + Math.max(term.length, 1)
    }
  }
  return ranges
}

function mergeRanges(ranges: readonly SearchHighlightMatch[]) {
  const sorted = [...ranges].sort((left, right) => left.from - right.from || left.to - right.to)
  const merged: SearchHighlightMatch[] = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && range.from < previous.to) previous.to = Math.max(previous.to, range.to)
    else merged.push({ ...range })
  }
  return merged
}

function atomSearchText(node: ProseMirrorNode) {
  if (node.type.name === "tag") return `#${String(node.attrs.name ?? "")}`
  if (node.type.name === "wikilink") {
    return String(node.attrs.alias ?? node.attrs.target ?? "")
  }
  if (node.type.name === "csvEmbed") return String(node.attrs.path ?? "")
  if (node.type.name === "image") return String(node.attrs.alt ?? node.attrs.src ?? "")
  return String(node.attrs.source ?? node.textContent ?? "")
}

function containsTerm(text: string, terms: readonly string[]) {
  const normalized = normalizeSearchText(text)
  return terms.some((term) => term.length > 0 && normalized.includes(term))
}

/** Rebuilds visible text positions from the current PM document. */
export function projectSearchHighlights(
  doc: ProseMirrorNode,
  rawTerms: readonly string[]
): SearchProjection {
  const terms = [...new Set(rawTerms.map(normalizeSearchText).filter(Boolean))]
  const matches: SearchHighlightMatch[] = []
  let excludedReason: SearchProjection["excludedReason"] = null

  doc.descendants((node, position) => {
    if (CODE_BLOCKS.has(node.type.name)) {
      if (!excludedReason && containsTerm(node.textContent, terms)) excludedReason = "codeBlock"
      return false
    }

    if (node.isAtom && EMBED_ATOMS.has(node.type.name)) {
      if (!excludedReason && containsTerm(atomSearchText(node), terms)) excludedReason = "embed"
      return false
    }

    if (!node.isTextblock) return true

    let segment: TextSegment = { normalized: "", positions: [] }
    const flush = () => {
      matches.push(...findTermRanges(segment, terms))
      segment = { normalized: "", positions: [] }
    }

    node.descendants((child, childPosition) => {
      if (child.isText) {
        appendText(segment, child.text ?? "", position + 1 + childPosition)
        return false
      }
      if (child.isAtom) {
        flush()
        if (!excludedReason && containsTerm(atomSearchText(child), terms)) {
          excludedReason = "embed"
        }
        return false
      }
      return true
    })
    flush()
    return false
  })

  return { excludedReason, matches: mergeRanges(matches) }
}

export function getSearchHighlightState(editor: Editor) {
  return SEARCH_HIGHLIGHT_KEY.getState(editor.state) ?? EMPTY_STATE
}

function staleResult(
  identity: RevealIdentity,
  reason: "revisionChanged" | "privacyChanged"
): RevealResult {
  return { ...resultIdentity(identity), reason, status: "stale" }
}

function cancelledResult(identity: RevealIdentity): RevealResult {
  return { ...resultIdentity(identity), status: "cancelled" }
}

async function scrollMatchIntoViewport(
  editor: Editor,
  match: SearchHighlightMatch,
  getViewport: () => HTMLElement | null
) {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (editor.isDestroyed) return
  const viewport = getViewport()
  if (!viewport) return

  const matchRect = editor.view.coordsAtPos(match.from)
  const viewportRect = viewport.getBoundingClientRect()
  const inset = 12
  if (matchRect.top < viewportRect.top + inset) {
    viewport.scrollTop += matchRect.top - viewportRect.top - inset
  } else if (matchRect.bottom > viewportRect.bottom - inset) {
    viewport.scrollTop += matchRect.bottom - viewportRect.bottom + inset
  }
}

export function createSearchRevealHandle(
  getEditor: () => Editor | null,
  getViewport: () => HTMLElement | null
): SearchRevealHandle {
  return {
    async revealTerms(plan, signal) {
      const identity = identityOf(plan)
      const editor = getEditor()
      if (!editor || editor.isDestroyed || signal?.aborted) return cancelledResult(identity)

      const previous = getSearchHighlightState(editor)
      if (plan.uiEpoch < previous.uiEpoch) return staleResult(identity, "privacyChanged")
      if (editor.view.composing) {
        dispatchMeta(editor, clearMeta(previous, "revisionChanged"))
        return cancelledResult(identity)
      }

      const sourceDoc = editor.state.doc
      const projection = projectSearchHighlights(sourceDoc, plan.terms)
      await Promise.resolve()
      if (signal?.aborted) return cancelledResult(identity)
      if (editor.state.doc !== sourceDoc) return staleResult(identity, "revisionChanged")

      if (projection.matches.length === 0) {
        dispatchMeta(editor, {
          type: "clear",
          identity,
          staleReason: null,
          uiEpoch: plan.uiEpoch,
        })
        if (projection.excludedReason) {
          return {
            ...resultIdentity(identity),
            reason: projection.excludedReason,
            status: "documentOnly",
          }
        }
        return { ...resultIdentity(identity), status: "noVisibleMatch" }
      }

      dispatchMeta(editor, {
        type: "show",
        activeIndex: 0,
        identity,
        matches: projection.matches,
        sourceDoc,
        uiEpoch: plan.uiEpoch,
      })
      await scrollMatchIntoViewport(editor, projection.matches[0], getViewport)
      return {
        ...resultIdentity(identity),
        activeIndex: 0,
        matchCount: projection.matches.length,
        status: "revealed",
      }
    },

    async stepHit(direction) {
      const editor = getEditor()
      if (!editor || editor.isDestroyed) {
        return { requestId: "", revision: "", status: "cancelled", targetKey: "" }
      }
      const state = getSearchHighlightState(editor)
      if (!state.identity) {
        return { requestId: "", revision: "", status: "cancelled", targetKey: "" }
      }
      if (state.staleReason) return staleResult(state.identity, state.staleReason)
      if (state.sourceDoc !== editor.state.doc) return staleResult(state.identity, "revisionChanged")
      if (state.matches.length === 0) return cancelledResult(state.identity)

      const activeIndex =
        (state.activeIndex + direction + state.matches.length) % state.matches.length
      dispatchMeta(editor, { type: "step", activeIndex })
      await scrollMatchIntoViewport(editor, state.matches[activeIndex], getViewport)
      return {
        ...resultIdentity(state.identity),
        activeIndex,
        matchCount: state.matches.length,
        status: "revealed",
      }
    },

    clearHits(reason) {
      const editor = getEditor()
      if (!editor || editor.isDestroyed) return
      const state = getSearchHighlightState(editor)
      dispatchMeta(
        editor,
        clearMeta(state, reason === "edit" ? "revisionChanged" : null)
      )
    },
  }
}

class SearchHighlightPluginView {
  constructor(private readonly view: EditorView) {
    view.dom.addEventListener("compositionstart", this.onCompositionStart)
    view.dom.addEventListener("compositionend", this.onCompositionEnd)
  }

  destroy() {
    this.view.dom.removeEventListener("compositionstart", this.onCompositionStart)
    this.view.dom.removeEventListener("compositionend", this.onCompositionEnd)
    this.view.dom.classList.remove("shard-rich-search-composing")
  }

  private onCompositionStart = () => {
    this.view.dom.classList.add("shard-rich-search-composing")
    const state = SEARCH_HIGHLIGHT_KEY.getState(this.view.state) ?? EMPTY_STATE
    this.view.dispatch(
      this.view.state.tr
        .setMeta(SEARCH_HIGHLIGHT_KEY, clearMeta(state, "revisionChanged"))
        .setMeta("addToHistory", false)
    )
  }

  private onCompositionEnd = () => {
    this.view.dom.classList.remove("shard-rich-search-composing")
  }
}

export const ShardSearchHighlight = Extension.create({
  name: "shardSearchHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<SearchHighlightState>({
        key: SEARCH_HIGHLIGHT_KEY,
        state: {
          init: () => EMPTY_STATE,
          apply(transaction, previous) {
            const meta = transaction.getMeta(SEARCH_HIGHLIGHT_KEY) as
              | SearchHighlightMeta
              | undefined
            if (meta) return applyMeta(transaction, previous, meta)
            if (transaction.docChanged) {
              return {
                ...EMPTY_STATE,
                identity: previous.identity,
                staleReason: previous.identity ? "revisionChanged" : null,
                uiEpoch: previous.uiEpoch,
              }
            }
            return previous
          },
        },
        props: {
          decorations: (state) =>
            SEARCH_HIGHLIGHT_KEY.getState(state)?.decorations ?? DecorationSet.empty,
        },
        view: (view) => new SearchHighlightPluginView(view),
      }),
    ]
  },
})
