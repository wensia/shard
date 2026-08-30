import { useRef, useState, type KeyboardEvent } from "react"

import {
  withInsertedTableColumn,
  withInsertedTableRow,
  withoutTableColumn,
  withoutTableRow,
  withTableCell,
  type MarkdownTable,
} from "@/lib/markdown-table"

interface CellPosition {
  /** 表头是 -1，数据行从 0 开始 */
  column: number
  row: number
}

interface CellDraft extends CellPosition {
  value: string
}

export interface EditorTableProps {
  onChange: (table: MarkdownTable) => void
  onExit?: () => void
  sourceStart: number
  table: MarkdownTable
}

/**
 * 编辑态的表格。
 *
 * 由 CM6 widget 挂载，单元格直接编辑并把变更写回文档。
 */
export function EditorTable({
  onChange,
  onExit,
  sourceStart,
  table,
}: EditorTableProps) {
  const [draft, setDraft] = useState<CellDraft | null>(null)
  const [active, setActive] = useState<CellPosition | null>(null)
  const surfaceRef = useRef<HTMLSpanElement>(null)
  const columnCount = table.align.length
  const lastRow = table.rows.length - 1

  function getCellValue(row: number, column: number) {
    if (draft && draft.row === row && draft.column === column) {
      return draft.value
    }

    return (row < 0 ? table.header[column] : table.rows[row]?.[column]) ?? ""
  }

  function focusCell(row: number, column: number) {
    // 结构变化要等这一帧的重渲染落地，新单元格才存在
    requestAnimationFrame(() => {
      const input = surfaceRef.current?.querySelector<HTMLInputElement>(
        `[data-cell="${row}:${column}"]`
      )
      if (!input) return

      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    })
  }

  function commitCell(row: number, column: number, value: string) {
    setDraft({ column, row, value })
    onChange(withTableCell(table, row, column, value))
  }

  function appendRow(row: number, column: number) {
    onChange(withInsertedTableRow(table, row))
    focusCell(Math.min(row + 1, table.rows.length), column)
  }

  function moveTo(row: number, column: number) {
    setDraft(null)
    focusCell(row, column)
  }

  function handleCellKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    row: number,
    column: number
  ) {
    if (event.key === "Escape") {
      event.preventDefault()
      setDraft(null)
      onExit?.()
      return
    }

    if (event.key === "Tab") {
      event.preventDefault()
      if (event.shiftKey) {
        if (column > 0) moveTo(row, column - 1)
        else if (row >= 0) moveTo(row - 1, columnCount - 1)
        return
      }

      if (column < columnCount - 1) moveTo(row, column + 1)
      else if (row < lastRow) moveTo(row + 1, 0)
      else appendRow(row, 0)
      return
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (row < lastRow) moveTo(row + 1, column)
      else appendRow(row, column)
      return
    }

    if (event.key === "ArrowUp" && row > -1) {
      event.preventDefault()
      moveTo(row - 1, column)
      return
    }

    if (event.key === "ArrowDown" && row < lastRow) {
      event.preventDefault()
      moveTo(row + 1, column)
    }
  }

  function renderCellInput(row: number, column: number) {
    const isHeader = row < 0
    const value = getCellValue(row, column)

    return (
      <input
        aria-label={
          isHeader
            ? `第 ${column + 1} 列表头`
            : `第 ${row + 1} 行第 ${column + 1} 列`
        }
        className="shard-editor-table-input"
        data-cell={`${row}:${column}`}
        onBlur={() => {
          setDraft(null)
          setActive((current) =>
            current && current.row === row && current.column === column
              ? null
              : current
          )
        }}
        onChange={(event) => commitCell(row, column, event.currentTarget.value)}
        onFocus={() => setActive({ column, row })}
        onKeyDown={(event) => handleCellKeyDown(event, row, column)}
        placeholder={isHeader ? "标题" : undefined}
        spellCheck={false}
        style={{ textAlign: table.align[column] ?? undefined }}
        type="text"
        value={value}
      />
    )
  }

  // 没有单元格在编辑时只允许追加：删除要有明确的目标行列，不能替用户猜。
  const target = active ?? { column: columnCount - 1, row: lastRow }
  const canDelete = active !== null

  return (
    <span
      className="shard-editor-table-block"
      data-table-start={sourceStart}
    >
      <span
        className="shard-editor-table-surface"
        ref={surfaceRef}
      >
        <table className="shard-editor-table">
          <thead>
            <tr>
              {table.header.map((_, column) => (
                <th key={column}>{renderCellInput(-1, column)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((_, column) => (
                  <td key={column}>{renderCellInput(rowIndex, column)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <span className="shard-editor-table-actions">
          <TableAction
            hint="在下方插入一行"
            label="+行"
            onClick={() => appendRow(target.row, target.column)}
          />
          <TableAction
            hint="在右侧插入一列"
            label="+列"
            onClick={() => {
              onChange(withInsertedTableColumn(table, target.column))
              focusCell(target.row, target.column + 1)
            }}
          />
          <TableAction
            disabled={!canDelete || table.rows.length === 0 || target.row < 0}
            hint="删除光标所在行"
            label="删行"
            onClick={() => {
              onChange(withoutTableRow(table, target.row))
              focusCell(Math.min(target.row, table.rows.length - 2), target.column)
            }}
          />
          <TableAction
            disabled={!canDelete || columnCount <= 1}
            hint="删除光标所在列"
            label="删列"
            onClick={() => {
              onChange(withoutTableColumn(table, target.column))
              focusCell(target.row, Math.min(target.column, columnCount - 2))
            }}
          />
        </span>
      </span>
    </span>
  )
}

interface TableActionProps {
  disabled?: boolean
  hint: string
  label: string
  onClick: () => void
}

function TableAction({
  disabled = false,
  hint,
  label,
  onClick,
}: TableActionProps) {
  return (
    <button
      aria-label={hint}
      className="shard-editor-table-action"
      disabled={disabled}
      // 按下时别让单元格失焦，否则 active 位置在点击生效前就没了
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      title={hint}
      type="button"
    >
      {label}
    </button>
  )
}
