import { describe, expect, it } from "vitest"

import {
  mergeSelectionFragments,
  selectionBandPosition,
  selectionLineHeight,
} from "@/lib/selection-band"

describe("selection band geometry", () => {
  it("merges fragments on the same visual line and filters subpixel width", () => {
    const lines = mergeSelectionFragments([
      { left: 30, right: 45, top: 40, bottom: 57, lineHeight: 25 },
      { left: 10, right: 29, top: 41, bottom: 58, lineHeight: 25 },
      { left: 46, right: 46.4, top: 40, bottom: 57, lineHeight: 25 },
      { left: 10, right: 35, top: 70, bottom: 87, lineHeight: 25 },
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ left: 10, right: 45, lineHeight: 25 })
    expect(lines[1]).toMatchObject({ left: 10, right: 35 })
  })

  it("uses pixel line height and falls back to the fragment for normal", () => {
    expect(selectionLineHeight("25.2px", 17)).toBe(25.2)
    expect(selectionLineHeight("normal", 17)).toBe(17)
    expect(selectionLineHeight("1.8", 17)).toBe(17)
  })

  it("positions the full line box in the scrolling host coordinate system", () => {
    const line = mergeSelectionFragments([
      { left: 130, right: 180, top: 240, bottom: 258, lineHeight: 26 },
    ])[0]
    expect(selectionBandPosition(line, { left: 100, top: 200 }, {
      clientLeft: 1,
      clientTop: 2,
      scrollLeft: 7,
      scrollTop: 11,
    })).toEqual({ left: 36, top: 45, width: 50, height: 26 })
  })
})
