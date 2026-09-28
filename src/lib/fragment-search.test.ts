import { describe, expect, it } from "vitest"

import { markdownToSearchText } from "./fragment-search"
import { createCanvasFile, createCanvasNode } from "@/features/canvas/model"
import { parseMindMapOutline } from "./mind-map-outline"

describe("graph fragment search text", () => {
  it("plain Markdown search preview excludes hard-break markers", () => {
    expect(markdownToSearchText("正文\\\n续行 字面\\\\\\\\")).toBe("正文 续行 字面\\\\\\\\")
  })
  it("projects JSON outline node text and notes without internal fields", () => {
    const file = parseMindMapOutline("- 发布计划\n  - 准备素材").file!
    file.id = "secret-map-id"
    file.nodes[file.rootId].note = "根节点备注"
    const child = Object.values(file.nodes).find(node => node.id !== file.rootId)!
    delete file.nodes[child.id]
    child.id = "secret-child-id"
    child.sortKey = "SecretSortKey"
    child.note = "确认发布时间"
    file.nodes[child.id] = child
    const text = markdownToSearchText(`\`\`\`shardmap\n${JSON.stringify(file)}\n\`\`\``)

    expect(text).toContain("发布计划")
    expect(text).toContain("准备素材")
    expect(text).toContain("根节点备注")
    expect(text).toContain("确认发布时间")
    expect(text).not.toContain("schemaVersion")
    expect(text).not.toContain("secret-map-id")
    expect(text).not.toContain("SecretSortKey")
  })

  it("projects JSON flowchart title, nodes and labels without ids or coordinates", () => {
    const file = createCanvasFile("发布流程")
    file.id = "secret-flow-id"
    file.nodes = [
      { ...createCanvasNode("terminal", { x: 987654, y: 123456 }, { text: "开始" }), id: "secret-start-id" },
      { ...createCanvasNode("process", { x: 20, y: 30 }, { text: "审核" }), id: "secret-review-id" },
    ]
    file.edges = [{ id: "secret-edge-id", source: "secret-start-id", target: "secret-review-id", label: "通过" }]
    const text = markdownToSearchText(`\`\`\`shardflow\n${JSON.stringify(file)}\n\`\`\``)

    expect(text).toContain("发布流程")
    expect(text).toContain("开始")
    expect(text).toContain("审核")
    expect(text).toContain("通过")
    expect(text).not.toContain("schemaVersion")
    expect(text).not.toContain("secret-review-id")
    expect(text).not.toContain("987654")
  })

  it("keeps broken regions and legacy indented outlines on the Markdown fallback", () => {
    expect(markdownToSearchText("前文\n\n```shardmap\n{not json}\n```\n\n后文"))
      .toBe("前文 {not json} 后文")
    expect(markdownToSearchText("- 旧式根节点\n  - 子节点\n补充说明"))
      .toBe("旧式根节点 子节点 补充说明")
  })
})
