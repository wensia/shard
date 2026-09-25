import { describe, expect, it } from "vitest"

import { matchPinyinTitle } from "@/lib/pinyin-search"

describe("matchPinyinTitle", () => {
  it("mixed_hanzi_pinyin_maps_back_to_title", () => {
    const result = matchPinyinTitle("北京周报", "北jing")

    expect(result).toMatchObject({
      status: "matched",
      ranges: [{ start: 0, end: 2 }],
    })
    if (result.status === "matched") {
      expect(result.ranges.map(({ start, end }) => "北京周报".slice(start, end))).toEqual([
        "北京",
      ])
    }
  })

  it("polyphonic_matching_stays_within_budget", () => {
    const result = matchPinyinTitle("重庆重要事项", "cqzysx", { maxWork: 80 })
    expect(result.status).toBe("matched")
    expect(result.work).toBeLessThanOrEqual(80)

    const degraded = matchPinyinTitle("重庆重要事项", "not-a-match", {
      maxWork: 2,
    })
    expect(degraded).toEqual({ status: "budgetExceeded", work: 2 })
  })

  it("matches every supported reading without enumerating title permutations", () => {
    expect(matchPinyinTitle("重庆", "chongqing").status).toBe("matched")
    expect(matchPinyinTitle("重要", "zhongyao").status).toBe("matched")
    expect(matchPinyinTitle("重要", "chongyao").status).toBe("matched")
  })
})
