import { describe, expect, it } from "vitest"

import projectionFixture from "../../tests/fixtures/search/projection-v1.json"
import { normalizeSearchText } from "@/lib/search-normalize"
import { projectSearchText } from "@/lib/search-projection"

describe("search projection v1", () => {
  it.each(projectionFixture.cases)("$id", ({ markdown, expected }) => {
    expect(projectSearchText(markdown)).toEqual(expected)
  })

  it("search_projection_preserves_inline_code_underscores", () => {
    expect(projectSearchText("`snake_case` and `__init__`").revealableText).toBe(
      "snake_case and __init__"
    )
  })

  it("search_projection_separates_fence_text_from_revealable_text", () => {
    const projection = projectSearchText(
      "可定位正文\n```ts\nconst hidden_value = 1\n```"
    )
    expect(projection.revealableText).toBe("可定位正文")
    expect(projection.documentOnlyText).toBe("const hidden_value = 1")
    expect(normalizeSearchText(projection.searchableText)).toContain(
      "hidden_value"
    )
  })
})
