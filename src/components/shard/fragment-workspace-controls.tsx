import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Trash2Icon, XIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SelectControl } from "@/components/ui/select"
import { emptyTrash, getApiErrorMessage, purgeFromTrash, restoreFromTrash } from "@/lib/api"
import { isTypeTag } from "@/lib/content-kind"
import { notify } from "@/lib/notify"
import { libraryDirectoryOptions, type FragmentFilters } from "@/lib/fragment-space"
import type { Fragment, LibraryMutationResult, LibraryTreeEntry } from "@/types"

/** The home stream has no filter chrome until the user applies a condition. */
export function FragmentFilterContext({ filters, onClear }: {
  filters: FragmentFilters
  onClear: () => void
}) {
  const labels = [filters.tag ? `#${filters.tag}` : null, filters.month, filters.pinned ? "只看置顶" : null].filter(Boolean)
  if (!labels.length) return null
  return <div className="shard-content-inset shrink-0 pb-2" role="region" aria-label="当前碎片筛选">
    <div className="shard-content-measure flex items-center gap-2 text-[length:var(--text-meta)] text-muted-foreground">
      <span className="min-w-0 truncate" title={labels.join(" · ")}>{labels.join(" · ")}</span>
      <Button size="icon-sm" variant="ghost" aria-label="清除筛选" onClick={onClear}><XIcon aria-hidden="true" /></Button>
    </div>
  </div>
}

