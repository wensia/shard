import type { Editor } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import type { EditorState, Transaction } from "@tiptap/pm/state"

import { getTagMarker } from "@/lib/editor-format"
import type { SlashCommandId } from "@/lib/slash-commands"

import { findBlockSlashItem, type ShardBlockSlashItem } from "./blocks/registry-ui"
import { characterBefore } from "./suggestion/inline-match"

/** 选区浮动条上的行内格式，与 `SelectionToolbar` 的按钮一一对应。 */
export type ShardRichInlineFormat = "bold" | "underline" | "highlight"

/** 碎片基础档暴露的行格式。 */
export type ShardRichLineFormat = "unordered" | "ordered" | "task"

/**
 * 文档档才开放的块级命令（产品框架 §2「文档在禅模式下拥有完整能力」）。
 * 0 表示回到正文段落，1–4 是方言允许的标题层级（技术方案 §3）。
 */
export type ShardRichHeadingLevel = 0 | 1 | 2 | 3 | 4

/**
 * `/` 菜单里由 `src/lib/slash-commands.ts` 提供的命令。
 *
 * 大纲导图与数据表不在这里——它们是围栏块，条目由块 UI 注册表提供，
 * 这样新增一个块不需要改编辑器的任何代码（产品框架 §10 验收口径）。
 */
export const RICH_SLASH_COMMAND_IDS: ReadonlySet<SlashCommandId> = new Set([
  "task",
  "unordered",
  "ordered",
  "table",
  "divider",
  "tag",
  "image",
  "memo",
  "outline",
  "flowchart",
  "document",
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "quote",
  "codeblock",
])

/**
 * 宿主接手的内容类型命令（产品框架 §6）。两套编辑器共用同一组回调名：
 * 编辑器只负责把命令转给宿主，模式切换与类型标记全部留在速记框一侧。
 */
export interface ShardRichHostCommands {
  onEnterOutline?: () => void
  onCreateFlowchart?: () => void
  onMarkDocument?: () => void
  onCreateDataset?: (position: number) => void
}

const TABLE_COLUMNS = 3
/** 含表头共 2 行，与旧编辑器 `createMarkdownTable(3, 2)` 的产物一致。 */
const TABLE_ROWS = 2
const FOCUS_RETRY_FRAMES = 10

export function applyRichInlineFormat(editor: Editor, format: ShardRichInlineFormat) {
  const chain = editor.chain().focus()
  if (format === "bold") chain.toggleBold()
  else if (format === "underline") chain.toggleUnderline()
  else chain.toggleHighlight()
  chain.run()
}

export function applyRichLineFormat(editor: Editor, format: ShardRichLineFormat) {
  const chain = editor.chain().focus()
  if (format === "unordered") chain.toggleBulletList()
  else if (format === "ordered") chain.toggleOrderedList()
  else chain.toggleTaskList()
  chain.run()
}

export function insertRichHorizontalRule(editor: Editor) {
  editor.chain().focus().setHorizontalRule().run()
}

/** 标题：0 回到正文段落，1–4 切到对应层级；重复点同一档也是切回正文。 */
export function applyRichHeading(editor: Editor, level: ShardRichHeadingLevel) {
  const chain = editor.chain().focus()
  if (level === 0) chain.setParagraph()
  else chain.toggleHeading({ level })
  chain.run()
}

export function toggleRichBlockquote(editor: Editor) {
  editor.chain().focus().toggleBlockquote().run()
}

export function toggleRichCodeBlock(editor: Editor) {
  editor.chain().focus().toggleCodeBlock().run()
}

export function insertRichTable(editor: Editor) {
  editor
    .chain()
    .focus()
    .insertTable({ cols: TABLE_COLUMNS, rows: TABLE_ROWS, withHeaderRow: true })
    .run()
}

/**
 * 只写下 `#`，随后由标签 Suggestion 接手候选。要不要补前置空格直接问
 * `getTagMarker`：这条规则（汉字/字母/数字后补空格，标点与空白后不补）
 * 只有一份真相源，不在富文本层抄第二遍。
 */
export function insertRichTagMarker(editor: Editor) {
  const previous = characterBefore(editor.state.selection.$from)
  const marker = getTagMarker(previous)
  editor.chain().focus().insertContent([{ type: "text", text: marker }]).run()
}

/**
 * 插入备忘卡片：一个任务项，标题段与细节段都留空，占位提示由 Placeholder
 * 给出（产品框架 §5.2「没有细节的任务项仍是普通任务行」）。光标落在标题，
 * 插完直接打字就是标题。
 */
