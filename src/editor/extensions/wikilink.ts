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
  WidgetType,
  type DecorationSet,
} from "@codemirror/view"
import { createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { toast } from "sonner"

import { CsvPreview } from "@/components/shard/csv-preview"
import { getApiErrorMessage, openCsvFile } from "@/lib/api"

import {
  isCsvWikilinkTarget,
  normalizeWikilinkTarget,
  resolveWikilinkTarget,
  type WikilinkCandidate,
  type WikilinkMatch,
} from "@/lib/wikilink"
import { parseWikilinksInWorker } from "@/lib/wikilink-worker"

interface ShardWikilinkOptions {
  getCandidates: () => readonly WikilinkCandidate[]
  maxCsvRows: number
  onMissingTarget: (target: string) => void
  onNavigate: (fragmentId: string) => void
}

interface DecoratedWikilink extends WikilinkMatch {
  csvExists?: boolean
  csvPath?: string
  fragmentId?: string
  maxCsvRows?: number
}

const csvPreviewRoots = new WeakMap<HTMLElement, Root>()

class CsvPreviewWidget extends WidgetType {
  constructor(readonly path: string, readonly maxRows: number) {
    super()
  }

  eq(other: CsvPreviewWidget) {
    return this.path === other.path && this.maxRows === other.maxRows
  }

  get estimatedHeight() {
    return 320
  }

  toDOM() {
    const container = document.createElement("div")
    container.className = "shard-cm-csv-widget"
    const root = createRoot(container)
    csvPreviewRoots.set(container, root)
    root.render(createElement(CsvPreview, { maxRows: this.maxRows, path: this.path }))
    return container
  }

  destroy(dom: HTMLElement) {
    csvPreviewRoots.get(dom)?.unmount()
    csvPreviewRoots.delete(dom)
  }

  ignoreEvent() {
    return true
  }
}

const setWikilinkDecorations = StateEffect.define<readonly DecoratedWikilink[]>()

const wikilinkDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setWikilinkDecorations)) continue
      const ranges = effect.value.map((link) => {
        const line = transaction.state.doc.lineAt(link.from)
        const source = transaction.state.doc.sliceString(link.from, link.to)
        const isStandaloneEmbed =
          link.embed && line.text.trim() === source && Boolean(link.csvPath)

        if (isStandaloneEmbed && link.csvPath) {
          return Decoration.replace({
            block: true,
            widget: new CsvPreviewWidget(link.csvPath, link.maxCsvRows ?? 10),
          }).range(line.from, line.to)
        }

        return Decoration.mark({
            attributes: {
              "data-wikilink-csv-path": link.csvPath ?? "",
              "data-wikilink-id": link.fragmentId ?? "",
              "data-wikilink-target": link.target,
              role: "link",
            },
            class: link.fragmentId || link.csvExists
              ? "shard-cm-wikilink"
              : "shard-cm-wikilink shard-cm-wikilink--missing",
          }).range(link.from, link.to)
      })
      next = Decoration.set(
        ranges,
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
        detail:
          candidate.kind === "csv"
            ? "CSV"
            : candidate.kind === "note"
              ? "笔记"
              : "碎片",
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
  maxCsvRows,
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
                links.map((link) => {
                  const candidate = resolveWikilinkTarget(link.target, candidates)
                  return {
                    ...link,
                    csvPath:
                      candidate?.kind === "csv"
                        ? candidate.path
                        : isCsvWikilinkTarget(link.target)
                          ? link.target
                          : undefined,
                    csvExists: candidate?.kind === "csv",
                    fragmentId:
                      candidate?.kind === "csv" ? undefined : candidate?.fragmentId,
                    maxCsvRows,
                  }
                })
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
        const csvPath = element.dataset.wikilinkCsvPath
        const target = element.dataset.wikilinkTarget ?? ""
        if (fragmentId) onNavigate(fragmentId)
        else if (csvPath) {
          void openCsvFile(csvPath).catch((error) => {
            toast.error(`打开 CSV 失败：${getApiErrorMessage(error)}`, {
              duration: Infinity,
            })
          })
        }
        else onMissingTarget(target)
        return true
      },
    }),
  ]
}
