import { describe, expect, it } from "vitest"
import { validateCanvasMindMap } from "@/features/canvas/model"
import {
  addMindMapParent,
  addMindMapSibling,
  getMindMapChildren,
  updateMindMapNodeNote,
} from "@/lib/mind-map-tree"
import type { ShardMapFile, ShardMapNode } from "@/types"

function fixture(): ShardMapFile {
  const createdAt = "2026-09-01T00:00:00.000Z"
  const node = (id: string, parentId: string | null, sortKey: string): ShardMapNode => ({
    id, parentId, sortKey, text: id, createdAt, updatedAt: createdAt,
  })
  return {
    kind: "shard.map", schemaVersion: 1, id: "map", title: "root", rootId: "root",
    createdAt, updatedAt: createdAt, savedWithAppVersion: "0.1.3", revision: 1,
    hasProtectedLinks: false,
    nodes: {
      root: node("root", null, "U"),
      first: node("first", "root", "A"),
      selected: {
        ...node("selected", "root", "U"),
        note: "保留备注", collapsed: true, width: 200, style: { tone: "accent" },
        links: [{ id: "source", targetType: "fragment", targetId: "fragment" }],
      },
      last: node("last", "root", "k"),
      child: node("child", "selected", "A"),
      grandchild: node("grandchild", "child", "U"),
    },
  }
}

describe("mind-map note editing", () => {
  it("preserves the tree, links and presentation fields while replacing the full note", () => {
    const original = fixture()
    const before = structuredClone(original)
    const note = "第一行描述\n第二行描述\n\n  保留空白  "
    const result = updateMindMapNodeNote(original, "selected", note)

    expect(result.nodes.selected).toEqual({
      ...original.nodes.selected,
      note,
      updatedAt: result.nodes.selected.updatedAt,
    })
    expect(result.nodes.selected.updatedAt).not.toBe(original.nodes.selected.updatedAt)
    expect(result.updatedAt).not.toBe(original.updatedAt)
    expect(result).toEqual({
      ...original,
      updatedAt: result.updatedAt,
      nodes: { ...original.nodes, selected: result.nodes.selected },
    })
    expect(result.nodes.selected.links).not.toBe(original.nodes.selected.links)
    expect(result.nodes.selected.style).not.toBe(original.nodes.selected.style)
    expect(original).toEqual(before)
    expect(() => validateCanvasMindMap(result)).not.toThrow()
  })

  it("can clear a note without changing the topic text or descendants", () => {
    const original = fixture()
    const result = updateMindMapNodeNote(original, "selected", "")

    expect(result.nodes.selected.note).toBe("")
    expect(result.nodes.selected.text).toBe(original.nodes.selected.text)
    expect(result.nodes.child).toEqual(original.nodes.child)
    expect(result.nodes.grandchild).toEqual(original.nodes.grandchild)
    expect(original.nodes.selected.note).toBe("保留备注")
  })

  it("keeps the document title when editing the root note", () => {
    const original = fixture()
    const result = updateMindMapNodeNote(original, "root", "文档的说明")

    expect(result.nodes.root.note).toBe("文档的说明")
    expect(result.nodes.root.text).toBe(original.nodes.root.text)
    expect(result.title).toBe(original.title)
  })

  it("does not create a content change for a missing node or an identical note", () => {
    const original = fixture()

    expect(updateMindMapNodeNote(original, "missing", "说明")).toBe(original)
    expect(updateMindMapNodeNote(original, "selected", "保留备注")).toBe(original)
  })
})

