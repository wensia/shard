import { describe, expect, it } from "vitest"
import { addMindMapChild, deleteMindMapNode, toggleMindMapNodeCollapsed, updateMindMapNodeText } from "@/lib/mind-map-tree"
import {
  CANVAS_MAX_BYTES, createCanvasFile, createCanvasNode, isCanvasContentEqual, parseCanvasFile, validateCanvasFile,
  type CanvasFile,
} from "@/features/canvas/model"
import { addCanvasEdge, addCanvasNode, moveCanvasNodes, removeCanvasNodes, updateCanvasNode } from "@/features/canvas/mutations"
import { CanvasHistory } from "@/features/canvas/history"

function fixture(): CanvasFile {
  let file = createCanvasFile("资料流程")
  file = addCanvasNode(file, createCanvasNode("process", { x: 0, y: 0 }))
  file = addCanvasNode(file, createCanvasNode("decision", { x: 300, y: 0 }))
  return addCanvasEdge(file, { id: "flow", source: file.nodes[0].id, target: file.nodes[1].id, label: "下一步", sourceHandle: "right", targetHandle: "left" })
}

describe("canvas file contract", () => {
  it("creates flow documents and forbids embedding mind maps while retaining document links", () => {
    const file = fixture()
    expect(file.kind).toBe("shard.flow")
    expect(() => addCanvasNode(file, createCanvasNode("mindmap", { x: 0, y: 0 }))).toThrow("不能嵌入")
    for (const targetType of ["map", "flow"] as const) {
      const referenced = addCanvasNode(file, createCanvasNode("reference", { x: 0, y: 0 }, { link: { id: "link", targetType, targetId: "other-document" } }))
      expect(parseCanvasFile(JSON.stringify(referenced))).toEqual(referenced)
      expect(referenced.nodes[referenced.nodes.length - 1]).not.toHaveProperty("mindMap")
    }
  })

  it("round-trips all object types and permits directed cycles without modifying a tree", () => {
    let file: CanvasFile = { ...fixture(), kind: "shard.canvas" }
    for (const kind of ["terminal", "text", "reference", "mindmap"] as const) file = addCanvasNode(file, createCanvasNode(kind, { x: 0, y: 100 }, kind === "reference" ? { link: { id: "ref", targetType: "fragment", targetId: "public-fragment" } } : {}))
    const beforeTree = structuredClone(file.nodes.find(node => node.mindMap)!.mindMap)
    file = addCanvasEdge(file, { source: file.nodes[1].id, target: file.nodes[0].id, label: "重试" })
    file = addCanvasEdge(file, { source: file.nodes[0].id, target: file.nodes[5].id, label: "依据" })
    expect(parseCanvasFile(JSON.stringify(file))).toEqual(file)
    expect(file.nodes[5].mindMap).toEqual(beforeTree)
  })

  it.each([
    ["unsupported schema", (file: CanvasFile) => { (file as unknown as { schemaVersion: number }).schemaVersion = 2 }],
    ["duplicate node", (file: CanvasFile) => { file.nodes.push(file.nodes[0]) }],
    ["duplicate edge", (file: CanvasFile) => { file.edges.push(file.edges[0]) }],
    ["missing endpoint", (file: CanvasFile) => { file.edges[0].target = "missing" }],
    ["bad coordinate", (file: CanvasFile) => { file.nodes[0].x = Number.NaN }],
    ["huge coordinate", (file: CanvasFile) => { file.nodes[0].y = 1_000_001 }],
    ["bad dimension", (file: CanvasFile) => { file.nodes[0].width = 0 }],
    ["bad date", (file: CanvasFile) => { file.createdAt = "2026" }],
    ["unsafe revision", (file: CanvasFile) => { file.revision = Number.MAX_SAFE_INTEGER + 1 }],
    ["wrong kind payload", (file: CanvasFile) => { file.nodes[0].link = { id: "ref", targetType: "map", targetId: "map" } }],
    ["unsupported node", (file: CanvasFile) => { (file.nodes[0] as unknown as { kind: string }).kind = "script" }],
    ["text too long", (file: CanvasFile) => { file.nodes[0].text = "字".repeat(20001) }],
    ["invalid handle", (file: CanvasFile) => { (file.edges[0] as unknown as { sourceHandle: string }).sourceHandle = "internal-node" }],
  ])("rejects %s", (_name, mutate) => {
    const file = fixture(); mutate(file)
    expect(() => validateCanvasFile(file)).toThrow()
  })

  it.each(["../lockbox/secret.md", "notes/../secret.md", "notes/.secret.md", "notes/folder/../../secret.md", "notes\\secret.md", "/notes/a.md", "notes/a.shardmap.json"])("rejects protected or escaping path %s", path => {
    expect(() => createCanvasNode("reference", { x: 0, y: 0 }, { link: { id: "link", targetType: "markdownPath", path } })).toThrow()
  })

  it("retains a missing public reference so an unrelated edit can still be saved", () => {
    const reference = createCanvasNode("reference", { x: 0, y: 0 }, { link: { id: "link", targetType: "markdownPath", path: "notes/已删除的笔记.md" } })
    const file = addCanvasNode(createCanvasFile("资料"), reference)
    const changed = updateCanvasNode(file, reference.id, { x: 400 })
    expect(changed.nodes[0].link).toEqual(reference.link)
    expect(changed.nodes[0]).not.toHaveProperty("body")
  })

  it("enforces all resource budgets", () => {
    const file = createCanvasFile("large")
    file.nodes = Array.from({ length: 401 }, (_, i) => ({ ...createCanvasNode("text", { x: i, y: 0 }), id: `node-${i}` }))
    expect(() => validateCanvasFile(file)).toThrow("400")
    const flow = fixture()
    flow.edges = Array.from({ length: 1601 }, (_, i) => ({ ...flow.edges[0], id: `edge-${i}` }))
    expect(() => validateCanvasFile(flow)).toThrow("1600")
    expect(() => parseCanvasFile(" ".repeat(CANVAS_MAX_BYTES + 1))).toThrow("8 MiB")
    const maps = { ...createCanvasFile("many maps"), kind: "shard.canvas" as const }
    for (let index = 0; index < 5; index++) {
      const node = createCanvasNode("mindmap", { x: index, y: 0 })
      const map = node.mindMap!
      const root = map.nodes[map.rootId]
      for (let child = 1; child < 400; child++) map.nodes[`child-${child}`] = { ...root, id: `child-${child}`, parentId: map.rootId, sortKey: child.toString().padStart(3, "0") }
      maps.nodes.push(node)
    }
    expect(() => validateCanvasFile(maps)).toThrow("2000")
  })

  it.each(["orphan", "cycle", "second root", "sort duplicate", "internal endpoint", "protected"])("rejects invalid embedded tree: %s", reason => {
    const file = { ...fixture(), kind: "shard.canvas" as const }
    const node = createCanvasNode("mindmap", { x: 600, y: 0 })
    const child = addMindMapChild(node.mindMap!, node.mindMap!.rootId)
    const second = addMindMapChild(child.file, child.file.rootId)
    node.mindMap = second.file
    const map = node.mindMap
    if (reason === "orphan") map.nodes[child.nodeId].parentId = "missing"
    if (reason === "cycle") { map.nodes[child.nodeId].parentId = second.nodeId; map.nodes[second.nodeId].parentId = child.nodeId }
    if (reason === "second root") map.nodes[child.nodeId].parentId = null
    if (reason === "sort duplicate") map.nodes[second.nodeId].sortKey = map.nodes[child.nodeId].sortKey
    if (reason === "protected") (map as unknown as { hasProtectedLinks: boolean }).hasProtectedLinks = true
    file.nodes.push(node)
    if (reason === "internal endpoint") file.edges.push({ id: "internal", source: file.nodes[0].id, target: child.nodeId, label: "invalid" })
    expect(() => validateCanvasFile(file)).toThrow()
  })
})

