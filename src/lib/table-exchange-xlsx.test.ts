import { describe, expect, it } from "vitest"
import { buildXlsxImportedTable, defaultXlsxMappings, xlsxPreviewAsCsv } from "@/features/tables/exchange-xlsx"
import type { XlsxCell, XlsxPreview } from "@/features/tables/xlsx-api"

const cell = (kind: string, value: XlsxCell["value"], extra: Partial<XlsxCell> = {}): XlsxCell => ({ kind, value, rawText: null, formula: null, issues: [], ...extra })
const preview = (rows: XlsxCell[][]): XlsxPreview => ({ sheetNames: ["表 1"], sheetIndex: 0, rows, totalRows: rows.length, totalColumns: Math.max(...rows.map(row => row.length)), truncated: false, issues: rows.flatMap(row => row.flatMap(cell => cell.issues)) })

describe("typed XLSX import adapter", () => {
  it("retains text identifiers, numbers, dates, booleans, empty text and missing values", () => {
    const source = preview([[cell("text", "名称"), cell("text", "编号"), cell("text", "数值"), cell("text", "日期"), cell("text", "完成"), cell("text", "空文本"), cell("text", "空值")],
      [cell("text", "中文"), cell("text", "00123"), cell("number", 0), cell("date", "2024-02-29"), cell("checkbox", false), cell("text", ""), cell("empty", null)]])
    const mappings = defaultXlsxMappings(source, true)
    expect(mappings.map(mapping => mapping.type)).toEqual(["text", "text", "number", "date", "checkbox", "text", "text"])
    const result = buildXlsxImportedTable(source, true, mappings, { errorsAsText: false, acknowledgeWarnings: false })
    expect(result.issues).toEqual([])
    const content = result.content!; const record = content.records[content.recordOrder[0]]
    expect(content.fieldOrder.map(id => record.values[id])).toEqual(["中文", "00123", 0, "2024-02-29", false, "", undefined])
  })
  it("blocks missing formula caches until all mapped targets are explicitly text", () => {
    const source = preview([[cell("text", "公式")], [cell("error", null, { formula: "SUM(A1:A2)", issues: [{ code: "FORMULA_CACHE_MISSING", message: "没有缓存值", severity: "error", row: 1, column: 0 }] })]])
    const mappings = defaultXlsxMappings(source, true)
    expect(buildXlsxImportedTable(source, true, mappings, { errorsAsText: false, acknowledgeWarnings: true }).content).toBeNull()
    const extra = [...mappings, { sourceColumn: 0, name: "数字", type: "number" as const }]
    expect(buildXlsxImportedTable(source, true, extra, { errorsAsText: true, acknowledgeWarnings: true }).content).toBeNull()
    const result = buildXlsxImportedTable(source, true, mappings, { errorsAsText: true, acknowledgeWarnings: true }).content!
    expect(result.records[result.recordOrder[0]].values[result.primaryFieldId]).toBe("=SUM(A1:A2)")
  })
  it("does not replace an unavailable shared formula with an empty value", () => {
    const source = preview([[cell("error", null, { issues: [{ code: "FORMULA_CACHE_MISSING", message: "没有缓存值", severity: "error", row: 0, column: 0 }] })]])
    const result = buildXlsxImportedTable(source, false, defaultXlsxMappings(source, false), { errorsAsText: true, acknowledgeWarnings: true })
    expect(result.content).toBeNull(); expect(result.issues[0].message).toContain("没有可保留的文本")
  })
  it("requires acknowledgment before using formula caches and ignores omitted source columns", () => {
    const source = preview([[cell("text", "名称"), cell("text", "值")], [cell("text", "甲"), cell("number", 2, { formula: "1+1", issues: [{ code: "FORMULA_CACHED_VALUE", message: "使用缓存", severity: "warning", row: 1, column: 1 }] })]])
    const mappings = defaultXlsxMappings(source, true)
    expect(buildXlsxImportedTable(source, true, mappings, { errorsAsText: false, acknowledgeWarnings: false }).content).toBeNull()
    expect(buildXlsxImportedTable(source, true, mappings.slice(0, 1), { errorsAsText: false, acknowledgeWarnings: false }).content).not.toBeNull()
    expect(buildXlsxImportedTable(source, true, mappings, { errorsAsText: false, acknowledgeWarnings: true }).content).not.toBeNull()
  })
  it("preserves numeric lexical values only after explicit text selection and rejects truncated previews", () => {
    const source = preview([[cell("text", "长编号")], [cell("error", null, { rawText: "98765432101234567890", issues: [{ code: "NUMBER_PRECISION_OR_LEADING_ZERO", message: "超出精度", severity: "error", row: 1, column: 0 }] })]])
    expect(xlsxPreviewAsCsv(source, true).rows).toEqual([["98765432101234567890"]])
    const result = buildXlsxImportedTable(source, true, defaultXlsxMappings(source, true), { errorsAsText: true, acknowledgeWarnings: true }).content!
    expect(result.records[result.recordOrder[0]].values[result.primaryFieldId]).toBe("98765432101234567890")
    source.truncated = true
    expect(buildXlsxImportedTable(source, true, defaultXlsxMappings(source, true), { errorsAsText: true, acknowledgeWarnings: true }).issues[0].code).toBe("LIMIT_EXCEEDED")
  })
})