export function FragmentFilterDialog({ open, fragments, filters, onClose, onApply }: {
  open: boolean
  fragments: Fragment[]
  filters: FragmentFilters
  onClose: () => void
  onApply: (filters: FragmentFilters) => void
}) {
  const [draft, setDraft] = useState(filters)
  useEffect(() => { if (open) setDraft(filters) }, [open, filters])
  const tags = useMemo(() => [...new Set(fragments.flatMap(fragment => fragment.tags))]
    .filter(tag => tag !== "inbox" && !isTypeTag(tag)).sort((a, b) => a.localeCompare(b)), [fragments])
  const months = useMemo(() => [...new Set(fragments.map(fragment => fragment.createdAt.slice(0, 7)))].sort().reverse(), [fragments])
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>筛选碎片</DialogTitle>
        <DialogDescription>按标签、记录时间和置顶状态查看碎片。</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-[var(--field-rhythm)]">
        <label className="flex flex-col gap-2 text-[length:var(--text-body)]" htmlFor="filter-fragment-tag">
          标签
          <SelectControl id="filter-fragment-tag" aria-label="标签" value={draft.tag ?? ""}
            options={[{ value: "", label: "全部标签" }, ...tags.map(tag => ({ value: tag, label: `#${tag}` }))]}
            onValueChange={tag => setDraft(current => ({ ...current, tag: tag || null }))} />
        </label>
        <label className="flex flex-col gap-2 text-[length:var(--text-body)]" htmlFor="filter-fragment-month">
          时间
          <SelectControl id="filter-fragment-month" aria-label="时间" value={draft.month ?? ""}
            options={[{ value: "", label: "全部时间" }, ...months.map(month => ({ value: month, label: month }))]}
            onValueChange={month => setDraft(current => ({ ...current, month: month || null }))} />
        </label>
        <label className="flex items-center gap-2 text-[length:var(--text-body)]">
          <Checkbox checked={draft.pinned} onCheckedChange={pinned => setDraft(current => ({ ...current, pinned: pinned === true }))} />
          只看置顶
        </label>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button onClick={() => onApply(draft)}>查看碎片</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export function ConvertFragmentDialog({ open, title, directory, entries, busy, needsVerification, error, onTitleChange, onDirectoryChange, onClose, onSubmit }: {
  open: boolean
  title: string
  directory: string
  entries: LibraryTreeEntry[]
  busy: boolean
  needsVerification: boolean
  error: string | null
  onTitleChange: (value: string) => void
  onDirectoryChange: (value: string) => void
  onClose: () => void
  onSubmit: () => void
}) {
  const options = useMemo(() => libraryDirectoryOptions(entries), [entries])
  const locked = busy || needsVerification
  return <Dialog open={open} onOpenChange={next => { if (!next && !locked) onClose() }} disablePointerDismissal={locked}>
    <DialogContent aria-busy={busy} showCloseButton={!locked}>
      <DialogHeader>
        <DialogTitle>转为文档</DialogTitle>
        <DialogDescription>转换后移入资料库，不再显示在碎片流中。</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-[var(--field-rhythm)]">
        <label className="flex flex-col gap-2 text-[length:var(--text-body)]" htmlFor="convert-document-title">
          文档标题
          <Input id="convert-document-title" autoFocus value={title} disabled={locked} onChange={event => onTitleChange(event.target.value)} />
        </label>
        <label className="flex flex-col gap-2 text-[length:var(--text-body)]" htmlFor="convert-document-directory">
          保存位置
          <SelectControl id="convert-document-directory" aria-label="保存位置" value={directory} options={options}
            disabled={locked} onValueChange={onDirectoryChange} />
        </label>
        {error ? <p role="alert" className="text-[length:var(--text-body)] text-destructive">{error}</p> : null}
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={locked} onClick={onClose}>取消</Button>
        <Button disabled={busy || !title.trim()} onClick={onSubmit}>{needsVerification ? busy ? "正在核对…" : "重新核对" : busy ? "正在转换…" : "转为文档"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export function FragmentTrashWorkspace({ entries, fragments, loading, targetId, onMutation, onRestored }: {
  entries: LibraryTreeEntry[]
  fragments: Fragment[]
  loading: boolean
  targetId?: string | null
  onMutation: (result: LibraryMutationResult) => void
  onRestored: (id?: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<LibraryTreeEntry | "all" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const targetRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const target = targetRef.current
    if (!viewport || !target || !targetId || loading) return
    viewport.scrollTop += target.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    target.focus({ preventScroll: true })
  }, [entries, targetId, loading])
  async function mutate(action: "restore" | "purge" | "empty", entry?: LibraryTreeEntry) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = action === "empty" ? await emptyTrash("fragments")
        : action === "purge" ? await purgeFromTrash(entry!.path) : await restoreFromTrash(entry!.path)
      onMutation(result)
      setPending(null)
      notify.success(action === "restore" ? "碎片已恢复" : action === "empty" ? "碎片回收站已清空" : "碎片已永久删除")
      if (action === "restore") onRestored(fragments.find(fragment => fragment.path === entry?.path)?.id)
    } catch (failure) {
      const message = getApiErrorMessage(failure)
      setError(message)
      if (action === "restore") {
        notify.failure("碎片恢复失败", failure, {
          action: { label: "重试", onClick: () => void mutate("restore", entry) },
        })
      }
    } finally { setBusy(false) }
  }
  return <section aria-label="碎片回收站" className="flex h-full min-h-0 flex-col overflow-hidden bg-background" aria-busy={busy || loading}>
    <header className="shard-content-inset flex shrink-0 items-center justify-between gap-3 py-3">
      <h1 className="text-[length:var(--text-page-title)] font-semibold">碎片回收站</h1>
      <Button size="sm" variant="outline" disabled={busy || !entries.length} onClick={() => setPending("all")}>
        <Trash2Icon aria-hidden="true" />清空碎片回收站
      </Button>
    </header>
    <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
      <div className="shard-content-inset">
        <div className="shard-content-measure">
          {loading ? <p className="py-6 text-muted-foreground">正在读取…</p> : !entries.length ? <p className="py-6 text-muted-foreground">没有已删除的碎片。</p> : entries.map(entry => {
            const fragment = fragments.find(item => item.path === entry.path)
            const highlighted = Boolean(targetId && fragment?.id === targetId)
            return <article key={entry.path} ref={highlighted ? targetRef : undefined} tabIndex={-1}
              className={`flex items-center gap-3 border-b border-border py-3 ${highlighted ? "bg-primary-subtle" : ""}`} data-trash-path={entry.path}>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[length:var(--text-body)]">{fragment?.content || entry.name}</p>
                <p className="mt-1 text-[length:var(--text-meta)] text-muted-foreground">{fragment?.createdAt.slice(0, 10) ?? entry.modifiedAt.slice(0, 10)}</p>
              </div>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate("restore", entry)}>恢复</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending(entry)}>永久删除</Button>
            </article>
          })}
        </div>
      </div>
    </ScrollArea>
    <Dialog open={pending !== null} onOpenChange={open => { if (!open && !busy) { setPending(null); setError(null) } }} disablePointerDismissal={busy}>
      <DialogContent role="alertdialog" aria-busy={busy} showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{pending === "all" ? "清空碎片回收站" : "永久删除碎片"}</DialogTitle>
          <DialogDescription>{pending === "all" ? `将永久删除 ${entries.length} 条已删除碎片，无法恢复。资料库回收站不受影响。` : "这条碎片将永久删除，无法恢复。已生成的文档会保留。"}</DialogDescription>
        </DialogHeader>
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => { setPending(null); setError(null) }}>取消</Button>
          <Button variant="destructive" disabled={busy} onClick={() => pending === "all" ? void mutate("empty") : pending && void mutate("purge", pending)}>{busy ? "正在删除…" : "永久删除"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
}
