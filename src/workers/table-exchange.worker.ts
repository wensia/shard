import { buildImportedTable, defaultImportMappings, exportNativeTable, exportTableCsv, exportTableXlsxRows, importNativeTableContent, parseCsvTablePreview, type CsvTablePreview } from "@/features/tables/exchange"
import { buildXlsxImportedTable, defaultXlsxMappings, xlsxPreviewAsCsv } from "@/features/tables/exchange-xlsx"
import type { ExchangeCommand, ExchangePreview, ExchangeRequest, ExchangeResponse, ExchangeResult } from "@/features/tables/exchange-protocol"
import { tableContent, type TableContent } from "@/features/tables/model"
import type { XlsxPreview } from "@/features/tables/xlsx-api"

let source: { format: "csv"; preview: CsvTablePreview } | { format: "xlsx"; preview: CsvTablePreview; xlsx: XlsxPreview } | { format: "native"; content: TableContent } | null = null
let prepared: TableContent | null = null
function previewResult(): ExchangePreview {
  if (!source) throw new Error("请先选择导入文件")
  if (source.format === "native") {
    const content = source.content
    return { format: "native", hasHeader: false, columns: content.fieldOrder.map((id, sourceColumn) => ({ sourceColumn, name: content.fields[id].name })), rows: [], rowCount: content.recordOrder.length, mappings: [], sourceIssues: [], sourceIssueCount: 0, sourceHasWarnings: false, sourceHasErrors: false }
  }
  const preview = source.preview
  const sourceIssues = source.format === "xlsx" ? source.xlsx.issues : []
  return { format: source.format, ...(source.format === "csv" ? { encoding: preview.encoding } : {}), hasHeader: preview.hasHeader, columns: preview.columns,
    rows: preview.rows.slice(0, 8).map(row => preview.columns.map(column => { const value = row[column.sourceColumn]; if (value === undefined) return null; const characters = Array.from(value); return characters.length > 160 ? characters.slice(0, 160).join("") + "…" : value })), rowCount: preview.rows.length,
    mappings: source.format === "xlsx" ? defaultXlsxMappings(source.xlsx, preview.hasHeader) : defaultImportMappings(preview), sourceIssues: sourceIssues.slice(0, 100), sourceIssueCount: sourceIssues.length, sourceHasWarnings: sourceIssues.some(issue => issue.severity === "warning"), sourceHasErrors: sourceIssues.some(issue => issue.severity === "error") }
}
function execute(command: ExchangeCommand): ExchangeResult {
  switch (command.type) {
    case "loadCsv": {
      let bytes = command.bytes
      if (command.encoding !== "auto") {
        const encoding = command.encoding === "utf-8-bom" ? "utf-8" : command.encoding
        bytes = new TextEncoder().encode(new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/u, ""))
      }
      const preview = parseCsvTablePreview(bytes, { header: command.hasHeader })
      if (command.encoding !== "auto") preview.encoding = command.encoding
      source = { format: "csv", preview }; prepared = null
      return previewResult()
    }
    case "loadXlsx": source = { format: "xlsx", xlsx: command.preview, preview: xlsxPreviewAsCsv(command.preview, command.hasHeader) }; prepared = null; return previewResult()
    case "loadNative": source = { format: "native", content: importNativeTableContent(command.bytes) }; prepared = source.content; return previewResult()
    case "validate": {
      if (!source) throw new Error("请先选择导入文件")
      const result = source.format === "native" ? { content: source.content, issues: [] } : source.format === "xlsx"
        ? buildXlsxImportedTable(source.xlsx, source.preview.hasHeader, command.mappings, command)
        : buildImportedTable(source.preview, command.mappings)
      prepared = result.content
      return { valid: prepared !== null, rowCount: prepared?.recordOrder.length ?? 0, fieldCount: prepared?.fieldOrder.length ?? 0, issues: result.issues.slice(0, 100), issueCount: result.issues.length }
    }
    case "content": if (!prepared) throw new Error("请先校验导入内容"); return prepared
    case "export": {
      if (command.format === "native") return { type: "bytes", bytes: new TextEncoder().encode(exportNativeTable(command.file)), escapedCells: 0, recordCount: command.file.recordOrder.length, fieldCount: command.file.fieldOrder.length }
      const content = tableContent(command.file)
      if (command.format === "xlsx") {
        const data = exportTableXlsxRows(content, command.scope)
        return { type: "xlsx", bytes: new TextEncoder().encode(JSON.stringify(data)), escapedCells: 0, recordCount: data.rows.length, fieldCount: data.columns.length }
      }
      const result = exportTableCsv(content, command.scope, command.mode)
      return { type: "bytes", bytes: new TextEncoder().encode("\uFEFF" + result.text), escapedCells: result.escapedCells, recordCount: result.recordCount, fieldCount: result.fieldCount }
    }
  }
}
self.onmessage = ({ data }: MessageEvent<ExchangeRequest>) => {
  try {
    const value = execute(data.command)
    const transfer = "bytes" in value ? [value.bytes.buffer] : []
    self.postMessage({ id: data.id, value } satisfies ExchangeResponse, { transfer })
  } catch (error) { self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) } satisfies ExchangeResponse) }
}