describe("canvas operations and shared history", () => {
  it("deletes nodes with incident edges in one undoable gesture", () => {
    const file = fixture()
    const history = new CanvasHistory(file)
    history.commit(removeCanvasNodes(file, [file.nodes[0].id]))
    expect(history.getDraft().nodes).toHaveLength(1)
    expect(history.getDraft().edges).toHaveLength(0)
    expect(history.undo()).toEqual(file)
    expect(history.redo()!.edges).toHaveLength(0)
    expect(file.nodes).toHaveLength(2)
  })

  it("moves a multi-selection with one undo and isolates snapshots from external mutation", () => {
    const file = fixture(); const history = new CanvasHistory(file)
    const moved = moveCanvasNodes(file, file.nodes.map(node => ({ id: node.id, x: node.x + 30, y: node.y + 20 })))
    history.commit(moved)
    moved.nodes[0].text = "mutated externally"
    expect(history.getDraft().nodes[0].text).toBe(file.nodes[0].text)
    expect(history.undo()).toEqual(file)
    expect(history.canUndo()).toBe(false)
    expect(history.redo()!.nodes[1].x).toBe(330)
  })

  it("merges text input but separates another gesture and breaks redo on new edits", () => {
    const file = fixture(); const history = new CanvasHistory(file); const id = file.nodes[0].id
    history.commit(updateCanvasNode(file, id, { text: "a" }), { mergeKey: `text:${id}` })
    history.commit(updateCanvasNode(history.getDraft(), id, { text: "ab" }), { mergeKey: `text:${id}` })
    expect(history.undo()!.nodes[0].text).toBe(file.nodes[0].text)
    expect(history.canUndo()).toBe(false)
    history.redo(); history.breakMerge()
    history.commit(updateCanvasNode(history.getDraft(), id, { text: "abc" }), { mergeKey: `text:${id}` })
    expect(history.undo()!.nodes[0].text).toBe("ab")
    history.commit(updateCanvasNode(history.getDraft(), id, { x: 900 }))
    expect(history.canRedo()).toBe(false)
  })

  it("stores tree text, structure, collapse and deletion in the same canvas history", () => {
    const node = createCanvasNode("mindmap", { x: 0, y: 0 })
    const file = addCanvasNode({ ...fixture(), kind: "shard.canvas" }, node); const history = new CanvasHistory(file)
    const child = addMindMapChild(node.mindMap!, node.mindMap!.rootId)
    history.commit(updateCanvasNode(history.getDraft(), node.id, { mindMap: child.file }))
    let map = updateMindMapNodeText(child.file, child.nodeId, "证据")
    map = toggleMindMapNodeCollapsed(map, child.nodeId)
    history.commit(updateCanvasNode(history.getDraft(), node.id, { mindMap: map }))
    history.commit(updateCanvasNode(history.getDraft(), node.id, { mindMap: deleteMindMapNode(map, child.nodeId).file }))
    expect(history.undo()!.nodes[2].mindMap!.nodes[child.nodeId]).toMatchObject({ text: "证据", collapsed: true })
    expect(history.undo()!.nodes[2].mindMap!.nodes[child.nodeId].text).toBe("")
    expect(history.undo()).toEqual(file)
  })

  it("ignores timestamps and save revisions when detecting edits", () => {
    const file = addCanvasNode({ ...fixture(), kind: "shard.canvas" }, createCanvasNode("mindmap", { x: 0, y: 0 }))
    const next = structuredClone(file); next.revision += 1; next.updatedAt = "2030-01-01T00:00:00.000Z"
    next.nodes[2].mindMap!.revision += 1
    next.nodes[2].mindMap!.updatedAt = next.updatedAt
    next.nodes[2].mindMap!.nodes[next.nodes[2].mindMap!.rootId].updatedAt = next.updatedAt
    expect(isCanvasContentEqual(file, next)).toBe(true)
    const history = new CanvasHistory(file); history.commit(next)
    expect(history.canUndo()).toBe(false)
    expect(removeCanvasNodes(file, ["missing"])).toBe(file)
  })

  it("bounds history while keeping the most recent gestures", () => {
    const file = fixture(); const history = new CanvasHistory(file, { limit: 2 })
    for (let x = 1; x <= 3; x++) history.commit(updateCanvasNode(history.getDraft(), file.nodes[0].id, { x }))
    expect(history.undo()!.nodes[0].x).toBe(2)
    expect(history.undo()!.nodes[0].x).toBe(1)
    expect(history.undo()).toBeNull()
  })
})
