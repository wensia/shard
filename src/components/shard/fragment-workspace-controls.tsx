import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Trash2Icon, XIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SelectControl } from "@/components/ui/select"
import {
  emptyTrash,
  getApiErrorMessage,
  preflightOutlineUpgrade,
  purgeFromTrash,
  restoreFromTrash,
  runOutlineUpgrade,
} from "@/lib/api"
import { CONTENT_KIND_LABELS, isTypeTag } from "@/lib/content-kind"
import { libraryDirectoryOptions, type FragmentFilterKind, type FragmentFilters } from "@/lib/fragment-space"
import type {
  Fragment,
  LibraryMutationResult,
  LibraryTreeEntry,
  OutlineUpgradeIssue,
  OutlineUpgradePreflightItem,
  OutlineUpgradeRunResult,
} from "@/types"

export function OutlineUpgradeContext({ count, onDismiss, onOpen }: {
  count: number
  onDismiss: () => void
  onOpen: () => void
}) {
  if (count < 1) return null
  return <div className="shard-content-inset shrink-0 pb-2" role="region" aria-label="旧格式大纲升级提示">
    <div className="shard-content-measure flex items-center gap-2 text-[length:var(--text-meta)] text-muted-foreground">
      <span className="min-w-0 flex-1">有 {count} 篇旧格式大纲，升级后可用导图编辑</span>
      <Button size="sm" variant="outline" onClick={onOpen}>查看并升级</Button>
      <Button size="sm" variant="ghost" onClick={onDismiss}>暂不</Button>
    </div>
  </div>
}

const OUTLINE_UPGRADE_GROUPS = [
  { status: "lossless", title: "可无损升级" },
  { status: "lossy", title: "有损" },
  { status: "blocked", title: "无法升级" },
] as const

const OUTLINE_ISSUE_LABELS: Record<OutlineUpgradeIssue["kind"], string> = {
  discardedNonListLine: "丢弃非列表行",
  continuationLine: "丢弃续行",
  codeFence: "丢弃代码围栏",
  truncatedNodeText: "截断超长节点文字",
}

function outlineIssueSummary(issues: OutlineUpgradeIssue[]) {
  return issues
    .map((issue) => `${OUTLINE_ISSUE_LABELS[issue.kind]} ${issue.count} 处${issue.samples.length ? `（如：${issue.samples.join("；")}）` : ""}`)
    .join("；")
}

