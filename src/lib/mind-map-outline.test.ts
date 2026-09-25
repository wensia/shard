import { describe, expect, it } from "vitest"
import { getMindMapChildren } from "@/lib/mind-map-tree"
import {
  EMPTY_MIND_MAP_OUTLINE_SOURCE,
  MAX_MIND_MAP_OUTLINE_NODES,
  MIND_MAP_FENCE_LANGUAGE,
  buildMindMapFence,
  createEmptyMindMapOutline,
  isMindMapFenceLanguage,
  parseMindMapOutline,
  serializeMindMapOutline,
} from "@/lib/mind-map-outline"
import type { ShardMapFile } from "@/types"

function childTexts(file: ShardMapFile, parentId: string) {
  return getMindMapChildren(file, parentId).map((node) => node.text)
}

function requireFile(source: string) {
  const result = parseMindMapOutline(source)
  if (!result.file) throw new Error("大纲导图应解析出根节点")
  return { ...result, file: result.file }
}

describe("isMindMapFenceLanguage", () => {
  it("忽略大小写与首尾空白", () => {
    expect(isMindMapFenceLanguage(MIND_MAP_FENCE_LANGUAGE)).toBe(true)
    expect(isMindMapFenceLanguage(" MindMap ")).toBe(true)
    expect(isMindMapFenceLanguage("js")).toBe(false)
    expect(isMindMapFenceLanguage("")).toBe(false)
  })
})

describe("parseMindMapOutline", () => {
  it("把第一个列表项作为根并按缩进建树", () => {
    const { file, nodeCount, truncated } = requireFile(
      "- 中心主题\n  - 分支一\n    - 叶子\n  - 分支二"
    )

    expect(nodeCount).toBe(4)
    expect(truncated).toBe(false)
    expect(file.rootId).toBe("n0")
    expect(file.title).toBe("中心主题")
    expect(file.id).toBe("outline")
    expect(file.revision).toBe(0)
    expect(file.hasProtectedLinks).toBe(false)
    expect(file.savedWithAppVersion).toBe("")
    expect(file.nodes.n0).toMatchObject({
      parentId: null,
      text: "中心主题",
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
    })
    expect(Object.keys(file.nodes)).toEqual(["n0", "n1", "n2", "n3"])
    expect(childTexts(file, "n0")).toEqual(["分支一", "分支二"])
    expect(childTexts(file, "n1")).toEqual(["叶子"])
  })

  it("兼容 -、*、+ 与有序标记", () => {
    const { file } = requireFile("* 中心\n  + 甲\n  1. 乙\n  2) 丙")

    expect(childTexts(file, file.rootId)).toEqual(["甲", "乙", "丙"])
  })

  it("Tab 按 4 列折算并与 4 空格同级", () => {
    const { file } = requireFile("- 根\n\t- 制表\n    - 四空格\n\t\t- 更深")

    expect(childTexts(file, "n0")).toEqual(["制表", "四空格"])
    expect(childTexts(file, "n2")).toEqual(["更深"])
  })

  it("跳级缩进直接算作下一层", () => {
    const { file } = requireFile("- 根\n        - 跳级\n  - 回到一级")

    expect(childTexts(file, "n0")).toEqual(["跳级", "回到一级"])
    expect(file.nodes.n1.parentId).toBe("n0")
  })

  it("后续顶层项归并为根的子节点", () => {
    const { file, nodeCount } = requireFile("- 甲\n  - 甲一\n- 乙\n- 丙")

    expect(nodeCount).toBe(4)
    expect(childTexts(file, "n0")).toEqual(["甲一", "乙", "丙"])
  })

  it("首行非列表纯文本作根文本", () => {
    const { file } = requireFile("中心主题\n- 甲\n  - 甲一\n- 乙")

    expect(file.title).toBe("中心主题")
    expect(file.nodes.n0.text).toBe("中心主题")
    expect(childTexts(file, "n0")).toEqual(["甲", "乙"])
    expect(childTexts(file, "n1")).toEqual(["甲一"])
  })

  it("空行与中间非列表行忽略", () => {
    const { file, nodeCount } = requireFile(
      "- 根\n\n  这行不是列表\n  - 甲\n\n> 引用也忽略\n  - 乙"
    )

    expect(nodeCount).toBe(3)
    expect(childTexts(file, "n0")).toEqual(["甲", "乙"])
  })

  it("CRLF 与 CR 归一后结果一致", () => {
    const expected = parseMindMapOutline("- 根\n  - 甲\n  - 乙")

    expect(parseMindMapOutline("- 根\r\n  - 甲\r\n  - 乙")).toEqual(expected)
    expect(parseMindMapOutline("- 根\r  - 甲\r  - 乙")).toEqual(expected)
  })

  it("sortKey 定宽两位并保证同级出现顺序", () => {
    const children = Array.from({ length: 70 }, (_, index) => `  - 第 ${index}`)
    const { file, nodeCount } = requireFile(["- 根", ...children].join("\n"))

    expect(nodeCount).toBe(71)
    expect(file.nodes.n1.sortKey).toBe("00")
    expect(file.nodes.n62.sortKey).toBe("0z")
    expect(file.nodes.n63.sortKey).toBe("10")
    // 定宽两位保证「按字母表比较」与「按出现顺序」一致，跨 62 进位不会错序。
    const sortKeys = getMindMapChildren(file, "n0").map((node) => node.sortKey)
    expect(new Set(sortKeys.map((key) => key.length))).toEqual(new Set([2]))
    expect(childTexts(file, "n0")).toEqual(
      children.map((_, index) => `第 ${index}`)
    )
  })

  it("恰好 200 个节点不截断", () => {
    const rows = Array.from(
      { length: MAX_MIND_MAP_OUTLINE_NODES - 1 },
      (_, index) => `  - 子 ${index}`
    )
    const result = requireFile(["- 根", ...rows].join("\n"))

    expect(result.nodeCount).toBe(MAX_MIND_MAP_OUTLINE_NODES)
    expect(result.truncated).toBe(false)
  })

  it("超过 200 个节点截断并标记 truncated", () => {
    const rows = Array.from({ length: 299 }, (_, index) => `  - 子 ${index}`)
    const result = requireFile(["- 根", ...rows].join("\n"))

    expect(result.nodeCount).toBe(MAX_MIND_MAP_OUTLINE_NODES)
    expect(result.truncated).toBe(true)
    expect(Object.keys(result.file.nodes)).toHaveLength(
      MAX_MIND_MAP_OUTLINE_NODES
    )
    expect(childTexts(result.file, "n0")).toHaveLength(
      MAX_MIND_MAP_OUTLINE_NODES - 1
    )
  })

  it("无有效行时返回空结果", () => {
    for (const source of ["", "   ", "\n\r\n  \n"]) {
      expect(parseMindMapOutline(source)).toEqual({
        file: null,
        nodeCount: 0,
        truncated: false,
      })
    }
  })
})

