/** Input order is reading order; ties go to the leftmost column. */
export function layoutMasonry(heights: number[], columns: number, gap: number) {
  const bottoms = Array.from({ length: columns }, () => 0)
  const positions = heights.map((height) => {
    let column = 0
    for (let index = 1; index < columns; index += 1) {
      if (bottoms[index] < bottoms[column]) column = index
    }
    const top = bottoms[column]
    bottoms[column] = top + height + gap
    return { column, top, height }
  })
  return {
    positions,
    height: Math.max(0, ...bottoms) - (heights.length ? gap : 0),
  }
}
