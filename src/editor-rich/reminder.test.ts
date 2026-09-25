import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import type { JSONContent } from "@tiptap/core"
import { Node } from "@tiptap/pm/model"
import { EditorState } from "@tiptap/pm/state"
import { describe, expect, it } from "vitest"

import { shardSchema } from "@/editor-rich/schema"

import { findTaskReminders, taskReminderTransaction } from "./commands"
import { parseShardMarkdown } from "./markdown/parse"
import { serializeShardMarkdown } from "./markdown/serialize"

function reminderAts(doc: JSONContent): string[] {
  const found: string[] = []
  const visit = (node: JSONContent) => {
    if (node.type === "reminder") found.push(String(node.attrs?.at))
    node.content?.forEach(visit)
  }
  visit(doc)
  return found
}

function stateOf(markdown: string) {
  const doc = Node.fromJSON(shardSchema, parseShardMarkdown(markdown).doc)
  return EditorState.create({ schema: shardSchema, doc })
}

function taskPositions(state: EditorState) {
  const positions: number[] = []
  state.doc.descendants((node, pos) => {
    if (node.type.name === "taskItem") positions.push(pos)
    return true
  })
  return positions
}

function apply(markdown: string, taskIndex: number, at: string | null) {
  const state = stateOf(markdown)
  const tr = taskReminderTransaction(state, taskPositions(state)[taskIndex], at)
  if (!tr) throw new Error("不是任务项")
  return serializeShardMarkdown(tr.doc.toJSON())
}

describe("提醒芯片的识别", () => {
  it("golden 用例里只有合法、未被代码/双链占用的写法变成芯片", () => {
    const golden = path.join(path.dirname(fileURLToPath(import.meta.url)), "markdown/golden/reminders/input.md")
    const source = readFileSync(golden, "utf8").replace(/\n$/u, "")
    expect(reminderAts(parseShardMarkdown(source).doc)).toEqual([
      "2026-10-01 09:00",
      "2026-09-01 10:30",
      "2026-10-02 18:00",
      "2026-10-03 08:05",
      "2026-10-04 07:00",
      "2026-12-31 23:59",
      "2026-10-05 12:00",
    ])
  })

  it("标签紧跟提醒节点时写回补一个空格，重新读取仍是标签 + 提醒", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "tag", attrs: { name: "生活" } },
            { type: "reminder", attrs: { at: "2026-10-01 09:00" } },
          ],
        },
      ],
    }
    const markdown = serializeShardMarkdown(doc)
    expect(markdown).toBe("#生活 ⏰ 2026-10-01 09:00")
    expect(reminderAts(parseShardMarkdown(markdown).doc)).toEqual(["2026-10-01 09:00"])
  })
})

describe("taskReminderTransaction", () => {
  it("在标题末尾插入，正文与提醒之间补一个空格", () => {
    expect(apply("- [ ] 买菜", 0, "2026-10-01 09:00")).toBe("- [ ] 买菜 ⏰ 2026-10-01 09:00")
    expect(apply("- [ ] 买菜 ", 0, "2026-10-01 09:00")).toBe("- [ ] 买菜 ⏰ 2026-10-01 09:00")
  })

  it("空标题的备忘卡片直接写在标记后面", () => {
    expect(apply("- [ ] \n\n  细节", 0, "2026-10-01 09:00")).toBe("- [ ] ⏰ 2026-10-01 09:00\n\n  细节")
  })

  it("多行标题写在第一行末尾，保持与任务同一行", () => {
    expect(apply("- [ ] 买菜\n  番茄、鸡蛋、葱", 0, "2026-10-01 09:00")).toBe(
      "- [ ] 买菜 ⏰ 2026-10-01 09:00\n  番茄、鸡蛋、葱"
    )
  })

  it("已有提醒时改时间，多余的删除", () => {
    expect(apply("- [ ] 买菜 ⏰ 2026-10-01 09:00", 0, "2026-10-02 18:00")).toBe(
      "- [ ] 买菜 ⏰ 2026-10-02 18:00"
    )
    expect(apply("- [ ] 甲 ⏰ 2026-10-01 09:00 乙 ⏰ 2026-10-05 09:00", 0, "2026-10-02 18:00")).toBe(
      "- [ ] 甲 ⏰ 2026-10-02 18:00 乙"
    )
  })

  it("清除提醒连带分隔空格一起删", () => {
    expect(apply("- [ ] 买菜 ⏰ 2026-10-01 09:00", 0, null)).toBe("- [ ] 买菜")
    expect(apply("- [ ] 买菜 ⏰ 2026-10-01 09:00\n  番茄", 0, null)).toBe("- [ ] 买菜\n  番茄")
    expect(apply("- [ ] 甲 ⏰ 2026-10-01 09:00 乙", 0, null)).toBe("- [ ] 甲 乙")
  })

  it("只改目标任务，不碰嵌套子任务的提醒", () => {
    const source = "- [ ] 父\n  - [ ] 子 ⏰ 2026-10-01 09:00"
    expect(apply(source, 0, "2026-10-03 09:00")).toBe(
      "- [ ] 父 ⏰ 2026-10-03 09:00\n  - [ ] 子 ⏰ 2026-10-01 09:00"
    )
    expect(apply(source, 1, null)).toBe("- [ ] 父\n  - [ ] 子")
  })

  it("findTaskReminders 只看标题段", () => {
    const state = stateOf("- [ ] 标题 ⏰ 2026-10-01 09:00\n\n  细节 ⏰ 2026-10-02 09:00")
    const pos = taskPositions(state)[0]
    const task = state.doc.nodeAt(pos)!
    expect(findTaskReminders(task, pos).map((item) => item.at)).toEqual(["2026-10-01 09:00"])
  })

  it("位置不是任务项时返回 null", () => {
    const state = stateOf("普通段落")
    expect(taskReminderTransaction(state, 0, "2026-10-01 09:00")).toBeNull()
  })
})
