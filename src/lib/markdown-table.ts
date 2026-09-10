// Compatibility entry point; implementation lives in the reusable package.
export {
  isTableCandidateLine,
  parseMarkdownTable,
  MAX_EDITABLE_TABLE_CELLS,
  createMarkdownTable,
  serializeMarkdownTable,
  hasOversizedTable,
  getTableCellCount,
  getFirstEditableTableOffset,
  withTableCell,
  withInsertedTableRow,
  withoutTableRow,
  withInsertedTableColumn,
  withoutTableColumn,
  withTableAlign,
  replaceTableLines,
  getLineStartOffset,
} from "@shard/markdown/core"
export type { TableAlign, MarkdownTable } from "@shard/markdown/core"
