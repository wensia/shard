import { describe, expect, it } from "vitest"
import { createCanvasFile, createCanvasNode, CANVAS_MAX_BYTES } from "@/features/canvas/model"
import { updateCanvasNode } from "@/features/canvas/mutations"
import { CanvasHistory } from "@/features/canvas/history"
import { CanvasSaveQueue } from "@/features/canvas/save-queue"

describe("canvas measured gesture cost", () => {
  it("measures a committed edit at the documented 400-object / near-8-MiB boundary", () => {
    const file = createCanvasFile("边界测量")
    const prototype = createCanvasNode("text", { x: 0, y: 0 })
    file.nodes = Array.from({ length: 400 }, (_, index) => ({ ...prototype, id: `node-${index}`, x: index * 50, text: `${index}:`.padEnd(20000, "x") }))
    const bytes = new TextEncoder().encode(JSON.stringify(file)).byteLength
    expect(bytes).toBeLessThan(CANVAS_MAX_BYTES)
    expect(bytes).toBeGreaterThan(CANVAS_MAX_BYTES * 0.95)
    const history = new CanvasHistory(file)
    const queue = new CanvasSaveQueue({ file, path: "notes/boundary.shardcanvas.json", lastSavedHash: "hash" }, async () => { throw new Error("measurement never writes") })
    const durations: number[] = []
    for (let index = 0; index < 5; index++) {
      const started = performance.now()
      const updated = updateCanvasNode(file, "node-0", { x: index + 1 })
      history.commit(updated)
      queue.update(updated)
      durations.push(Number((performance.now() - started).toFixed(2)))
    }
    // An observation, not a claimed browser/native acceptance threshold.
    console.info(JSON.stringify({ canvasGestureBenchmark: { bytes, objects: file.nodes.length, runtime: process.version, durationsMs: durations } }))
    expect(queue.getDraft().nodes[0].x).toBe(5)
  })
})
