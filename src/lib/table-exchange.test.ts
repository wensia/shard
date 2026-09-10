import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseCsv } from "@/lib/csv"
import { buildImportedTable, defaultImportMappings, exportNativeTable, exportTableCsv, exportTableXlsxRows,
  importNativeTableContent, parseCsvTablePreview, type TableImportMapping } from "@/features/tables/exchange"
import { businessSnapshot, parseTableFile, tableContent, validateTableContent, type TableField } from "@/features/tables/model"

const bytes = (text: string) => new TextEncoder().encode(text)
function options() { let sequence = 1; return { now: () => "2030-01-01T00:00:00.000Z", id: (prefix: "fld" | "opt" | "rec" | "view") => `${prefix}_${(sequence++).toString(16).padStart(32, "0")}` } }
const sourceFile = () => parseTableFile(readFileSync(new URL("../../tests/fixtures/tables/valid/six-types.json", import.meta.url), "utf8"))

describe("CSV typed preview and mapping", () => {
  it("defaults every source column to text and preserves identifiers, formulas and empty text", () => {
    const preview = parseCsvTablePreview(bytes("名称,编号,长编号,表达式\r\n,00123,9007199254740993,=1+1\r\n"))
    expect(defaultImportMappings(preview).every(mapping => mapping.type === "text")).toBe(true)
    const result = buildImportedTable(preview, undefined, options()); expect(result.issues).toEqual([])
    const content = result.content!; const record = content.records[content.recordOrder[0]]
    expect(content.fieldOrder.map(id => record.values[id])).toEqual(["", "00123", "9007199254740993", "=1+1"])
    expect(content.records[content.recordOrder[0]].createdAt).toBe("2030-01-01T00:00:00.000Z")
  })
  it("retains duplicate headers as independent field IDs and handles ragged rows without truncating extra columns", () => {
    const preview = parseCsvTablePreview(bytes("重复,重复,\n甲,\n乙,丙,丁,额外\n"))
    const content = buildImportedTable(preview, undefined, options()).content!
    expect(content.fieldOrder.map(id => content.fields[id].name)).toEqual(["重复", "重复", "列 3", "列 4"])
    expect(new Set(content.fieldOrder).size).toBe(4)
    const first = content.records[content.recordOrder[0]]
    expect(first.values[content.fieldOrder[1]]).toBe(""); expect(first.values[content.fieldOrder[2]]).toBeUndefined()
    expect(content.records[content.recordOrder[1]].values[content.fieldOrder[3]]).toBe("额外")
  })
  it("uses shared CSV quote/newline decoding and supports headerless imports", () => {
    const preview = parseCsvTablePreview(bytes('"甲,乙","第一行\n第二行"\r\n"带""引号",末尾\r\n'), { header: false })
    const content = buildImportedTable(preview, undefined, options()).content!
    expect(preview.columns.map(column => column.name)).toEqual(["列 1", "列 2"])
    expect(content.records[content.recordOrder[0]].values[content.fieldOrder[1]]).toBe("第一行\n第二行")
    expect(content.records[content.recordOrder[1]].values[content.primaryFieldId]).toBe('带"引号')
    expect(() => parseCsvTablePreview(bytes('a,b\n"unterminated'))).toThrow(/未闭合/)
  })
  it("reuses BOM/UTF-16/GBK decoding rather than rebuilding the parser", () => {
    const text = "名称\n中文\n"; const utf16 = new Uint8Array(2 + text.length * 2); utf16.set([0xff, 0xfe])
    for (let index = 0; index < text.length; index++) { utf16[index * 2 + 2] = text.charCodeAt(index) & 0xff; utf16[index * 2 + 3] = text.charCodeAt(index) >> 8 }
    expect(parseCsvTablePreview(utf16)).toMatchObject({ encoding: "utf-16le", rows: [["中文"]] })
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(text)])
    expect(parseCsvTablePreview(bom)).toMatchObject({ encoding: "utf-8-bom", rows: [["中文"]] })
    expect(parseCsvTablePreview(new Uint8Array([0xd0, 0xd5, 0xc3, 0xfb, 10, 0xd5, 0xc5, 0xc8, 0xfd]))).toMatchObject({ encoding: "gbk", rows: [["张三"]] })
  })
  it("maps all six field types and creates stable option IDs from label order", () => {
    const preview = parseCsvTablePreview(bytes('名称,数量,日期,状态,标签,完成\r\n中文,0,2024-02-29,待办,"[""甲"",""乙""]",false\r\n第二条,-2.5,,完成,[],1\r\n'))
    const types = ["text", "number", "date", "select", "multiSelect", "checkbox"] as const
    const result = buildImportedTable(preview, types.map((type, sourceColumn) => ({ sourceColumn, type })), options())
    expect(result.issues).toEqual([]); const content = result.content!; validateTableContent(content)
    const [first, second] = content.recordOrder.map(id => content.records[id]); const [, numeric, date, select, multi, checkbox] = content.fieldOrder
    expect(first.values[numeric]).toBe(0); expect(second.values[numeric]).toBe(-2.5); expect(first.values[date]).toBe("2024-02-29"); expect(second.values[date]).toBeUndefined()
    expect(first.values[checkbox]).toBe(false); expect(second.values[checkbox]).toBe(true); expect(second.values[multi]).toEqual([])
    const selectField = content.fields[select] as Extract<TableField, { type: "select" | "multiSelect" }>
    expect(selectField.options.map(option => option.label)).toEqual(["待办", "完成"]); expect(first.values[select]).toBe(selectField.options[0].id)
    expect(exportTableXlsxRows(content, { type: "all" }).rows[0]).toEqual(["中文", 0, "2024-02-29", "待办", '["甲","乙"]', false])
  })
  it("reports each invalid mapped cell without returning a partially valid table", () => {
    const preview = parseCsvTablePreview(bytes('数字,日期,复选框,标签\n00123,2025-02-29,是,"[""甲"",""甲""]"\n9007199254740993,2025-01-01T00:00:00Z,maybe,甲\n'))
    const mappings: TableImportMapping[] = [{ sourceColumn: 0, type: "number" }, { sourceColumn: 1, type: "date" }, { sourceColumn: 2, type: "checkbox" }, { sourceColumn: 3, type: "multiSelect" }]
    const result = buildImportedTable(preview, mappings, options())
    expect(result.content).toBeNull(); expect(result.issues.map(issue => [issue.sourceRow, issue.sourceColumn])).toEqual([[2, 1], [2, 2], [2, 3], [2, 4], [3, 1], [3, 2], [3, 3], [3, 4]])
  })
  it("supports mapping one source column to multiple targets and inserts a text primary when needed", () => {
    const preview = parseCsvTablePreview(bytes("数值\n12\n"))
    const content = buildImportedTable(preview, [{ sourceColumn: 0, type: "text", name: "原文" }, { sourceColumn: 0, type: "number", name: "数值" }], options()).content!
    const record = content.records[content.recordOrder[0]]; expect(content.fieldOrder.map(id => record.values[id])).toEqual(["12", 12])
    const numericOnly = buildImportedTable(preview, [{ sourceColumn: 0, type: "number" }], options()).content!
    expect(numericOnly.fields[numericOnly.primaryFieldId].type).toBe("text"); expect(numericOnly.fieldOrder).toHaveLength(2)
  })
  it("rejects ambiguous mappings and respects explicitly configured select options", () => {
    const preview = parseCsvTablePreview(bytes("状态\n未配置\n"))
    for (const mappings of [[], [{ sourceColumn: 3, type: "text" }], [{ sourceColumn: 0, type: "number", primary: true }], [{ sourceColumn: 0, type: "select", options: ["重复", "重复"] }]] as TableImportMapping[][])
      expect(buildImportedTable(preview, mappings, options())).toMatchObject({ content: null, issues: [expect.objectContaining({ code: "INVALID_MAPPING" })] })
    expect(buildImportedTable(preview, [{ sourceColumn: 0, type: "select", options: ["待办"] }], options())).toMatchObject({ content: null, issues: [{ sourceRow: 2, sourceColumn: 1, code: "INVALID_VALUE", message: "值不在指定的选项中", rawValue: "未配置" }] })
  })
  it("creates a valid empty table and rejects structural capacity overflow before full CSV parsing", () => {
    const empty = buildImportedTable(parseCsvTablePreview(bytes("")), undefined, options()).content!
    expect(empty.recordOrder).toEqual([]); expect(empty.fieldOrder).toHaveLength(1); expect(empty.viewOrder).toHaveLength(1)
    expect(() => parseCsvTablePreview(bytes("标题\n" + "\n".repeat(10_001)))).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }))
    expect(() => parseCsvTablePreview(bytes(Array.from({ length: 129 }, () => "列").join(",")))).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }))
    const quotedNewlines = parseCsvTablePreview(bytes('标题\n"' + "\n".repeat(10_001) + '"\n'))
    expect(quotedNewlines.rows).toHaveLength(1)
  })
})

