import {
  CornerDownLeftIcon,
  FileTextIcon,
  LockKeyholeIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"

import { FragmentBody } from "@/components/shard/fragment-body"
import styles from "@/components/shard/fragment-search-dialog.module.css"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
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
      open={open}
      onOpenChange={(nextOpen, eventDetails) => {
        if (
          !nextOpen &&
          eventDetails.reason === "escape-key" &&
          query
        ) {
          clearSearch()
          return
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        className="gap-0 overflow-hidden p-0"
        showCloseButton={false}
        style={{
          top: "clamp(16px, 10dvh, 80px)",
          width: "min(720px, calc(100vw - 32px))",
          maxWidth: "none",
          transform: "translate(-50%, 0)",
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>搜索笔记</DialogTitle>
          <DialogDescription>搜索未归档笔记的正文和标签。</DialogDescription>
        </DialogHeader>
        <div
          style={{
            borderBottom: "1px solid var(--border)",
            padding: "var(--shard-space-3)",
          }}
        >
          <div className="relative">
            <label className="sr-only" htmlFor="shard-fragment-search">
              搜索笔记
            </label>
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-controls={SEARCH_RESULTS_ID}
              aria-expanded={items.length > 0}
              className="h-10 pl-9 pr-9"
              id="shard-fragment-search"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="搜索正文或标签"
              ref={inputRef}
              role="combobox"
              value={query}
            />
            {query ? (
              <Button
                aria-label="清空搜索"
                className="absolute right-1 top-1/2 -translate-y-1/2"
                onClick={clearSearch}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <XIcon aria-hidden="true" />
                <span className="sr-only">清空搜索</span>
              </Button>
            ) : null}
          </div>
        </div>

        <div
          aria-busy={isSearching}
          id={SEARCH_RESULTS_ID}
          role="listbox"
          style={{
            minHeight: 260,
            overflow: "hidden",
            background: "var(--popover)",
          }}
        >
          {fragments.length === 0 ? (
            <SearchEmptyState message="还没有可搜索的笔记。" />
          ) : items.length === 0 ? (
            <SearchEmptyState message="没有匹配的笔记。" />
          ) : (
            <>
              <div
                className="flex items-center justify-between"
                style={{
                  height: 36,
                  borderBottom: "1px solid var(--border)",
                  paddingInline: "var(--shard-space-3)",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  color: "var(--muted-foreground)",
                }}
              >
                <span>{hasQuery ? "搜索结果" : "最近笔记"}</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  {formatResultCount(totalResultCount)}
                </span>
              </div>
              <div
                style={{
                  maxHeight: "min(58dvh, 480px)",
                  overflowY: "auto",
                }}
              >
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
      </DialogContent>
    </Dialog>
  )
}

function SearchEmptyState({ message }: { message: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3"
      style={{
        minHeight: 260,
        paddingInline: "var(--shard-space-6)",
        textAlign: "center",
        color: "var(--muted-foreground)",
      }}
    >
      <SearchIcon size={24} strokeWidth={1.6} />
      <p style={{ fontSize: "0.875rem", fontWeight: 600, textWrap: "balance" }}>
        {message}
      </p>
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
      className={cn(styles.resultButton, isSelected && styles.resultButtonSelected)}
      onClick={() => onOpen(fragment)}
      onMouseEnter={onMouseEnter}
      role="option"
      type="button"
    >
      <div
        style={{
          display: "flex",
          minWidth: 0,
          alignItems: "center",
          gap: "var(--shard-space-2)",
          fontSize: "0.75rem",
          lineHeight: "1rem",
          fontWeight: 500,
          color: "var(--muted-foreground)",
        }}
      >
        {fragment.lockbox ? (
          <LockKeyholeIcon
            size={14}
            strokeWidth={1.75}
            style={{ flexShrink: 0 }}
          />
        ) : (
          <FileTextIcon size={14} strokeWidth={1.75} style={{ flexShrink: 0 }} />
        )}
        <span
          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {formatSearchDate(fragment.createdAt)}
        </span>
        <span aria-hidden="true">·</span>
        <span
          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {fragment.path || fragment.id}
        </span>
      </div>
      <div className={cn(styles.openHint, isSelected && styles.openHintVisible)}>
        <CornerDownLeftIcon size={14} strokeWidth={1.75} />
        打开
      </div>

      <div style={{ gridColumn: "1 / -1", maxHeight: 180, overflow: "hidden" }}>
        <FragmentBody
          className="shard-search-result-body"
          content={fragment.content}
          hideTags
          previewImages={false}
          renderImages={Boolean(vaultPath)}
          selectionEnd={matchEnd}
          selectionStart={matchStart}
          trimEnd
          vaultPath={vaultPath}
        />
      </div>

      {visibleTags.length > 0 ? (
        <div
          className="shard-card-tags"
          style={{
            gridColumn: "1 / -1",
            display: "flex",
            minWidth: 0,
            flexWrap: "wrap",
            gap: "var(--shard-space-2)",
          }}
        >
          {visibleTags.slice(0, 4).map((tag) => {
            const isMatched = matchedTags.includes(tag)

            return (
              <span
                className={cn(
                  "shard-tag",
                  isMatched ? "shard-tag-active" : "shard-tag-muted"
                )}
                key={tag}
                style={{ maxWidth: "100%", fontWeight: 500 }}
              >
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  #{tag}
                </span>
              </span>
            )
          })}
          {visibleTags.length > 4 ? (
            <span
              className="shard-chip"
              style={{
                color: "var(--muted-foreground)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
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
