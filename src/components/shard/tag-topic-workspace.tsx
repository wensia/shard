import { useMemo, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react"

import appStyles from "@/App.module.css"
import { FragmentTimeline } from "@/components/shard/fragment-timeline"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CONTENT_KIND_LABELS, deriveKind } from "@/lib/content-kind"
import {
  collectTagTopicBacklinks,
  collectTagTopicPropertyColumns,
  countTagTopicKinds,
  deriveTagTopicTitle,
  formatTagTopicPropertyValue,
  sortTagTopicFragments,
  type TagTopicSort,
  type TagTopicSortKey,
} from "@/lib/tag-topic"
import type { Fragment, PropertyRegistry } from "@/types"

const VIEW_STORAGE_PREFIX = "shard.tag-topic-view:"

const PROPERTY_TYPE_LABELS = {
  checkbox: "勾选",
  date: "日期",
  datetime: "日期时间",
  link: "链接",
  list: "列表",
  number: "数字",
  text: "文本",
} as const

type TagTopicView = "cards" | "table"

interface TagTopicWorkspaceProps {
  allFragments: Fragment[]
  filterContext?: ReactNode
  fragments: Fragment[]
  isLoading: boolean
  onBack: () => void
  onNavigateToFragment: (fragmentId: string) => void
  onOpenFragment: (fragment: Fragment) => void
  propertyRegistry: PropertyRegistry | null
  propertyRegistryLoading: boolean
  tag: string
  timeline: Omit<ComponentProps<typeof FragmentTimeline>, "footer" | "fragments">
  topicFragments: Fragment[]
}

export function TagTopicWorkspace({
  allFragments,
  filterContext,
  fragments,
  isLoading,
  onBack,
  onNavigateToFragment,
  onOpenFragment,
  propertyRegistry,
  propertyRegistryLoading,
  tag,
  timeline,
  topicFragments,
}: TagTopicWorkspaceProps) {
  const [view, setView] = useState<TagTopicView>(() => readView(tag))
  const counts = useMemo(() => countTagTopicKinds(topicFragments), [topicFragments])
  const backlinks = useMemo(
    () => collectTagTopicBacklinks(allFragments, topicFragments, tag),
    [allFragments, tag, topicFragments]
  )
  const backlinksSection = backlinks.length > 0 ? (
    <TagTopicBacklinks
      fragments={backlinks}
      onNavigate={onNavigateToFragment}
    />
  ) : null

  function changeView(next: TagTopicView) {
    setView(next)
    writeView(tag, next)
  }

  return (
    <section
      aria-label={`标签主题页：${tag}`}
      className={appStyles.workspaceColumn}
    >
      <header className="shard-content-inset shrink-0 py-3">
        <div className="shard-content-measure flex flex-wrap items-center gap-3">
          <Button onClick={onBack} size="sm" variant="outline">
            返回全部碎片
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[length:var(--text-page-title)] font-semibold">
              #{tag}
            </h1>
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[length:var(--text-meta)] text-muted-foreground">
              <span>碎片 {counts.fragment}</span>
              <span>大纲 {counts.outline}</span>
              <span>流程图 {counts.flowchart}</span>
              <span>文档 {counts.document}</span>
            </p>
          </div>
          <div
            aria-label="主题页视图"
            className="inline-flex gap-1 rounded-md border border-border-visible/50 bg-muted/40 p-1"
            role="group"
          >
            <Button
              aria-pressed={view === "cards"}
              className={view === "cards"
                ? "bg-card font-medium text-primary shadow-[var(--shadow-card)] hover:bg-card"
                : "text-muted-foreground hover:bg-foreground/[0.03]"}
              onClick={() => changeView("cards")}
              size="sm"
              variant="ghost"
            >
              卡片
            </Button>
            <Button
              aria-pressed={view === "table"}
              className={view === "table"
                ? "bg-card font-medium text-primary shadow-[var(--shadow-card)] hover:bg-card"
                : "text-muted-foreground hover:bg-foreground/[0.03]"}
              onClick={() => changeView("table")}
              size="sm"
              variant="ghost"
            >
              表格
            </Button>
          </div>
        </div>
      </header>
      {filterContext}
      <div className={appStyles.workAreaStage}>
        <div className={appStyles.normalWorkArea}>
          {view === "cards" ? (
            <FragmentTimeline
              {...timeline}
              emptyMessage={
                topicFragments.length === 0
                  ? `没有带 #${tag} 的公开内容。`
                  : "没有符合当前筛选条件的内容。"
              }
              footer={backlinksSection}
              fragments={fragments}
              isLoading={isLoading}
            />
          ) : (
            <TagTopicTable
              backlinks={backlinksSection}
              fragments={fragments}
              isLoading={isLoading}
              onOpenFragment={onOpenFragment}
              propertyRegistry={propertyRegistry}
              propertyRegistryLoading={propertyRegistryLoading}
              topicFragments={topicFragments}
            />
          )}
        </div>
      </div>
    </section>
  )
}

