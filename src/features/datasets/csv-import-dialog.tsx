import { useEffect, useState } from "react"
import { notify } from "@/lib/notify"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { parseCsvBytesInWorker } from "@/lib/csv-worker"
import { inspectCsvImport, type CsvImportInspection } from "@/lib/csv"
import { getApiErrorMessage } from "@/lib/api"
import { createDataset, type XlsxRecords } from "./api"
import { newRowId } from "./ops"

/** CSV 交原始字节（编码在 worker 里识别）；Excel 由 Rust 读成字符串矩阵后传入。 */
export type DatasetImportFile =
  | { name: string; bytes: Uint8Array }
  | { name: string; workbook: XlsxRecords }

/** 自定义落盘方式（如资料库同时生成说明文档）；返回数据集路径。 */
export type DatasetImportCreate = (title: string, header: string[], rows: string[][], primaryKey?: string) => Promise<string>

type ParsedImport = { records: string[][]; inspection: CsvImportInspection; source: string; warnings: string[] }

export function CsvImportDialog({ file, allowed, onClose, onImported, onCreate }: {
  file: DatasetImportFile | null
  allowed: boolean
  onClose: () => void
  onImported: (path: string) => void
  onCreate?: DatasetImportCreate
}) {
  const [parsed, setParsed] = useState<ParsedImport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addId, setAddId] = useState(true)
  const [creating, setCreating] = useState(false)
  const excel = file !== null && "workbook" in file

  useEffect(() => {
    if (!file) return
    let active = true
    setParsed(null)
    setError(null)
    setAddId(true)
    if ("workbook" in file) {
      const { records, sheetName, sheetCount, warnings } = file.workbook
      setParsed({
        records,
        inspection: inspectCsvImport(records),
        source: sheetCount > 1 ? `工作表：${sheetName}（共 ${sheetCount} 个，只导入第一个）` : `工作表：${sheetName}`,
        warnings,
      })
      return
    }
    if (file.bytes.length > 128 * 1024 * 1024) {
      setError("LIMIT_EXCEEDED:CSV 文件超过导入上限")
      return
    }
    void parseCsvBytesInWorker(file.bytes, true).then((document) => {
      if (active) setParsed({ records: document.records, inspection: document.importInspection!, source: `编码：${document.encoding.toUpperCase()}`, warnings: [] })
    }).catch((cause) => { if (active) setError(getApiErrorMessage(cause)) })
    return () => { active = false }
  }, [file])

  const header = parsed?.records[0] ?? []
  const rows = parsed?.records.slice(1) ?? []
  const hasId = header.includes("id")
  const inspection = parsed?.inspection
  const validId = inspection?.idValid ?? true
  const kindLabel = excel ? "Excel" : "CSV"
  const reason = !allowed ? "私密碎片不支持数据集" : error ?? (inspection ? inspection.headerInvalid ? "表头名称不能为空且不能重复" : inspection.ragged ? `${kindLabel} 每行列数必须与表头一致` : addId && !hasId ? inspection.withIdLimit : inspection.baseLimit : null)
  const selectedKey = addId && (!hasId || validId)

  async function submit() {
    if (!file || !parsed || reason || creating) return
    setCreating(true)
    try {
      const title = file.name.replace(/\.(?:csv|xlsx)$/iu, "") || "数据集"
      const outputHeader = selectedKey && !hasId ? ["id", ...header] : header
      const outputRows = selectedKey && !hasId ? rows.map((row) => [newRowId(), ...row]) : rows
      const primaryKey = selectedKey ? "id" : undefined
      const path = onCreate
        ? await onCreate(title, outputHeader, outputRows, primaryKey)
        : (await createDataset(title, outputHeader, outputRows, primaryKey)).path
      onImported(path)
      onClose()
    } catch (cause) {
      notify.failure("导入失败", cause)
    } finally {
      setCreating(false)
    }
  }

  return <Dialog open={file !== null} onOpenChange={(open) => { if (!open && !creating) onClose() }}>
    <DialogContent className="sm:max-w-2xl" aria-busy={creating || Boolean(file && !parsed && !error)}>
      <DialogHeader><DialogTitle>导入 {kindLabel} 为数据集</DialogTitle></DialogHeader>
      <div className="min-h-0 space-y-3 overflow-y-auto pr-2 text-[length:var(--text-body)]">
        <p className="text-muted-foreground">{file?.name} · {parsed?.source ?? "识别中…"} · {parsed ? `${rows.length} 行 · ${header.length} 列` : ""}</p>
        {reason ? <p role="alert" className="text-destructive">{reason}</p> : null}
        {parsed?.warnings.length ? <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {parsed.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul> : null}
        {parsed ? <div className="max-h-72 overflow-auto rounded-[var(--shard-surface-radius)] border border-border">
          <table className="w-full border-collapse text-left">
            <thead><tr>{header.map((name, index) => <th className="sticky top-0 bg-muted px-2 py-1 text-[length:var(--text-meta)]" key={index}>{name}</th>)}</tr></thead>
            <tbody>{rows.slice(0, 20).map((row, index) => <tr key={index}>{row.map((value, column) => <td className="border-t border-border px-2 py-1" key={column}>{value}</td>)}</tr>)}</tbody>
          </table>
        </div> : null}
        {parsed ? <label className="flex items-center gap-2">
          <Checkbox checked={selectedKey} disabled={creating || (hasId && !validId)} onCheckedChange={(checked) => setAddId(checked === true)} />
          {hasId ? "用 id 列作为主键" : "添加稳定 ID 列（推荐）"}
        </label> : null}
        {hasId && !validId ? <p className="text-destructive">id 列含空值或重复值，不能用作主键。</p> : null}
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={creating} onClick={onClose}>取消</Button>
        <Button disabled={!parsed || Boolean(reason) || creating} onClick={() => void submit()}>{creating ? "导入中…" : "导入"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
