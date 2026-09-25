import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"

import { CsvEmbedNodeView } from "./csv-embed-view"
import { ISOLATED_NODE_VIEW_OPTIONS } from "./node-view-utils"

export interface CsvEmbedAttributes {
  /** 库内 CSV 路径，来自独占一行的 `![[x.csv]]`。 */
  path: string
}

/**
 * 宿主面决定预览行数：资料库与禅模式 50 行，卡片与速记框 10 行
 * （与旧编辑器各宿主的 `maxCsvRows` 一致）。挂在实例 storage 上，
 * 理由同 `WikilinkHostBridge`：扩展集是模块级的一份。
 */
export interface CsvEmbedStorage {
  maxRows: number
}

declare module "@tiptap/core" {
  interface Storage {
    csvEmbed: CsvEmbedStorage
  }
}

/** CSV 嵌入：块级原子节点，只读预览。 */
export const CsvEmbed = Node.create<Record<string, never>, CsvEmbedStorage>({
  name: "csvEmbed",
  group: "block",
  atom: true,
  draggable: true,

  addStorage() {
    return { maxRows: 10 }
  },

  addAttributes() {
    return {
      path: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-csv-path") ?? "",
        renderHTML: (attributes) => ({ "data-csv-path": attributes.path }),
      },
    }
  },

  parseHTML() {
    return [{ tag: "div[data-csv-path]" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-shard-block": "csv-embed" })]
  },

  addNodeView() {
    return ReactNodeViewRenderer(CsvEmbedNodeView, ISOLATED_NODE_VIEW_OPTIONS)
  },
})
