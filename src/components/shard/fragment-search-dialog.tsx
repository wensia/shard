import {
  CornerDownLeftIcon,
  FileTextIcon,
  LockKeyholeIcon,
  SearchIcon,
} from "lucide-react"
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"

import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { Layout, LayoutContent } from "@astryxdesign/core/Layout"
import { TextInput } from "@astryxdesign/core/TextInput"
import { FragmentBody } from "@/components/shard/fragment-body"
import { searchFragments } from "@/lib/fragment-search"
import { LOCKBOX_TAG } from "@/lib/lockbox"
import { cn } from "@/lib/utils"
import type { Fragment } from "@/types"

const MAX_RESULTS = 40
const RECENT_COUNT = 8
const SEARCH_RESULTS_ID = "shard-floating-search-results"

interface FragmentSearchDialogProps {
  fragments: Fragment[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenFragment: (fragment: Fragment) => void
  vaultPath?: string
}

interface SearchListItem {
  fragment: Fragment
  matchEnd?: number
  matchStart?: number
  matchedTags: string[]
}

export function FragmentSearchDialog({
  fragments,
  open,
  onOpenChange,
  onOpenFragment,
  vaultPath,
}: FragmentSearchDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const deferredQuery = useDeferredValue(query)
  const hasQuery = deferredQuery.trim().length > 0
  const results = useMemo(
    () => searchFragments(fragments, deferredQuery),
    [deferredQuery, fragments]
  )
  const recentItems = useMemo<SearchListItem[]>(
    () =>
      fragments.slice(0, RECENT_COUNT).map((fragment) => ({
        fragment,
        matchedTags: [],
      })),
    [fragments]
  )
  const items = hasQuery ? results.slice(0, MAX_RESULTS) : recentItems
  const totalResultCount = hasQuery ? results.length : recentItems.length
  const isSearching = query !== deferredQuery

  useEffect(() => {
    if (!open) return

    setQuery("")
    setSelectedIndex(0)
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    setSelectedIndex(0)
  }, [deferredQuery])

  useEffect(() => {
    setSelectedIndex((current) =>
      items.length === 0 ? 0 : Math.min(current, items.length - 1)
    )
  }, [items.length])

  function handleOpenFragment(fragment: Fragment) {
    onOpenChange(false)
    onOpenFragment(fragment)
  }

  function clearSearch() {
    setQuery("")
    setSelectedIndex(0)
    inputRef.current?.focus()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (query) {
        event.preventDefault()
        event.stopPropagation()
        clearSearch()
      }
      return
    }

    if (items.length === 0) return

    if (event.key === "ArrowDown") {
      event.preventDefault()
      setSelectedIndex((current) => (current + 1) % items.length)
      return
    }

    if (event.key === "ArrowUp") {
      event.preventDefault()
      setSelectedIndex((current) => (current - 1 + items.length) % items.length)
      return
    }

    if (event.key === "Enter") {
      event.preventDefault()
      const selectedItem = items[selectedIndex]
      if (selectedItem) handleOpenFragment(selectedItem.fragment)
    }
  }