export function OutlineUpgradeDialog({ open, preselectedIds, onClose, onComplete }: {
  open: boolean
  preselectedIds: string[] | null
  onClose: () => void
  onComplete: (result: OutlineUpgradeRunResult) => Promise<void> | void
}) {
  const [items, setItems] = useState<OutlineUpgradePreflightItem[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [includeLossy, setIncludeLossy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<OutlineUpgradeRunResult | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setBusy(false)
    setError(null)
    setResult(null)
    setItems([])
    setSelectedIds([])
    setIncludeLossy(false)
    void preflightOutlineUpgrade()
      .then((nextItems) => {
        if (cancelled) return
        setItems(nextItems)
        const requested = preselectedIds ? new Set(preselectedIds) : null
        setSelectedIds(nextItems
          .filter((item) => item.status === "lossless" && (!requested || requested.has(item.id)))
          .map((item) => item.id))
      })
      .catch((failure) => {
        if (!cancelled) setError(getApiErrorMessage(failure))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [open, preselectedIds])

  const locked = loading || busy
  const selectedItems = items.filter((item) =>
    selectedIds.includes(item.id) && item.status !== "blocked" && (item.status !== "lossy" || includeLossy)
  )

  function setLossyIncluded(checked: boolean) {
    setIncludeLossy(checked)
    const requested = preselectedIds ? new Set(preselectedIds) : null
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const item of items) {
        if (item.status !== "lossy") continue
        if (checked && (!requested || requested.has(item.id))) next.add(item.id)
        else next.delete(item.id)
      }
      return Array.from(next)
    })
  }

  function toggleItem(item: OutlineUpgradePreflightItem, checked: boolean) {
    setSelectedIds((current) => checked
      ? Array.from(new Set([...current, item.id]))
      : current.filter((id) => id !== item.id))
  }

  async function submit() {
    if (busy || selectedItems.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const next = await runOutlineUpgrade(selectedItems.map((item) => ({
        id: item.id,
        fileSha: item.fileSha,
      })))
      setResult(next)
      await onComplete(next)
    } catch (failure) {
      setError(getApiErrorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return <Dialog open={open} onOpenChange={next => { if (!next && !locked) onClose() }} disablePointerDismissal={locked}>
    <DialogContent aria-busy={locked} showCloseButton={!locked} className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>升级旧格式大纲</DialogTitle>
        <DialogDescription>升级前会先建立可恢复点；有损项需明确允许后才会执行。</DialogDescription>
      </DialogHeader>
      {loading ? <p role="status" className="text-[length:var(--text-body)] text-muted-foreground">正在检查旧格式大纲…</p> : null}
      {!loading && !result ? <div className="flex min-h-0 flex-col gap-4 overflow-auto">
        {OUTLINE_UPGRADE_GROUPS.map((group) => {
          const groupItems = items.filter((item) => item.status === group.status)
          return <section key={group.status} aria-label={group.title} className="flex flex-col gap-2">
            <h3 className="text-[length:var(--text-section-title)] font-semibold">{group.title}（{groupItems.length}）</h3>
            {groupItems.length === 0 ? <p className="text-[length:var(--text-meta)] text-muted-foreground">无</p> : groupItems.map((item) => {
              const disabled = item.status === "blocked" || (item.status === "lossy" && !includeLossy)
              return <label key={`${item.path}:${item.id}`} className="flex items-start gap-2 text-[length:var(--text-body)]">
                {item.status === "blocked" ? null : <Checkbox
                  aria-label={`选择 ${item.title}`}
                  checked={selectedIds.includes(item.id)}
                  disabled={disabled || locked}
                  onCheckedChange={(checked) => toggleItem(item, checked === true)}
                />}
                <span className="min-w-0">
                  <span className="block font-medium">{item.title || item.path}</span>
                  <span className="block text-[length:var(--text-meta)] text-muted-foreground">{item.path} · {item.nodeCount} 个节点</span>
                  {item.reason ? <span className="block text-[length:var(--text-meta)] text-destructive">{item.reason}</span> : null}
                  {item.issues.length ? <span className="block text-[length:var(--text-meta)] text-warning">{outlineIssueSummary(item.issues)}</span> : null}
                </span>
              </label>
            })}
          </section>
        })}
        <label className="flex items-center gap-2 text-[length:var(--text-body)]">
          <Checkbox checked={includeLossy} disabled={locked || !items.some((item) => item.status === "lossy")} onCheckedChange={(checked) => setLossyIncluded(checked === true)} />
          包含有损项
        </label>
      </div> : null}
      {busy ? <p role="status" aria-live="polite" className="text-[length:var(--text-body)] text-muted-foreground">正在升级 {selectedItems.length} 篇…</p> : null}
      {result ? <div className="flex min-h-0 flex-col gap-3 overflow-auto" aria-label="升级结果">
        <p className="text-[length:var(--text-body)]">
          成功 {result.results.filter((item) => item.status === "upgraded").length} 篇，跳过 {result.results.filter((item) => item.status === "skipped").length} 篇，失败 {result.results.filter((item) => item.status === "failed").length} 篇。
        </p>
        <p className="text-[length:var(--text-meta)] text-muted-foreground">
          {result.backupPath ? `备份位置：${result.backupPath}` : result.checkpointStatus ? "已先保存 Git 检查点" : "未生成恢复信息"}
        </p>
        {result.results.filter((item) => item.status !== "upgraded").map((item) => <p key={`${item.id}:${item.path ?? "missing"}`} className="text-[length:var(--text-meta)] text-muted-foreground">{item.path ?? item.id}：{item.reason ?? item.status}</p>)}
        {result.commitError ? <p role="alert" className="text-[length:var(--text-body)] text-destructive">语义提交失败：{result.commitError}</p> : null}
      </div> : null}
      {error ? <p role="alert" className="text-[length:var(--text-body)] text-destructive">{error}</p> : null}
      <DialogFooter>
        <Button variant="outline" disabled={locked} onClick={onClose}>{result ? "关闭" : "取消"}</Button>
        {!result ? <Button disabled={locked || selectedItems.length === 0} onClick={() => void submit()}>{busy ? "正在升级…" : `升级 ${selectedItems.length} 篇`}</Button> : null}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

/** The home stream has no filter chrome until the user applies a condition. */
export function FragmentFilterContext({ filters, onClear }: {
  filters: FragmentFilters
  onClear: () => void
}) {
  const labels = [filters.kind ? CONTENT_KIND_LABELS[filters.kind] : null, filters.tag ? `#${filters.tag}` : null, filters.month, filters.pinned ? "只看置顶" : null].filter(Boolean)
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
        <DialogDescription>按类型、标签、记录时间和置顶状态查看碎片。</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-[var(--field-rhythm)]">
        <label className="flex flex-col gap-2 text-[length:var(--text-body)]" htmlFor="filter-fragment-kind">
          类型
          <SelectControl id="filter-fragment-kind" aria-label="类型" value={draft.kind ?? ""}
            options={[
              { value: "", label: "全部类型" },
              { value: "fragment", label: "碎片" },
              { value: "outline", label: "大纲" },
              { value: "flowchart", label: "流程图" },
              { value: "document", label: "文档" },
            ]}
            onValueChange={kind => setDraft(current => ({ ...current, kind: (kind || null) as FragmentFilterKind }))} />
        </label>
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
      toast(action === "restore" ? "碎片已恢复" : action === "empty" ? "碎片回收站已清空" : "碎片已永久删除")
      if (action === "restore") onRestored(fragments.find(fragment => fragment.path === entry?.path)?.id)
    } catch (failure) {
      const message = getApiErrorMessage(failure)
      setError(message)
      if (action === "restore") toast.error(`恢复失败：${message}`)
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
