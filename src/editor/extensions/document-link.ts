import { syntaxTree } from "@codemirror/language"
import { type Extension, type Range } from "@codemirror/state"
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view"

import type { ShardDocumentLink } from "@/types"

function parseDocumentLink(href: string): ShardDocumentLink | null {
  const match = /^shard:\/\/(map|flow)\/([^/?#]+)$/u.exec(href)
  if (!match) return null
  try {
    const targetId = decodeURIComponent(match[2])
    return targetId ? { id: href, targetType: match[1] as "map" | "flow", targetId } : null
  } catch { return null }
}

/** Reuse the editor's incremental syntax tree; only decorate visible document links. */
function documentLinkDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = []
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({ from, to, enter(node) {
      if (node.name !== "Link") return
      const url = node.node.getChild("URL")
      if (!url) return
      const href = view.state.sliceDoc(url.from, url.to)
      if (!parseDocumentLink(href)) return
      ranges.push(Decoration.mark({
        class: "shard-cm-wikilink",
        attributes: { "data-shard-document-link": href, role: "link", tabindex: "0", title: "打开图文档" },
      }).range(node.from, node.to))
      return false
    } })
  }
  return Decoration.set(ranges, true)
}

export function createShardDocumentLinkExtension(onOpen: (link: ShardDocumentLink) => void): Extension {
  const open = (event: Event): boolean => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-shard-document-link]") : null
    const link = parseDocumentLink(element?.dataset.shardDocumentLink ?? "")
    if (!link) return false
    event.preventDefault()
    onOpen(link)
    return true
  }
  return [
    ViewPlugin.fromClass(class {
      decorations: DecorationSet
      constructor(view: EditorView) { this.decorations = documentLinkDecorations(view) }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
          this.decorations = documentLinkDecorations(update.view)
        }
      }
    }, { decorations: instance => instance.decorations }),
    EditorView.domEventHandlers({
      click: open,
      keydown: event => event.key === "Enter" && event.target instanceof HTMLElement && event.target.hasAttribute("data-shard-document-link") ? open(event) : false,
    }),
  ]
}