describe("serializeMindMapOutline", () => {
  it("规范文本 round-trip 后完全一致", () => {
    for (const source of [
      "- 中心主题\n  - 分支一\n    - 叶子\n  - 分支二",
      "- 只有根",
      EMPTY_MIND_MAP_OUTLINE_SOURCE,
    ]) {
      expect(serializeMindMapOutline(requireFile(source).file)).toBe(source)
    }
  })

  it("把非规范写法归一为 2 空格缩进与 - 标记", () => {
    const { file } = requireFile("* 中心\n\t+ 甲\n        1. 甲一\n- 乙")

    expect(serializeMindMapOutline(file)).toBe("- 中心\n  - 甲\n    - 甲一\n  - 乙")
  })

  it("parse(serialize(file)) 的树结构等价", () => {
    const { file } = requireFile("- 根\n  - 甲\n    - 甲一\n  - 乙")
    const reparsed = requireFile(serializeMindMapOutline(file)).file

    expect(reparsed).toEqual(file)
  })

  it("多行主题折成空格，一个节点始终只占一行", () => {
    const { file } = requireFile("- 根\n  - 占位")
    file.nodes.n1.text = "第一行\n第二行\t带制表"

    expect(serializeMindMapOutline(file)).toBe("- 根\n  - 第一行 第二行 带制表")
  })

  it("折叠只是会话状态，不影响写回的子树", () => {
    const { file } = requireFile("- 根\n  - 甲\n    - 甲一")
    file.nodes.n1.collapsed = true

    expect(serializeMindMapOutline(file)).toBe("- 根\n  - 甲\n    - 甲一")
  })

  it("根节点缺失时返回空串", () => {
    const { file } = requireFile("- 根")

    expect(serializeMindMapOutline({ ...file, rootId: "missing" })).toBe("")
  })
})

describe("buildMindMapFence", () => {
  it("包回 mindmap 围栏，与解析侧互为逆运算", () => {
    const code = "- 根\n  - 甲"

    expect(buildMindMapFence(code)).toBe(`\`\`\`${MIND_MAP_FENCE_LANGUAGE}\n${code}\n\`\`\``)
  })
})

describe("createEmptyMindMapOutline", () => {
  it("给出单个空文本根节点，序列化回空根围栏", () => {
    const file = createEmptyMindMapOutline()

    expect(Object.keys(file.nodes)).toEqual(["n0"])
    expect(file.nodes.n0.text).toBe("")
    expect(serializeMindMapOutline(file)).toBe(EMPTY_MIND_MAP_OUTLINE_SOURCE)
  })
})
