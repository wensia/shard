import { describe, expect, it } from "vitest"

import queryFixture from "../../tests/fixtures/search/query-v1.json"
import {
  normalizeSearchText,
  parseSearchTerms,
  SearchQueryError,
} from "@/lib/search-normalize"

describe("search normalization v1", () => {
  it.each(queryFixture.normalizationCases)(
    "$id",
    ({ input, normalized, terms }) => {
      expect(normalizeSearchText(input)).toBe(normalized)
      expect(parseSearchTerms(input)).toEqual(terms)
    }
  )

  it("只折叠 ASCII 大小写，不擅自改变其他 Unicode 字符", () => {
    expect(normalizeSearchText("ÉCOLE école Σσ")).toBe("École école Σσ")
  })

  it("超过 256 个 Unicode 字符时返回明确错误", () => {
    try {
      parseSearchTerms("😀".repeat(257))
      throw new Error("expected parseSearchTerms to reject an oversized query")
    } catch (error) {
      expect(error).toBeInstanceOf(SearchQueryError)
      expect((error as SearchQueryError).reason).toBe("queryTooLong")
    }
  })

  it("超过 8 个去重关键词时返回明确错误", () => {
    try {
      parseSearchTerms("一 二 三 四 五 六 七 八 九")
      throw new Error("expected parseSearchTerms to reject too many terms")
    } catch (error) {
      expect(error).toBeInstanceOf(SearchQueryError)
      expect((error as SearchQueryError).reason).toBe("tooManyTerms")
    }
  })
})
