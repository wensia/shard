import { describe, expect, it } from "vitest"

import {
  filterBlockSlashItems,
  findBlockSlashItem,
  getBlockUI,
  hasBlockUI,
  listBlockSlashItems,
  listBlockUI,
  registerBlockUI,
  unregisterBlockUI,
  type ShardBlockUI,
} from "./registry-ui"

// 组件本身不在 node 环境渲染，这里只验证注册 / 查找契约；
// 顺便也守住「registry-ui 可以在无 DOM 的测试路径里 import」这条。
const fakeUI = {
  Editor: (() => null) as unknown as ShardBlockUI["Editor"],
  Preview: (() => null) as unknown as ShardBlockUI["Preview"],
}

describe("围栏块 UI 注册表", () => {
  it("导图块与数据表各注册一次，语言大小写与空白不敏感", () => {
    expect(listBlockUI().map((item) => item.lang).sort()).toEqual(["datatable", "mindmap"])
    expect(hasBlockUI(" MindMap ")).toBe(true)
    expect(hasBlockUI("python")).toBe(false)
    expect(getBlockUI("DataTable")?.slash?.label).toBe("数据表")
    expect(getBlockUI("mindmap")?.icon).toBeTypeOf("object")
  })

  it("命令条目按注册顺序出，关键词匹配与斜杠菜单同一套规则", () => {
    expect(listBlockSlashItems().map((item) => item.slash.label)).toEqual([
      "导图块",
      "数据表",
    ])
    expect(filterBlockSlashItems("sjb").map((item) => item.slash.id)).toEqual(["datatable"])
    expect(filterBlockSlashItems("导图").map((item) => item.slash.id)).toEqual(["mindmap"])
    // 围栏块不再认「大纲」：那是内容类型命令的关键词。
    expect(filterBlockSlashItems("大纲")).toEqual([])
    expect(filterBlockSlashItems("不存在")).toEqual([])
    // 大纲块插入后要把焦点交给幕布根节点，这条由注册项自带而不是编辑器写死。
    expect(findBlockSlashItem("mindmap")?.slash.focusSelector).toContain("data-outline-field")
    expect(findBlockSlashItem("datatable")?.slash.focusSelector).toBeUndefined()
  })

  it("新增一个围栏块只需注册一次，注销后立刻消失", () => {
    expect(hasBlockUI("kanban")).toBe(false)
    registerBlockUI("Kanban", {
      ...fakeUI,
      slash: {
        hint: "kanban",
        id: "kanban",
        keywords: ["看板", "kanban"],
        label: "看板",
        template: "{}",
      },
    })

    expect(hasBlockUI("kanban")).toBe(true)
    expect(filterBlockSlashItems("看板").map((item) => item.slash.label)).toEqual(["看板"])

    unregisterBlockUI("kanban")
    expect(hasBlockUI("kanban")).toBe(false)
    expect(listBlockUI().map((item) => item.lang).sort()).toEqual(["datatable", "mindmap"])
  })

  it("空 lang 直接拒绝注册", () => {
    expect(() => registerBlockUI("  ", fakeUI)).toThrow()
  })
})
