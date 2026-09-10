import { describe, expect, it } from "vitest"

import { layoutMasonry } from "./masonry-layout"

describe("timeline masonry geometry", () => {
  it("fills the shorter column while a long card occupies the other", () => {
    const layout = layoutMasonry([1200, 100, 100, 100, 100], 2, 16)
    expect(layout.positions.map(({ column }) => column)).toEqual([0, 1, 1, 1, 1])
    expect(layout.positions.map(({ top }) => top)).toEqual([0, 0, 116, 232, 348])
    expect(layout.height).toBe(1200)
  })

  it("reflows measured height changes without overlapping any cards", () => {
    for (const heights of [[100, 100, 400, 120, 60], [800, 100, 400, 120, 60]]) {
      const layout = layoutMasonry(heights, 2, 16)
      for (const column of [0, 1]) {
        const items = layout.positions.filter((item) => item.column === column)
        items.slice(1).forEach((item, index) => {
          expect(item.top).toBe(items[index].top + items[index].height + 16)
        })
      }
      expect(layout.height).toBe(Math.max(...layout.positions.map((item) => item.top + item.height)))
    }
  })

  it("has no trailing gap and supports empty and single-column lists", () => {
    expect(layoutMasonry([], 2, 16).height).toBe(0)
    expect(layoutMasonry([50], 2, 16).height).toBe(50)
    expect(layoutMasonry([50, 100, 75], 1, 16)).toEqual({
      height: 257,
      positions: [
        { column: 0, top: 0, height: 50 },
        { column: 0, top: 66, height: 100 },
        { column: 0, top: 182, height: 75 },
      ],
    })
  })
})