describe("mind-map sibling insertion", () => {
  it.each([undefined, "after"] as const)("keeps %s insertion immediately after the selected node", placement => {
    const original = fixture()
    const before = structuredClone(original)
    const result = addMindMapSibling(original, "selected", placement)

    expect(getMindMapChildren(result.file, "root").map(node => node.id)).toEqual([
      "first", "selected", result.nodeId, "last",
    ])
    expect(result.file.nodes[result.nodeId].collapsed).toBe(false)
    expect(result.file.nodes.selected).toEqual(original.nodes.selected)
    expect(original).toEqual(before)
    expect(() => validateCanvasMindMap(result.file)).not.toThrow()
  })

  it.each(["first", "selected"])("inserts before %s without changing existing nodes", selectedId => {
    const original = fixture()
    const before = structuredClone(original)
    const result = addMindMapSibling(original, selectedId, "before")
    const expectedIds = ["first", "selected", "last"]
    expectedIds.splice(expectedIds.indexOf(selectedId), 0, result.nodeId)

    expect(getMindMapChildren(result.file, "root").map(node => node.id)).toEqual(expectedIds)
    for (const id of Object.keys(original.nodes)) expect(result.file.nodes[id]).toEqual(original.nodes[id])
    expect(original).toEqual(before)
    expect(() => validateCanvasMindMap(result.file)).not.toThrow()
  })

  it.each(["first", "selected"])("preserves sibling order when imported keys leave no gap before %s", selectedId => {
    const original = fixture()
    original.nodes.first.sortKey = "0"
    original.nodes.selected.sortKey = "00"
    original.nodes.last.sortKey = "0U"
    const before = structuredClone(original)
    const result = addMindMapSibling(original, selectedId, "before")
    const expectedIds = ["first", "selected", "last"]
    expectedIds.splice(expectedIds.indexOf(selectedId), 0, result.nodeId)

    expect(getMindMapChildren(result.file, "root").map(node => node.id)).toEqual(expectedIds)
    expect(result.file.nodes.child).toEqual(original.nodes.child)
    expect(result.file.nodes.selected.links).toEqual(original.nodes.selected.links)
    expect(original).toEqual(before)
    expect(() => validateCanvasMindMap(result.file)).not.toThrow()
  })

  it.each(["before", "after"] as const)("falls back to a root child for %s insertion at the root", placement => {
    const original = fixture()
    const result = addMindMapSibling(original, original.rootId, placement)

    expect(getMindMapChildren(result.file, "root").map(node => node.id)).toEqual([
      "first", "selected", "last", result.nodeId,
    ])
    expect(result.file.rootId).toBe(original.rootId)
    expect(() => validateCanvasMindMap(result.file)).not.toThrow()
  })
})

describe("mind-map parent insertion", () => {
  it("wraps the selected subtree at its existing position without losing node data", () => {
    const original = fixture()
    const before = structuredClone(original)
    const result = addMindMapParent(original, "selected")
    const parent = result.file.nodes[result.nodeId]
    const selected = result.file.nodes.selected

    expect(result.nodeId).not.toBe("selected")
    expect(parent).toMatchObject({
      parentId: "root", sortKey: original.nodes.selected.sortKey,
      text: "", collapsed: false, links: [],
    })
    expect(getMindMapChildren(result.file, "root").map(node => node.id)).toEqual([
      "first", result.nodeId, "last",
    ])
    expect(getMindMapChildren(result.file, result.nodeId).map(node => node.id)).toEqual(["selected"])
    expect(selected).toEqual({
      ...original.nodes.selected,
      parentId: result.nodeId, sortKey: selected.sortKey, updatedAt: parent.updatedAt,
    })
    expect(result.file.rootId).toBe(original.rootId)
    expect(Object.keys(result.file.nodes)).toHaveLength(Object.keys(original.nodes).length + 1)
    for (const id of ["root", "first", "last", "child", "grandchild"]) {
      expect(result.file.nodes[id]).toEqual(original.nodes[id])
    }
    expect(original).toEqual(before)
    expect(() => validateCanvasMindMap(result.file)).not.toThrow()
  })

  it("can insert a parent below a nested parent without moving siblings elsewhere", () => {
    const original = fixture()
    const result = addMindMapParent(original, "grandchild")

    expect(result.file.nodes[result.nodeId].parentId).toBe("child")
    expect(result.file.nodes.grandchild.parentId).toBe(result.nodeId)
    expect(getMindMapChildren(result.file, "root")).toEqual(getMindMapChildren(original, "root"))
    expect(() => validateCanvasMindMap(result.file)).not.toThrow()
  })

  it.each(["root", "missing"])("leaves the original file unchanged for %s", selectedId => {
    const original = fixture()
    const result = addMindMapParent(original, selectedId)

    expect(result.file).toBe(original)
    expect(result.nodeId).toBe(original.rootId)
  })
})