export function insertRichMemoCard(editor: Editor) {
  editor
    .chain()
    .focus()
    .insertContent({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [{ type: "paragraph" }, { type: "paragraph" }],
        },
      ],
    })
    .run()

  const pos = findNearestNode(editor, "taskItem")
  if (pos === null) return
  // taskItem 起点 +1 进入任务项、+1 进入标题段落，正好是标题正文的起点。
  editor.chain().focus().setTextSelection(pos + 2).run()
}

/** 任务项标题段里已有的提醒芯片（按文档顺序）。 */
export function findTaskReminders(task: ProseMirrorNode, taskPos: number) {
  const title = task.firstChild
  const found: { pos: number; at: string }[] = []
  if (!title?.isTextblock) return found
  title.forEach((child, offset) => {
    if (child.type.name === "reminder") found.push({ pos: taskPos + 2 + offset, at: String(child.attrs.at ?? "") })
  })
  return found
}

const LEAF_PLACEHOLDER = "\ufffc"

function charAt(doc: ProseMirrorNode, from: number, to: number) {
  return doc.textBetween(from, to, "\n", LEAF_PLACEHOLDER)
}

/**
 * 删除 `pos` 处的提醒芯片，连带它和正文之间的那一个分隔空格：
 * 芯片在行尾时吃掉前面的空格，在句中时吃掉后面的空格，文件里不留多余空白。
 */
function deleteReminder(tr: Transaction, pos: number) {
  const node = tr.doc.nodeAt(pos)
  if (!node || node.type.name !== "reminder") return
  const $pos = tr.doc.resolve(pos)
  const start = $pos.start()
  const end = $pos.end()
  let from = pos
  let to = pos + node.nodeSize
  const after = to < end ? charAt(tr.doc, to, to + 1) : ""
  const before = from > start ? charAt(tr.doc, from - 1, from) : ""
  if ((after === "" || after === "\n" || after === LEAF_PLACEHOLDER) && before === " ") from -= 1
  else if (after === " ") to += 1
  tr.delete(from, to)
}

/** 任务项当前的提醒：优先取提升上来的 `reminder` 属性，退回标题段里第一个行内芯片。 */
export function taskReminderOf(task: ProseMirrorNode, taskPos: number): string | null {
  const attr = task.attrs.reminder
  if (typeof attr === "string" && attr) return attr
  return findTaskReminders(task, taskPos)[0]?.at ?? null
}

/**
 * 设置 / 替换 / 清除一张任务卡片的提醒（`at` 为 `YYYY-MM-DD HH:mm`，null 表示清除）。
 *
 * 提醒存成任务项的 `reminder` 属性，序列化时写回标题第一行末尾（Tasks 兼容写法要求
 * 与任务同一行）；一张卡片只保留一个，标题段里残留的行内芯片一并删掉。
 * 返回 null 表示位置不是任务项。
 */
export function taskReminderTransaction(
  state: EditorState,
  taskPos: number,
  at: string | null
): Transaction | null {
  const task = state.doc.nodeAt(taskPos)
  if (!task || task.type.name !== "taskItem" || !task.firstChild?.isTextblock) return null

  const tr = state.tr
  // 从后往前删，前面的位置不受影响；删行内芯片不改变任务项自身的起点。
  for (const reminder of [...findTaskReminders(task, taskPos)].reverse()) {
    deleteReminder(tr, reminder.pos)
  }
  tr.setNodeAttribute(taskPos, "reminder", at)
  return tr
}

export function setTaskReminder(editor: Editor, taskPos: number, at: string | null) {
  const tr = taskReminderTransaction(editor.state, taskPos, at)
  if (!tr) return false
  editor.view.dispatch(tr)
  return true
}

/** 删除单个提醒芯片（芯片自己的弹层里「清除提醒」用）。 */
export function removeReminder(editor: Editor, pos: number) {
  const tr = editor.state.tr
  deleteReminder(tr, pos)
  if (!tr.docChanged) return false
  editor.view.dispatch(tr)
  return true
}

/**
 * 图片命令没有纯文本产物：借一个隐藏 input 把文件交回宿主上传，
 * 与旧 CodeMirror 斜杠命令的做法保持一致。
 */
export function pickRichImageFiles(onImageFiles: (files: File[]) => void) {
  const input = document.createElement("input")
  input.type = "file"
  input.accept = "image/*"
  input.multiple = true
  input.style.display = "none"
  document.body.append(input)

  const finish = (files: File[]) => {
    input.remove()
    if (files.length > 0) onImageFiles(files)
  }

  input.addEventListener("change", () => finish(Array.from(input.files ?? [])))
  input.addEventListener("cancel", () => finish([]))
  input.click()
}

