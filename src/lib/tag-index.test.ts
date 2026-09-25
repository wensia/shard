import { describe, expect, it } from "vitest"

import { buildTagSearchIndex, getMatchingTagsBySearchQuery } from "@/lib/tag-index"

function match(tags: string[], query: string, limit = 8) {
  return getMatchingTagsBySearchQuery(buildTagSearchIndex(tags), query, limit)
}

describe("getMatchingTagsBySearchQuery", () => {
  it.each(["日", "rc", "ri", "richeng", "ric", "rich", "rcheng", "cheng", "#RC"])(
    "「%s」命中中文标签「日程」",
    (query) => {
      expect(match(["日程", "work"], query)).toEqual(["日程"])
    }
  )

  it.each(["zy", "zhongyao", "cy", "chongyao", "zhongy"])(
    "多音字每种读法都能命中：「%s」→「重要」",
    (query) => {
      expect(match(["重要"], query)).toEqual(["重要"])
    }
  )

  it("中英混合标签按字母和拼音一起索引", () => {
    expect(match(["AI笔记"], "aibj")).toEqual(["AI笔记"])
    expect(match(["AI笔记"], "aibiji")).toEqual(["AI笔记"])
  })

  it("不相关的拼音不命中", () => {
    expect(match(["日程", "灵感"], "xyz")).toEqual([])
    expect(match(["日程"], "rx")).toEqual([])
  })

  it("原文前缀排在拼音前缀前面，拼音前缀排在包含前面", () => {
    expect(match(["灵感", "lg", "alg"], "lg")).toEqual(["lg", "灵感", "alg"])
  })

  it("空 query 返回全部并受 limit 截断", () => {
    expect(match(["日程", "灵感", "work"], "")).toHaveLength(3)
    expect(match(["日程", "灵感", "work"], "", 2)).toHaveLength(2)
  })
})
