import { useEffect, useMemo, useState } from "react"
import { XIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { DatePicker } from "@/components/ui/date-picker"
import { Input } from "@/components/ui/input"
import { SelectControl } from "@/components/ui/select"
import { TimePicker } from "@/components/ui/time-picker"
import {
  getApiErrorMessage,
  preflightOutlineUpgrade,
  runOutlineUpgrade,
} from "@/lib/api"
import { CONTENT_KIND_LABELS, isTypeTag } from "@/lib/content-kind"
import type { FragmentFilterKind, FragmentFilters } from "@/lib/fragment-space"
import {
  propertyFilterOperators,
  propertyFilterType,
  validatePropertyFilter,
  type PropertyFilter,
  type PropertyFilterOperator,
} from "@/lib/property-filter"
import type { PropertyType } from "@/lib/properties"
import type {
  Fragment,
  OutlineUpgradeIssue,
  OutlineUpgradePreflightItem,
  OutlineUpgradeRunResult,
  PropertyRegistry,
} from "@/types"

export function OutlineUpgradeContext({ count, onDismiss, onOpen }: {
  count: number
  onDismiss: () => void
  onOpen: () => void
}) {
  if (count < 1) return null
  return <div className="shard-content-inset shrink-0 pb-2 [--shard-focus-offset:-2px]" role="region" aria-label="旧格式大纲升级提示">
    <div className="shard-content-measure flex items-center gap-2 text-[length:var(--text-meta)] text-muted-foreground">
      <span className="min-w-0 flex-1">有 {count} 篇旧格式大纲，升级后可用导图编辑</span>
      <Button className="focus-visible:ring-inset" size="sm" variant="outline" onClick={onOpen}>查看并升级</Button>
      <Button className="focus-visible:ring-inset" size="sm" variant="ghost" onClick={onDismiss}>暂不</Button>
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
const PROPERTY_FILTER_OPERATOR_LABELS: Record<PropertyFilterOperator, string> = {
  exists: "存在",
  missing: "不存在",
  empty: "为空",
  notEmpty: "不为空",
  equals: "等于",
  contains: "包含",
  eq: "等于",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
  between: "介于",
  on: "日期为",
  before: "早于",
  after: "晚于",
  isTrue: "为是",
  isFalse: "为否",
  includes: "包含项",
}

function propertyFilterLabel(filter: PropertyFilter) {
  const operator = PROPERTY_FILTER_OPERATOR_LABELS[filter.op]
  if (Array.isArray(filter.value)) return `属性：${filter.key} ${operator} ${filter.value[0]} 与 ${filter.value[1]}`
  if (typeof filter.value === "string") return `属性：${filter.key} ${operator} ${filter.value}`
  return `属性：${filter.key} ${operator}`
}

export function FragmentFilterContext({ filters, onClear, onClearProperty, onOpenTagTopic }: {
  filters: FragmentFilters
  onClear: () => void
  onClearProperty: () => void
  onOpenTagTopic?: (tag: string) => void
}) {
  const labels = [filters.kind ? CONTENT_KIND_LABELS[filters.kind] : null, filters.tag ? `#${filters.tag}` : null, filters.month, filters.pinned ? "只看置顶" : null, filters.property ? propertyFilterLabel(filters.property) : null].filter(Boolean)
  if (!labels.length) return null
  return <div className="shard-content-inset shrink-0 pb-2" role="region" aria-label="当前碎片筛选">
    <div className="shard-content-measure flex items-center gap-2 text-[length:var(--text-meta)] text-muted-foreground">
      <span className="min-w-0 truncate" title={labels.join(" · ")}>{labels.join(" · ")}</span>
      {filters.tag && onOpenTagTopic ? <Button size="sm" variant="outline" onClick={() => onOpenTagTopic(filters.tag!)}>打开主题页</Button> : null}
      {filters.property ? <Button size="icon-sm" variant="ghost" aria-label="清除属性筛选" onClick={onClearProperty}><XIcon aria-hidden="true" /></Button> : null}
      <Button size="icon-sm" variant="ghost" aria-label="清除筛选" onClick={onClear}><XIcon aria-hidden="true" /></Button>
    </div>
  </div>
}

export function FragmentFilterDialog({ open, fragments, filters, propertyRegistry, propertyRegistryError, propertyRegistryLoading, onClose, onApply }: {
  open: boolean
  fragments: Fragment[]
  filters: FragmentFilters
  propertyRegistry: PropertyRegistry | null
  propertyRegistryError: string | null
  propertyRegistryLoading: boolean
  onClose: () => void
  onApply: (filters: FragmentFilters) => void
}) {
  const [draft, setDraft] = useState(filters)
  const [propertyProblem, setPropertyProblem] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setDraft(filters)
    setPropertyProblem(null)
  }, [open, filters])
  const tags = useMemo(() => [...new Set(fragments.flatMap(fragment => fragment.tags))]
    .filter(tag => tag !== "inbox" && !isTypeTag(tag)).sort((a, b) => a.localeCompare(b)), [fragments])
  const months = useMemo(() => [...new Set(fragments.map(fragment => fragment.createdAt.slice(0, 7)))].sort().reverse(), [fragments])
  const propertyKeys = useMemo(() => [...new Set([
    ...fragments.flatMap(fragment => (fragment.properties ?? []).map(property => property.key)),
    ...Object.keys(propertyRegistry?.properties ?? {}),
  ])].sort((a, b) => a.localeCompare(b)), [fragments, propertyRegistry])
  const selectedPropertyType = draft.property
    ? propertyFilterType(draft.property.key, propertyRegistry?.properties)
    : "text"
  const propertyOperators = propertyFilterOperators(selectedPropertyType)

  useEffect(() => {
    if (!open || propertyRegistryLoading || !propertyRegistry || !draft.property) return
    if (propertyOperators.includes(draft.property.op)) return
    setDraft(current => ({ ...current, property: current.property ? { key: current.property.key, op: "exists" } : null }))
    setPropertyProblem(null)
  }, [draft.property, open, propertyOperators, propertyRegistry, propertyRegistryLoading])

  function applyDraft() {
    if (draft.property) {
      const problem = validatePropertyFilter(draft.property, selectedPropertyType)
      if (problem) {
        setPropertyProblem(problem)
        return
      }
    }
    onApply(draft)
  }

  return <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
    <DialogContent aria-busy={propertyRegistryLoading}>
      <DialogHeader>
        <DialogTitle>筛选碎片</DialogTitle>
        <DialogDescription>按类型、标签、记录时间、置顶状态和属性查看碎片。</DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-col gap-[var(--field-rhythm)] overflow-y-auto">
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
        <label className="flex flex-col gap-2 text-[length:var(--text-body)]" htmlFor="filter-fragment-property">
          属性
          <SelectControl id="filter-fragment-property" aria-label="属性名" value={draft.property?.key ?? ""}
            disabled={propertyRegistryLoading}
            options={[{ value: "", label: "不按属性筛选" }, ...propertyKeys.map(key => ({ value: key, label: key }))]}
            onValueChange={key => {
              setPropertyProblem(null)
              setDraft(current => ({ ...current, property: key ? { key, op: "exists" } : null }))
            }} />
        </label>
        {propertyRegistryLoading ? <p role="status" className="text-[length:var(--text-meta)] text-muted-foreground">正在读取属性类型…</p> : null}
        {propertyRegistryError ? <p role="alert" className="text-[length:var(--text-meta)] text-warning">属性类型读取失败，未登记属性将按文本筛选：{propertyRegistryError}</p> : null}
        {draft.property ? <>
          <label className="flex flex-col gap-2 text-[length:var(--text-body)]" htmlFor="filter-fragment-property-operator">
            运算
            <SelectControl id="filter-fragment-property-operator" aria-label="属性运算" value={draft.property.op}
              options={propertyOperators.map(op => ({ value: op, label: PROPERTY_FILTER_OPERATOR_LABELS[op] }))}
              onValueChange={value => {
                const op = value as PropertyFilterOperator
                setPropertyProblem(null)
                setDraft(current => current.property ? {
                  ...current,
                  property: { key: current.property.key, op, ...(op === "between" ? { value: ["", ""] as [string, string] } : propertyFilterNeedsValue(op) ? { value: "" } : {}) },
                } : current)
              }} />
          </label>
          {propertyFilterNeedsValue(draft.property.op) ? <PropertyFilterValueControl
            filter={draft.property}
            onChange={property => {
              setPropertyProblem(null)
              setDraft(current => ({ ...current, property }))
            }}
            problem={propertyProblem}
            type={selectedPropertyType}
          /> : null}
        </> : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button disabled={propertyRegistryLoading && Boolean(draft.property)} onClick={applyDraft}>查看碎片</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

function propertyFilterNeedsValue(operator: PropertyFilterOperator) {
  return !["exists", "missing", "empty", "notEmpty", "isTrue", "isFalse"].includes(operator)
}

function PropertyFilterValueControl({ filter, onChange, problem, type }: {
  filter: PropertyFilter
  onChange: (filter: PropertyFilter) => void
  problem: string | null
  type: PropertyType
}) {
  const between = filter.op === "between"
  const values: [string, string] = Array.isArray(filter.value) ? filter.value : [typeof filter.value === "string" ? filter.value : "", ""]
  function change(index: 0 | 1, value: string) {
    if (between) {
      const next: [string, string] = [...values]
      next[index] = value
      onChange({ ...filter, value: next })
    } else onChange({ ...filter, value })
  }
  const labels = between ? ["属性下限", "属性上限"] as const : ["属性值"] as const
  return <div className="flex flex-col gap-2 text-[length:var(--text-body)]">
    {labels.map((label, index) => <PropertyFilterOperand key={label} label={label} type={type}
      value={values[index]} onChange={value => change(index as 0 | 1, value)} invalid={Boolean(problem)} />)}
    {problem ? <p role="alert" className="text-[length:var(--text-meta)] text-destructive">{problem}</p> : null}
  </div>
}

function PropertyFilterOperand({ label, type, value, onChange, invalid }: {
  label: string
  type: PropertyType
  value: string
  onChange: (value: string) => void
  invalid: boolean
}) {
  if (type === "date") {
    return <label className="flex flex-col gap-2">{label}<DatePicker aria-label={label} value={value} onValueChange={onChange} /></label>
  }
  if (type === "datetime") {
    const [date = "", time = ""] = value.split("T", 2)
    return <fieldset className="flex flex-col gap-2">
      <legend>{label}</legend>
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <DatePicker aria-label={`${label}日期`} value={date} onValueChange={next => onChange(`${next}T${time}`)} />
        <TimePicker aria-label={`${label}时间`} value={time} onValueChange={next => onChange(`${date}T${next}`)} />
      </div>
    </fieldset>
  }
  return <label className="flex flex-col gap-2">{label}<Input aria-label={label} aria-invalid={invalid}
    inputMode={type === "number" ? "decimal" : undefined} type="text" value={value} onChange={event => onChange(event.target.value)} /></label>
}
