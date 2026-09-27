import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react"
import { toast } from "sonner"

import { ZenSurface } from "@/components/shard/zen-surface"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { getApiErrorMessage, openCsvFile } from "@/lib/api"
import { DatasetEditor, type DatasetEditorHandle } from "./dataset-editor"
import type { DatasetSnapshot } from "./types"

export type DatasetZenHandle = DatasetEditorHandle & { focus(): void }

export const DatasetZen = forwardRef<DatasetZenHandle, { path: string; onClose(): void }>(function DatasetZen({ path, onClose }, ref) {
  const editor = useRef<DatasetEditorHandle>(null)
  const surface = useRef<HTMLDivElement>(null)
  const [title, setTitle] = useState(path.split("/").pop() ?? path)
  const [confirmClose, setConfirmClose] = useState(false)
  const [busy, setBusy] = useState(false)
  const onSnapshot = useCallback((snapshot: DatasetSnapshot) => {
    setTitle(snapshot.schema?.title || snapshot.path.split("/").pop() || snapshot.path)
  }, [])

  const flush = useCallback(async () => (await editor.current?.flush()) ?? true, [])
  useImperativeHandle(ref, () => ({ flush, isDirty: () => editor.current?.isDirty() ?? false, focus: () => surface.current?.focus() }), [flush])

  const requestClose = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      if (await flush()) onClose()
      else setConfirmClose(true)
    } finally {
      setBusy(false)
    }
  }, [busy, flush, onClose])

  const openExternal = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (!await flush()) { toast.error("数据集尚未保存，请先处理保存问题"); return }
      await openCsvFile(path)
      toast("返回 Shard 时会重新载入")
    } catch (error) {
      toast.error(`打开 CSV 失败：${getApiErrorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return <ZenSurface ariaLabel="数据集禅模式" onRequestClose={() => { void requestClose() }}>
    <div ref={surface} tabIndex={-1} className="flex h-full min-h-0 min-w-0 flex-col" data-dataset-path={path}
      onKeyDownCapture={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing && !confirmClose) { event.preventDefault(); event.stopPropagation(); void requestClose() } }}>
      <header className="flex shrink-0 items-center gap-[var(--space-3)] border-b border-border px-[var(--space-4)] py-[var(--space-2)]" data-density="compact">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[length:var(--text-body)] font-semibold">{title}</div>
          <div className="truncate text-[length:var(--text-meta)] text-muted-foreground" title={path}>{path}</div>
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void openExternal() }}>用默认程序打开</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void requestClose() }}>关闭</Button>
      </header>
      <div className="min-h-0 min-w-0 flex-1"><DatasetEditor ref={editor} path={path} onSnapshot={onSnapshot} /></div>
    </div>
    <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
      <DialogContent role="alertdialog">
        <DialogHeader><DialogTitle>仍有未保存的修改，确定关闭？</DialogTitle><DialogDescription>关闭后，未保存的修改会丢失。</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" onClick={() => setConfirmClose(false)}>继续编辑</Button><Button variant="destructive" onClick={onClose}>仍然关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </ZenSurface>
})
