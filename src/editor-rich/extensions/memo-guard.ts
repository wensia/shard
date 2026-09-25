import { Extension } from "@tiptap/core"
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model"
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"

import { taskItemHasDetail } from "../schema/task-item-view"

/**
 * 备忘卡片的备注栏不可删除。
 *
 * 备忘卡片靠「任务项里除了标题还有备注块」来认（见 taskItemHasDetail）。
 * 备注块一旦被并进标题或删掉，这一项就退回普通任务，编辑器里也没有入口再把
 * 备注栏加回来。这里分两层守住它：
 *
 * - 键位：在备注段开头按退格只把光标送回标题末尾，在标题末尾按 Delete 不把
 *   备注并上来——这两种是最常见的误删路径，直接不让它发生；
 * - 兜底：任何事务（选区删除、剪切、粘贴覆盖……）让一个原本的备忘项丢了备注块，
 *   就在同一拍补回一个空备注段。补回的步骤由 appendTransaction 追加，与原操作
 *   同属一次撤销。整张卡片被删掉（任务项自身没了）时不补。
 *
 * 空备注不写回文件是既有规则（没有细节的任务项仍是普通任务行），这里只管
 * 编辑会话里不丢栏。
 */

const memoGuardKey = new PluginKey("shardMemoGuard")

/**
 * 按键这一刻的光标位置，以 DOM 为准：连续按方向键再立刻按删除时，
 * ProseMirror 的选区要等 selectionchange 才同步，键位处理拿到的可能还是上一处。
 * 选区不是折叠的、或不在编辑器里时返回 null，交给默认行为。
 */
function caretAt(view: EditorView): ResolvedPos | null {
  const selection = view.dom.ownerDocument.getSelection()
  if (selection && selection.rangeCount > 0 && selection.isCollapsed && selection.anchorNode) {
    if (!view.dom.contains(selection.anchorNode)) return null
    try {
      return view.state.doc.resolve(view.posAtDOM(selection.anchorNode, selection.anchorOffset))
    } catch {
      return null
    }
  }
  const { $from, empty } = view.state.selection
  return empty ? $from : null
}

/** 光标所在的段落若是某个备忘项的第一块备注，返回标题末尾位置。 */
function firstNoteAtCursor($from: ResolvedPos) {
  if ($from.depth < 2 || $from.parentOffset !== 0) return null
  const item = $from.node(-1)
  if (item.type.name !== "taskItem" || $from.index(-1) !== 1) return null
  if (!taskItemHasDetail(item)) return null
  return $from.before() - 1
}

function isAtTitleEndOfMemo($from: ResolvedPos) {
  if ($from.depth < 2) return false
  const item = $from.node(-1)
  return (
    item.type.name === "taskItem" &&
    $from.index(-1) === 0 &&
    item.childCount > 1 &&
    $from.parentOffset === $from.parent.content.size &&
    taskItemHasDetail(item)
  )
}

function memoItemPositions(doc: ProseMirrorNode) {
  const positions: number[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === "taskItem" && taskItemHasDetail(node)) positions.push(pos)
    return true
  })
  return positions
}

export const ShardMemoGuard = Extension.create({
  name: "shardMemoGuard",
  // 排在默认键位（joinBackward / joinForward）之前。
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { view } = editor
        if (view.composing) return false
        const caret = caretAt(view)
        const titleEnd = caret ? firstNoteAtCursor(caret) : null
        if (titleEnd === null) return false
        const { state } = view
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, titleEnd)).scrollIntoView())
        return true
      },
      Delete: ({ editor }) => {
        const { view } = editor
        if (view.composing) return false
        const caret = caretAt(view)
        return caret !== null && isAtTitleEndOfMemo(caret)
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: memoGuardKey,
        appendTransaction(transactions, oldState, newState) {
          const changing = transactions.filter((tr) => tr.docChanged)
          if (changing.length === 0) return null

          const paragraph = newState.schema.nodes.paragraph
          if (!paragraph) return null
          const inserts: number[] = []
          for (const oldPos of memoItemPositions(oldState.doc)) {
            let pos = oldPos
            let deleted = false
            for (const tr of changing) {
              const result = tr.mapping.mapResult(pos, 1)
              if (result.deleted) {
                deleted = true
                break
              }
              pos = result.pos
            }
            if (deleted) continue
            const node = newState.doc.nodeAt(pos)
            if (!node || node.type.name !== "taskItem" || taskItemHasDetail(node)) continue
            const title = node.firstChild
            if (!title) continue
            inserts.push(pos + 1 + title.nodeSize)
          }
          if (inserts.length === 0) return null

          // 从后往前插，前面的位置不受后面插入的影响。
          const tr = newState.tr
          for (const at of inserts.sort((left, right) => right - left)) {
            tr.insert(at, paragraph.create())
          }
          return tr.setMeta(memoGuardKey, true)
        },
      }),
    ]
  },
})