function TagTopicTable({
  backlinks,
  fragments,
  isLoading,
  onOpenFragment,
  propertyRegistry,
  propertyRegistryLoading,
  topicFragments,
}: {
  backlinks: ReactNode
  fragments: Fragment[]
  isLoading: boolean
  onOpenFragment: (fragment: Fragment) => void
  propertyRegistry: PropertyRegistry | null
  propertyRegistryLoading: boolean
  topicFragments: Fragment[]
}) {
  const [sort, setSort] = useState<TagTopicSort | null>(null)
  const columns = useMemo(
    () => collectTagTopicPropertyColumns(topicFragments, propertyRegistry?.properties),
    [propertyRegistry, topicFragments]
  )
  const rows = useMemo(
    () => sortTagTopicFragments(fragments, sort, propertyRegistry?.properties),
    [fragments, propertyRegistry, sort]
  )

  function cycleSort(key: TagTopicSortKey) {
    setSort((current) => {
      if (!current || current.key !== key) return { direction: "asc", key }
      if (current.direction === "asc") return { direction: "desc", key }
      return null
    })
  }

  function openOnKeyboard(event: KeyboardEvent<HTMLTableRowElement>, fragment: Fragment) {
    if (event.currentTarget !== event.target) return
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    onOpenFragment(fragment)
  }

  return (
    <div
      aria-busy={isLoading || propertyRegistryLoading || undefined}
      className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-none"
      data-tag-topic-table-viewport
    >
      <div className="shard-content-inset min-w-0 pb-6">
        <div className="shard-content-measure min-w-0">
          <table
            aria-label="标签内容属性表格"
            className="w-full min-w-max border-collapse text-left text-[length:var(--text-body)]"
          >
            <thead className="static z-auto">
              <tr>
                <SortableHeader label="标题" sort={sort} sortKey="title" onSort={cycleSort} />
                <SortableHeader label="类型" sort={sort} sortKey="type" onSort={cycleSort} />
                <SortableHeader label="更新时间" sort={sort} sortKey="updatedAt" onSort={cycleSort} />
                {columns.map((column) => (
                  <SortableHeader
                    key={column.key}
                    label={column.key}
                    meta={column.type ? PROPERTY_TYPE_LABELS[column.type] : "未登记"}
                    alignEnd={column.type === "number"}
                    sort={sort}
                    sortKey={`property:${column.key}`}
                    onSort={cycleSort}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading || propertyRegistryLoading ? Array.from({ length: 5 }, (_, rowIndex) => (
                <tr className="h-12 border-b border-border bg-card" key={`skeleton:${rowIndex}`}>
                  {Array.from({ length: 3 + columns.length }, (_, cellIndex) => (
                    <td className="px-4" key={cellIndex}>
                      <span className="block h-3 w-20 animate-pulse rounded-sm bg-muted/60" />
                    </td>
                  ))}
                </tr>
              )) : rows.length === 0 ? (
                <tr className="border-b border-border bg-card">
                  <td className="h-12 px-4 text-muted-foreground" colSpan={3 + columns.length}>
                    没有符合当前条件的内容。
                  </td>
                </tr>
              ) : rows.map((fragment) => (
                <tr
                  aria-label={`打开${CONTENT_KIND_LABELS[deriveKind(fragment.tags)]}：${deriveTagTopicTitle(fragment)}`}
                  className="h-12 cursor-pointer border-b border-border bg-card transition-colors hover:bg-muted/40"
                  data-tag-topic-row={fragment.id}
                  key={fragment.id}
                  onClick={() => onOpenFragment(fragment)}
                  onKeyDown={(event) => openOnKeyboard(event, fragment)}
                  tabIndex={0}
                >
                  <td className="max-w-80 px-4 py-3 font-medium">
                    <span className="block max-w-80 truncate" title={deriveTagTopicTitle(fragment)}>
                      {deriveTagTopicTitle(fragment)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {CONTENT_KIND_LABELS[deriveKind(fragment.tags)]}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                    {formatUpdatedAt(fragment.updatedAt)}
                  </td>
                  {columns.map((column) => (
                    <TagTopicPropertyCell
                      key={column.key}
                      fragment={fragment}
                      propertyKey={column.key}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {backlinks}
        </div>
      </div>
    </div>
  )
}

function SortableHeader({
  alignEnd = false,
  label,
  meta,
  onSort,
  sort,
  sortKey,
}: {
  alignEnd?: boolean
  label: string
  meta?: string
  onSort: (key: TagTopicSortKey) => void
  sort: TagTopicSort | null
  sortKey: TagTopicSortKey
}) {
  const active = sort?.key === sortKey
  const ariaSort = !active ? "none" : sort.direction === "asc" ? "ascending" : "descending"
  return (
    <th
      aria-sort={ariaSort}
      className="sticky top-0 z-30 h-10 bg-muted/30 px-1 text-[length:var(--text-meta)] font-semibold text-muted-foreground"
      scope="col"
    >
      <Button
        className={`h-10 min-h-10 w-full px-3 py-0 ${alignEnd ? "justify-end text-right" : "justify-start text-left"}`}
        onClick={() => onSort(sortKey)}
        size="sm"
        variant="ghost"
      >
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="truncate">{label}</span>
          {meta ? <span className="shrink-0 text-[length:var(--text-tiny)] font-normal">{meta}</span> : null}
        </span>
        {active ? <span className="text-[length:var(--text-tiny)]">{sort.direction === "asc" ? "升序" : "降序"}</span> : null}
      </Button>
    </th>
  )
}

function TagTopicPropertyCell({
  fragment,
  propertyKey,
}: {
  fragment: Fragment
  propertyKey: string
}) {
  const property = (fragment.properties ?? []).find((candidate) => candidate.key === propertyKey)
  const value = formatTagTopicPropertyValue(property?.value)
  if (value.kind === "empty") return <td className="px-4 py-3" />
  if (value.kind === "checkbox") {
    return (
      <td className="whitespace-nowrap px-4 py-3">
        <Badge variant="outline">{value.text}</Badge>
      </td>
    )
  }
  if (value.kind === "list") {
    const visible = value.items.length > 3 ? value.items.slice(0, 2) : value.items
    return (
      <td className="px-4 py-3">
        <div className="flex max-w-64 flex-wrap gap-1">
          {visible.map((item, index) => <Badge key={`${item}:${index}`} variant="secondary">{item}</Badge>)}
          {value.items.length > 3 ? <Badge variant="secondary">另 {value.items.length - 2} 项</Badge> : null}
        </div>
      </td>
    )
  }
  return (
    <td className={value.kind === "number" ? "px-4 py-3 text-right tabular-nums" : "max-w-64 px-4 py-3"}>
      <span className={value.kind === "other" ? "block max-w-64 truncate" : undefined} title={value.kind === "other" ? value.text : undefined}>
        {value.text}
      </span>
    </td>
  )
}

function TagTopicBacklinks({
  fragments,
  onNavigate,
}: {
  fragments: Fragment[]
  onNavigate: (fragmentId: string) => void
}) {
  return (
    <section aria-label="标签主题反向链接" className="shard-content-measure mt-6">
      <h2 className="mb-2 text-[length:var(--text-section-title)] font-semibold">
        反向链接（{fragments.length}）
      </h2>
      <div className="border-t border-border">
        {fragments.map((fragment) => (
          <button
            className="flex min-h-(--table-row-height) w-full items-center justify-between gap-3 border-b border-border bg-card px-4 py-3 text-left text-[length:var(--text-body)] transition-colors hover:bg-muted/40"
            key={fragment.id}
            onClick={() => onNavigate(fragment.id)}
            type="button"
          >
            <span className="min-w-0 flex-1 truncate">{deriveTagTopicTitle(fragment)}</span>
            <span className="shrink-0 text-[length:var(--text-meta)] text-muted-foreground">
              {CONTENT_KIND_LABELS[deriveKind(fragment.tags)]}
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

function readView(tag: string): TagTopicView {
  try {
    return window.localStorage.getItem(`${VIEW_STORAGE_PREFIX}${tag}`) === "table"
      ? "table"
      : "cards"
  } catch {
    return "cards"
  }
}

function writeView(tag: string, view: TagTopicView) {
  try {
    window.localStorage.setItem(`${VIEW_STORAGE_PREFIX}${tag}`, view)
  } catch {
    // Storage can be unavailable in a restricted WebView.
  }
}

function formatUpdatedAt(value: string) {
  return value.slice(0, 16).replace("T", " ")
}
