import { getSchema } from "@tiptap/core"
import type { AnyExtension } from "@tiptap/core"
import Highlight from "@tiptap/extension-highlight"
import Image from "@tiptap/extension-image"
import Link from "@tiptap/extension-link"
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table"
import { TaskItem } from "@tiptap/extension-task-item"
import { TaskList } from "@tiptap/extension-task-list"
import Underline from "@tiptap/extension-underline"
import { ReactNodeViewRenderer } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"

import { CsvEmbed } from "./csv-embed"
import { ImageNodeView } from "./image-view"
import { ISOLATED_NODE_VIEW_OPTIONS } from "./node-view-utils"
import { RawBlock } from "./raw-block"
import { Reminder } from "./reminder"
import { ShardBlock } from "./shard-block"
import { Tag } from "./tag"
import { TASK_ITEM_CONTROL_ATTRIBUTE, TaskItemNodeView } from "./task-item-view"
import { Wikilink } from "./wikilink"

export { CsvEmbed } from "./csv-embed"
export { RawBlock } from "./raw-block"
export { Reminder } from "./reminder"
export { ShardBlock } from "./shard-block"
export { Tag } from "./tag"
export { Wikilink } from "./wikilink"
export type { CsvEmbedAttributes } from "./csv-embed"
export type { RawBlockAttributes } from "./raw-block"
export type { ReminderAttributes } from "./reminder"
export type { ShardBlockAttributes } from "./shard-block"
export type { TagAttributes } from "./tag"
export type { WikilinkAttributes } from "./wikilink"

/**
 * Shard 方言的完整扩展集。阶段 0 只用它产出 schema 与文档 JSON，
 * 不构造 Editor 实例，因此整套在无 DOM 的 node 环境下可用。
 *
 * `underline` / `link` 关掉 StarterKit 自带的一份，改用同名独立扩展，
 * 避免重复注册警告，也让方言用到的扩展在这一处列全。
 */
export const shardEditorExtensions: AnyExtension[] = [
  StarterKit.configure({ underline: false, link: false }),
  Underline,
  // `shard://map|flow/<id>` 是图文档链接；不列进协议白名单，渲染时 href 会被清空。
  Link.configure({ openOnClick: false, protocols: ["shard"] }),
  Highlight,
  // 行内图片与独占一行的图片共用一个节点：独占一行时段落里只有这一个子节点，
  // 序列化后自然还是独占一行，行内图片也不会退化成字面文本。
  Image.extend({
    // 图片是不可编辑的原子节点，内部的按钮与对话框全部拦在 ProseMirror 之外。
    addNodeView() {
      return ReactNodeViewRenderer(ImageNodeView, ISOLATED_NODE_VIEW_OPTIONS)
    },
  }).configure({ inline: true }),
  TaskList.extend({
    addAttributes() {
      return {
        // `1. [ ] 事项` 是有序任务：保留序号语义，序列化写回 `1. [ ] `、`2. [ ] `，
        // 不被规范成无序的 `- [ ] `。缺省 false，普通任务列表的 DOM 不多一个属性。
        ordered: {
          default: false,
          parseHTML: (element) => element.getAttribute("data-ordered") === "true",
          renderHTML: (attributes) =>
            attributes.ordered === true ? { "data-ordered": "true" } : {},
        },
      }
    },
  }),
  TaskItem.extend({
    // 备忘卡片是任务项的渲染增强，不进围栏块注册表（技术方案 §4.4 末段）。
    // NodeView 的外层元素必须仍是 `li`，taskList 的 `ul` 才有合法子节点。
    addNodeView() {
      return ReactNodeViewRenderer(TaskItemNodeView, {
        as: "li",
        // 外层 li 保持与默认 NodeView 一样的数据属性，样式与 DOM 解析口径不变。
        attrs: ({ node }) => ({
          "data-checked": node.attrs.checked === true ? "true" : "false",
          "data-type": "taskItem",
        }),
        // 复选框与折叠钮落在 contentDOM 之外，事件全部拦在 ProseMirror 之外；
        // 正文区域照常交给编辑器，输入法与选区不受影响。
        stopEvent: ({ event }) =>
          event.target instanceof HTMLElement &&
          event.target.closest(`[${TASK_ITEM_CONTROL_ATTRIBUTE}]`) !== null,
      })
    },
  }).configure({
    nested: true,
    // 复选框的读屏名称与卡片渲染、旧编辑器 widget 统一，默认的英文串不留在界面上。
    a11y: {
      checkboxLabel: (_node, checked) => (checked ? "标记为未完成" : "标记为完成"),
    },
  }),
  Table,
  TableRow,
  TableHeader,
  TableCell,
  Tag,
  Wikilink,
  Reminder,
  CsvEmbed,
  ShardBlock,
  RawBlock,
]

/** 方言 schema，供转换层与测试校验文档 JSON 合法性。 */
export const shardSchema = getSchema(shardEditorExtensions)
