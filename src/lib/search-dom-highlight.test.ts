import { describe, expect, it } from "vitest"

import { findSearchTermSpans } from "@/lib/search-dom-highlight"

describe("fragment DOM search matching", () => {
  it("matches every normalized occurrence without crossing blocks", () => {
    expect(
      findSearchTermSpans(["alpha needle", "needle beta"], ["NEEDLE"])
    ).toEqual([
      { end: 12, segmentIndex: 0, start: 6 },
      { end: 6, segmentIndex: 1, start: 0 },
    ])
  })

  it("deduplicates terms and merges overlapping ranges", () => {
    expect(findSearchTermSpans(["abcde"], ["abc", "bcd", "ＡＢＣ"])).toEqual([
      { end: 4, segmentIndex: 0, start: 0 },
    ])
  })

  it("keeps a repeated request matchable instead of caching target identity", () => {
    expect(findSearchTermSpans(["first second"], ["first"])).toEqual([
      { end: 5, segmentIndex: 0, start: 0 },
    ])
    expect(findSearchTermSpans(["first second"], ["second"])).toEqual([
      { end: 12, segmentIndex: 0, start: 6 },
    ])
  })
})
