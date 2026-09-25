import { Node, mergeAttributes, type Editor } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"

import type { WikilinkCandidate } from "@/lib/wikilink"

import { WikilinkNodeView } from "./wikilink-view"

export interface WikilinkAttributes {
  /** `[[目标]]` 里的目标，语义与 `parseWikilinks` 一致。 */
  target: string
  /** `[[目标|别名]]` 的别名，没有时为 null。 */
  alias: string | null
}

/**
 * 宿主桥：候选集合与导航回调。
 *
 * 走 `editor.storage` 而不是扩展 options——`shardEditorExtensions` 是模块级
 * 的一份，转换层与无 DOM 测试都 import 它；每个编辑器实例的宿主回调只能挂在
 * 实例自己的 storage 上，否则多个编辑器会互相覆盖。
 */
export interface WikilinkHostBridge {
  getCandidates: () => readonly WikilinkCandidate[]
  onNavigate: ((target: string) => void) | null
}

declare module "@tiptap/core" {
  interface Storage {
    wikilink: WikilinkHostBridge
  }
}

const NO_CANDIDATES: readonly WikilinkCandidate[] = []

export function getWikilinkHost(editor: Editor): WikilinkHostBridge {
  return editor.storage.wikilink
}

/** 双链芯片：行内原子节点，Markdown 写作 `[[目标]]` 或 `[[目标|别名]]`。 */
export const Wikilink = Node.create<Record<string, never>, WikilinkHostBridge>({
  name: "wikilink",
  group: "inline",
  inline: true,
  atom: true,

  addStorage() {
    return { getCandidates: () => NO_CANDIDATES, onNavigate: null }
  },

  addAttributes() {
    return {
      target: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-wikilink-target") ?? "",
        renderHTML: (attributes) => ({ "data-wikilink-target": attributes.target }),
      },
      alias: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-wikilink-alias"),
        renderHTML: (attributes) =>
          attributes.alias ? { "data-wikilink-alias": attributes.alias } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: "span[data-wikilink-target]" }]
  },

  renderHTML({ HTMLAttributes, node }) {
    const target = String(node.attrs.target ?? "")
    const alias = node.attrs.alias ? String(node.attrs.alias) : ""
    return ["span", mergeAttributes(HTMLAttributes), alias || target]
  },

  addNodeView() {
    // 芯片是不含输入框的行内原子节点，不适用 `ISOLATED_NODE_VIEW_OPTIONS`：
    // 只把 click 拦在 ProseMirror 之外，其余事件照常交给编辑器，
    // 选区、Backspace 整体删除与拖选都保持原生行为。
    return ReactNodeViewRenderer(WikilinkNodeView, {
      stopEvent: ({ event }) => event.type === "click",
    })
  },
})
