import { useEffect, useRef, useState, type ReactNode } from "react"
import { open, save } from "@tauri-apps/plugin-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { SelectControl } from "@/components/ui/select"
import { createTable, tableError, type CreateTableRequest } from "./api"
import { TableExchangeClient } from "./exchange-client"
import type { ExchangeExport, ExchangePreview, ExchangeValidation } from "./exchange-protocol"
import type { TableImportMapping } from "./exchange"
import { createTableId, TABLE_LIMITS, type FieldType, type TableContent, type TableFile, type TableReadResult } from "./model"
import { inspectTableXlsx, prepareTableXlsxExport, previewTableXlsx, readTableExchangeFile, writeTableExchangeFile, type XlsxPreview } from "./xlsx-api"
import type { CsvEncoding } from "@/lib/csv"
import { libraryNameError } from "@/lib/library-entry"
import "./exchange-dialog.css"

const fieldTypes: { value: FieldType; label: string }[] = [
  { value: "text", label: "文本" }, { value: "number", label: "数值" }, { value: "date", label: "日期" },
  { value: "select", label: "单选" }, { value: "multiSelect", label: "多选" }, { value: "checkbox", label: "复选框" },
]
function errorMessage(error: unknown) { return tableError(error).message }
function Check({ checked, onChange, disabled, children }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; children: ReactNode }) {
  return <label className="table-exchange-check"><Checkbox checked={checked} disabled={disabled} onCheckedChange={checked => onChange(checked === true)} />{children}</label>
}
function useExchangeClient() {
  const client = useRef<TableExchangeClient | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; client.current = new TableExchangeClient(); return () => { alive.current = false; client.current?.dispose(); client.current = null } }, [])
  return { client, alive }
}

