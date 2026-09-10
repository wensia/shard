import { describe, expect, it } from "vitest"
import { createCanvasMindMap } from "@/features/canvas/model"
import { layoutMindMap } from "@/lib/mind-map-layout"

describe("mind-map explicit line breaks", () => {
  it.each([undefined, 240])("preserves authored lines with width %s and sizes the node by its longest line", width => {
    const file = createCanvasMindMap("第一行\n第二行\n\n第三行")
    file.nodes[file.rootId].width = width
    const result = layoutMindMap(file).nodes[0]
    expect(result.textLines).toEqual(["第一行", "第二行", "", "第三行"])
    expect(result.width).toBeLessThanOrEqual(240)
    expect(result.height).toBeGreaterThanOrEqual(4 * 18)
  })

  it("keeps an authored paragraph boundary after wrapping a long line", () => {
    const file = createCanvasMindMap(`${"需要自动换行的长主题".repeat(4)}\n独立的一行`)
    const result = layoutMindMap(file, { maxNodeLines: 20 }).nodes[0]
    expect(result.textLines.length).toBeGreaterThan(2)
    expect(result.textLines[result.textLines.length - 1]).toBe("独立的一行")
  })

  it.each([undefined, 240])("sizes full document text including trailing blank lines with width %s", width => {
    const text = `${"需要自动换行的长主题".repeat(150)}\n\n\n`
    const file = createCanvasMindMap(text)
    // Assign the authored value directly; creation can supply a normalized title.
    file.nodes[file.rootId].text = text
    file.nodes[file.rootId].width = width
    const result = layoutMindMap(file, { maxNodeLines: Infinity }).nodes[0]
    expect(result.textLines.length).toBeGreaterThan(24)
    expect(result.textLines.slice(-3)).toEqual(["", "", ""])
    expect(result.textLines.join("")).toBe(text.replace(/\n/g, ""))
    expect(result.height).toBe(26 + result.textLines.length * 18)
  })

  it("preserves whitespace while keeping previews abbreviated", () => {
    const file = createCanvasMindMap("主题")
    file.nodes[file.rootId].text = "  主题  \n\n"
    expect(layoutMindMap(file).nodes[0].textLines).toEqual(["  主题  ", "", ""])
    file.nodes[file.rootId].text = "长主题".repeat(30)
    const preview = layoutMindMap(file).nodes[0]
    expect(preview.textLines).toHaveLength(3)
    expect(preview.textLines[2]).toMatch(/\.\.\.$/)
  })
})