describe("table exchanges", () => {
  it("exports all rows or the full filtered view with visible columns and view order, never a display page", () => {
    const content = tableContent(sourceFile()); const viewId = content.viewOrder[0]; const view = content.views[viewId]; const numeric = content.fieldOrder[1]
    view.hiddenFieldIds = [numeric]; view.fieldOrder.reverse(); view.filters.conditions = [{ fieldId: numeric, operator: "gte", value: 0 }]; view.sorts = [{ fieldId: numeric, direction: "desc" }]
    const all = exportTableXlsxRows(content, { type: "all" }); const selected = exportTableXlsxRows(content, { type: "view", viewId })
    expect(all.rows).toHaveLength(4); expect(all.columns).toHaveLength(6); expect(selected.rows).toHaveLength(2); expect(selected.columns).toHaveLength(5)
    expect(selected.columns.map(column => column.name)).toEqual(view.fieldOrder.filter(id => id !== numeric).map(id => content.fields[id].name))
    const textIndex = selected.columns.findIndex(column => column.name === content.fields[content.primaryFieldId].name)
    expect(selected.rows[0][textIndex]).toBeNull(); expect(selected.rows[1][textIndex]).toBe(content.records[content.recordOrder[0]].values[content.primaryFieldId])
    expect(exportTableCsv(content, { type: "view", viewId }).recordCount).toBe(2)
  })
  it("escapes formula-like text and headers by default while preserving actual negative numbers", () => {
    const content = tableContent(sourceFile()); const field = content.primaryFieldId; content.fields[field].name = "=header"
    const labels = ["=1+1", " \t@A1", "\nplain", "-12"]
    content.recordOrder.forEach((id, index) => { content.records[id].values[field] = labels[index] })
    content.records[content.recordOrder[0]].values[content.fieldOrder[1]] = -2
    const safe = exportTableCsv(content, { type: "all" }); const raw = exportTableCsv(content, { type: "all" }, "raw")
    expect(safe.escapedCells).toBe(5); expect(raw.escapedCells).toBe(0)
    const safeRows = parseCsv(safe.text); const rawRows = parseCsv(raw.text)
    expect(safeRows[0][0]).toBe("'=header"); expect(safeRows.slice(1).map(row => row[0])).toEqual(labels.map(label => `'${label}`))
    expect(safeRows[1][1]).toBe("-2"); expect(rawRows.slice(1).map(row => row[0])).toEqual(labels)
  })
  it("writes multi-select labels as JSON arrays and retains newlines/quotes in raw CSV", () => {
    const file = sourceFile(); const content = tableContent(file); const multi = content.fieldOrder[4]; const field = content.fields[multi]
    if (field.type !== "multiSelect") throw new Error("fixture type")
    const first = content.records[content.recordOrder[0]]; first.values[multi] = field.options.map(option => option.id).reverse(); first.values[content.primaryFieldId] = '第一行\n带"引号,逗号'
    const parsed = parseCsv(exportTableCsv(content, { type: "all" }, "raw").text)
    expect(parsed[1][0]).toBe(first.values[content.primaryFieldId]); expect(JSON.parse(parsed[1][4])).toEqual(field.options.map(option => option.label))
  })
  it("uses the existing Rust XLSX columns/rows wire shape and retains null, empty text and exact numeric values", () => {
    const content = tableContent(sourceFile()); const first = content.recordOrder[0]; content.records[first].values[content.fieldOrder[1]] = Number.MAX_SAFE_INTEGER
    const result = exportTableXlsxRows(content, { type: "all" })
    expect(result.columns.map(column => column.kind)).toEqual(["text", "number", "date", "text", "text", "checkbox"])
    expect(result.rows[0][1]).toBe(Number.MAX_SAFE_INTEGER); expect(result.rows[2][0]).toBe(""); expect(result.rows[2][1]).toBeNull(); expect(result.rows[3][0]).toBeNull()
    // The Rust writer reports Excel's stricter significant-digit limit; this layer must not round it.
    expect(result.rows[0][5]).toBe(false)
  })
  it("exports a complete strict native file and strips old identity metadata when preparing a new import", () => {
    const file = sourceFile(); const exported = exportNativeTable(file)
    expect(exported.endsWith("\n")).toBe(true); expect(exported.endsWith("\n\n")).toBe(false)
    const parsed = parseTableFile(exported); expect(parsed.id).toBe(file.id); expect(parsed.creation).toEqual(file.creation)
    const imported = importNativeTableContent(bytes(exported)); expect(imported).not.toHaveProperty("id"); expect(imported).not.toHaveProperty("creation"); expect(imported).not.toHaveProperty("revision")
    expect(businessSnapshot(imported)).toBe(businessSnapshot(tableContent(file))); expect(exportNativeTable(parsed)).toBe(exported)
    expect(() => importNativeTableContent('{"schemaVersion":1,"schemaVersion":1}')).toThrowError(expect.objectContaining({ code: "DUPLICATE_KEY" }))
  })
})
