import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { businessSnapshot, normalizeTableContent, parseTableFile, tableContent, type TableContent, type TableReadResult } from "@/features/tables/model"
import { TableSaveQueue, type TableSaveTransport } from "@/features/tables/save-queue"
import { type ApplyTableMutationsRequest, type ApplyTableMutationsResult, type TableMutation } from "@/features/tables/mutations"

const stamp = "2030-01-01T00:00:00.000Z"
const initial = (): TableReadResult => { const file = parseTableFile(readFileSync(new URL("../../tests/fixtures/tables/valid/six-types.json", import.meta.url), "utf8")); return { file, revision: file.revision, contentHash: "a".repeat(64), path: "notes/示例.shardtable.json", title: "示例" } }
const edits = (base: TableReadResult, value: string): TableMutation[] => [{ type: "setCells", cells: [{ recordId: base.file.recordOrder[0], fieldId: base.file.primaryFieldId, value }] }]
function changed(base: TableReadResult, value: string): TableContent {
  const content = normalizeTableContent(tableContent(base.file)); content.records[content.recordOrder[0]].values[content.primaryFieldId] = value; content.records[content.recordOrder[0]].updatedAt = stamp; return content
}
function committed(base: TableReadResult, request: ApplyTableMutationsRequest, content: TableContent, hash = "b"): { read: TableReadResult; result: ApplyTableMutationsResult } {
  const revision = base.revision + 1; const contentHash = hash.repeat(64)
  const file = { ...base.file, ...content, revision, updatedAt: stamp, lastMutationId: request.mutationId, lastMutationHash: "f".repeat(64) }
  return {
    read: { file, path: base.path, title: base.title, revision, contentHash },
    result: { tableId: file.id, path: base.path, mutationId: request.mutationId, baseRevision: base.revision, revision, contentHash, updatedAt: stamp,
      changedRecords: Object.values(content.records), changedFields: Object.values(content.fields), changedViews: Object.values(content.views), deletedRecordIds: [], deletedFieldIds: [], deletedViewIds: [],
      fieldOrder: content.fieldOrder, recordOrder: content.recordOrder, viewOrder: content.viewOrder },
  }
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function queue(base: TableReadResult, transport: TableSaveTransport) { let sequence = 1; return new TableSaveQueue(base, transport, { now: () => stamp, mutationId: () => `mut_${(sequence++).toString(16).padStart(32, "0")}` }) }

describe("serialized save queue", () => {
  it("never lets a late response overwrite a newer draft; the next request uses confirmed hash/revision", async () => {
    const base = initial(); const first = deferred<ApplyTableMutationsResult>(); const second = deferred<ApplyTableMutationsResult>()
    const apply = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise); const read = vi.fn()
    const saves = queue(base, { apply, read }); saves.enqueue(edits(base, "A")); const flushing = saves.flush()
    saves.enqueue(edits(base, "B")); expect(saves.flush()).toBe(flushing); expect(apply).toHaveBeenCalledTimes(1)
    const a = committed(base, apply.mock.calls[0][0], changed(base, "A")); first.resolve(a.result)
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2))
    expect(apply.mock.calls[1][0]).toMatchObject({ expectedRevision: a.read.revision, expectedHash: a.read.contentHash })
    expect(saves.getDraft().records[base.file.recordOrder[0]].values[base.file.primaryFieldId]).toBe("B")
    expect(saves.getState()).toMatchObject({ savedGeneration: 1, generation: 2, dirty: true })
    second.resolve(committed(a.read, apply.mock.calls[1][0], changed(a.read, "B"), "c").result)
    await expect(flushing).resolves.toMatchObject({ status: "saved", savedGeneration: 2, dirty: false })
    expect(saves.getBaseline()).toMatchObject({ revision: 3, contentHash: "c".repeat(64) }); expect(read).not.toHaveBeenCalled()
  })
  it("accepts an unknown successful write only after a full business snapshot check, then replays later gestures", async () => {
    const base = initial(); const reading = deferred<TableReadResult>(); const read = vi.fn().mockReturnValue(reading.promise)
    const apply = vi.fn().mockRejectedValueOnce(new Error("connection lost"))
    const saves = queue(base, { apply, read }); saves.enqueue(edits(base, "A")); const flushing = saves.flush()
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1)); expect(saves.getState().status).toBe("checking")
    saves.enqueue(edits(base, "B")); const a = committed(base, apply.mock.calls[0][0], changed(base, "A"))
    apply.mockImplementationOnce(async request => committed(a.read, request, changed(a.read, "B"), "c").result)
    reading.resolve(a.read); await flushing
    expect(apply).toHaveBeenCalledTimes(2); expect(apply.mock.calls[1][0].expectedHash).toBe(a.read.contentHash)
    expect(saves.getDraft().records[base.file.recordOrder[0]].values[base.file.primaryFieldId]).toBe("B")
    expect(saves.getState().savedGeneration).toBe(2)
  })
  it("does not confirm matching mutation IDs when an unedited view differs on disk", async () => {
    const base = initial(); const apply = vi.fn().mockRejectedValue(new Error("lost"))
    const read = vi.fn(async () => {
      const content = changed(base, "A"); content.views[content.viewOrder[0]].columnWidths[content.primaryFieldId] = 999
      return committed(base, apply.mock.calls[0][0], content).read
    })
    const saves = queue(base, { apply, read }); saves.enqueue(edits(base, "A")); const draft = businessSnapshot(saves.getDraft())
    await expect(saves.flush()).rejects.toMatchObject({ code: "STALE_BASE" })
    expect(saves.getState()).toMatchObject({ status: "conflict", dirty: true, savedGeneration: 0 })
    expect(businessSnapshot(saves.getDraft())).toBe(draft); expect(saves.getBaseline().contentHash).toBe(base.contentHash)
    await expect(saves.flush()).rejects.toMatchObject({ code: "STALE_BASE" }); expect(apply).toHaveBeenCalledTimes(1)
  })
  it("retries exactly the same frozen request only after confirming unchanged disk bytes/revision", async () => {
    const base = initial(); const apply = vi.fn().mockRejectedValueOnce(new Error("lost"))
      .mockImplementationOnce(async request => committed(base, request, changed(base, "A")).result)
    const read = vi.fn().mockResolvedValue(base); const saves = queue(base, { apply, read }); const operations = edits(base, "A")
    saves.enqueue(operations); (operations[0] as Extract<TableMutation, { type: "setCells" }>).cells[0].value = "mutated outside queue"
    await saves.flush(); expect(apply.mock.calls[0][0]).toEqual(apply.mock.calls[1][0]); expect(apply.mock.calls[0][0].operations).toEqual(edits(base, "A"))
    expect(saves.getState().dirty).toBe(false)
  })
  it("stops after bounded retries and preserves the frozen request for an explicit later flush", async () => {
    const base = initial(); const apply = vi.fn().mockRejectedValue(new Error("offline")); const read = vi.fn().mockResolvedValue(base)
    const saves = queue(base, { apply, read }); saves.enqueue(edits(base, "A"))
    await expect(saves.flush()).rejects.toThrow("offline"); expect(apply).toHaveBeenCalledTimes(2); expect(read).toHaveBeenCalledTimes(2)
    expect(saves.getState()).toMatchObject({ dirty: true, status: "error", pendingCount: 1 })
    apply.mockImplementationOnce(async request => committed(base, request, changed(base, "A")).result)
    await saves.flush(); expect(apply.mock.calls[2][0]).toEqual(apply.mock.calls[0][0]); expect(saves.getState().dirty).toBe(false)
  })
  it("preserves dirty content when read-back fails and never resends before that read succeeds", async () => {
    const base = initial(); const apply = vi.fn().mockRejectedValue({ code: "IO_ERROR", message: "write result unknown" }); const read = vi.fn().mockRejectedValue(new Error("read unavailable"))
    const saves = queue(base, { apply, read }); saves.enqueue(edits(base, "A"))
    await expect(saves.flush()).rejects.toThrow("read unavailable"); expect(apply).toHaveBeenCalledTimes(1); expect(saves.getState().dirty).toBe(true)
    await expect(saves.flush()).rejects.toThrow("read unavailable"); expect(apply).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(2)
    read.mockResolvedValueOnce(committed(base, apply.mock.calls[0][0], changed(base, "A")).read)
    await saves.flush(); expect(apply).toHaveBeenCalledTimes(1); expect(saves.getState().dirty).toBe(false)
  })
  it("does not read or automatically retry a known unwritten failure", async () => {
    const base = initial(); const apply = vi.fn().mockRejectedValue({ code: "GIT_BUSY", message: "git busy" }); const read = vi.fn()
    const saves = queue(base, { apply, read }); saves.enqueue(edits(base, "A"))
    await expect(saves.flush()).rejects.toMatchObject({ code: "GIT_BUSY" }); expect(read).not.toHaveBeenCalled(); expect(apply).toHaveBeenCalledTimes(1)
    expect(saves.getState()).toMatchObject({ status: "error", dirty: true })
  })
  it("read-checks an incomplete success delta instead of silently advancing its hash", async () => {
    const base = initial(); const apply = vi.fn(async (request: ApplyTableMutationsRequest) => ({ ...committed(base, request, changed(base, "A")).result, changedRecords: [] }))
    const read = vi.fn(async () => committed(base, apply.mock.calls[0][0], changed(base, "A")).read)
    const saves = queue(base, { apply, read }); saves.enqueue(edits(base, "A")); await saves.flush()
    expect(read).toHaveBeenCalledTimes(1); expect(saves.getBaseline().contentHash).toBe("b".repeat(64)); expect(saves.getState().dirty).toBe(false)
  })
  it.each(["other cell", "other record", "field", "view", "order", "duplicate record", "invalid record", "deletion"])("rejects an acknowledged change to %s and preserves the draft when read-back fails", async kind => {
    const base = initial()
    const apply = vi.fn(async (request: ApplyTableMutationsRequest) => {
      const result = committed(base, request, changed(base, "A")).result
      if (kind === "other cell") result.changedRecords[0].values[base.file.fieldOrder[1]] = 999
      if (kind === "other record") result.changedRecords[1].values[base.file.primaryFieldId] = "unexpected"
      if (kind === "field") result.changedFields[1].name = "unexpected"
      if (kind === "view") result.changedViews[0].name = "unexpected"
      if (kind === "order") result.recordOrder = [...result.recordOrder!].reverse()
      if (kind === "duplicate record") result.changedRecords.push(structuredClone(result.changedRecords[0]))
      if (kind === "invalid record") result.changedRecords[0].updatedAt = "invalid"
      if (kind === "deletion") result.deletedRecordIds = [base.file.recordOrder[1]]
      return result
    })
    const read = vi.fn().mockRejectedValue(new Error("read unavailable")); const saves = queue(base, { apply, read })
    saves.enqueue(edits(base, "A")); const draft = businessSnapshot(saves.getDraft())
    await expect(saves.flush()).rejects.toThrow("read unavailable")
    expect(apply).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(1)
    expect(saves.getState()).toMatchObject({ dirty: true, savedGeneration: 0, status: "error" })
    expect(saves.getBaseline().contentHash).toBe(base.contentHash); expect(businessSnapshot(saves.getDraft())).toBe(draft)
  })
  it("allows an unchanged touched record to be omitted from a minimal successful cell delta", async () => {
    const base = initial(); const second = base.file.recordOrder[1]
    const apply = vi.fn(async (request: ApplyTableMutationsRequest) => {
      const result = committed(base, request, changed(base, "A")).result
      result.changedRecords = result.changedRecords.filter(record => record.id !== second)
      result.changedFields = []; result.changedViews = []; delete result.fieldOrder; delete result.recordOrder; delete result.viewOrder
      return result
    })
    const read = vi.fn(); const saves = queue(base, { apply, read })
    saves.enqueue([...edits(base, "A"), { type: "setCells", cells: [{ recordId: second, fieldId: base.file.primaryFieldId, value: base.file.records[second].values[base.file.primaryFieldId] }] }])
    await expect(saves.flush()).resolves.toMatchObject({ status: "saved", dirty: false }); expect(read).not.toHaveBeenCalled()
  })
  it("skips no-op gestures and requires explicit external-version acceptance to discard a conflict", async () => {
    const base = initial(); const apply = vi.fn().mockRejectedValue({ code: "STALE_BASE", message: "changed" }); const read = vi.fn(); const saves = queue(base, { apply, read })
    expect(saves.enqueue([])).toBe(0)
    const existing = base.file.records[base.file.recordOrder[0]].values[base.file.primaryFieldId] as string
    expect(saves.enqueue(edits(base, existing))).toBe(0); await saves.flush(); expect(apply).not.toHaveBeenCalled()
    saves.enqueue(edits(base, "A")); await expect(saves.flush()).rejects.toMatchObject({ code: "STALE_BASE" })
    saves.acceptExternal(base); expect(saves.getState()).toMatchObject({ dirty: false, status: "saved" })
    expect(businessSnapshot(saves.getDraft())).toBe(businessSnapshot(tableContent(base.file)))
  })
})
