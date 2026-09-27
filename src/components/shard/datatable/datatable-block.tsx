import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"

import {
  ChevronRightIcon,
  DownloadIcon,
  FunnelIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  PlusIcon,
  SaveIcon,
  TableIcon,
  Trash2Icon,
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getApiErrorMessage, readCsvFile } from "@/lib/api"
import { openDatasetEditor } from "@/features/datasets/open-dataset"
import { parseCsvBytesInWorker } from "@/lib/csv-worker"
import {
  addDatatableColumn,
  addDatatableRow,
  coerceDatatableValue,
  datatableColumnsFromCsv,
  datatableEditText,
  datatableRowsFromCsv,
  datatableToCsv,
  filterDatatableEntries,
  formatDatatableCell,
  groupDatatableEntries,
  isDatatableParseError,
  parseDatatableSource,
  removeDatatableColumn,
  removeDatatableRow,
  renameDatatableColumn,
  serializeDatatableSpec,
  setDatatableCell,
  sortDatatableEntries,
  toDatatableEntries,
  writeDatatableView,
  type DatatableColumn,
  type DatatableEntry,
  type DatatableRow,
  type DatatableSpec,
  type DatatableView,
} from "@/lib/datatable"

import styles from "./datatable-block.module.css"

export interface DatatableBlockProps {
  /** 围栏正文（JSON 原文）。 */
  source: string
  readOnly?: boolean
  /** 只有内联 rows 的可编辑表才会回调；视图状态变化不走这里。 */
  onChange?: (source: string) => void
}

type CsvState =
  | { state: "idle" }
  | { state: "loading" }
  | { message: string; state: "error" }
  | { records: string[][]; state: "ready" }

const DEFAULT_TITLE = "数据表"

/**
 * ```datatable 围栏块的组件形态：排序、分组、搜索、全屏、导出 CSV，
 * 内联 rows 时单元格可编辑并写回围栏 JSON（技术方案 §4.3）。
 *
 * 原生 table + React state，不引入 TanStack。视图状态（排序/分组/搜索）只活在
 * 组件里，除非用户点「保存视图」，否则不写回文件——浏览动作不该产生 Git 改动。
 */
export function DatatableBlock({ source, readOnly = false, onChange }: DatatableBlockProps) {
  const parsed = useMemo(() => parseDatatableSource(source), [source])

  if (isDatatableParseError(parsed)) {
    return (
      <section className={styles.block} data-datatable="error">
        <header className={styles.header}>
          <TableIcon className={styles.titleIcon} />
          <span className={styles.title}>{DEFAULT_TITLE}</span>
        </header>
        <p className={styles.status} role="alert">
          数据表 JSON 无法解析：{parsed.error}
        </p>
        <pre className={styles.rawSource}>{source}</pre>
      </section>
    )
  }

  return (
    <DatatableSurface
      onChange={onChange}
      readOnly={readOnly}
      spec={parsed}
    />
  )
}

interface DatatableSurfaceProps {
  spec: DatatableSpec
  readOnly: boolean
  onChange?: (source: string) => void
}

