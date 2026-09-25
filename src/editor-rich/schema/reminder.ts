import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"

import { ReminderNodeView } from "./reminder-view"

export interface ReminderAttributes {
  /** 本地时间 `YYYY-MM-DD HH:mm`，不含 `⏰` 前缀。 */
  at: string
}

/**
 * 提醒芯片：行内原子节点，Markdown 写作 `⏰ YYYY-MM-DD HH:mm`
 * （obsidian-reminder 的 Tasks 兼容写法）。识别与序列化规则在 `src/editor-rich/markdown/`。
 *
 * 与标签不同，提醒是独立的一枚芯片：编辑区里不露出日期语法，
 * 点开芯片可以改时间或清除。
 */
export const Reminder = Node.create({
  name: "reminder",
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return {
      at: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-shard-reminder") ?? "",
        renderHTML: (attributes) => ({ "data-shard-reminder": attributes.at }),
      },
    }
  },

  parseHTML() {
    return [{ tag: "span[data-shard-reminder]" }]
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "shard-rich-reminder" }),
      `⏰ ${String(node.attrs.at ?? "")}`,
    ]
  },

  // 复制成纯文本时写回文件里的原始写法，粘贴到别处仍能被识别。
  renderText({ node }) {
    return `⏰ ${String(node.attrs.at ?? "")}`
  },

  addNodeView() {
    // 芯片是弹层触发器：按下与点击都拦在 ProseMirror 之外（否则按下会先变成节点选区），
    // 其余事件照常交给编辑器，Backspace 整体删除不受影响。
    return ReactNodeViewRenderer(ReminderNodeView, {
      stopEvent: ({ event }) => event.type === "click" || event.type === "mousedown",
    })
  },
})
