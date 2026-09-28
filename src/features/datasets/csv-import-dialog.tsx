import { useEffect, useState } from "react"
import { notify } from "@/lib/notify"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { parseCsvBytesInWorker } from "@/lib/csv-worker"
import type { CsvDocument } from "@/lib/csv"
import { getApiErrorMessage } from "@/lib/api"
import { createDataset } from "./api"
import { newRowId } from "./ops"

type ImportFile = { name: string; bytes: Uint8Array }

export function CsvImportDialog({ file, allowed, onClose, onImported }: {
  file: ImportFile | null
  allowed: boolean
  onClose: () => void
  onImported: (path: string) => void
}) {
  const [document, setDocument] = useState<CsvDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addId, setAddId] = useState(true)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!file) return
    let active = true
    setDocument(null)
    setError(null)
    setAddId(true)
    if (file.bytes.length > 128 * 1024 * 1024) {
      setError("LIMIT_EXCEEDED:CSV 文件超过导入上限")
      return
    }
    void parseCsvBytesInWorker(file.bytes, true).then((parsed) => {
      if (active) setDocument(parsed)
    }).catch((cause) => { if (active) setError(getApiErrorMessage(cause)) })
    return () => { active = false }
  }, [file])

  const header = document?.records[0] ?? []
  const rows = document?.records.slice(1) ?? []
  const hasId = header.includes("id")
  const inspection = document?.importInspection
  const validId = inspection?.idValid ?? true
  const reason = !allowed ? "私密碎片不支持数据集" : error ?? (inspection ? inspection.headerInvalid ? "表头名称不能为空且不能重复" : inspection.ragged ? "CSV 每行列数必须与表头一致" : addId && !hasId ? inspection.withIdLimit : inspection.baseLimit : null)
  const selectedKey = addId && (!hasId || validId)

  async function submit() {
    if (!file || !document || reason || creating) return
    setCreating(true)
    try {
      const title = file.name.replace(/\.csv$/iu, "") || "数据集"
      const outputHeader = selectedKey && !hasId ? ["id", ...header] : header
      const outputRows = selectedKey && !hasId ? rows.map((row) => [newRowId(), ...row]) : rows
      const snapshot = await createDataset(title, outputHeader, outputRows, selectedKey ? "id" : undefined)
      onImported(snapshot.path)
      onClose()
    } catch (cause) {
      notify.failure("导入失败", cause)
    } finally {
      setCreating(false)
    }
  }

  return <Dialog open={file !== null} onOpenChange={(open) => { if (!open && !creating) onClose() }}>
    <DialogContent className="sm:max-w-2xl" aria-busy={creating || Boolean(file && !document && !error)}>
      <DialogHeader><DialogTitle>导入 CSV 为数据集</DialogTitle></DialogHeader>
      <div className="min-h-0 space-y-3 overflow-y-auto pr-2 text-[length:var(--text-body)]">
        <p className="text-muted-foreground">{file?.name} · 编码：{document?.encoding.toUpperCase() ?? "识别中…"} · {document ? `${rows.length} 行 · ${header.length} 列` : ""}</p>
        {reason ? <p role="alert" className="text-destructive">{reason}</p> : null}
        {document ? <div className="max-h-72 overflow-auto rounded-[var(--shard-surface-radius)] border border-border">
          <table className="w-full border-collapse text-left">
            <thead><tr>{header.map((name, index) => <th className="sticky top-0 bg-muted px-2 py-1 text-[length:var(--text-meta)]" key={index}>{name}</th>)}</tr></thead>
            <tbody>{rows.slice(0, 20).map((row, index) => <tr key={index}>{row.map((value, column) => <td className="border-t border-border px-2 py-1" key={column}>{value}</td>)}</tr>)}</tbody>
          </table>
        </div> : null}
        {document ? <label className="flex items-center gap-2">
          <Checkbox checked={selectedKey} disabled={creating || (hasId && !validId)} onCheckedChange={(checked) => setAddId(checked === true)} />
          {hasId ? "用 id 列作为主键" : "添加稳定 ID 列（推荐）"}
        </label> : null}
        {hasId && !validId ? <p className="text-destructive">id 列含空值或重复值，不能用作主键。</p> : null}
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={creating} onClick={onClose}>取消</Button>
        <Button disabled={!document || Boolean(reason) || creating} onClick={() => void submit()}>{creating ? "导入中…" : "导入"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
