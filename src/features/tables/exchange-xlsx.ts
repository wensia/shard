// Entire-workbook conversion belongs in the exchange Worker. Kept pure for typed-value tests.
import { buildImportedTable, type CsvTablePreview, type TableImportIssue, type TableImportMapping, type TableImportResult } from "./exchange"
import type { FieldType } from "./model"
import type { XlsxCell, XlsxPreview } from "./xlsx-api"

export function xlsxCellText(cell: XlsxCell | undefined): string | undefined {
  if (!cell || cell.kind === "empty") return undefined
  if (cell.kind === "error") return cell.formula ? `=${cell.formula}` : cell.rawText ?? undefined
  return cell.value == null ? undefined : String(cell.value)
}
export function xlsxPreviewAsCsv(source: XlsxPreview, hasHeader: boolean): CsvTablePreview {
  const firstRow = hasHeader ? source.rows[0] : undefined
  const rows = (hasHeader ? source.rows.slice(1) : source.rows).map(row => {
    const result: string[] = []
    row.forEach((cell, column) => { const value = xlsxCellText(cell); if (value !== undefined) result[column] = value })
    return result
  })
  return { encoding: "utf-8", hasHeader, columns: Array.from({ length: source.totalColumns }, (_, sourceColumn) => {
    const text = xlsxCellText(firstRow?.[sourceColumn])
    return { sourceColumn, name: text?.trim() ? text : `列 ${sourceColumn + 1}` }
  }), rows }
}
export function defaultXlsxMappings(source: XlsxPreview, hasHeader: boolean): TableImportMapping[] {
  const preview = xlsxPreviewAsCsv(source, hasHeader)
  return preview.columns.map(column => {
    const kinds = new Set((hasHeader ? source.rows.slice(1) : source.rows).map(row => row[column.sourceColumn]?.kind ?? "empty").filter(kind => kind !== "empty"))
    const single = kinds.size === 1 ? [...kinds][0] : "text"
    const type: FieldType = single === "number" || single === "date" || single === "checkbox" ? single : "text"
    return { ...column, type }
  })
}
export function buildXlsxImportedTable(source: XlsxPreview, hasHeader: boolean, mappings: TableImportMapping[], options: { errorsAsText: boolean; acknowledgeWarnings: boolean }): TableImportResult {
  const issues: TableImportIssue[] = []
  if (source.truncated) return { content: null, issues: [{ sourceRow: null, sourceColumn: 0, code: "LIMIT_EXCEEDED", message: "工作表预览不完整，不能只导入预览行" }] }
  const selected = new Set(mappings.map(mapping => mapping.sourceColumn))
  for (const issue of source.issues) {
    if (issue.column !== null && !selected.has(issue.column)) continue
    const location = { sourceRow: issue.row === null ? null : issue.row + 1, sourceColumn: issue.column === null ? 0 : issue.column + 1 }
    if (issue.severity === "warning" && !options.acknowledgeWarnings) {
      issues.push({ ...location, code: "INVALID_VALUE", message: "请确认工作表提示后再导入：" + issue.message })
    } else if (issue.severity === "error") {
      const cell = issue.row === null || issue.column === null ? undefined : source.rows[issue.row]?.[issue.column]
      const targets = mappings.filter(mapping => mapping.sourceColumn === issue.column)
      const textAvailable = cell && xlsxCellText(cell) !== undefined
      // Header cells are labels, while every mapped target of a data cell must be text.
      const mappedAsText = hasHeader && issue.row === 0 || targets.length > 0 && targets.every(mapping => mapping.type === "text")
      if (!options.errorsAsText || !textAvailable || !mappedAsText)
        issues.push({ ...location, code: "INVALID_VALUE", message: issue.message + (textAvailable ? "；可将该来源列的全部目标设为文本，并勾选按文本保留异常值" : "；源文件没有可保留的文本，请修正源文件") })
    }
  }
  if (issues.length) return { content: null, issues }
  return buildImportedTable(xlsxPreviewAsCsv(source, hasHeader), mappings)
}
