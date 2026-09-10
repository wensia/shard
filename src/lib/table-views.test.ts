import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseTableFile, tableContent, type TableFilter, type TableSort } from "@/features/tables/model"
import { projectTableView } from "@/features/tables/views"

const fixture = (path: string) => readFileSync(new URL(`../../tests/fixtures/tables/${path}`, import.meta.url), "utf8")
const load = () => tableContent(parseTableFile(fixture("valid/six-types.json")))
const cases = (JSON.parse(fixture("projection-cases.json")) as { cases: { name: string; source: string; filters: TableFilter; sorts: TableSort[]; groupBy: string | null; viewId: string; expectedRecordIds: string[] }[] }).cases

describe("stable table projections", () => {
  it.each(cases)("matches shared projection fixture $name", test => {
    const content = tableContent(parseTableFile(fixture(test.source)))
    Object.assign(content.views[test.viewId], { filters: test.filters, sorts: test.sorts, groupBy: test.groupBy })
    const snapshot = structuredClone(content); const projection = projectTableView(content, test.viewId, 17)
    expect(projection.recordIds).toEqual(test.expectedRecordIds); expect(projection.generation).toBe(17); expect(projection.viewId).toBe(test.viewId)
    expect(content).toEqual(snapshot)
  })
  it("uses Unicode codepoint ordering, then stable root recordOrder ties", () => {
    const content = load(); const [a, b, c, d] = content.recordOrder; const field = content.primaryFieldId; const viewId = content.viewOrder[0]
    content.records[a].values[field] = "𐀀"; content.records[b].values[field] = "\ue000"; content.records[c].values[field] = "\ue000"; delete content.records[d].values[field]
    content.views[viewId].sorts = [{ fieldId: field, direction: "asc" }]
    expect(projectTableView(content, viewId, 0).recordIds).toEqual([b, c, a, d])
    content.recordOrder = [c, a, b, d]
    expect(projectTableView(content, viewId, 1).recordIds).toEqual([c, b, a, d])
  })
  it("sorts multi-select by option-order tuples rather than storage array order", () => {
    const content = load(); const [a, b, c, d] = content.recordOrder; const fieldId = content.fieldOrder[4]; const field = content.fields[fieldId]
    if (field.type !== "multiSelect") throw new Error("fixture type")
    const [first, second] = field.options.map(option => option.id)
    content.records[a].values[fieldId] = [second, first]; content.records[b].values[fieldId] = [second]; content.records[c].values[fieldId] = []; content.records[d].values[fieldId] = null
    const viewId = content.viewOrder[0]; content.views[viewId].sorts = [{ fieldId, direction: "asc" }]
    expect(projectTableView(content, viewId, 0).recordIds).toEqual([c, a, b, d])
    content.views[viewId].sorts[0].direction = "desc"
    expect(projectTableView(content, viewId, 1).recordIds).toEqual([b, a, c, d])
  })
  it("groups every record once, keeps null distinct from empty text and orders within groups", () => {
    const content = load(); const [a, b, c, d] = content.recordOrder; const field = content.primaryFieldId; const numeric = content.fieldOrder[1]; const viewId = content.viewOrder[0]
    content.records[a].values[field] = ""; content.records[b].values[field] = ""; content.records[c].values[field] = "组"; delete content.records[d].values[field]
    content.records[a].values[numeric] = 1; content.records[b].values[numeric] = 2
    content.views[viewId].groupBy = field; content.views[viewId].sorts = [{ fieldId: numeric, direction: "desc" }]
    const result = projectTableView(content, viewId, 3)
    expect(result.recordIds).toEqual([b, a, c, d]); expect(new Set(result.recordIds).size).toBe(4)
    expect(result.groups).toEqual([
      { key: '["text",""]', value: "", start: 0, count: 2, collapsed: false, gridStart: 0 },
      { key: '["text","组"]', value: "组", start: 2, count: 1, collapsed: false, gridStart: 3 },
      { key: '["text",null]', value: null, start: 3, count: 1, collapsed: false, gridStart: 5 },
    ])
    const collapsed = projectTableView(content, viewId, 3, { collapsedGroups: new Set([result.groups[0].key]), displayRevision: 9 })
    expect(collapsed.recordIds).toEqual(result.recordIds)
    expect(collapsed.gridRows).toEqual([
      { kind: "group", key: result.groups[0].key },
      { kind: "group", key: result.groups[1].key }, { kind: "record", recordId: c },
      { kind: "group", key: result.groups[2].key }, { kind: "record", recordId: d },
    ])
    expect(collapsed.groups.map(group => group.gridStart)).toEqual([0, 1, 3])
    expect(collapsed.displayRevision).toBe(9)
  })
  it("keeps independent views isolated and never returns group headers as record IDs", () => {
    const file = parseTableFile(fixture("valid/independent-views.json")); const content = tableContent(file)
    const before = structuredClone(content.views); for (const id of content.viewOrder) {
      const projection = projectTableView(content, id, 4)
      expect(projection.recordIds.every(recordId => !!content.records[recordId])).toBe(true)
    }
    expect(content.views).toEqual(before)
  })
})
