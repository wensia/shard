import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { businessSnapshot, parseTableFile, tableContent, type CellValue, type TableContent } from "@/features/tables/model"
import { applyTableMutations, createOwnedTableContent, prepareTableMutations, type PreparedTableChange, type TableMutation } from "@/features/tables/mutations"
import { TableHistory } from "@/features/tables/history"
import { TableSaveQueue } from "@/features/tables/save-queue"
import { projectOwnedTableView, projectTableView } from "@/features/tables/views"

const loadFile = () => parseTableFile(readFileSync(new URL("../../tests/fixtures/tables/valid/six-types.json", import.meta.url), "utf8"))
const load = () => tableContent(loadFile())
const stamp = "2030-01-01T00:00:00.000Z"
const edits = (content: TableContent, value: CellValue, fieldId = content.primaryFieldId): TableMutation[] => [{ type: "setCells", cells: [{ recordId: content.recordOrder[0], fieldId, value }] }]
function queue() {
  const file = loadFile()
  return new TableSaveQueue({ file, revision: file.revision, path: "notes/test.shardtable.json", title: "test", contentHash: "a".repeat(64) }, { apply: vi.fn(), read: vi.fn() })
}

describe("owned immutable table changes", () => {
  it("freezes every nested snapshot and shares only unchanged immutable records", () => {
    const original = load(); const owned = createOwnedTableContent(original)
    const [first, second] = owned.recordOrder
    expect(() => { owned.records[first].values[owned.primaryFieldId] = "outside" }).toThrow()
    expect(() => { owned.views[owned.viewOrder[0]].fieldOrder.pop() }).toThrow()
    const multi = owned.fieldOrder[4]
    expect(() => { (owned.records[first].values[multi] as string[]).push("outside") }).toThrow()
    original.records[first].values[original.primaryFieldId] = "external input changed"
    const operations = edits(owned, "A"); const prepared = prepareTableMutations(owned, operations, stamp)
    expect(prepared.content.records[first]).not.toBe(owned.records[first])
    expect(prepared.content.records[second]).toBe(owned.records[second])
    expect(prepared.content.fields).toBe(owned.fields)
    expect(prepared.changedRecordIds).toEqual([first]); expect(prepared.changedFieldIds).toEqual([owned.primaryFieldId])
    ;(operations[0] as Extract<TableMutation, { type: "setCells" }>).cells[0].value = "mutated operation"
    expect(prepared.content.records[first].values[owned.primaryFieldId]).toBe("A")
    expect(prepared.operations).toEqual(edits(owned, "A"))
    const saves = queue(); const detached = saves.getDraft(); detached.records[first].values[owned.primaryFieldId] = "detached"
    expect(saves.peekDraft().records[first].values[owned.primaryFieldId]).not.toBe("detached")
  })
  it.each(["record", "field", "view"])("keeps full public validation for dirty unedited %s input", kind => {
    const source = load(); createOwnedTableContent(source)
    if (kind === "record") source.records[source.recordOrder[1]].values[source.fieldOrder[1]] = "not a number"
    if (kind === "field") source.fields[source.fieldOrder[1]].name = ""
    if (kind === "view") source.views[source.viewOrder[0]].hiddenFieldIds = ["fld_ffffffffffffffffffffffffffffffff"]
    expect(() => applyTableMutations(source, edits(source, "A"), stamp)).toThrow()
    expect(() => createOwnedTableContent(source)).toThrow()
  })
  it("rejects unowned contents and forged or stale prepared changes", () => {
    const source = load()
    expect(() => prepareTableMutations(source, edits(source, "A"), stamp)).toThrow(/内部快照/)
    const saves = queue(); const draft = saves.peekDraft()
    const first = prepareTableMutations(draft, edits(draft, "A"), stamp)
    const stale = prepareTableMutations(draft, edits(draft, "B"), stamp)
    expect(() => saves.enqueuePrepared({ ...first } as PreparedTableChange)).toThrow(/已验证结果/)
    saves.enqueuePrepared(first)
    expect(() => saves.enqueuePrepared(stale)).toThrow(/已验证结果/)
    expect(() => projectOwnedTableView(structuredClone(draft), draft.viewOrder[0], 0)).toThrow(/内部快照/)
    expect(projectOwnedTableView(draft, draft.viewOrder[0], 0)).toEqual(projectTableView(draft, draft.viewOrder[0], 0))
  })
  it("validates final cross-operation values and restores the value before the whole gesture", () => {
    const original = load(); original.records[original.recordOrder[1]].updatedAt = "2040-01-01T00:00:00.000Z"
    const source = createOwnedTableContent(original); const numeric = source.fieldOrder[1]
    const operations = [...edits(source, "temporary invalid number", numeric), ...edits(source, 17, numeric)]
    const prepared = prepareTableMutations(source, operations, stamp)
    expect(businessSnapshot(prepared.content)).toBe(businessSnapshot(applyTableMutations(source, operations, stamp)))
    expect(prepared.content.records[source.recordOrder[0]].updatedAt).toBe("2040-01-01T00:00:00.000Z")
    expect(businessSnapshot(prepareTableMutations(prepared.content, prepared.inverse, stamp).content)).toBe(businessSnapshot(source))
    const duplicate = edits(source, 17, numeric)[0] as Extract<TableMutation, { type: "setCells" }>
    duplicate.cells.push({ ...duplicate.cells[0] })
    expect(() => prepareTableMutations(source, [duplicate], stamp)).toThrow(/重复/)
  })
  it("preserves normalized no-op semantics without erasing invalid values", () => {
    const raw = load(); const record = raw.records[raw.recordOrder[0]]; const [text, number, date, , multi, checkbox] = raw.fieldOrder
    record.values[text] = ""; record.values[number] = 0; record.values[date] = null; record.values[multi] = []; record.values[checkbox] = false
    const source = createOwnedTableContent(raw)
    const noOp = [edits(source, "", text), edits(source, -0, number), edits(source, null, date), edits(source, [], multi), edits(source, false, checkbox)].flat()
    expect(prepareTableMutations(source, noOp, stamp)).toMatchObject({ changed: false, content: source, inverse: [] })
    expect(prepareTableMutations(source, edits(source, null, text), stamp).changed).toBe(true)
    const field = source.fields[multi]; if (!("options" in field)) throw new Error("fixture needs options")
    const option = field.options[0].id
    expect(() => prepareTableMutations(source, edits(source, [option, option], multi), stamp)).toThrow()
    const added = prepareTableMutations(source, edits(source, field.options.map(item => item.id), multi), stamp).content
    expect(prepareTableMutations(added, edits(added, field.options.map(item => item.id).reverse(), multi), stamp).changed).toBe(false)
  })
  it("keeps history stacks atomic when accepting a prepared gesture fails", () => {
    const source = createOwnedTableContent(load()); const history = new TableHistory(); const reject = () => { throw new Error("queue refused") }
    expect(() => history.applyPrepared(source, edits(source, "A"), stamp, reject)).toThrow("queue refused")
    expect(history.canUndo).toBe(false)
    const accepted = history.applyPrepared(source, edits(source, "A"), stamp)
    expect(() => history.undoPrepared(accepted.content, stamp, reject)).toThrow("queue refused")
    expect(history.canUndo).toBe(true); expect(history.canRedo).toBe(false)
    const undone = history.undoPrepared(accepted.content, stamp)!
    expect(() => history.redoPrepared(undone.content, stamp, reject)).toThrow("queue refused")
    expect(history.canRedo).toBe(true); expect(history.canUndo).toBe(false)
  })
  it("uses full validation and restoration for structural changes", () => {
    const source = createOwnedTableContent(load()); const operations: TableMutation[] = [{ type: "deleteField", fieldId: source.fieldOrder[3] }]
    const history = new TableHistory(); const prepared = history.applyPrepared(source, operations, stamp)
    expect(prepared.changedRecordIds).toBeNull()
    expect(businessSnapshot(prepared.content)).toBe(businessSnapshot(applyTableMutations(source, operations, stamp)))
    expect(businessSnapshot(history.undoPrepared(prepared.content, stamp)!.content)).toBe(businessSnapshot(source))
  })
})