export type TableImportDialogProps = { parentPath: string; initialPath?: string; onCreated: (result: TableReadResult) => void | Promise<void>; onClose: () => void }
export function TableImportDialog({ parentPath, initialPath, onCreated, onClose }: TableImportDialogProps) {
  const { client, alive } = useExchangeClient()
  const [busy, setBusy] = useState<"read" | "validate" | "create" | null>(null)
  const [error, setError] = useState("")
  const [path, setPath] = useState("")
  const [name, setName] = useState("")
  const [preview, setPreview] = useState<ExchangePreview | null>(null)
  const [mappings, setMappings] = useState<TableImportMapping[]>([])
  const [header, setHeader] = useState(true)
  const [encoding, setEncoding] = useState<"auto" | CsvEncoding>("auto")
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [sheetIndex, setSheetIndex] = useState(0)
  const [errorsAsText, setErrorsAsText] = useState(false)
  const [acknowledgeWarnings, setAcknowledgeWarnings] = useState(false)
  const [validation, setValidation] = useState<ExchangeValidation | null>(null)
  const [frozen, setFrozen] = useState(false)
  const frozenRequest = useRef<CreateTableRequest | null>(null)
  const created = useRef<TableReadResult | null>(null)
  const readGeneration = useRef(0)
  const source = useRef<{ type: "csv" | "native"; bytes: Uint8Array } | { type: "xlsx"; preview: XlsxPreview } | null>(null)
  const blocked = busy !== null || frozen

  useEffect(() => {
    // StrictMode replays effects; cancel the first scheduled read before it reaches disk.
    let cancelled = false
    queueMicrotask(() => { if (!cancelled && initialPath) void chooseFile(initialPath) })
    return () => { cancelled = true; readGeneration.current++ }
  }, [initialPath])

  function acceptPreview(next: ExchangePreview) {
    setPreview(next); setMappings(next.mappings); setValidation(null); setError(""); setErrorsAsText(false); setAcknowledgeWarnings(false)
  }
  async function chooseFile(initialSelection?: string) {
    const generation = ++readGeneration.current
    const current = () => alive.current && generation === readGeneration.current
    setBusy("read"); setError("")
    try {
      const selected = initialSelection ?? await open({ title: "导入多维表格", multiple: false, directory: false, filters: [{ name: "多维表格", extensions: ["csv", "xlsx", "json"] }] })
      if (!selected || !current() || !client.current) return
      const fileName = selected.split(/[\\/]/u).pop() ?? "多维表格"
      const lower = fileName.toLowerCase()
      if (!lower.endsWith(".csv") && !lower.endsWith(".xlsx") && !lower.endsWith(".shardtable.json")) throw new Error("请选择 CSV、XLSX 或 .shardtable.json 文件")
      // Clear the old preview before an asynchronous load can fail; it must not be submitted under the new name.
      source.current = null; setPreview(null); setValidation(null); setMappings([]); setSheetNames([])
      setPath(selected); setName(fileName.replace(/(?:\.shardtable\.json|\.xlsx|\.csv)$/iu, "")); setHeader(true); setEncoding("auto"); setSheetIndex(0)
      if (lower.endsWith(".xlsx")) {
        const info = await inspectTableXlsx(selected)
        if (!current() || !client.current) return
        if (!info.sheetNames.length) throw new Error("工作簿中没有可导入的工作表")
        const data = await previewTableXlsx(selected, 0)
        if (!current() || !client.current) return
        source.current = { type: "xlsx", preview: data }; setSheetNames(info.sheetNames)
        const next = await client.current.request<ExchangePreview>({ type: "loadXlsx", preview: data, hasHeader: true })
        if (current()) acceptPreview(next)
      } else {
        const bytes = await readTableExchangeFile(selected)
        if (!current() || !client.current) return
        const type = lower.endsWith(".csv") ? "csv" : "native"
        source.current = { type, bytes }
        const next = await client.current.request<ExchangePreview>(type === "csv" ? { type: "loadCsv", bytes, hasHeader: true, encoding: "auto" } : { type: "loadNative", bytes })
        if (current()) acceptPreview(next)
      }
    } catch (error) { if (current()) setError(errorMessage(error)) }
    finally { if (current()) setBusy(null) }
  }
  async function configure(nextHeader: boolean, nextEncoding: "auto" | CsvEncoding, nextSheet = sheetIndex) {
    if (!source.current || !client.current) return
    setBusy("read"); setError(""); setValidation(null); setPreview(null)
    setHeader(nextHeader); setEncoding(nextEncoding); setSheetIndex(nextSheet)
    try {
      let next: ExchangePreview
      if (source.current.type === "xlsx") {
        const data = nextSheet === source.current.preview.sheetIndex ? source.current.preview : await previewTableXlsx(path, nextSheet)
        if (!alive.current || !client.current) return
        source.current = { type: "xlsx", preview: data }
        next = await client.current.request({ type: "loadXlsx", preview: data, hasHeader: nextHeader })
      } else if (source.current.type === "csv") next = await client.current.request({ type: "loadCsv", bytes: source.current.bytes, hasHeader: nextHeader, encoding: nextEncoding })
      else return
      if (alive.current) acceptPreview(next)
    } catch (error) { if (alive.current) setError(errorMessage(error)) }
    finally { if (alive.current) setBusy(null) }
  }
  function changeMapping(index: number, change: Partial<TableImportMapping>) {
    setMappings(current => current.map((mapping, position) => position === index ? { ...mapping, ...change } : mapping)); setValidation(null)
  }
  async function validate() {
    if (!client.current) return
    setBusy("validate"); setError(""); setValidation(null)
    try {
      const result = await client.current.request<ExchangeValidation>({ type: "validate", mappings, errorsAsText, acknowledgeWarnings })
      if (alive.current) setValidation(result)
    } catch (error) { if (alive.current) setError(errorMessage(error)) }
    finally { if (alive.current) setBusy(null) }
  }
  async function create() {
    if (!client.current) return
    setBusy("create"); setError("")
    try {
      if (!frozenRequest.current) {
        const title = name.trim()
        if (!title || title === "." || title === "..") throw new Error("名称不能为空。")
        if (/[\p{Cc}/\\:*?"<>|]/u.test(title)) throw new Error("名称包含不允许的路径字符。")
        const nameError = libraryNameError(title, ".shardtable.json")
        if (nameError) throw new Error(nameError)
        const content = await client.current.request<TableContent>({ type: "content" })
        frozenRequest.current = { requestId: createTableId("req"), tableId: createTableId("tbl"), parentPath, suggestedName: title, content }
        setFrozen(true)
      }
      // A transport failure retains the same IDs and payload. create_table resolves an earlier successful write before retrying.
      created.current ??= await createTable(frozenRequest.current)
      await onCreated(created.current)
      onClose()
    } catch (error) { if (alive.current) setError(errorMessage(error)) }
    finally { if (alive.current) setBusy(null) }
  }
  const hasSourceWarnings = !!preview?.sourceHasWarnings
  const hasSourceErrors = !!preview?.sourceHasErrors
  return <Dialog open onOpenChange={open => { if (!open && busy !== "create") onClose() }}>
    <DialogContent className="table-exchange-dialog" showCloseButton={busy !== "create"} aria-busy={busy !== null}>
      <DialogHeader><DialogTitle>导入多维表格</DialogTitle><DialogDescription>创建新表，源文件保持原样。</DialogDescription></DialogHeader>
      <div className="table-exchange-body">
        <div className="table-exchange-file-row"><Button variant="outline" onClick={() => void chooseFile()} disabled={blocked}>{path ? "重新选择文件" : "选择文件"}</Button><span className="table-exchange-path" title={path}>{path ? path.split(/[\\/]/u).pop() : "CSV、XLSX、原生多维表格"}</span></div>
        {path && <label className="table-exchange-field">多维表格名称<Input value={name} onChange={event => setName(event.target.value)} disabled={blocked} /></label>}
        {source.current && source.current.type !== "native" && <div className="table-exchange-source-controls">
          <Check checked={header} onChange={value => void configure(value, encoding)} disabled={blocked}>首行是字段名</Check>
          {source.current.type === "csv" ? <label className="table-exchange-field">编码<SelectControl aria-label="编码" value={encoding} onValueChange={value => void configure(header, value as "auto" | CsvEncoding)} disabled={blocked} options={[{ value: "auto", label: `自动识别${preview?.encoding ? `（${preview.encoding}）` : ""}` }, { value: "utf-8", label: "UTF-8" }, { value: "utf-16le", label: "UTF-16 LE" }, { value: "utf-16be", label: "UTF-16 BE" }, { value: "gbk", label: "GBK" }]} /></label>
            : <label className="table-exchange-field">工作表<SelectControl aria-label="工作表" value={String(sheetIndex)} onValueChange={value => void configure(header, encoding, Number(value))} disabled={blocked} options={sheetNames.map((sheet, index) => ({ value: String(index), label: sheet }))} /></label>}
        </div>}
        {busy === "read" && <p role="status">正在读取并解析文件…</p>}
        {preview && <>
          <p className="table-exchange-meta">{preview.rowCount.toLocaleString()} 条记录 · {preview.columns.length} 个来源字段{preview.format === "native" ? " · 以副本导入，保留字段与视图" : ""}</p>
          {preview.format !== "native" && <>
            <div className="table-exchange-section-row"><span>字段映射</span><Button variant="outline" size="sm" disabled={blocked || !preview.columns.length || mappings.length >= TABLE_LIMITS.fields} onClick={() => { setMappings(current => [...current, { sourceColumn: 0, name: preview.columns[0].name, type: "text" }]); setValidation(null) }}>添加目标字段</Button></div>
            <div className="table-exchange-mapping-viewport"><table className="table-exchange-mapping"><thead><tr><th>来源列</th><th>目标字段</th><th>类型</th><th>首个值</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{mappings.map((mapping, index) => <tr key={index}>
              <td><SelectControl aria-label={`字段 ${index + 1} 来源列`} value={String(mapping.sourceColumn)} disabled={blocked} onValueChange={value => changeMapping(index, { sourceColumn: Number(value) })} options={preview.columns.map(column => ({ value: String(column.sourceColumn), label: `${column.sourceColumn + 1}. ${column.name}` }))} /></td>
              <td><Input aria-label={`字段 ${index + 1} 名称`} value={mapping.name ?? ""} maxLength={TABLE_LIMITS.name} disabled={blocked} onChange={event => changeMapping(index, { name: event.target.value })} /></td>
              <td><SelectControl aria-label={`字段 ${index + 1} 类型`} value={mapping.type} disabled={blocked} onValueChange={value => changeMapping(index, { type: value as FieldType })} options={fieldTypes} /></td>
              <td className="table-exchange-sample" title={preview.rows[0]?.[mapping.sourceColumn] ?? "空值"}>{preview.rows[0]?.[mapping.sourceColumn] ?? "空值"}</td>
              <td><Button variant="outline" size="sm" disabled={blocked} aria-label={`移除目标字段 ${index + 1}`} onClick={() => { setMappings(current => current.filter((_, position) => position !== index)); setValidation(null) }}>移除</Button></td>
            </tr>)}</tbody></table></div>
            <p className="table-exchange-help">同一来源列可添加多个目标。首个文本字段用作名称；没有文本字段时会新增“名称”。多选值使用标签数组，例如 ["甲","乙"]。</p>
          </>}
          {preview.sourceIssueCount > 0 && <div className="table-exchange-source-issues"><p>{preview.sourceIssueCount} 项工作表提示{preview.sourceIssueCount > preview.sourceIssues.length ? "（显示前 100 项）" : ""}</p><ul>{preview.sourceIssues.map((issue, index) => <li key={index}>{issue.row !== null ? `第 ${issue.row + 1} 行${issue.column !== null ? `，第 ${issue.column + 1} 列` : ""}：` : ""}{issue.message}</li>)}</ul></div>}
          {hasSourceWarnings && <Check checked={acknowledgeWarnings} onChange={value => { setAcknowledgeWarnings(value); setValidation(null) }} disabled={blocked}>已确认提示：使用缓存值，不保留公式、显示格式和合并关系</Check>}
          {hasSourceErrors && <Check checked={errorsAsText} onChange={value => { setErrorsAsText(value); setValidation(null) }} disabled={blocked}>按文本保留异常值（相关目标均须设为文本；保存原始值或公式文本）</Check>}
        </>}
        {validation && <div role={validation.valid ? "status" : "alert"} className={validation.valid ? "table-exchange-success" : "table-exchange-error"}>
          {validation.valid ? `校验通过：${validation.rowCount.toLocaleString()} 条记录，${validation.fieldCount} 个字段。` : <><p>{validation.issueCount} 项问题，调整映射后重新校验{validation.issueCount > validation.issues.length ? "（显示前 100 项）" : ""}。</p><ul>{validation.issues.map((issue, index) => <li key={index}>{issue.sourceRow !== null ? `第 ${issue.sourceRow} 行，` : ""}{issue.sourceColumn ? `第 ${issue.sourceColumn} 列：` : ""}{issue.message}</li>)}</ul></>}
        </div>}
        {error && <p role="alert" className="table-exchange-error">{error}</p>}
        {frozen && error && <p className="table-exchange-help">重试会核对同一次导入，避免重复创建。若关闭此窗口，已成功创建的文件会保留在资料库。</p>}
      </div>
      <DialogFooter className="table-exchange-footer"><Button variant="outline" onClick={onClose} disabled={busy === "create"}>取消</Button>
        {!frozen && <Button variant="outline" onClick={() => void validate()} disabled={busy !== null || !preview}>{busy === "validate" ? "正在校验…" : "校验全部记录"}</Button>}
        <Button onClick={() => void create()} disabled={busy !== null || !name.trim() || (!frozen && !validation?.valid)}>{busy === "create" ? "正在创建…" : created.current ? "打开已创建的多维表格" : frozen ? "核对并重试" : "创建多维表格"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export type TableExportDialogProps = { getFile: () => Promise<TableFile>; currentViewId?: string; suggestedName: string; onClose: () => void }
export function TableExportDialog({ getFile, currentViewId, suggestedName, onClose }: TableExportDialogProps) {
  const { client, alive } = useExchangeClient()
  const [format, setFormat] = useState<"csv" | "xlsx" | "native">("csv")
  const [scope, setScope] = useState<"all" | "view">("all")
  const [mode, setMode] = useState<"safe" | "raw">("safe")
  const [busy, setBusy] = useState(false)
  const [writing, setWriting] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState("")
  async function exportFile() {
    if (!client.current) return
    setBusy(true); setError(""); setResult("")
    try {
      const file = await getFile()
      if (!alive.current || !client.current) return
      const data = await client.current.request<ExchangeExport>({ type: "export", file, format, scope: scope === "view" && currentViewId ? { type: "view", viewId: currentViewId } : { type: "all" }, mode })
      if (!alive.current) return
      const bytes = data.type === "xlsx" ? await prepareTableXlsxExport(data.bytes) : data.bytes
      if (!alive.current) return
      const extension = format === "native" ? "shardtable.json" : format
      const chosen = await save({ title: "导出多维表格", defaultPath: `${suggestedName.replace(/(?:\.shardtable\.json|\.csv|\.xlsx)$/iu, "")}.${extension}`, filters: [{ name: format === "native" ? "Shard 原生多维表格" : format.toUpperCase(), extensions: [extension] }] })
      if (!chosen || !alive.current) return
      setWriting(true)
      await writeTableExchangeFile(chosen, bytes)
      if (alive.current) setResult(`已导出 ${data.recordCount.toLocaleString()} 条记录、${data.fieldCount} 个字段${data.escapedCells ? `；${data.escapedCells} 个公式样文本已加前缀` : ""}。`)
    } catch (error) { if (alive.current) setError(errorMessage(error)) }
    finally { if (alive.current) { setBusy(false); setWriting(false) } }
  }
  return <Dialog open onOpenChange={open => { if (!open && !writing) onClose() }}>
    <DialogContent className="table-exchange-export-dialog" showCloseButton={!writing} aria-busy={busy}>
      <DialogHeader><DialogTitle>导出多维表格</DialogTitle><DialogDescription>CSV 和 XLSX 导出数据值；原生备份保留完整数据与视图。</DialogDescription></DialogHeader>
      <div className="table-exchange-export-body">
        <label className="table-exchange-field">格式<SelectControl aria-label="格式" value={format} disabled={busy} onValueChange={value => { setFormat(value as typeof format); setResult("") }} options={[{ value: "csv", label: "CSV" }, { value: "xlsx", label: "XLSX" }, { value: "native", label: "原生备份（.shardtable.json）" }]} /></label>
        {format !== "native" && <label className="table-exchange-field">范围<SelectControl aria-label="范围" value={scope} disabled={busy} onValueChange={value => setScope(value as typeof scope)} options={[{ value: "all", label: "全部记录与字段" }, ...(currentViewId ? [{ value: "view", label: "当前视图（筛选、排序及可见字段）" }] : [])]} /></label>}
        {format !== "native" && scope === "view" && <p className="table-exchange-help">导出所有符合视图条件的记录，不受当前显示页限制。</p>}
        {format === "csv" && <label className="table-exchange-field">文本处理<SelectControl aria-label="文本处理" value={mode} disabled={busy} onValueChange={value => setMode(value as typeof mode)} options={[{ value: "safe", label: "电子表格安全导出（默认）" }, { value: "raw", label: "原值导出" }]} /></label>}
        {format === "csv" && <p className="table-exchange-help">{mode === "safe" ? "可能被识别为公式的文本会添加单引号前缀，再次导入时会保留此前缀。CSV 无法区分空文本与空值。" : "按原值导出；Excel 等软件可能将以 =、+、-、@ 开头的文本作为公式执行。CSV 无法区分空文本与空值。"}</p>}
        {format === "xlsx" && <p className="table-exchange-help">保留文本、数值、日期和复选框类型；单选导出标签，多选导出标签数组。</p>}
        {format === "native" && <p className="table-exchange-help">备份包含全部记录及视图。重新导入时会创建一个独立副本。</p>}
        {busy && <p role="status">{writing ? "正在写入文件…" : "正在准备导出…"}</p>}
        {error && <p role="alert" className="table-exchange-error">{error}</p>}
        {result && <p role="status" className="table-exchange-success">{result}</p>}
      </div>
      <DialogFooter className="table-exchange-footer"><Button variant="outline" disabled={writing} onClick={onClose}>关闭</Button><Button onClick={() => void exportFile()} disabled={busy}>{busy ? "正在导出…" : "选择保存位置"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