function DatatableSurface({ spec, readOnly, onChange }: DatatableSurfaceProps) {
  const [csv, setCsv] = useState<CsvState>({ state: spec.src ? "loading" : "idle" })
  const [sort, setSort] = useState<DatatableView["sort"] | null>(spec.view?.sort ?? null)
  const [group, setGroup] = useState<string | null>(spec.view?.group ?? null)
  const [query, setQuery] = useState(spec.view?.filter ?? "")
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null)
  const blockRef = useRef<HTMLElement>(null)
  // 新增行写回后等新 source 渲染出来，再把焦点放进新行第一格。
  const pendingRowFocusRef = useRef<number | null>(null)

  const src = spec.src
  useEffect(() => {
    if (!src) {
      setCsv({ state: "idle" })
      return
    }
    let cancelled = false
    const reload = () => {
      // CSV 读取与解析都在后台：主线程只等 Promise（AGENTS.md Runtime Rules）。
      void readCsvFile(src)
        .then((bytes) => parseCsvBytesInWorker(Uint8Array.from(bytes)))
        .then((document) => {
          if (!cancelled) setCsv({ records: document.records, state: "ready" })
        })
        .catch((error: unknown) => {
          if (!cancelled) setCsv({ message: getApiErrorMessage(error), state: "error" })
        })
    }
    setCsv({ state: "loading" })
    reload()
    const changed = (event: Event) => { if ((event as CustomEvent<{ path: string }>).detail.path === src) reload() }
    window.addEventListener("shard:dataset-changed", changed)
    return () => {
      cancelled = true
      window.removeEventListener("shard:dataset-changed", changed)
    }
  }, [src])

  const { columns, rows } = useMemo(() => resolveData(spec, csv), [spec, csv])
  const editable = !readOnly && !spec.src && Boolean(onChange)

  const entries = useMemo(() => {
    const all = toDatatableEntries(rows)
    return sortDatatableEntries(filterDatatableEntries(all, columns, query), columns, sort ?? undefined)
  }, [columns, query, rows, sort])
  const groups = useMemo(
    () => groupDatatableEntries(entries, columns, group),
    [columns, entries, group]
  )

  const viewActive = Boolean(sort || group || query.trim())
  const savedView = spec.view ?? {}
  const currentView: DatatableView = {}
  if (sort) currentView.sort = sort
  if (group) currentView.group = group
  if (query.trim()) currentView.filter = query.trim()
  const viewDirty =
    JSON.stringify(normalizeViewForCompare(currentView)) !==
    JSON.stringify(normalizeViewForCompare(savedView))

  function toggleSort(key: string) {
    setSort((current) => {
      if (!current || current.key !== key) return { direction: "asc", key }
      if (current.direction === "asc") return { direction: "desc", key }
      return null
    })
  }

  function toggleGroupValue(value: string) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  function commit(next: DatatableSpec) {
    if (!editable || !onChange || next === spec) return
    onChange(serializeDatatableSpec(next))
  }

  function commitCell(index: number, column: DatatableColumn, text: string) {
    const value = coerceDatatableValue(text, column.type)
    const current = spec.rows[index]
    if (current && current[column.key] === value) return
    commit(setDatatableCell(spec, index, column.key, value))
  }

  function addRow() {
    // 搜索词会把新加的空行筛掉，加行时先清掉，免得点了没反应。
    setQuery("")
    pendingRowFocusRef.current = spec.rows.length
    commit(addDatatableRow(spec))
  }

  function addColumn() {
    const { key, spec: next } = addDatatableColumn(spec)
    setRenamingKey(key)
    commit(next)
  }

  function removeColumn(key: string) {
    if (sort?.key === key) setSort(null)
    if (group === key) setGroup(null)
    commit(removeDatatableColumn(spec, key))
  }

  useEffect(() => {
    const index = pendingRowFocusRef.current
    if (index === null || index >= spec.rows.length) return
    pendingRowFocusRef.current = null
    const input = blockRef.current?.querySelector<HTMLInputElement>(
      `input[data-datatable-row="${index}"]`
    )
    input?.focus()
  }, [spec.rows.length])

  function saveView() {
    if (!onChange) return
    onChange(serializeDatatableSpec(writeDatatableView(spec, currentView)))
  }

  async function exportCsv() {
    if (isExporting) return
    setIsExporting(true)
    try {
      const { save } = await import("@tauri-apps/plugin-dialog")
      const { writeTableExchangeFile } = await import("@/features/tables/xlsx-api")
      const name = (spec.title || DEFAULT_TITLE).replace(/[\\/:*?"<>|]/gu, "_")
      const chosen = await save({
        defaultPath: `${name}.csv`,
        filters: [{ extensions: ["csv"], name: "CSV" }],
        title: "导出数据表",
      })
      if (!chosen) return
      const text = datatableToCsv(columns, groups ? groups.flatMap((item) => item.entries) : entries)
      await writeTableExchangeFile(chosen, new TextEncoder().encode(text))
      toast("数据表已导出为 CSV")
    } catch (error) {
      toast.error(`数据表导出失败：${getApiErrorMessage(error)}`, { duration: Infinity })
    } finally {
      setIsExporting(false)
    }
  }

  const title = spec.title || DEFAULT_TITLE
  const controls = (
    <div className={styles.controls}>
      <input
        aria-label="搜索表格"
        className={styles.search}
        data-datatable-search=""
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索"
        type="text"
        value={query}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label="分组"
              className={styles.controlButton}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <FunnelIcon />
          <span className="sr-only">分组</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setGroup(null)}>不分组</DropdownMenuItem>
          {columns.map((column) => (
            <DropdownMenuItem key={column.key} onClick={() => setGroup(column.key)}>
              按{column.label}分组
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {editable && viewDirty ? (
        <Button
          aria-label="保存视图"
          className={styles.controlButton}
          onClick={saveView}
          size="icon-sm"
          variant="ghost"
        >
          <SaveIcon />
          <span className="sr-only">保存视图</span>
        </Button>
      ) : null}
      <Button
        aria-label="导出 CSV"
        className={styles.controlButton}
        disabled={isExporting}
        onClick={() => void exportCsv()}
        size="icon-sm"
        variant="ghost"
      >
        <DownloadIcon />
        <span className="sr-only">导出 CSV</span>
      </Button>
      {spec.src && <Button size="sm" variant="outline" onClick={() => openDatasetEditor(spec.src!)}>编辑数据</Button>}
      {isFullscreen ? null : (
        <Button
          aria-label="全屏"
          className={styles.controlButton}
          onClick={() => setIsFullscreen(true)}
          ref={fullscreenButtonRef}
          size="icon-sm"
          variant="ghost"
        >
          <Maximize2Icon />
          <span className="sr-only">全屏</span>
        </Button>
      )}
    </div>
  )

  const table = (
    <DatatableGrid
      collapsed={collapsed}
      columns={columns}
      editable={editable}
      entries={entries}
      group={group}
      groups={groups}
      onAddColumn={addColumn}
      onAddRow={addRow}
      onCommitCell={commitCell}
      onRemoveColumn={removeColumn}
      onRemoveRow={(index) => commit(removeDatatableRow(spec, index))}
      onRenameColumn={(key, label) => {
        setRenamingKey(null)
        commit(renameDatatableColumn(spec, key, label))
      }}
      onStartRename={setRenamingKey}
      renamingKey={renamingKey}
      onToggleGroup={toggleGroupValue}
      onToggleSort={toggleSort}
      sort={sort}
    />
  )

  const rowSummary =
    entries.length === rows.length ? `${rows.length} 行` : `${entries.length} / ${rows.length} 行`

  return (
    <section
      aria-label={`数据表：${title}`}
      className={styles.block}
      data-datatable="block"
      data-datatable-editable={editable ? "true" : "false"}
      data-view-active={viewActive ? "true" : "false"}
      ref={blockRef}
    >
      <header className={styles.header}>
        <TableIcon className={styles.titleIcon} />
        <span className={styles.title}>{title}</span>
        <span className={styles.meta}>
          {rowSummary}
          {spec.src ? <span title={spec.src}> · 来自 {spec.src}</span> : null}
        </span>
        {controls}
      </header>
      {csv.state === "loading" ? (
        <p aria-busy="true" className={styles.status} role="status">
          正在读取 CSV…
        </p>
      ) : csv.state === "error" ? (
        <p className={styles.status} role="alert">
          无法读取 CSV：{csv.message}
        </p>
      ) : (
        <div className={styles.scroll}>{table}</div>
      )}
      <Dialog open={isFullscreen} onOpenChange={setIsFullscreen}>
        <DialogContent className={styles.fullscreen} finalFocus={fullscreenButtonRef}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              全屏查看数据表；排序、分组与搜索与内嵌视图共用同一份状态。
            </DialogDescription>
          </DialogHeader>
          {controls}
          <div className={styles.fullscreenScroll}>{table}</div>
        </DialogContent>
      </Dialog>
    </section>
  )
}

interface DatatableGridProps {
  columns: DatatableColumn[]
  entries: DatatableEntry[]
  groups: { value: string; entries: DatatableEntry[] }[] | null
  group: string | null
  sort: DatatableView["sort"] | null
  collapsed: ReadonlySet<string>
  editable: boolean
  renamingKey: string | null
  onToggleSort: (key: string) => void
  onToggleGroup: (value: string) => void
  onCommitCell: (index: number, column: DatatableColumn, text: string) => void
  onAddRow: () => void
  onRemoveRow: (index: number) => void
  onAddColumn: () => void
  onStartRename: (key: string | null) => void
  onRenameColumn: (key: string, label: string) => void
  onRemoveColumn: (key: string) => void
}

function DatatableGrid({
  collapsed,
  columns,
  editable,
  entries,
  group,
  groups,
  onAddColumn,
  onAddRow,
  onCommitCell,
  onRemoveColumn,
  onRemoveRow,
  onRenameColumn,
  onStartRename,
  onToggleGroup,
  onToggleSort,
  renamingKey,
  sort,
}: DatatableGridProps) {
  // 可编辑时末尾多一条窄操作列：表头放「加列」，每行放「删行」。
  const spanCount = Math.max(columns.length, 1) + (editable ? 1 : 0)
  const groupLabel = group
    ? (columns.find((column) => column.key === group)?.label ?? group)
    : ""

  function renderRows(items: DatatableEntry[]): ReactNode {
    return items.map((entry) => (
      <tr key={entry.index}>
        {columns.map((column) => (
          <td
            className={styles.cell}
            data-align={alignOf(column)}
            key={column.key}
          >
            {editable ? (
              <DatatableCellInput
                column={column}
                label={`${column.label} 第 ${entry.index + 1} 行`}
                rowIndex={entry.index}
                onCommit={(text) => onCommitCell(entry.index, column, text)}
                value={entry.row[column.key]}
              />
            ) : (
              <span className={styles.cellText}>
                {formatDatatableCell(entry.row[column.key], column.type)}
              </span>
            )}
          </td>
        ))}
        {editable ? (
          <td className={styles.actionCell}>
            <button
              aria-label={`删除第 ${entry.index + 1} 行`}
              className={styles.rowAction}
              onClick={() => onRemoveRow(entry.index)}
              type="button"
            >
              <Trash2Icon />
            </button>
          </td>
        ) : null}
      </tr>
    ))
  }

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          {columns.map((column) => {
            const direction = sort?.key === column.key ? sort.direction : null
            if (editable && renamingKey === column.key) {
              return (
                <th data-align={alignOf(column)} key={column.key} scope="col">
                  <DatatableColumnNameInput
                    label={column.label}
                    onCancel={() => onStartRename(null)}
                    onCommit={(label) => onRenameColumn(column.key, label)}
                  />
                </th>
              )
            }
            return (
              <th data-align={alignOf(column)} key={column.key} scope="col">
                <div className={styles.headerCell}>
                  <button
                    aria-label={`按${column.label}排序`}
                    aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}
                    className={styles.headerButton}
                    data-datatable-sort={column.key}
                    data-direction={direction ?? "none"}
                    onClick={() => onToggleSort(column.key)}
                    type="button"
                  >
                    <span className={styles.headerLabel}>{column.label}</span>
                    <SortMark direction={direction} />
                  </button>
                  {editable ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <button
                            aria-label={`${column.label}列操作`}
                            className={styles.columnMenuButton}
                            type="button"
                          />
                        }
                      >
                        <MoreHorizontalIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => onStartRename(column.key)}>
                          重命名
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={columns.length <= 1}
                          onClick={() => onRemoveColumn(column.key)}
                          variant="destructive"
                        >
                          删除列
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              </th>
            )
          })}
          {editable ? (
            // 操作格不是列头：用 td，读屏与 `thead th` 都只数真实的列。
            <td className={styles.actionCell}>
              <button
                aria-label="新增列"
                className={styles.columnAdd}
                onClick={onAddColumn}
                type="button"
              >
                <PlusIcon />
              </button>
            </td>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {groups ? (
          groups.map((item) => (
            <DatatableGroupRows
              collapsed={collapsed.has(item.value)}
              columnCount={spanCount}
              group={item}
              key={item.value}
              label={groupLabel}
              onToggle={() => onToggleGroup(item.value)}
              renderRows={renderRows}
            />
          ))
        ) : entries.length > 0 ? (
          renderRows(entries)
        ) : (
          <tr>
            <td className={styles.empty} colSpan={spanCount}>
              {editable && entries.length === 0 && !group ? "还没有行" : "没有匹配的行"}
            </td>
          </tr>
        )}
      </tbody>
      {editable ? (
        <tfoot>
          <tr>
            <td colSpan={spanCount}>
              <button className={styles.rowAdd} onClick={onAddRow} type="button">
                <PlusIcon />
                新增行
              </button>
            </td>
          </tr>
        </tfoot>
      ) : null}
    </table>
  )
}

interface DatatableGroupRowsProps {
  group: { value: string; entries: DatatableEntry[] }
  label: string
  columnCount: number
  collapsed: boolean
  onToggle: () => void
  renderRows: (entries: DatatableEntry[]) => ReactNode
}

function DatatableGroupRows({
  collapsed,
  columnCount,
  group,
  label,
  onToggle,
  renderRows,
}: DatatableGroupRowsProps) {
  return (
    <>
      <tr>
        <td className={styles.groupCell} colSpan={Math.max(columnCount, 1)}>
          <button
            aria-expanded={!collapsed}
            className={styles.groupButton}
            data-datatable-group={group.value}
            onClick={onToggle}
            type="button"
          >
            <ChevronRightIcon className={styles.groupChevron} data-expanded={!collapsed} />
            <span>
              {label}：{group.value}
            </span>
            <span className={styles.groupCount}>{group.entries.length}</span>
          </button>
        </td>
      </tr>
      {collapsed ? null : renderRows(group.entries)}
    </>
  )
}

interface DatatableColumnNameInputProps {
  label: string
  onCommit: (label: string) => void
  onCancel: () => void
}

/** 列名就地编辑：挂上即全选，Enter 或失焦提交，Esc 放弃。 */
function DatatableColumnNameInput({ label, onCancel, onCommit }: DatatableColumnNameInputProps) {
  const [draft, setDraft] = useState(label)
  const cancelledRef = useRef(false)

  return (
    <input
      aria-label="列名"
      autoFocus
      className={styles.columnNameInput}
      onBlur={() => {
        if (cancelledRef.current) return
        onCommit(draft)
      }}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === "Enter") {
          event.preventDefault()
          event.currentTarget.blur()
        } else if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          cancelledRef.current = true
          onCancel()
        }
      }}
      type="text"
      value={draft}
    />
  )
}

