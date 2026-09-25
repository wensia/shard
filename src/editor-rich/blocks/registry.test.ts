import { describe, expect, it } from "vitest"

import {
  dataTableBlockDefinition,
  getShardBlock,
  isShardBlockLanguage,
  isShardBlockParseError,
  listShardBlocks,
  mindMapBlockDefinition,
} from "./registry"

describe("围栏块注册表", () => {
  it("注册了大纲与数据表，且语言大小写不敏感", () => {
    expect(listShardBlocks().map((block) => block.lang).sort()).toEqual(["datatable", "mindmap"])
    expect(isShardBlockLanguage(" MindMap ")).toBe(true)
    expect(isShardBlockLanguage("python")).toBe(false)
    expect(getShardBlock("DataTable")?.title).toBe("数据表")
  })

  it("大纲块 parse/serialize 往返一致", () => {
    const source = "- 中心主题\n  - 分支一\n    - 叶子\n  - 分支二"
    const parsed = mindMapBlockDefinition.parse(source)
    expect(isShardBlockParseError(parsed)).toBe(false)
    if (isShardBlockParseError(parsed)) return
    expect(mindMapBlockDefinition.serialize(parsed)).toBe(source)
  })

  it("数据表 parse/serialize 往返一致，结构不合法时报错", () => {
    const source = [
      "{",
      '  "columns": [',
      "    {",
      '      "key": "name",',
      '      "label": "名称"',
      "    }",
      "  ],",
      '  "rows": [',
      "    {",
      '      "name": "甲"',
      "    }",
      "  ]",
      "}",
    ].join("\n")
    const parsed = dataTableBlockDefinition.parse(source)
    expect(isShardBlockParseError(parsed)).toBe(false)
    if (isShardBlockParseError(parsed)) return
    expect(dataTableBlockDefinition.serialize(parsed)).toBe(source)
    expect(isShardBlockParseError(dataTableBlockDefinition.parse("{ not json"))).toBe(true)
    expect(isShardBlockParseError(dataTableBlockDefinition.parse("  "))).toBe(true)
    // 既没有 columns 也没有 src 的 JSON 不是数据表。
    expect(isShardBlockParseError(dataTableBlockDefinition.parse('{"rows":[]}'))).toBe(true)
  })
})
