import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { businessSnapshot, parseTableFile, tableContent, type TableContent } from "@/features/tables/model"
import { applyTableMutations, type TableMutation } from "@/features/tables/mutations"
import { TableHistory } from "@/features/tables/history"

const fixture = (path: string) => readFileSync(new URL(`../../tests/fixtures/tables/${path}`, import.meta.url), "utf8")
const load = (path = "valid/six-types.json") => tableContent(parseTableFile(fixture(path)))
const now = "2030-01-01T00:00:00.000Z"
const later = "2030-01-02T00:00:00.000Z"
const id = (prefix: string, number: number) => `${prefix}_${number.toString(16).padStart(32, "0")}`
const manifest = JSON.parse(fixture("manifest.json")) as { operations: { file: string }[] }

describe("atomic table operations", () => {
  it.each(manifest.operations)("runs shared operation fixture $file", ({ file }) => {
    const test = JSON.parse(fixture(file)) as { source: string; operations: TableMutation[]; expected: { errorCode?: string; changedValues?: Record<string, Record<string, unknown>>; deletedFieldIds?: string[]; mustRemoveValuesForField?: string } }
    const source = load(test.source); const before = structuredClone(source)
    if (test.expected.errorCode) expect(() => applyTableMutations(source, test.operations, now)).toThrowError(expect.objectContaining({ code: test.expected.errorCode }))
    else {
      const next = applyTableMutations(source, test.operations, now)
      for (const [recordId, values] of Object.entries(test.expected.changedValues ?? {})) expect(next.records[recordId].values).toMatchObject(values)
      for (const fieldId of test.expected.deletedFieldIds ?? []) expect(next.fields[fieldId]).toBeUndefined()
      if (test.expected.mustRemoveValuesForField) for (const record of Object.values(next.records)) expect(record.values).not.toHaveProperty(test.expected.mustRemoveValuesForField)
    }
    expect(source).toEqual(before)
  })
  it("supports all ten operations with stable identities and independent view order", () => {
    const source = load("valid/empty.json"); const primary = source.primaryFieldId; const initialView = source.viewOrder[0]
    const field = id("fld", 20); const first = id("rec", 20); const second = id("rec", 21); const view = id("view", 20)
    const added = applyTableMutations(source, [
      { type: "putField", field: { id: field, name: "数字", type: "number" }, beforeFieldId: primary },
      { type: "insertRecords", records: [{ id: first, values: { [primary]: "一", [field]: 1 } }, { id: second, values: { [primary]: "二", [field]: 2 } }], beforeRecordId: null },
      { type: "setCells", cells: [{ recordId: first, fieldId: field, value: 3 }] },
      { type: "setRecordOrder", recordIds: [second, first] },
      { type: "setFieldOrder", fieldIds: [primary, field] },
      { type: "putView", view: { ...source.views[initialView], id: view, name: "独立", fieldOrder: [field, primary] }, beforeViewId: initialView },
      { type: "setViewOrder", viewIds: [initialView, view] },
    ], now)
    expect(added.recordOrder).toEqual([second, first]); expect(added.views[view].fieldOrder).toEqual([field, primary]); expect(added.fieldOrder).toEqual([primary, field])
    const deleted = applyTableMutations(added, [{ type: "deleteRecords", recordIds: [first] }, { type: "deleteField", fieldId: field }, { type: "deleteView", viewId: initialView }], later)
    expect(deleted.recordOrder).toEqual([second]); expect(deleted.viewOrder).toEqual([view]); expect(deleted.records[second].values).toEqual({ [primary]: "二" })
  })
  it("rejects duplicate writes/IDs, missing anchors and forward entity references atomically", () => {
    const source = load(); const cell = { recordId: source.recordOrder[0], fieldId: source.primaryFieldId, value: "修改" }
    for (const operations of [
      [{ type: "setCells", cells: [cell, cell] }],
      [{ type: "insertRecords", records: [{ id: cell.recordId, values: {} }], beforeRecordId: null }],
      [{ type: "insertRecords", records: [{ id: id("rec", 99), values: {} }], beforeRecordId: id("rec", 100) }],
      [{ type: "setCells", cells: [{ ...cell, recordId: id("rec", 100) }] }, { type: "insertRecords", records: [{ id: id("rec", 100), values: {} }], beforeRecordId: null }],
    ] as TableMutation[][]) expect(() => applyTableMutations(source, operations, now)).toThrow()
  })
  it("requires explicit clearing before type changes, including empty text and empty multi-select", () => {
    const source = load(); const fieldId = source.fieldOrder[4]
    for (const record of Object.values(source.records)) record.values[fieldId] = []
    const put: TableMutation = { type: "putField", field: { id: fieldId, name: "改为数字", type: "number" }, beforeFieldId: null }
    expect(() => applyTableMutations(source, [put], now)).toThrow(/非空/)
    const next = applyTableMutations(source, [{ type: "setCells", cells: source.recordOrder.map(recordId => ({ recordId, fieldId, value: null })) }, put], now)
    expect(next.fields[fieldId].type).toBe("number")
    expect(Object.values(next.records).every(record => record.values[fieldId] === undefined)).toBe(true)
  })
  it("does not refresh record timestamps for view-only modifications", () => {
    const source = load(); const view = { ...source.views[source.viewOrder[0]], name: "新视图名" }
    const next = applyTableMutations(source, [{ type: "putView", view, beforeViewId: null }], now)
    for (const id of source.recordOrder) expect([next.records[id].createdAt, next.records[id].updatedAt]).toEqual([source.records[id].createdAt, source.records[id].updatedAt])
  })
  it("clamps backward clocks and restored future creation timestamps for the entire batch", () => {
    const source = load(); const first = source.recordOrder[0]; source.records[first].updatedAt = "2040-01-01T00:00:00.000Z"
    const restoredId = id("rec", 100)
    const next = applyTableMutations(source, [
      { type: "setCells", cells: [{ recordId: first, fieldId: source.primaryFieldId, value: "changed" }] },
      { type: "insertRecords", records: [{ id: restoredId, createdAt: "2050-01-01T00:00:00.000Z", values: {} }], beforeRecordId: null },
    ], "2020-01-01T00:00:00.000Z")
    expect(next.records[first].updatedAt).toBe("2050-01-01T00:00:00.000Z")
    expect(next.records[restoredId].updatedAt).toBe(next.records[restoredId].createdAt)
  })
})

