import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"

import { ISOLATED_NODE_VIEW_OPTIONS } from "./node-view-utils"
import { ShardBlockNodeView } from "./shard-block-view"

export interface ShardBlockAttributes {
  /** 围栏语言，必须在块注册表里，否则解析为普通代码块。 */
  lang: string
  /** 围栏体原文，转换层原样保留，由注册表的 parse/serialize 负责解释。 */
  source: string
}

/**
 * 通用围栏块：大纲块、数据表以及未来插件的块都走这一个节点，
 * NodeView 与卡片渲染按 `lang` 从块注册表分派（技术方案 §4.4）。
 */
export const ShardBlock = Node.create({
  name: "shardBlock",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      lang: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-shard-block-lang") ?? "",
        renderHTML: (attributes) => ({ "data-shard-block-lang": attributes.lang }),
      },
      source: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-shard-block-source") ?? "",
        renderHTML: (attributes) => ({ "data-shard-block-source": attributes.source }),
      },
    }
  },

  parseHTML() {
    return [{ tag: "div[data-shard-block-lang]" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes)]
  },

  addNodeView() {
    return ReactNodeViewRenderer(ShardBlockNodeView, ISOLATED_NODE_VIEW_OPTIONS)
  },
})
