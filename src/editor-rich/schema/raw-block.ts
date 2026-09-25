import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"

import { ISOLATED_NODE_VIEW_OPTIONS } from "./node-view-utils"
import { RawBlockNodeView } from "./raw-block-view"

export interface RawBlockAttributes {
  /** 方言不认识的块级结构原文，原样保留以保证往返无损。 */
  source: string
}

/** 原始块：块级 HTML、链接引用定义等方言未建模结构的兜底容器。 */
export const RawBlock = Node.create({
  name: "rawBlock",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      source: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-raw-source") ?? "",
        renderHTML: (attributes) => ({ "data-raw-source": attributes.source }),
      },
    }
  },

  parseHTML() {
    return [{ tag: "div[data-raw-source]" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-shard-block": "raw" })]
  },

  addNodeView() {
    return ReactNodeViewRenderer(RawBlockNodeView, ISOLATED_NODE_VIEW_OPTIONS)
  },
})
