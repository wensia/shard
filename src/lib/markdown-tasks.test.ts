import { describe, expect, it } from "vitest"

import { shardMarkdownParser } from "@/editor/extensions/markdown"
import { markdownTaskFromNode, type MarkdownTask } from "@/lib/markdown-tasks"

function tasksIn(source: string) {
  const tasks: MarkdownTask[] = []
  shardMarkdownParser.parse(source).iterate({
    enter(node) {
      const task = markdownTaskFromNode(node.node, (from, to) => source.slice(from, to))
      if (task) tasks.push(task)
    },
  })
  return tasks
}

describe("markdownTaskFromNode", () => {
  it.each([
    ["- [ ] 任务", { from: 0, to: 6, markerFrom: 2, markerTo: 5, checked: false }],
    ["* [x] 任务", { from: 0, to: 6, markerFrom: 2, markerTo: 5, checked: true }],
    ["+ [X] 任务", { from: 0, to: 6, markerFrom: 2, markerTo: 5, checked: true }],
    ["- [ ] ", { from: 0, to: 6, markerFrom: 2, markerTo: 5, checked: false }],
    ["1. [ ] 任务", { from: 3, to: 7, markerFrom: 3, markerTo: 6, checked: false }],
    ["12) [X]\t任务", { from: 4, to: 8, markerFrom: 4, markerTo: 7, checked: true }],
    ["  - [ ] 任务", { from: 2, to: 8, markerFrom: 4, markerTo: 7, checked: false }],
    ["> - [ ] 任务", { from: 2, to: 8, markerFrom: 4, markerTo: 7, checked: false }],
    ["> 1. [x] 任务", { from: 5, to: 9, markerFrom: 5, markerTo: 8, checked: true }],
  ] as const)("解析任务范围：%s", (source, expected) => {
    expect(tasksIn(source)).toEqual([expected])
  })

  it("嵌套任务只替换自身标记，保留父列表与缩进", () => {
    const source = "- 父级\n  - [x] 子任务\n  1. [ ] 有序子任务"
    const tasks = tasksIn(source)
    expect(tasks).toHaveLength(2)
    expect(tasks.map((task) => source.slice(task.from, task.to))).toEqual([
      "- [x] ",
      "[ ] ",
    ])
    expect(tasks.map((task) => source.slice(task.markerFrom, task.markerTo))).toEqual([
      "[x]",
      "[ ]",
    ])
    expect(source.slice(0, tasks[0].from)).toBe("- 父级\n  ")
    expect(source.slice(tasks[1].from - 5, tasks[1].from)).toBe("  1. ")
  })

  it.each(["\n", "\r\n"])("吃掉水平空白但保留换行 %j 和正文", (newline) => {
    const source = `- [ ] \t ${newline}续行`
    const [task] = tasksIn(source)
    expect(source.slice(task.from, task.to)).toBe("- [ ] \t ")
    expect(source.slice(task.to)).toBe(`${newline}续行`)
  })

  it.each([
    "- \n  [ ] 任务",
    "-\n  [ ] ",
    "- \n\n  [ ] 任务",
    "> - \n>   [ ] 任务",
    "1. \n   [ ] 任务",
    "- 父级\n  - \n    [ ] 任务",
    "- \r\n  [ ] 任务",
  ])("标记分属两行时保留前一行列表结构：%s", (source) => {
    const [task] = tasksIn(source)
    expect(task.from).toBe(task.markerFrom)
    expect(source.slice(task.from, task.to)).toBe("[ ] ")
    expect(source.slice(0, task.from)).toBe(source.slice(0, source.indexOf("[ ]")))
  })

  it.each([
    "- [ ]",
    "- [ ]任务",
    "- [x]任务",
    "- [ 任务",
    "- [x 任务",
    "- [y] 任务",
    "[ ] 任务",
    "- \\[ ] 任务",
    "`- [ ] 任务`",
    "    - [ ] 任务",
    "```md\n- [ ] 任务\n```",
    "~~~\n- [x] 任务\n~~~",
    "```\n- [ ] 任务",
  ])("不把非任务或代码里的源码识别成 checkbox：%s", (source) => {
    expect(tasksIn(source)).toEqual([])
  })

  it("精确切换引用内的任务状态时只改变标记中的一个字符", () => {
    const source = "> - [ ] 保留正文 [x]"
    const [task] = tasksIn(source)
    const next = source.slice(0, task.markerFrom + 1) + "x" + source.slice(task.markerFrom + 2)
    expect(next).toBe("> - [x] 保留正文 [x]")
  })
})
