import { describe, expect, it, vi } from "vitest"
import { createCanvasFile, createCanvasNode, type CanvasReadResult } from "@/features/canvas/model"
import { addCanvasNode, updateCanvasNode } from "@/features/canvas/mutations"
import { CanvasSaveQueue, type CanvasSaveRequest, type CanvasSaveState } from "@/features/canvas/save-queue"

function initial(): CanvasReadResult {
  const file = addCanvasNode(createCanvasFile("流程"), createCanvasNode("process", { x: 0, y: 0 }))
  file.revision = 1
  return { file, path: "notes/流程.shardcanvas.json", lastSavedHash: "original" }
}
function ack(request: CanvasSaveRequest, hash = "saved"): CanvasReadResult {
  return { file: { ...structuredClone(request.file), revision: request.expectedRevision + 1, updatedAt: new Date().toISOString() }, path: request.path, lastSavedHash: hash }
}
function edit(base: CanvasReadResult, text: string) { return updateCanvasNode(base.file, base.file.nodes[0].id, { text }) }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

describe("canvas serialized saves", () => {
  it("serializes writes, drains edits made during saving, and uses the last confirmed revision and hash", async () => {
    const base = initial(); const a = deferred<CanvasReadResult>(); const b = deferred<CanvasReadResult>()
    const write = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const state: CanvasSaveState[] = []; const queue = new CanvasSaveQueue(base, write, next => state.push(next))
    queue.update(edit(base, "A")); const flush = queue.flush()
    expect(queue.flush()).toBe(flush)
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    queue.update(edit(base, "B")); expect(write).toHaveBeenCalledTimes(1)
    a.resolve(ack(write.mock.calls[0][0], "hash-A"))
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(write.mock.calls[1][0]).toMatchObject({ expectedRevision: 2, lastSavedHash: "hash-A", file: { revision: 2 } })
    expect(queue.getDraft().nodes[0].text).toBe("B")
    b.resolve(ack(write.mock.calls[1][0], "hash-B"))
    await expect(flush).resolves.toBe(true)
    expect(queue.getState()).toEqual({ status: "saved", dirty: false, saving: false, error: null })
    expect(queue.getBaseline().lastSavedHash).toBe("hash-B")
    expect(state.some(entry => entry.status === "saving")).toBe(true)
  })

  it("does not treat undo to the baseline as saved while a different version is in flight", async () => {
    const base = initial(); const pending = deferred<CanvasReadResult>()
    const write = vi.fn().mockReturnValueOnce(pending.promise).mockImplementationOnce(async request => ack(request))
    const queue = new CanvasSaveQueue(base, write)
    queue.update(edit(base, "temporary")); const flush = queue.flush()
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    queue.update(base.file)
    expect(queue.getState()).toMatchObject({ dirty: true, saving: true })
    pending.resolve(ack(write.mock.calls[0][0]))
    await expect(flush).resolves.toBe(true)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1][0].file.nodes[0].text).toBe(base.file.nodes[0].text)
    expect(queue.getDraft().nodes[0].text).toBe(base.file.nodes[0].text)
    expect(queue.getState().dirty).toBe(false)
  })

  it("does not write a change undone before dispatch", async () => {
    const base = initial(); const write = vi.fn(); const queue = new CanvasSaveQueue(base, write)
    queue.update(edit(base, "discarded")); queue.update(base.file)
    await expect(queue.flush()).resolves.toBe(true)
    expect(write).not.toHaveBeenCalled()
  })

  it("replaces the fragment file baseline without reloading the canvas draft", async () => {
    const base = initial(); const write = vi.fn(async (request: CanvasSaveRequest) => ack(request))
    const queue = new CanvasSaveQueue(base, write)
    const draftBefore = queue.getDraft()
    queue.replaceBaseline("property-sha")
    expect(queue.getDraft()).toEqual(draftBefore)
    expect(queue.getBaseline()).toMatchObject({ lastSavedHash: "property-sha", file: draftBefore })
    queue.update(edit(base, "属性写入后继续编辑"))
    await expect(queue.flush()).resolves.toBe(true)
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ lastSavedHash: "property-sha" }))
  })

  it("freezes failed requests, stops automatic saves, then explicitly retries before draining later edits", async () => {
    const base = initial(); const write = vi.fn().mockRejectedValueOnce(new Error("磁盘暂时不可用"))
      .mockImplementation(async request => ack(request))
    const queue = new CanvasSaveQueue(base, write)
    queue.update(edit(base, "A"))
    await expect(queue.flush()).resolves.toBe(false)
    expect(queue.getState()).toMatchObject({ status: "error", dirty: true, error: "磁盘暂时不可用", saving: false })
    queue.update(edit(base, "B"))
    await expect(queue.flush()).resolves.toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
    await expect(queue.retry()).resolves.toBe(true)
    expect(write).toHaveBeenCalledTimes(3)
    expect(write.mock.calls[1][0]).toEqual(write.mock.calls[0][0])
    expect(write.mock.calls[2][0]).toMatchObject({ expectedRevision: 2, file: { nodes: [{ text: "B" }] } })
    expect(queue.getDraft().nodes[0].text).toBe("B")
  })

  it("preserves the undo when a failed in-flight request is later confirmed by retry", async () => {
    const base = initial(); const pending = deferred<CanvasReadResult>(); const write = vi.fn().mockReturnValueOnce(pending.promise).mockImplementation(async request => ack(request))
    const queue = new CanvasSaveQueue(base, write)
    queue.update(edit(base, "A")); const flushing = queue.flush()
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    queue.update(base.file); pending.reject("connection lost")
    await expect(flushing).resolves.toBe(false)
    await expect(queue.retry()).resolves.toBe(true)
    expect(write.mock.calls[1][0].file.nodes[0].text).toBe("A")
    expect(write.mock.calls[2][0].file.nodes[0].text).toBe(base.file.nodes[0].text)
  })

  it.each(["content", "identity", "path", "revision", "creation time", "hash"])("does not acknowledge an inconsistent %s response", async field => {
    const base = initial(); const write = vi.fn(async (request: CanvasSaveRequest) => {
      const result = ack(request)
      if (field === "content") result.file.nodes[0].text = "wrong"
      if (field === "identity") result.file.id = "other"
      if (field === "path") result.path = "notes/other.shardcanvas.json"
      if (field === "revision") result.file.revision += 1
      if (field === "creation time") result.file.createdAt = "2000-01-01T00:00:00.000Z"
      if (field === "hash") result.lastSavedHash = ""
      return result
    })
    const queue = new CanvasSaveQueue(base, write); queue.update(edit(base, "intended"))
    await expect(queue.flush()).resolves.toBe(false)
    expect(queue.getBaseline()).toEqual(base)
    expect(queue.getDraft().nodes[0].text).toBe("intended")
    expect(queue.getState()).toMatchObject({ status: "error", dirty: true })
  })

  it("copies external drafts and requests so mutation outside the queue cannot change frozen content", async () => {
    const base = initial(); const pending = deferred<CanvasReadResult>(); const write = vi.fn().mockReturnValue(pending.promise)
    const queue = new CanvasSaveQueue(base, write); const draft = edit(base, "A")
    queue.update(draft); draft.nodes[0].text = "outside change"
    const flushing = queue.flush(); await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    const successful = ack(write.mock.calls[0][0]); write.mock.calls[0][0].file.nodes[0].text = "transport mutation"
    pending.resolve(successful)
    await expect(flushing).resolves.toBe(true)
    expect(queue.getDraft().nodes[0].text).toBe("A")
  })

  it("rejects edits for another document without overwriting the draft", () => {
    const base = initial(); const queue = new CanvasSaveQueue(base, vi.fn())
    expect(() => queue.update(createCanvasFile("another"))).toThrow("跨画布")
    expect(queue.getDraft()).toEqual(base.file)
  })

  it("accepts Rust's omitted tree defaults and node-map ordering without inventing unsaved edits", async () => {
    const base = initial(); base.file.kind = "shard.canvas"
    const node = createCanvasNode("mindmap", { x: 300, y: 0 })
    const root = node.mindMap!.nodes[node.mindMap!.rootId]
    root.collapsed = false; root.note = ""; root.style = { tone: "default" }
    node.mindMap!.nodes.child = { ...root, id: "child", parentId: root.id, sortKey: "a" }
    const write = vi.fn(async (request: CanvasSaveRequest) => {
      const result = ack(request)
      const map = result.file.nodes[1].mindMap!
      map.nodes = Object.fromEntries(Object.entries(map.nodes).reverse())
      for (const entry of Object.values(map.nodes)) { delete entry.links; delete entry.collapsed; delete entry.note; delete entry.style }
      return result
    })
    const queue = new CanvasSaveQueue(base, write)
    queue.update(addCanvasNode(base.file, node))
    await expect(queue.flush()).resolves.toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    expect(queue.getState()).toMatchObject({ status: "saved", dirty: false })
  })

  it("confirms exact native drag coordinates and rejects a one-ULP serialization loss", async () => {
    const base = initial()
    const moved = updateCanvasNode(base.file, base.file.nodes[0].id, { x: 463.52000000000004, y: 249.65999999999997 })
    const exact = new CanvasSaveQueue(base, async request => ack(request))
    exact.update(moved)
    await expect(exact.flush()).resolves.toBe(true)
    expect(exact.getBaseline().file.nodes[0].x).toBe(463.52000000000004)

    // The native parser must preserve IEEE-754 bits; tolerances would conceal an altered file.
    const rounded = new CanvasSaveQueue(base, async request => {
      const result = ack(request)
      result.file.nodes[0].x = 463.52
      return result
    })
    rounded.update(moved)
    await expect(rounded.flush()).resolves.toBe(false)
    expect(rounded.getState()).toMatchObject({ status: "error", dirty: true })
    expect(rounded.getDraft().nodes[0].x).toBe(463.52000000000004)
    expect(rounded.getBaseline()).toEqual(base)
  })
})
