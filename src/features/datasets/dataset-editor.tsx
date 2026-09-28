import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import DataEditor, { GridCellKind, emptyGridSelection, type DataEditorRef, type GridCell, type GridSelection, type Item, type Rectangle } from "@glideapps/glide-data-grid"
import "@glideapps/glide-data-grid/dist/index.css"
import { Redo2Icon, Undo2Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { readKilnGridTheme } from "@/features/tables/kiln-grid-theme"
import { provideTableTextEditor } from "@/features/tables/text-cell-editor"
import { getApiErrorMessage } from "@/lib/api"
import { toast } from "sonner"
import { applyDatasetOps as saveDatasetOps, isStaleBaseError, readDataset } from "./api"
import { applyDatasetOps, DatasetOpError, invertDatasetOps, newRowId } from "./ops"
import type { CsvTable, DatasetOp, DatasetSnapshot } from "./types"

export type DatasetEditorHandle = { flush(): Promise<boolean>; isDirty(): boolean }
export type DatasetEditorProps = { path: string; onSnapshot?: (snapshot: DatasetSnapshot) => void }
type SaveStatus = "保存中" | "已保存" | "未保存" | "冲突" | "出错"
type History = { undo: DatasetOp[]; redo: DatasetOp[] }

function failure(error: unknown): string { return getApiErrorMessage(error) }
function explicitCells(ops: DatasetOp[]): number {
  return ops.reduce((count, op) => count + (op.op === "setCells" ? op.cells.length : op.op === "insertRows" ? op.rows.reduce((sum, row) => sum + row.length, 0) : 0), 0)
}

/** The parent awaits flush before unmounting or changing path. */
export const DatasetEditor = forwardRef<DatasetEditorHandle, DatasetEditorProps>(function DatasetEditor({ path, onSnapshot }, ref) {
  const host = useRef<HTMLDivElement>(null)
  const grid = useRef<DataEditorRef>(null)
  const [metrics, setMetrics] = useState<ReturnType<typeof readKilnGridTheme>>()
  const [snapshot, setSnapshot] = useState<DatasetSnapshot | null>(null)
  const snapshotRef = useRef<DatasetSnapshot | null>(null)
  const [table, setTable] = useState<CsvTable | null>(null)
  const tableRef = useRef<CsvTable | null>(null)
  const [selection, setSelection] = useState<GridSelection>(emptyGridSelection)
  const [status, setStatus] = useState<SaveStatus>("已保存")
  const [problem, setProblem] = useState("")
  const [loading, setLoading] = useState(true)
  const [menu, setMenu] = useState<{ column: number; anchor: { getBoundingClientRect(): DOMRect } } | null>(null)
  const [nameDialog, setNameDialog] = useState<{ action: "insert" | "rename"; column: number } | null>(null)
  const [name, setName] = useState("")
  const [nameError, setNameError] = useState("")
  const composing = useRef(false)
  const pending = useRef<DatasetOp[][]>([])
  const inFlight = useRef<Promise<void> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const paused = useRef(false)
  const history = useRef<History[]>([])
  const redo = useRef<History[]>([])
  const [historyVersion, setHistoryVersion] = useState(0)
  const alive = useRef(true)
  const generation = useRef(0)

  const replaceTable = useCallback((next: CsvTable) => { tableRef.current = next; setTable(next) }, [])
  const resetHistory = useCallback(() => { history.current = []; redo.current = []; setHistoryVersion(value => value + 1) }, [])
  const cancelTimer = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null }, [])

  const load = useCallback(async (discard = false) => {
    const version = ++generation.current
    if (discard) { cancelTimer(); pending.current = []; paused.current = false }
    if (!snapshotRef.current) setLoading(true)
    try {
      const next = await readDataset(path)
      if (!alive.current || version !== generation.current) return
      const changed = snapshotRef.current?.sha !== next.sha || snapshotRef.current?.schemaSha !== next.schemaSha
      snapshotRef.current = next
      setSnapshot(next)
      onSnapshot?.(next)
      if (changed || discard) replaceTable(next.table)
      if (changed || discard) resetHistory()
      setProblem("")
      setStatus("已保存")
      if (changed || discard) setSelection(emptyGridSelection)
    } catch (error) {
      if (alive.current && version === generation.current) { setProblem(failure(error)); setStatus("出错") }
    } finally {
      if (alive.current && version === generation.current) setLoading(false)
    }
  }, [cancelTimer, onSnapshot, path, replaceTable, resetHistory])

  useEffect(() => {
    alive.current = true
    void load()
    return () => { alive.current = false; generation.current++; cancelTimer() }
  }, [load, cancelTimer])

  useEffect(() => {
    const element = host.current
    if (!element) return
    const update = () => setMetrics(readKilnGridTheme(element))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const drain = useCallback(async (): Promise<void> => {
    if (inFlight.current || paused.current || !snapshotRef.current || !pending.current.length) return
    cancelTimer()
    const job = (async () => {
      while (pending.current.length && !paused.current) {
        const batch = pending.current[0]
        const base = snapshotRef.current!
        setStatus("保存中")
        try {
          const next = await saveDatasetOps(path, base.sha, base.schemaSha, batch)
          if (!alive.current) return
          snapshotRef.current = next
          setSnapshot(next)
          pending.current.shift()
          setProblem("")
          window.dispatchEvent(new CustomEvent("shard:dataset-changed", { detail: { path } }))
        } catch (error) {
          if (!alive.current) return
          paused.current = true
          setStatus(isStaleBaseError(error) ? "冲突" : "出错")
          setProblem(isStaleBaseError(error) ? "数据文件已在别处被修改" : failure(error))
        }
      }
      if (alive.current && !paused.current) setStatus("已保存")
    })()
    inFlight.current = job
    try { await job } finally { inFlight.current = null }
  }, [cancelTimer, path])

  const flush = useCallback(async (): Promise<boolean> => {
    cancelTimer()
    while (inFlight.current) await inFlight.current
    if (paused.current) return false
    if (pending.current.length) await drain()
    return !paused.current && !pending.current.length && !inFlight.current
  }, [cancelTimer, drain])
  useImperativeHandle(ref, () => ({ flush, isDirty: () => pending.current.length > 0 || !!inFlight.current }), [flush])

  const schedule = useCallback(() => {
    cancelTimer()
    if (!paused.current) timer.current = setTimeout(() => { void drain() }, 600)
  }, [cancelTimer, drain])

  const commit = useCallback((ops: DatasetOp[], mode: "edit" | "undo" | "redo" = "edit", entry?: History) => {
    const before = tableRef.current
    const source = snapshotRef.current
    if (!before || !source?.editable || paused.current || !ops.length) return false
    try {
      const after = applyDatasetOps(before, source.schema, ops)
      let inverse: DatasetOp[] | null = null
      try { inverse = invertDatasetOps(before, ops) }
      catch (error) {
        if (!(error instanceof DatasetOpError) || error.code !== "LIMIT_EXCEEDED" || mode !== "edit") throw error
        resetHistory()
        toast.warning("本次编辑超出撤销上限，已清空撤销记录")
      }
      if (mode === "edit") {
        if (inverse) { history.current.push({ undo: inverse, redo: ops }); if (history.current.length > 100) history.current.shift() }
        redo.current = []
      } else if (mode === "undo" && entry) redo.current.push(entry)
      else if (mode === "redo" && entry) history.current.push(entry)
      setHistoryVersion(value => value + 1)
      replaceTable(after)
      // Merge queued gestures in order, but never alter the batch in flight or
      // exceed the server's per-batch limits.
      const lastIndex = pending.current.length - 1
      const last = pending.current[lastIndex]
      if (last && !(inFlight.current && lastIndex === 0) && last.length + ops.length <= 64 && explicitCells(last) + explicitCells(ops) <= 50_000) last.push(...ops)
      else pending.current.push([...ops])
      setStatus("未保存")
      schedule()
      return true
    } catch (error) { toast.error(failure(error)); return false }
  }, [replaceTable, resetHistory, schedule])

  const undo = useCallback(() => {
    const entry = history.current.pop()
    if (entry && !commit(entry.undo, "undo", entry)) history.current.push(entry)
    setHistoryVersion(value => value + 1)
  }, [commit])
  const doRedo = useCallback(() => {
    const entry = redo.current.pop()
    if (entry && !commit(entry.redo, "redo", entry)) redo.current.push(entry)
    setHistoryVersion(value => value + 1)
  }, [commit])

  useEffect(() => {
    const onFocus = () => {
      if (pending.current.length || inFlight.current) { void flush(); return }
      if (!paused.current) void load()
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [flush, load])

  const keyColumn = snapshot?.schema?.primaryKey ? table?.header.indexOf(snapshot.schema.primaryKey) ?? -1 : -1
  const blocked = !snapshot?.editable || paused.current
  const columns = useMemo(() => table?.header.map((title, index) => ({ id: `${index}:${title}`, title, width: metrics?.columnWidth ?? 180, hasMenu: !blocked, icon: index === keyColumn ? "lock" : undefined })) ?? [], [table?.header, metrics?.columnWidth, blocked, keyColumn])
  const getCellContent = useCallback(([column, row]: Item): GridCell => {
    const text = table?.rows[row]?.[column] ?? ""
    return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: !blocked && column !== keyColumn, readonly: blocked || column === keyColumn }
  }, [blocked, keyColumn, table])
  useEffect(() => {
    if (!import.meta.env.DEV || !host.current) return
    const element = host.current as HTMLDivElement & { __datasetGetCellContent?: typeof getCellContent }
    element.__datasetGetCellContent = getCellContent
    return () => { delete element.__datasetGetCellContent }
  }, [getCellContent])
  useEffect(() => {
    if (!import.meta.env.DEV || !host.current) return
    const element = host.current as HTMLDivElement & { __datasetSelection?: GridSelection }
    element.__datasetSelection = selection
    return () => { delete element.__datasetSelection }
  }, [selection])
  const paste = useCallback(([column, row]: Item, values: readonly (readonly string[])[]) => {
    const current = tableRef.current
    if (blocked || !current || !values.length) return false
    const cells: { row: number; column: number; value: string }[] = []
    const inserted: string[][] = []
    let truncated = false
    for (let y = 0; y < values.length; y++) {
      const targetRow = row + y
      if (targetRow >= 10_000) { truncated = true; break }
      const fresh = targetRow >= current.rows.length ? Array(current.header.length).fill("") as string[] : null
      if (fresh && keyColumn >= 0) fresh[keyColumn] = newRowId()
      for (let x = 0; x < values[y].length; x++) {
        const targetColumn = column + x
        if (targetColumn >= current.header.length) { truncated = true; continue }
        if (targetColumn === keyColumn) continue
        if (fresh) fresh[targetColumn] = values[y][x]
        else if (current.rows[targetRow][targetColumn] !== values[y][x]) cells.push({ row: targetRow, column: targetColumn, value: values[y][x] })
      }
      if (fresh) inserted.push(fresh)
    }
    if (truncated) toast.warning("粘贴内容超出表格范围，已截断")
    const ops: DatasetOp[] = []
    if (cells.length) ops.push({ op: "setCells", cells })
    if (inserted.length) ops.push({ op: "insertRows", at: current.rows.length, rows: inserted })
    commit(ops)
    return false
  }, [blocked, commit, keyColumn])
  const clear = useCallback((next: GridSelection) => {
    if (blocked || !next.current || !tableRef.current) return false
    const { x, y, width, height } = next.current.range
    const cells: { row: number; column: number; value: string }[] = []
    for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) {
      if (column !== keyColumn && tableRef.current.rows[row]?.[column]) cells.push({ row, column, value: "" })
    }
    if (cells.length) commit([{ op: "setCells", cells }])
    return false
  }, [blocked, commit, keyColumn])

  const openName = (action: "insert" | "rename", column: number) => {
    setMenu(null); setNameDialog({ action, column }); setName(action === "rename" ? tableRef.current?.header[column] ?? "" : ""); setNameError("")
  }
  const submitName = () => {
    if (!nameDialog || !tableRef.current) return
    const value = name.trim()
    if (!value || tableRef.current.header.some((item, index) => item === value && (nameDialog.action === "insert" || index !== nameDialog.column))) {
      setNameError("列名不能为空且不能重复"); return
    }
    const op: DatasetOp = nameDialog.action === "insert" ? { op: "insertColumn", at: nameDialog.column, name: value } : { op: "renameColumn", column: nameDialog.column, name: value }
    if (commit([op])) setNameDialog(null)
  }
  const deleteColumn = (column: number) => { setMenu(null); commit([{ op: "deleteColumn", column }]) }
  const selectedRows = selection.rows.toArray().filter(row => row < (table?.rows.length ?? 0))
  const appendRow = () => {
    const current = tableRef.current
    if (!current) return
    const row = Array(current.header.length).fill("") as string[]
    if (keyColumn >= 0) row[keyColumn] = newRowId()
    commit([{ op: "insertRows", at: current.rows.length, rows: [row] }])
  }

  return <section ref={host} className="flex h-full min-h-0 min-w-0 flex-col gap-[var(--space-2)] bg-background text-foreground" data-density="compact" aria-label="数据集编辑器"
    onCompositionStartCapture={() => { composing.current = true }} onCompositionEndCapture={() => { composing.current = false }}
    onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void flush() }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !blocked && !(event.target instanceof HTMLElement && event.target.closest("textarea, input, [contenteditable='true']"))) { event.preventDefault(); if (event.shiftKey) doRedo(); else undo() }
    }}>
    <div className="flex shrink-0 flex-wrap items-center gap-[var(--space-2)] px-[var(--space-3)] py-[var(--space-2)]">
      <Button size="sm" variant="outline" disabled={blocked || !selectedRows.length} onClick={() => { commit([{ op: "deleteRows", rows: selectedRows }]); setSelection(emptyGridSelection) }}>删除行</Button>
      <Button size="icon-sm" variant="outline" aria-label="撤销" title="撤销" disabled={blocked || !history.current.length} onClick={undo}><Undo2Icon /></Button>
      <Button size="icon-sm" variant="outline" aria-label="重做" title="重做" disabled={blocked || !redo.current.length} onClick={doRedo}><Redo2Icon /></Button>
      <span className="ml-auto text-[length:var(--text-meta)] text-muted-foreground" role="status" aria-live="polite" data-history-version={historyVersion}>{status}</span>
    </div>
    {snapshot && !snapshot.editable && <div className="mx-[var(--space-3)] rounded-md bg-warning/10 px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-body)]" role="alert">只读：{snapshot.readOnlyReason}</div>}
    {status === "冲突" && <div className="mx-[var(--space-3)] flex items-center gap-[var(--space-2)] rounded-md bg-destructive/10 px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-body)]" role="alert"><span>{problem}</span><Button size="sm" variant="outline" onClick={() => { void load(true) }}>放弃我的修改并载入磁盘版</Button><Button size="sm" variant="outline" onClick={() => { /* Keep the paused queue intact. */ }}>稍后处理</Button></div>}
    {status === "出错" && <div className="mx-[var(--space-3)] flex items-center gap-[var(--space-2)] rounded-md bg-destructive/10 px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-body)]" role="alert"><span>{problem}</span><Button size="sm" variant="outline" onClick={() => { if (snapshotRef.current) { paused.current = false; void drain() } else void load() }}>重试</Button></div>}
    <div className="min-h-0 min-w-0 flex-1" aria-busy={loading}>
      {loading && !table ? <div className="p-[var(--space-4)]" role="status">正在读取数据集…</div> : !table ? <div className="p-[var(--space-4)]">无法打开数据集</div> : metrics && <DataEditor ref={grid} width="100%" height="100%" columns={columns} rows={table.rows.length} getCellContent={getCellContent} getCellsForSelection={true}
        theme={metrics.theme} rowHeight={metrics.rowHeight} headerHeight={metrics.headerHeight} headerIcons={{ lock: ({ bgColor }) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${bgColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>` }}
        rowMarkers={{ kind: "both", width: metrics.headerHeight }} rowSelect="multi" rowSelectionMode="multi" columnSelect="none" rangeSelect="rect" cellActivationBehavior="double-click"
        gridSelection={selection} onGridSelectionChange={setSelection} provideEditor={provideTableTextEditor}
        trailingRowOptions={blocked ? undefined : { hint: "新增行", sticky: false }} onRowAppended={async () => { if (!blocked) appendRow(); return undefined }}
        onCellsEdited={edits => { if (blocked) return true; const cells = edits.flatMap(({ location: [column, row], value }) => value.kind === GridCellKind.Text && column !== keyColumn && tableRef.current?.rows[row]?.[column] !== value.data ? [{ row, column, value: value.data }] : []); if (cells.length) commit([{ op: "setCells", cells }]); return true }}
        onPaste={paste} onDelete={clear} onHeaderMenuClick={(column, bounds: Rectangle) => { if (!blocked) setMenu({ column, anchor: { getBoundingClientRect: () => DOMRect.fromRect(bounds) } }) }}
        smoothScrollX smoothScrollY />}
    </div>
    <DropdownMenu open={!!menu} onOpenChange={open => { if (!open) setMenu(null) }}>
      <DropdownMenuTrigger className="sr-only" aria-label="列操作" />
      {menu && <DropdownMenuContent anchor={menu.anchor}>
        <DropdownMenuItem onClick={() => openName("insert", menu.column)}>在左侧插入列</DropdownMenuItem>
        <DropdownMenuItem onClick={() => openName("insert", menu.column + 1)}>在右侧插入列</DropdownMenuItem>
        <DropdownMenuItem disabled={menu.column === keyColumn} onClick={() => openName("rename", menu.column)}>重命名</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" disabled={menu.column === keyColumn || table?.header.length === 1} onClick={() => deleteColumn(menu.column)}>删除列</DropdownMenuItem>
      </DropdownMenuContent>}
    </DropdownMenu>
    <Dialog open={!!nameDialog} onOpenChange={open => { if (!open) setNameDialog(null) }}><DialogContent>
      <DialogHeader><DialogTitle>{nameDialog?.action === "rename" ? "重命名列" : "插入列"}</DialogTitle></DialogHeader>
      <Input aria-label="列名" value={name} onChange={event => { setName(event.target.value); setNameError("") }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); submitName() } }} />
      {nameError && <p className="text-destructive" role="alert">{nameError}</p>}
      <DialogFooter><Button variant="outline" onClick={() => setNameDialog(null)}>取消</Button><Button onClick={submitName}>确定</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>
})
