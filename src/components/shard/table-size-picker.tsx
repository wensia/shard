import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { FileSpreadsheetIcon, TableIcon } from "@/components/icons"

import { ToolbarIconButton } from "@/components/ui/toolbar-icon-button"

const GRID_COLUMNS = 6
const GRID_ROWS = 6
const PANEL_GAP = 8

/** 面板贴着触发按钮的哪一侧展开 */
interface Placement {
  align: "end" | "start"
  side: "bottom" | "top"
}

interface TableSize {
  columns: number
  rows: number
}

interface TableSizePickerProps {
  disabled?: boolean
  /** 省略时不显示导入入口（例如非桌面环境） */
  onImport?: () => void
  onSelect: (columns: number, rows: number) => void
}

/**
 * 工具栏里的「插入表格」：点开是一张 6×6 网格，划到哪里就插多大的表。
 * 行数含表头，所以 3×2 得到的就是选择器里高亮出来的那两行。
 */
export function TableSizePicker({
  disabled = false,
  onImport,
  onSelect,
}: TableSizePickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [size, setSize] = useState<TableSize | null>(null)
  const [placement, setPlacement] = useState<Placement>({
    align: "start",
    side: "top",
  })
  const containerRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLSpanElement>(null)

  // 速记框就贴在窗口顶部，工具栏上方装不下这块面板——放不下就翻到下面去。
  // 用 layout effect：翻转要在浏览器绘制前定好，否则会先闪一帧在窗外。
  useLayoutEffect(() => {
    if (!isOpen) return

    const container = containerRef.current
    const panel = panelRef.current
    if (!container || !panel) return

    const anchor = container.getBoundingClientRect()
    const fitsAbove = anchor.top - panel.offsetHeight - PANEL_GAP >= 0
    const fitsFromLeft =
      anchor.left + panel.offsetWidth <= window.innerWidth - PANEL_GAP

    setPlacement({
      align: fitsFromLeft ? "start" : "end",
      side: fitsAbove ? "top" : "bottom",
    })
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && containerRef.current?.contains(target)) {
        return
      }

      setIsOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return

      event.preventDefault()
      setIsOpen(false)
    }

    document.addEventListener("pointerdown", handlePointerDown)
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [isOpen])

  useEffect(() => {
    if (isOpen) return

    setSize(null)
  }, [isOpen])

  function selectSize(columns: number, rows: number) {
    setIsOpen(false)
    onSelect(columns, rows)
  }

  return (
    <span ref={containerRef} style={{ position: "relative", display: "flex" }}>
      <ToolbarIconButton
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className="shard-edge-action"
        disabled={disabled}
        label="插入表格"
        // 编辑器靠 textarea 的选区决定插到哪里，按下工具栏不能夺走焦点
        onMouseDown={(event) => {
          event.preventDefault()
          setIsOpen((current) => !current)
        }}
        style={{
          borderRadius: "var(--shard-radius-control)",
          color: "var(--muted-foreground)",
        }}
        type="button"
        variant="ghost"
      >
        <TableIcon />
      </ToolbarIconButton>

      {isOpen ? (
        <span
          aria-label="选择表格大小"
          className="shard-table-size-picker"
          data-align={placement.align}
          data-side={placement.side}
          ref={panelRef}
          role="dialog"
        >
          <span className="shard-table-size-grid">
            {Array.from({ length: GRID_ROWS }, (_, rowIndex) =>
              Array.from({ length: GRID_COLUMNS }, (_, columnIndex) => {
                const columns = columnIndex + 1
                const rows = rowIndex + 1
                const isSelected =
                  size !== null && columns <= size.columns && rows <= size.rows

                return (
                  <button
                    aria-label={`${columns} 列 ${rows} 行`}
                    className="shard-table-size-cell"
                    data-selected={isSelected ? "" : undefined}
                    key={`${rows}-${columns}`}
                    onClick={() => selectSize(columns, rows)}
                    onFocus={() => setSize({ columns, rows })}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setSize({ columns, rows })}
                    type="button"
                  />
                )
              })
            )}
          </span>
          <span className="shard-table-size-label">
            {size ? `${size.columns} × ${size.rows}` : "拖选表格大小"}
          </span>
          {onImport ? (
            <button
              className="shard-table-size-import"
              onClick={() => {
                setIsOpen(false)
                onImport()
              }}
              onMouseDown={(event) => event.preventDefault()}
              type="button"
            >
              <FileSpreadsheetIcon aria-hidden="true" />
              从 Excel 导入…
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}
