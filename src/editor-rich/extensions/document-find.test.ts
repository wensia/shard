import { EditorState } from "@tiptap/pm/state"
import { describe, expect, it } from "vitest"

import { parseShardMarkdown } from "@/editor-rich/markdown"
import { shardSchema } from "@/editor-rich/schema"

import {
  DOCUMENT_FIND_KEY,
  createDocumentFindPlugin,
  findDocumentMatches,
  type DocumentFindMeta,
} from "./document-find"

function doc(markdown: string) {
  return shardSchema.nodeFromJSON(parseShardMarkdown(markdown).doc)
}

function texts(markdown: string, query: string) {
  const node = doc(markdown)
  return findDocumentMatches(node, query).map((match) => node.textBetween(match.from, match.to))
}

function stateWith(markdown: string) {
  return EditorState.create({ doc: doc(markdown), plugins: [createDocumentFindPlugin()] })
}

function apply(state: EditorState, meta: DocumentFindMeta) {
  return state.apply(state.tr.setMeta(DOCUMENT_FIND_KEY, meta))
}

function findState(state: EditorState) {
  const value = DOCUMENT_FIND_KEY.getState(state)
  if (!value) throw new Error("document find plugin missing")
  return value
}

describe("findDocumentMatches", () => {
  it("matches literally, folding case and full-width characters", () => {
    expect(texts("停顿 Shard ｓｈａｒｄ SHARD 停顿", "shard")).toEqual(["Shard", "ｓｈａｒｄ", "SHARD"])
    // 查询词不拆空格：整串字面匹配。
    expect(texts("我讲两千。我讲两千块", "讲两千 ")).toEqual([])
    expect(texts("我讲 两千", "讲 两千")).toEqual(["讲 两千"])
  })

  it("finds across inline marks and inside code blocks and tables", () => {
    expect(texts("开头 **共同**词 结尾", "共同词")).toEqual(["共同词"])
    expect(texts("```text\n代码里的词\n```", "里的")).toEqual(["里的"])
    expect(texts("| 列 |\n| --- |\n| 表格里的词 |", "里的")).toEqual(["里的"])
  })

  it("matches inline atoms as a whole and skips block atoms", () => {
    const node = doc("记一下 #骑行 装备 [[旧笔记]]")
    const matches = findDocumentMatches(node, "骑行")
    expect(matches).toHaveLength(1)
    expect(matches[0].node).toBe(true)
    expect(node.nodeAt(matches[0].from)?.type.name).toBe("tag")
    expect(findDocumentMatches(node, "旧笔记")[0]?.node).toBe(true)
    expect(findDocumentMatches(doc("![[数据.csv]]"), "数据")).toEqual([])
  })

  it("ignores blank queries", () => {
    expect(findDocumentMatches(doc("有 空格"), "")).toEqual([])
    expect(findDocumentMatches(doc("有 空格"), "  ")).toEqual([])
  })
})

describe("document find plugin state", () => {
  it("starts at the first match after the anchor and wraps when stepping", () => {
    let state = stateWith("甲 乙 甲 乙 甲")
    const second = findDocumentMatches(state.doc, "甲")[1]
    state = apply(state, { type: "search", query: "甲", anchor: second.from })
    expect(findState(state)).toMatchObject({ activeIndex: 1, query: "甲" })
    expect(findState(state).matches).toHaveLength(3)

    state = apply(state, { type: "step", direction: 1 })
    expect(findState(state).activeIndex).toBe(2)
    state = apply(state, { type: "step", direction: 1 })
    expect(findState(state).activeIndex).toBe(0)
    state = apply(state, { type: "step", direction: -1 })
    expect(findState(state).activeIndex).toBe(2)

    const active = state.doc.textBetween(findState(state).matches[2].from, findState(state).matches[2].to)
    expect(active).toBe("甲")
    expect(findState(state).decorations.find()).toHaveLength(3)
  })

  it("maps matches through edits, then refresh recounts and keeps the active spot", () => {
    let state = stateWith("甲 乙 甲 乙 甲")
    const matches = findDocumentMatches(state.doc, "甲")
    state = apply(state, { type: "search", query: "甲", anchor: matches[1].from })

    // 在第一处之前插一个「甲」：映射后位置后移、标记为待重算，当前命中仍是原来那处。
    state = state.apply(state.tr.insertText("甲", 1))
    expect(findState(state).stale).toBe(true)
    expect(findState(state).matches).toHaveLength(3)
    const mappedActive = findState(state).matches[findState(state).activeIndex]
    expect(mappedActive.from).toBe(matches[1].from + 1)

    state = apply(state, { type: "refresh" })
    expect(findState(state).stale).toBe(false)
    expect(findState(state).matches).toHaveLength(4)
    expect(findState(state).matches[findState(state).activeIndex].from).toBe(mappedActive.from)
  })

  it("drops deleted matches and clears everything on close", () => {
    let state = stateWith("甲乙甲")
    state = apply(state, { type: "search", query: "甲", anchor: 0 })
    const first = findState(state).matches[0]
    state = state.apply(state.tr.delete(first.from, first.to))
    expect(findState(state).matches).toHaveLength(1)
    expect(findState(state).activeIndex).toBe(0)

    state = apply(state, { type: "clear" })
    expect(findState(state)).toMatchObject({ activeIndex: -1, matches: [], query: "" })
    // 关掉以后再改文档，不再有任何查找状态被带着走。
    state = state.apply(state.tr.insertText("甲", 1))
    expect(findState(state).query).toBe("")
  })
})
