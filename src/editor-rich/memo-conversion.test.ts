import type { JSONContent } from "@tiptap/core"
import { history, redo, undo } from "@tiptap/pm/history"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { EditorState, type Transaction } from "@tiptap/pm/state"
import { describe, expect, it } from "vitest"

import { createMemoGuardPlugin, MEMO_CONVERSION_META } from "./extensions/memo-guard"
import { parseShardMarkdown, serializeShardMarkdown } from "./markdown"
import { memoToTaskTransaction } from "./memo-conversion"
import { shardSchema } from "./schema"
import { taskItemHasDetail } from "./schema/task-item-utils"

function stateOf(content: string | JSONContent) {
  const doc = shardSchema.nodeFromJSON(typeof content === "string" ? parseShardMarkdown(content).doc : content)
  return EditorState.create({ doc, plugins: [history(), createMemoGuardPlugin()] })
}

function tasks(state: EditorState) {
  const found: { node: ProseMirrorNode; pos: number }[] = []
  state.doc.descendants((node, pos) => {
    if (node.type.name === "taskItem") found.push({ node, pos })
    return true
  })
  return found
}

function convert(state: EditorState, index = 0) {
  const tr = memoToTaskTransaction(state, tasks(state)[index].pos)
  expect(tr).not.toBeNull()
  const result = state.applyTransaction(tr!)
  expect(result.transactions.filter((item) => item.docChanged)).toHaveLength(1)
  return result.state
}

const paragraph = (text?: string): JSONContent => ({
  type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}),
})
const task = (title: string, rest: JSONContent[] = [], attrs = {}): JSONContent => ({
  type: "taskItem", attrs: { checked: false, ...attrs }, content: [paragraph(title), ...rest],
})
const list = (items: JSONContent[]): JSONContent => ({ type: "taskList", content: items })

