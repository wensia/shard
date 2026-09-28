import { describe, expect, it } from "vitest"

import { createCanvasFile } from "@/features/canvas/model"
import { readFlowchartContent } from "@/lib/flowchart-content"

describe("readFlowchartContent", () => {
  it("读取 shardflow 受管区域", () => {
    const file = createCanvasFile("发布流程")
    const content = ["```shardflow", JSON.stringify(file), "```"].join("\n")

    expect(readFlowchartContent(content)).toEqual({ format: "json", file })
  })

  it.each([
    "普通正文",
    "```shardflow\n{not json}\n```",
    "```shardflow\n{}\n```",
    ["```shardflow", JSON.stringify({ ...createCanvasFile("旧画布"), kind: "shard.canvas" }), "```"].join("\n"),
  ])("非法流程图返回 null：%s", (content) => {
    expect(readFlowchartContent(content)).toBeNull()
  })
})