describe("domain undo/redo", () => {
  function dependentContent(): TableContent {
    const content = load(); const select = content.fieldOrder[3]; const view = content.views[content.viewOrder[0]]
    view.filters.conditions = [{ fieldId: select, operator: "isNotEmpty" }]; view.sorts = [{ fieldId: select, direction: "desc" }]
    view.groupBy = select; view.hiddenFieldIds = [select]; view.columnWidths[select] = 240
    return content
  }
  it("restores a deleted field, every value and complete dependent view as one undo gesture", () => {
    const before = dependentContent(); const history = new TableHistory()
    const after = history.apply(before, [{ type: "deleteField", fieldId: before.fieldOrder[3] }], now)
    expect(history.canUndo).toBe(true); expect(history.canRedo).toBe(false)
    const restored = history.undo(after.content, later)!
    expect(businessSnapshot(restored.content)).toBe(businessSnapshot(before))
    expect(restored.content.records[before.recordOrder[0]].updatedAt).toBe(later)
    expect(history.canUndo).toBe(false); expect(history.canRedo).toBe(true)
    expect(businessSnapshot(history.redo(restored.content, later)!.content)).toBe(businessSnapshot(after.content))
  })
  it("undoes record insertion/deletion with IDs, order and creation dates intact", () => {
    const before = load(); const history = new TableHistory(); const recordId = before.recordOrder[1]
    const deleted = history.apply(before, [{ type: "deleteRecords", recordIds: [recordId] }], now)
    const restored = history.undo(deleted.content, later)!.content
    expect(restored.recordOrder).toEqual(before.recordOrder); expect(restored.records[recordId].createdAt).toBe(before.records[recordId].createdAt)
    expect(businessSnapshot(restored)).toBe(businessSnapshot(before))
    const newId = id("rec", 99)
    const inserted = history.apply(restored, [{ type: "insertRecords", records: [{ id: newId, values: { [before.primaryFieldId]: "new" } }], beforeRecordId: recordId }], later)
    expect(history.canRedo).toBe(false)
    const undone = history.undo(inserted.content, later)!.content; const redone = history.redo(undone, later)!.content
    expect(redone.records[newId]).toBeDefined(); expect(redone.recordOrder).toEqual(inserted.content.recordOrder)
  })
  it("clears redo after a new gesture and leaves stacks unchanged on failed atomic edits", () => {
    const history = new TableHistory(); const before = load(); const edit = (value: string): TableMutation[] => [{ type: "setCells", cells: [{ recordId: before.recordOrder[0], fieldId: before.primaryFieldId, value }] }]
    const a = history.apply(before, edit("A"), now); const undone = history.undo(a.content, later)!
    expect(history.canRedo).toBe(true)
    expect(() => history.apply(undone.content, [{ type: "deleteField", fieldId: before.primaryFieldId }], later)).toThrow()
    expect(history.canRedo).toBe(true)
    history.apply(undone.content, edit("B"), later); expect(history.canRedo).toBe(false)
    history.clear(); expect(history.canUndo).toBe(false)
  })
  it("advances neither undo nor redo when the queue rejects the gesture", () => {
    const history = new TableHistory(); const before = load()
    const operations: TableMutation[] = [{ type: "setCells", cells: [{ recordId: before.recordOrder[0], fieldId: before.primaryFieldId, value: "A" }] }]
    const reject = () => { throw new Error("queue refused") }
    expect(() => history.apply(before, operations, now, reject)).toThrow("queue refused"); expect(history.canUndo).toBe(false)
    const accepted = history.apply(before, operations, now)
    expect(() => history.undo(accepted.content, later, reject)).toThrow("queue refused"); expect(history.canUndo).toBe(true); expect(history.canRedo).toBe(false)
    const undone = history.undo(accepted.content, later)!
    expect(() => history.redo(undone.content, later, reject)).toThrow("queue refused"); expect(history.canRedo).toBe(true); expect(history.canUndo).toBe(false)
  })
})
