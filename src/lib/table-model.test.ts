import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { TABLE_LIMITS, TableValidationError, businessSnapshot, compareCodePoints, normalizeTableContent, parseTableFile,
  tableContent, validateCellValue, validateFilter, validateTableContent } from "@/features/tables/model"

const fixture = (path: string) => readFileSync(new URL(`../../tests/fixtures/tables/${path}`, import.meta.url), "utf8")
const manifest = JSON.parse(fixture("manifest.json")) as { valid: { file: string }[]; invalid: { file: string; code: string; pointer: string }[] }

describe("table wire model", () => {
  it.each(manifest.valid)("accepts shared Rust/TS fixture $file", ({ file }) => {
    const parsed = parseTableFile(new TextEncoder().encode(fixture(file)))
    expect(parsed.kind).toBe("shard.table"); expect(() => validateTableContent(tableContent(parsed))).not.toThrow()
  })
  it.each(manifest.invalid)("rejects $file with its precise shared code/pointer", ({ file, code, pointer }) => {
    try { parseTableFile(fixture(file)); throw new Error("unexpected acceptance") }
    catch (error) { expect(error).toBeInstanceOf(TableValidationError); expect(error).toMatchObject({ code, pointer }) }
  })
  it("rejects malformed bytes, lone surrogates, escaped duplicate keys and trailing JSON", () => {
    expect(() => parseTableFile(new Uint8Array([0xff]))).toThrowError(expect.objectContaining({ code: "INVALID_JSON" }))
    for (const source of ['{"name":"\\ud800"}', '{"name":"\ud800"}', '{"a":1,}', '{"a":1} false', '{"a":1e999}'])
      expect(() => parseTableFile(source)).toThrowError(expect.objectContaining({ code: "INVALID_JSON" }))
    expect(() => parseTableFile('{"schemaVersion":1,"schema\\u0056ersion":1}')).toThrowError(expect.objectContaining({ code: "DUPLICATE_KEY", pointer: "/schemaVersion" }))
  })
  it("normalizes only unset keys, negative zero and multi-select order", () => {
    const content = tableContent(parseTableFile(fixture("valid/six-types.json"))); const [recordId] = content.recordOrder
    const numeric = content.fieldOrder[1]; const multi = content.fieldOrder[4]; const record = content.records[recordId]
    record.values[numeric] = -0; record.values[multi] = (content.fields[multi] as { options: { id: string }[] }).options.map(option => option.id).reverse()
    const normalized = normalizeTableContent(content)
    expect(normalized.records[recordId].values[numeric]).toBe(0)
    expect(Object.is(record.values[numeric], -0)).toBe(true)
    expect(normalized.records[recordId].values[multi]).toEqual([...(record.values[multi] as string[])].sort(compareCodePoints))
    expect(Object.values(normalized.records).flatMap(item => Object.values(item.values))).not.toContain(null)
    expect(businessSnapshot(normalized)).toBe(businessSnapshot(content))
  })
  it("strictly validates field-specific values and operator parameters", () => {
    const content = tableContent(parseTableFile(fixture("valid/six-types.json"))); const [text, number, date, select, multi, checkbox] = content.fieldOrder.map(id => content.fields[id])
    for (const [field, value] of [[text, 1], [number, Infinity], [number, Number.MAX_SAFE_INTEGER + 1], [date, "1900-02-29"], [checkbox, "false"], [select, "missing"], [multi, ["missing"]]] as const)
      expect(() => validateCellValue(field, value)).toThrowError(expect.objectContaining({ code: "INVALID_VALUE" }))
    expect(() => validateCellValue(date, "2000-02-29")).not.toThrow()
    expect(() => validateCellValue(text, "𠮷".repeat(TABLE_LIMITS.text))).not.toThrow()
    expect(() => validateCellValue(text, "𠮷".repeat(TABLE_LIMITS.text + 1))).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }))
    for (const condition of [
      { fieldId: number.id, operator: "gt", value: "3" }, { fieldId: text.id, operator: "isEmpty", value: "" },
      { fieldId: select.id, operator: "in", optionIds: [] }, { fieldId: text.id, operator: "contains" },
      { fieldId: date.id, operator: "between", lower: "2026-01-02", upper: "2026-01-01" },
    ]) expect(() => validateFilter(condition, content.fields)).toThrowError(expect.objectContaining({ code: "INVALID_FILTER" }))
  })
  it("compares Unicode code points rather than UTF-16 units", () => {
    expect(compareCodePoints("\ue000", "𐀀")).toBeLessThan(0)
    expect(compareCodePoints("é", "e\u0301")).toBeGreaterThan(0)
    expect(compareCodePoints("中", "中文")).toBeLessThan(0)
  })
  it("agrees with Rust on shared scalar and malformed cell-array cases", () => {
    const content = tableContent(parseTableFile(fixture("valid/six-types.json")))
    const cases = JSON.parse(fixture("cell-wire-cases.json")) as { valid: { fieldType: string; value: unknown }[]; invalid: { fieldType: string; value: unknown }[] }
    for (const entry of cases.valid) {
      const field = Object.values(content.fields).find(field => field.type === entry.fieldType)!
      expect(() => validateCellValue(field, entry.value)).not.toThrow()
    }
    for (const entry of cases.invalid) {
      const field = Object.values(content.fields).find(field => field.type === entry.fieldType)!
      expect(() => validateCellValue(field, entry.value)).toThrow()
    }
  })
  it("business snapshots include every view, order and value but exclude generated times", () => {
    const original = tableContent(parseTableFile(fixture("valid/six-types.json"))); const copy = structuredClone(original)
    for (const record of Object.values(copy.records)) { record.createdAt = "2020-01-01T00:00:00Z"; record.updatedAt = "2030-01-01T00:00:00Z" }
    expect(businessSnapshot(copy)).toBe(businessSnapshot(original))
    copy.views[copy.viewOrder[0]].columnWidths[copy.primaryFieldId] = 999
    expect(businessSnapshot(copy)).not.toBe(businessSnapshot(original))
  })
})
