import type {
  Completion,
  CompletionContext,
  CompletionSource,
} from "@codemirror/autocomplete"
import {
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state"
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
} from "@codemirror/view"

import {
  normalizeWikilinkTarget,
  resolveWikilinkTarget,
  type WikilinkCandidate,
  type WikilinkMatch,
} from "@/lib/wikilink"
import { parseWikilinksInWorker } from "@/lib/wikilink-worker"

interface ShardWikilinkOptions {
  getCandidates: () => readonly WikilinkCandidate[]
  onMissingTarget: (target: string) => void
  onNavigate: (fragmentId: string) => void
}

interface DecoratedWikilink extends WikilinkMatch {
  fragmentId?: string
}

const setWikilinkDecorations = StateEffect.define<readonly DecoratedWikilink[]>()

const wikilinkDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setWikilinkDecorations)) continue
      next = Decoration.set(
        effect.value.map((link) =>
          Decoration.mark({
            attributes: {
              "data-wikilink-id": link.fragmentId ?? "",
              "data-wikilink-target": link.target,
              role: "link",
            },
            class: link.fragmentId
              ? "shard-cm-wikilink"
              : "shard-cm-wikilink shard-cm-wikilink--missing",
          }).range(link.from, link.to)
        ),
        true
      )
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

export function createShardWikilinkCompletionSource({
  getCandidates,
}: Pick<ShardWikilinkOptions, "getCandidates">): CompletionSource {
  return (context: CompletionContext) => {
    if (context.view?.composing) return null

    const before = context.matchBefore(/\[\[[^\]|\]]*$/u)
    if (!before) return null
    const query = normalizeWikilinkTarget(before.text.slice(2))
    const options: Completion[] = getCandidates()
      .filter((candidate) =>
        query
          ? normalizeWikilinkTarget(
              `${candidate.label} ${candidate.target}`
            ).includes(query)
          : true
      )
      .slice(0, 12)
      .map((candidate) => ({
        apply: `[[${candidate.target}]]`,
        detail: candidate.kind === "note" ? "笔记" : "碎片",
        label: candidate.label,
        type: "shard-wikilink",
      }))

    return {
      filter: false,
      from: before.from,
      options,
      to: context.pos,
    }
  }
}

export function createShardWikilinkExtension({
  getCandidates,
  onMissingTarget,
  onNavigate,
}: ShardWikilinkOptions): Extension {
  const parserPlugin = ViewPlugin.fromClass(
    class {
      private destroyed = false
      private timer: number | null = null
      private version = 0

      constructor(private readonly view: EditorView) {
        this.scheduleParse()
      }

      update(update: { docChanged: boolean }) {
        if (update.docChanged) this.scheduleParse()
      }

      destroy() {
        this.destroyed = true
        this.version += 1
        if (this.timer !== null) window.clearTimeout(this.timer)
      }

      private scheduleParse() {
        if (this.timer !== null) window.clearTimeout(this.timer)
        this.timer = window.setTimeout(() => {
          this.timer = null
          this.parse()
        }, 40)
      }

      private parse() {
        const version = this.version + 1
        this.version = version
        const content = this.view.state.doc.toString()
        void parseWikilinksInWorker(content)
          .then((links) => {
            if (this.destroyed || version !== this.version) return
            const candidates = getCandidates()
            this.view.dispatch({
              effects: setWikilinkDecorations.of(
                links.map((link) => ({
                  ...link,
                  fragmentId:
                    resolveWikilinkTarget(link.target, candidates)?.fragmentId,
                }))
              ),
            })
          })
          .catch(() => {
            // worker 错误不能回退到主线程解析大正文；保留当前 decoration。
          })
      }
    }
  )

  return [
    wikilinkDecorationField,
    parserPlugin,
    EditorView.domEventHandlers({
      click(event) {
        const element =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-wikilink-target]")
            : null
        if (!element) return false

        event.preventDefault()
        const fragmentId = element.dataset.wikilinkId
        const target = element.dataset.wikilinkTarget ?? ""
        if (fragmentId) onNavigate(fragmentId)
        else onMissingTarget(target)
        return true
      },
    }),
  ]
}