describe("memoToTaskTransaction", () => {
  it("将备注放在当前任务下方，保留前后任务、勾选、标题格式和提醒", () => {
    const state = stateOf("- [ ] 前一项\n- [x] **买菜** ⏰ 2026-10-25 09:00\n  番茄、鸡蛋\n- [ ] 整理需求")
    const original = tasks(state)
    const converted = convert(state, 1)
    expect(serializeShardMarkdown(converted.doc.toJSON())).toBe(
      "- [ ] 前一项\n- [x] **买菜** ⏰ 2026-10-25 09:00\n\n番茄、鸡蛋\n\n- [ ] 整理需求"
    )
    const result = tasks(converted)
    expect(result[0].node.eq(original[0].node)).toBe(true)
    expect(result[2].node.eq(original[2].node)).toBe(true)
    expect(result[1].node.attrs).toEqual(original[1].node.attrs)
    expect(taskItemHasDetail(result[1].node)).toBe(false)
    const reloaded = stateOf(serializeShardMarkdown(converted.doc.toJSON()))
    expect(tasks(reloaded).every(({ node }) => !taskItemHasDetail(node))).toBe(true)
  })

  it("拆出标题中的软换行与硬换行，保留行内节点和格式", () => {
    const state = stateOf({
      type: "doc", content: [list([{
        type: "taskItem", attrs: { checked: true, reminder: "2026-10-25 09:00" },
        content: [{ type: "paragraph", content: [
          { type: "text", text: "标题\n备注", marks: [{ type: "bold" }] },
          { type: "hardBreak" },
          { type: "tag", attrs: { name: "生活" } },
          { type: "text", text: " 详情", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
        ] }],
      }])],
    })
    const converted = convert(state)
    const title = tasks(converted)[0].node
    expect(title.firstChild?.toJSON()).toEqual({
      type: "paragraph", content: [{ type: "text", text: "标题", marks: [{ type: "bold" }] }],
    })
    expect(title.attrs.checked).toBe(true)
    expect(title.attrs.reminder).toBe("2026-10-25 09:00")
    expect(converted.doc.child(1).firstChild?.marks[0].type.name).toBe("bold")
    expect(converted.doc.child(2).firstChild?.type.name).toBe("tag")
    expect(converted.doc.child(2).lastChild?.marks[0].attrs.href).toBe("https://example.com")
    expect(taskItemHasDetail(title)).toBe(false)
  })

  it("空备注不生成空正文，空标题的已完成任务仍保留提醒", () => {
    const state = stateOf({ type: "doc", content: [list([
      task("", [paragraph(), paragraph(" ")], { checked: true, reminder: "2026-10-25 09:00" }),
    ])] })
    const converted = convert(state)
    expect(converted.doc.childCount).toBe(1)
    expect(serializeShardMarkdown(converted.doc.toJSON())).toBe("- [x] ⏰ 2026-10-25 09:00")
    expect(taskItemHasDetail(tasks(converted)[0].node)).toBe(false)
  })

  it("复杂备注块与内部空段原样移出，子任务留在原任务下", () => {
    const state = stateOf({ type: "doc", content: [list([
      task("目标", [
        paragraph("备注一"), paragraph(),
        { type: "blockquote", content: [paragraph("引用") ] },
        { type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: "const a = 1" }] },
        list([task("子任务", [], { checked: true, reminder: "2026-11-01 09:00" })]),
        paragraph("备注二"),
      ]),
      task("后项"),
    ])] })
    const original = tasks(state)
    const converted = convert(state)
    const target = tasks(converted)[0].node
    expect(target.childCount).toBe(2)
    expect(target.child(1).eq(original[0].node.child(5))).toBe(true)
    expect(tasks(converted)[1].node.eq(original[1].node)).toBe(true)
    expect(taskItemHasDetail(target)).toBe(false)
    const moved = Array.from({ length: 5 }, (_, index) => converted.doc.child(index + 1))
    const details = [1, 2, 3, 4, 6].map((index) => original[0].node.child(index))
    expect(moved.every((node, index) => node.eq(details[index]))).toBe(true)
    expect(tasks(converted)[2].node.eq(original[2].node)).toBe(true)
  })

  it("嵌套任务的备注放在最外层列表之后，不把父任务变成备忘", () => {
    const state = stateOf({ type: "doc", content: [list([
      task("父任务", [list([
        task("嵌套目标", [paragraph("子任务的备注"), list([task("孙任务")])], { checked: true }),
        task("同层兄弟"),
      ])]),
      task("外层兄弟"),
    ]), paragraph("原有正文")] })
    const original = tasks(state)
    const converted = convert(state, 1)
    const result = tasks(converted)
    expect(result.map(({ node }) => taskItemHasDetail(node))).toEqual([false, false, false, false, false])
    expect(result[1].node.attrs.checked).toBe(true)
    for (const index of [2, 3, 4]) expect(result[index].node.eq(original[index].node)).toBe(true)
    expect(converted.doc.child(1).textContent).toBe("子任务的备注")
    expect(converted.doc.child(2).textContent).toBe("原有正文")
    const reloaded = stateOf(serializeShardMarkdown(converted.doc.toJSON()))
    expect(tasks(reloaded).map(({ node }) => taskItemHasDetail(node))).toEqual([false, false, false, false, false])
  })

  it("只转换所选备忘，有序列表两侧的兄弟备忘正文保持不变", () => {
    const state = stateOf({ type: "doc", content: [{
      type: "taskList", attrs: { ordered: true }, content: [
        task("之前的备忘", [paragraph("之前的备注")]),
        task("所选备忘", [paragraph("提到下方的备注")]),
        task("之后的备忘", [paragraph("之后的备注")]),
      ],
    }] })
    const original = tasks(state)
    const converted = convert(state, 1)
    const result = tasks(converted)
    expect(result[0].node.eq(original[0].node)).toBe(true)
    expect(result[2].node.eq(original[2].node)).toBe(true)
    expect(result.map(({ node }) => taskItemHasDetail(node))).toEqual([true, false, true])
    expect(converted.doc.child(0).attrs.ordered).toBe(true)
    expect(converted.doc.child(2).attrs.ordered).toBe(true)
    // 拆成两段后，各段按既有方言从 1 编号。
    expect(serializeShardMarkdown(converted.doc.toJSON())).toBe(
      "1. [ ] 之前的备忘\n\n   之前的备注\n2. [ ] 所选备忘\n\n提到下方的备注\n\n1. [ ] 之后的备忘\n\n   之后的备注"
    )
  })

  it("转换前后的输入各自成一步，转换可完整撤销和重做", () => {
    let state = stateOf("- [ ] 标题\n\n  备注")
    state = state.applyTransaction(state.tr.insertText("前", tasks(state)[0].pos + 2)).state
    const before = state.doc
    state = convert(state)
    const converted = state.doc
    state = state.applyTransaction(state.tr.insertText("后")).state
    const afterTyping = state.doc
    const dispatch = (tr: Transaction) => { state = state.applyTransaction(tr).state }
    expect(undo(state, dispatch)).toBe(true)
    expect(state.doc.eq(converted)).toBe(true)
    expect(undo(state, dispatch)).toBe(true)
    expect(state.doc.eq(before)).toBe(true)
    expect(redo(state, dispatch)).toBe(true)
    expect(state.doc.eq(converted)).toBe(true)
    expect(taskItemHasDetail(tasks(state)[0].node)).toBe(false)
    expect(redo(state, dispatch)).toBe(true)
    expect(state.doc.eq(afterTyping)).toBe(true)
  })

  it("普通删除仍补回备注栏，只有显式转换允许删除", () => {
    const state = stateOf("- [ ] 标题\n\n  备注")
    const { node, pos } = tasks(state)[0]
    const removeDetail = () => state.tr.delete(pos + 1 + node.firstChild!.nodeSize, pos + node.nodeSize - 1)
    const guarded = state.applyTransaction(removeDetail()).state
    expect(taskItemHasDetail(tasks(guarded)[0].node)).toBe(true)
    const explicit = state.applyTransaction(removeDetail().setMeta(MEMO_CONVERSION_META, true)).state
    expect(taskItemHasDetail(tasks(explicit)[0].node)).toBe(false)
  })

  it("不转换普通任务或无效位置", () => {
    const state = stateOf("- [ ] 普通任务\n  - [ ] 子任务")
    expect(memoToTaskTransaction(state, tasks(state)[0].pos)).toBeNull()
    for (const pos of [-1, 0, 0.5, state.doc.content.size, state.doc.content.size + 1]) {
      expect(memoToTaskTransaction(state, pos)).toBeNull()
    }
  })
})