/**
 * 插入一个围栏块。编辑器不认识具体的块：模板与「插入后聚焦哪个元素」
 * 都由注册项自带（`ShardBlockSlashItem`）。
 */
export function insertRichShardBlock(editor: Editor, lang: string, slash: ShardBlockSlashItem, source = slash.template, position?: number) {
  editor
    .chain()
    .focus()
    .setTextSelection(position ?? editor.state.selection.from)
    .insertContent({ attrs: { lang, source }, type: "shardBlock" })
    .run()

  const pos = findInsertedShardBlock(editor, lang)
  if (pos === null) return

  // 块落在文档末尾时后面没有可落脚的文本位置；补一个空段落，
  // 选区随之移到围栏之外——这正是旧 widget「先挪选区再聚焦」的前提。
  const node = editor.state.doc.nodeAt(pos)
  const end = pos + (node?.nodeSize ?? 0)
  if (end >= editor.state.doc.content.size) {
    editor.chain().insertContentAt(end, { type: "paragraph" }).run()
  }

  if (slash.focusSelector) focusInsideShardBlock(editor, pos, slash.focusSelector)
}

/**
 * 刚插入的块：离当前选区最近、语言匹配的 `shardBlock`。
 * 不能只往光标前找——块落在空段落上时 ProseMirror 会把选区变成落在块自身的
 * NodeSelection，`pos` 恰好等于 `selection.from`。
 */
function findInsertedShardBlock(editor: Editor, lang: string): number | null {
  return findNearestNode(
    editor,
    "shardBlock",
    (node) => node.attrs.lang === lang
  )
}

/** 离当前选区最近的同名节点；插入命令用它定位刚写进去的那一个。 */
function findNearestNode(
  editor: Editor,
  typeName: string,
  match?: (node: ProseMirrorNode) => boolean
): number | null {
  const { doc, selection } = editor.state
  let found: number | null = null
  let best = Number.POSITIVE_INFINITY
  doc.descendants((node, pos) => {
    if (node.type.name !== typeName || (match && !match(node))) return true
    const distance = Math.abs(pos - selection.from)
    if (distance < best) {
      best = distance
      found = pos
    }
    return false
  })
  return found
}

/**
 * 把焦点交给 NodeView 里的某个输入框。NodeView 由 React 渲染，首帧未必已经
 * 落地，所以按帧重试若干次——与旧 `focusRoot` 的 requestAnimationFrame 兜底同理。
 */
function focusInsideShardBlock(editor: Editor, pos: number, selector: string) {
  let attempts = 0
  const focus = () => {
    if (editor.isDestroyed) return
    const dom = editor.view.nodeDOM(pos)
    const target = dom instanceof HTMLElement ? dom.querySelector<HTMLElement>(selector) : null
    if (!target) {
      attempts += 1
      if (attempts < FOCUS_RETRY_FRAMES) requestAnimationFrame(focus)
      return
    }
    target.focus()
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      const end = target.value.length
      target.setSelectionRange(end, end)
    }
  }
  requestAnimationFrame(focus)
}

export function runRichSlashCommand(
  editor: Editor,
  id: string,
  onImageFiles?: (files: File[]) => void,
  host?: ShardRichHostCommands
) {
  if (id === "dataset") {
    host?.onCreateDataset?.(editor.state.selection.from)
    return
  }
  const block = findBlockSlashItem(id)
  if (block) {
    insertRichShardBlock(editor, block.lang, block.slash)
    return
  }

  switch (id) {
    case "outline":
      host?.onEnterOutline?.()
      return
    case "flowchart":
      host?.onCreateFlowchart?.()
      return
    case "document":
      host?.onMarkDocument?.()
      return
    case "task":
    case "unordered":
    case "ordered":
      applyRichLineFormat(editor, id === "task" ? "task" : id)
      return
    case "table":
      insertRichTable(editor)
      return
    case "divider":
      insertRichHorizontalRule(editor)
      return
    case "memo":
      insertRichMemoCard(editor)
      return
    case "heading1":
    case "heading2":
    case "heading3":
    case "heading4":
      applyRichHeading(editor, Number(id.slice(-1)) as ShardRichHeadingLevel)
      return
    case "quote":
      toggleRichBlockquote(editor)
      return
    case "codeblock":
      toggleRichCodeBlock(editor)
      return
    case "tag":
      insertRichTagMarker(editor)
      return
    case "image":
      editor.commands.focus()
      if (onImageFiles) pickRichImageFiles(onImageFiles)
      return
    default:
      return
  }
}