  return (
    <Dialog
      isOpen={open}
      onOpenChange={onOpenChange}
      padding={0}
      position={{ top: "clamp(16px, 10dvh, 80px)" }}
      width="min(720px, calc(100vw - 32px))"
    >
      <Layout
        header={
          <DialogHeader
            className="sr-only"
            subtitle="搜索未归档笔记的正文和标签。"
            title="搜索笔记"
          />
        }
        content={
          <LayoutContent isScrollable={false} padding={0}>
            <div className="border-b border-border p-[var(--shard-space-3)]">
              <TextInput
                aria-controls={SEARCH_RESULTS_ID}
                aria-expanded={items.length > 0}
                hasClear
                isLabelHidden
                label="搜索笔记"
                onChange={setQuery}
                onKeyDown={handleKeyDown}
                placeholder="搜索正文或标签"
                ref={inputRef}
                role="combobox"
                size="lg"
                startIcon={<SearchIcon />}
                value={query}
              />
            </div>

            <div
              aria-busy={isSearching}
              className="min-h-[260px] overflow-hidden bg-popover"
              id={SEARCH_RESULTS_ID}
              role="listbox"
            >
              {fragments.length === 0 ? (
                <SearchEmptyState message="还没有可搜索的笔记。" />
              ) : items.length === 0 ? (
                <SearchEmptyState message="没有匹配的笔记。" />
              ) : (
                <>
                  <div className="flex h-9 items-center justify-between border-b border-border px-[var(--shard-space-3)] text-xs font-semibold text-muted-foreground">
                    <span>{hasQuery ? "搜索结果" : "最近笔记"}</span>
                    <span className="tabular-nums">
                      {formatResultCount(totalResultCount)}
                    </span>
                  </div>
                  <div className="max-h-[min(58dvh,480px)] overflow-y-auto">
                    {items.map((item, index) => (
                      <SearchResultButton
                        isSelected={index === selectedIndex}
                        item={item}
                        key={item.fragment.id}
                        onMouseEnter={() => setSelectedIndex(index)}
                        onOpen={handleOpenFragment}
                        vaultPath={vaultPath}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          </LayoutContent>
        }
      />
    </Dialog>
  )
}

function SearchEmptyState({ message }: { message: string }) {
  return (
    <div className="flex min-h-[260px] flex-col items-center justify-center gap-[var(--shard-space-3)] px-[var(--shard-space-6)] text-center text-muted-foreground">
      <SearchIcon className="size-6 stroke-[1.6]" />
      <p className="text-sm font-semibold text-balance">{message}</p>
    </div>
  )
}

function SearchResultButton({
  isSelected,
  item,
  onMouseEnter,
  onOpen,
  vaultPath,
}: {
  isSelected: boolean
  item: SearchListItem
  onMouseEnter: () => void
  onOpen: (fragment: Fragment) => void
  vaultPath?: string
}) {
  const { fragment, matchEnd, matchStart, matchedTags } = item
  const visibleTags = fragment.tags.filter(
    (tag) => tag !== "inbox" && tag !== LOCKBOX_TAG
  )

  return (
    <button
      aria-selected={isSelected}
      className={[
        "group grid w-full grid-cols-[1fr_auto] gap-x-[var(--shard-space-3)] gap-y-[var(--shard-space-2)] border-b border-border px-[var(--shard-space-4)] py-[var(--shard-space-3)] text-left transition-colors last:border-b-0 focus-visible:ring-3 focus-visible:ring-ring/[var(--shard-alpha-34)] focus-visible:outline-none",
        isSelected
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "hover:bg-muted/[var(--shard-alpha-55)]",
      ].join(" ")}
      onClick={() => onOpen(fragment)}
      onMouseEnter={onMouseEnter}
      role="option"
      type="button"
    >
      <div className="flex min-w-0 items-center gap-[var(--shard-space-2)] text-xs leading-4 font-medium text-muted-foreground">
        {fragment.lockbox ? (
          <LockKeyholeIcon className="size-3.5 shrink-0 stroke-[1.75]" />
        ) : (
          <FileTextIcon className="size-3.5 shrink-0 stroke-[1.75]" />
        )}
        <span className="truncate">{formatSearchDate(fragment.createdAt)}</span>
        <span aria-hidden="true">·</span>
        <span className="truncate">{fragment.path || fragment.id}</span>
      </div>
      <div
        className={cn(
          "flex items-center gap-1 text-[11px] leading-4 font-semibold text-muted-foreground transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)] group-hover:scale-100 group-hover:opacity-100 group-hover:blur-0",
          isSelected
            ? "scale-100 opacity-100 blur-0"
            : "scale-[0.25] opacity-0 blur-[4px]"
        )}
      >
        <CornerDownLeftIcon className="size-3.5 stroke-[1.75]" />
        打开
      </div>

      <FragmentBody
        className="shard-search-result-body col-span-2 max-h-[180px] overflow-hidden text-sm"
        content={fragment.content}
        hideTags
        previewImages={false}
        renderImages={Boolean(vaultPath)}
        selectionEnd={matchEnd}
        selectionStart={matchStart}
        trimEnd
        vaultPath={vaultPath}
      />

      {visibleTags.length > 0 ? (
        <div className="shard-card-tags col-span-2 flex min-w-0 flex-wrap gap-[var(--shard-space-2)]">
          {visibleTags.slice(0, 4).map((tag) => {
            const isMatched = matchedTags.includes(tag)

            return (
              <span
                className={[
                  "shard-tag max-w-full font-medium",
                  isMatched ? "shard-tag-active" : "shard-tag-muted",
                ].join(" ")}
                key={tag}
              >
                <span className="truncate">#{tag}</span>
              </span>
            )
          })}
          {visibleTags.length > 4 ? (
            <span className="shard-chip text-muted-foreground tabular-nums">
              +{visibleTags.length - 4}
            </span>
          ) : null}
        </div>
      ) : null}
    </button>
  )
}

function formatSearchDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "未知时间"

  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

function formatResultCount(count: number) {
  return `${count} 条`
}
