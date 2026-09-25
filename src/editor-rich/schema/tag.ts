import { Node, mergeAttributes } from "@tiptap/core"

import { LOCKBOX_TAG } from "@/lib/lockbox"

export interface TagAttributes {
  /** 归一化后的标签名，不含前导 `#`。 */
  name: string
}

/**
 * 标签芯片：行内原子节点，Markdown 写作 `#名字`。
 * 阶段 0 只定义 schema，识别与序列化规则在 `src/editor-rich/markdown/`。
 */
export const Tag = Node.create({
  name: "tag",
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return {
      name: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-shard-tag") ?? "",
        renderHTML: (attributes) => ({ "data-shard-tag": attributes.name }),
      },
    }
  },

  parseHTML() {
    return [{ tag: "span[data-shard-tag]" }]
  },

  // 编辑态只着色不画芯片：标签是普通行内文本的一段颜色，没有背景块也没有
  // 内外边距，`#标签 ` 前后的空格因此保持可见可编辑（flomo 式间隔规则）。
  renderHTML({ HTMLAttributes, node }) {
    const name = String(node.attrs.name ?? "")
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class:
          name === LOCKBOX_TAG
            ? "shard-rich-tag shard-rich-tag--lockbox"
            : "shard-rich-tag",
      }),
      `#${name}`,
    ]
  },
})