interface DatatableCellInputProps {
  value: unknown
  label: string
  rowIndex: number
  column: DatatableColumn
  onCommit: (text: string) => void
}

/**
 * 编辑中的文本只活在本地：每敲一个字就写回围栏 JSON 会让排序中的行当场跳位，
 * 焦点跟着丢。提交点是失焦与 Enter，与表格类控件的常规约定一致。
 */
function DatatableCellInput({ column, label, onCommit, rowIndex, value }: DatatableCellInputProps) {
  const text = datatableEditText(value)
  const [draft, setDraft] = useState(text)
  const lastTextRef = useRef(text)

  if (lastTextRef.current !== text) {
    lastTextRef.current = text
    if (draft !== text) setDraft(text)
  }

  return (
    <input
      aria-label={label}
      className={styles.cellInput}
      data-align={alignOf(column)}
      data-datatable-row={rowIndex}
      onBlur={() => onCommit(draft)}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          onCommit(draft)
          event.currentTarget.blur()
        }
      }}
      type="text"
      value={draft}
    />
  )
}

/** 两枚小三角：未排序时两枚都淡，排序后只留一枚并加深（同 Craft 的列头排序标）。 */
function SortMark({ direction }: { direction: "asc" | "desc" | null }) {
  return (
    <svg aria-hidden="true" className={styles.sortMark} fill="currentColor" viewBox="0 0 16 16">
      {direction !== "desc" ? <path d={direction ? "M8 3l4 5H4z" : "M8 3l3 4H5z"} /> : null}
      {direction !== "asc" ? <path d={direction ? "M8 13l4-5H4z" : "M8 13l3-4H5z"} /> : null}
    </svg>
  )
}

function alignOf(column: DatatableColumn) {
  if (column.align) return column.align
  return column.type === "number" || column.type === "currency" || column.type === "percent"
    ? "right"
    : "left"
}

function normalizeViewForCompare(view: DatatableView) {
  return {
    filter: view.filter ?? "",
    group: view.group ?? "",
    sort: view.sort ? `${view.sort.key}:${view.sort.direction}` : "",
  }
}

function resolveData(
  spec: DatatableSpec,
  csv: CsvState
): { columns: DatatableColumn[]; rows: DatatableRow[] } {
  if (!spec.src) return { columns: spec.columns, rows: spec.rows }
  if (csv.state !== "ready") return { columns: spec.columns, rows: [] }

  const [header = [], ...records] = csv.records
  const columns = spec.columns.length > 0 ? spec.columns : datatableColumnsFromCsv(header)
  return { columns, rows: datatableRowsFromCsv(records, columns) }
}
