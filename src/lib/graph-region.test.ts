import { describe, expect, it } from "vitest"

import {
  findGraphRegion,
  renderGraphRegion,
  replaceGraphRegion,
} from "@/lib/graph-region"

describe("graph region", () => {
  it.each([
    ["outline", "shardmap"],
    ["flowchart", "shardflow"],
  ] as const)("查找 %s 围栏并忽略开围栏行尾空白", (kind, fence) => {
    const jsonText = '{"title":"测试"}'
    const body = `前文\n\`\`\`${fence} \t\n${jsonText}\n\`\`\`\n后文`
    const region = findGraphRegion(body, kind)

    expect(region.jsonText).toBe(jsonText)
    expect(body.slice(region.start, region.end)).toBe(
      `\`\`\`${fence} \t\n${jsonText}\n\`\`\``
    )
  })

  it("渲染时去掉 JSON 末尾的重复换行", () => {
    expect(renderGraphRegion("outline", "{\"nodes\": {}}\n\n")).toBe(
      "```shardmap\n{\"nodes\": {}}\n```"
    )
  })

  it("只替换受管区域并逐字保留前后正文", () => {
    const before = "标题😀\n\n"
    const after = "\n\n尾注  \n"
    const body = `${before}\`\`\`shardmap\n{\"old\":true}\n\`\`\`${after}`

    expect(replaceGraphRegion(body, "outline", '{"new":true}\n')).toBe(
      `${before}\`\`\`shardmap\n{\"new\":true}\n\`\`\`${after}`
    )
  })

  it("没有对应区域时给出独立错误", () => {
    expect(() => findGraphRegion("普通正文", "outline")).toThrow(
      "正文中没有受管 JSON 区域。"
    )
  })

  it("多个同名区域时给出独立错误", () => {
    const body = [
      "```shardmap",
      "{}",
      "```",
      "```shardmap",
      "{}",
      "```",
    ].join("\n")

    expect(() => findGraphRegion(body, "outline")).toThrow(
      "正文中有多个同类型的受管 JSON 区域。"
    )
  })

  it("两种围栏并存时拒绝读取", () => {
    const body = [
      "```shardmap",
      "{}",
      "```",
      "```shardflow",
      "{}",
      "```",
    ].join("\n")

    expect(() => findGraphRegion(body, "outline")).toThrow(
      "正文中不能同时包含大纲与流程图区域。"
    )
    expect(() => findGraphRegion(body, "flowchart")).toThrow(
      "正文中不能同时包含大纲与流程图区域。"
    )
  })

  it("开围栏未闭合时给出独立错误", () => {
    expect(() =>
      findGraphRegion("```shardflow\n{\"nodes\":[]}", "flowchart")
    ).toThrow("正文中的受管 JSON 区域未闭合。")
  })

  it("缩进或带行尾空白的闭围栏都不算闭合", () => {
    expect(() =>
      findGraphRegion("```shardmap\n{}\n  ```", "outline")
    ).toThrow("未闭合")
    expect(() =>
      findGraphRegion("```shardmap\n{}\n``` ", "outline")
    ).toThrow("未闭合")
  })

  it("缩进的开围栏不是受管区域", () => {
    expect(() =>
      findGraphRegion("  ```shardmap\n{}\n```", "outline")
    ).toThrow("没有受管 JSON 区域")
  })

  it("CRLF 下仍按逻辑行识别，并逐字保留区域外换行", () => {
    const body = "前文\r\n```shardflow\r\n{}\r\n```\r\n后文"

    expect(findGraphRegion(body, "flowchart").jsonText).toBe("{}")
    expect(replaceGraphRegion(body, "flowchart", '{"next":true}')).toBe(
      "前文\r\n```shardflow\n{\"next\":true}\n```\r\n后文"
    )
  })
})
