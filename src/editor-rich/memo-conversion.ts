import type { Editor } from "@tiptap/core"
import { closeHistory } from "@tiptap/pm/history"
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model"
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state"

import { MEMO_CONVERSION_META } from "./extensions/memo-guard"
import { NESTED_LIST_TYPES, taskItemHasDetail } from "./schema/task-item-utils"

/** 将标题内的续行拆成正文段落，保留各行的行内节点、标记及属性。 */
function splitTitleLines(title: ProseMirrorNode) {
  const lines: ProseMirrorNode[][] = [[]]
  title.forEach((child) => {
    if (child.type.name === "hardBreak") {
      lines.push([])
    } else if (child.isText && child.text?.includes("\n")) {
      let start = 0
      for (let offset = 0; offset < child.text.length; offset += 1) {
        if (child.text[offset] !== "\n") continue
        if (offset > start) lines[lines.length - 1].push(child.cut(start, offset))
        lines.push([])
        start = offset + 1
      }
      if (start < child.text.length) lines[lines.length - 1].push(child.cut(start))
    } else {
      lines[lines.length - 1].push(child)
    }
  })
  return lines.map((line) => title.copy(Fragment.fromArray(line)))
}

function isEmptyDetail(node: ProseMirrorNode) {
  if (node.type.name !== "paragraph") return false
  let empty = true
  node.forEach((child) => {
    if (child.type.name !== "hardBreak" && (!child.isText || child.text?.trim())) empty = false
  })
  return empty
}

/**
 * 备忘转复选框：备注成为下方正文，任务的勾选、提醒与子列表留在原位。
 * 嵌套任务的正文移到最外层包围列表之后，避免让父任务意外成为备忘。
 */
export function memoToTaskTransaction(state: EditorState, taskPos: number): Transaction | null {
  if (!Number.isInteger(taskPos) || taskPos < 0 || taskPos >= state.doc.content.size) return null
  const task = state.doc.nodeAt(taskPos)
  if (!task || task.type.name !== "taskItem" || !taskItemHasDetail(task)) return null
  const title = task.firstChild
  if (!title || title.type.name !== "paragraph") return null
  const $task = state.doc.resolve(taskPos)
  if ($task.parent.type.name !== "taskList") return null

  const [nextTitle, ...details] = splitTitleLines(title)
  const nestedLists: ProseMirrorNode[] = []
  for (let index = 1; index < task.childCount; index += 1) {
    const child = task.child(index)
    if (NESTED_LIST_TYPES.has(child.type.name)) nestedLists.push(child)
    else details.push(child)
  }
  // 插入命令留下的空备注栏没有正文可保留；非空备注内部的空段仍原样留下。
  const body = details.some((node) => !isEmptyDetail(node)) ? details : []
  const converted = task.copy(Fragment.fromArray([nextTitle, ...nestedLists]))
  const tr = state.tr

  let outerListDepth = $task.depth
  for (let depth = 1; depth < $task.depth; depth += 1) {
    if (NESTED_LIST_TYPES.has($task.node(depth).type.name)) {
      outerListDepth = depth
      break
    }
  }
  if (body.length === 0) {
    tr.replaceWith(taskPos, taskPos + task.nodeSize, converted)
  } else if (outerListDepth === $task.depth) {
    const list = $task.parent
    const before: ProseMirrorNode[] = []
    const after: ProseMirrorNode[] = []
    list.forEach((item, _offset, index) => {
      if (index < $task.index()) before.push(item)
      else if (index === $task.index()) before.push(converted)
      else after.push(item)
    })
    const replacement = [list.copy(Fragment.fromArray(before)), ...body]
    if (after.length > 0) replacement.push(list.copy(Fragment.fromArray(after)))
    tr.replaceWith($task.before(), $task.after(), Fragment.fromArray(replacement))
  } else {
    const afterOuterList = $task.after(outerListDepth)
    tr.replaceWith(taskPos, taskPos + task.nodeSize, converted)
    tr.insert(tr.mapping.map(afterOuterList, 1), Fragment.fromArray(body))
  }

  tr.setSelection(TextSelection.create(tr.doc, taskPos + 2 + nextTitle.content.size))
  return closeHistory(tr).setMeta(MEMO_CONVERSION_META, true)
}

export function convertMemoToTask(editor: Editor, taskPos: number) {
  if (editor.isDestroyed || !editor.isEditable) return false
  const tr = memoToTaskTransaction(editor.state, taskPos)
  if (!tr) return false
  editor.view.dispatch(tr)
  editor.view.focus()
  return true
}
