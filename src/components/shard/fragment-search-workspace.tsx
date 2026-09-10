import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LockKeyholeIcon,
  SearchIcon,
  XIcon,
  Trash2Icon,
} from "@/components/icons"
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"

import styles from "@/components/shard/fragment-search-workspace.module.css"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  toFragmentSearchDocument,
  type FragmentSearchHighlight,
  type FragmentSearchMatch,
  type FragmentSearchResponse,
  type FragmentSearchScope,
  type FragmentSearchWorkerRequest,
  type FragmentSearchWorkerResponse,
} from "@/lib/fragment-search"
import { LOCKBOX_TAG } from "@/lib/lockbox"
import { deriveKind, isTypeTag } from "@/lib/content-kind"
import { cn } from "@/lib/utils"
import type { Fragment } from "@/types"

const MAX_RESULTS = 80
const SEARCH_RESULTS_ID = "shard-search-results"

export interface FragmentSearchSession {
  activeIndex: number
  query: string
  resultIds: string[]
  resultScrollTop: number
  scope: FragmentSearchScope
  total: number
}

interface FragmentSearchWorkspaceProps {
  focusSignal: number
  contentType?: "all" | "fragments" | "notes"
  fragments: Fragment[]
  initialSession?: FragmentSearchSession | null
  lockboxSearchAvailable: boolean
  onExit: () => void
  onFilterFragments?: () => void
  onOpenFragment: (
    fragment: Fragment,
    session: FragmentSearchSession
  ) => void
}

export function FragmentSearchWorkspace({
  focusSignal,
  contentType = "all",
  fragments,
  initialSession = null,
  lockboxSearchAvailable,
  onExit,
  onFilterFragments,
  onOpenFragment,
}: FragmentSearchWorkspaceProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const isComposingRef = useRef(false)
  const latestRequestIdRef = useRef(0)
  const latestRequestKeyRef = useRef("")
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())
  const hasObservedInitialQueryRef = useRef(false)
  const restoredScrollRef = useRef(!initialSession)
  const versionRef = useRef(0)
  const viewportRef = useRef<HTMLDivElement>(null)
  const workerRef = useRef<Worker | null>(null)
  const [isIndexReady, setIsIndexReady] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [workerRestartKey, setWorkerRestartKey] = useState(0)
  const [query, setQuery] = useState(initialSession?.query ?? "")
  const [scope, setScope] = useState<FragmentSearchScope>(
    initialSession?.scope ?? "all"
  )
  const [searchResponse, setSearchResponse] = useState<FragmentSearchResponse>({
    matches: [],
    total: 0,
  })
  const [responseKey, setResponseKey] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(
    initialSession?.activeIndex ?? 0
  )
  const deferredQuery = useDeferredValue(query)
  const currentTrimmedQuery = query.trim()
  const trimmedQuery = deferredQuery.trim()
  const currentSearchKey = getSearchKey(currentTrimmedQuery, scope)
  const requestedSearchKey = getSearchKey(trimmedQuery, scope)
  const fragmentById = useMemo(
    () => new Map(fragments.map((fragment) => [fragment.id, fragment])),
    [fragments]
  )
  const visibleMatches = useMemo(
    () => {
      if (responseKey !== currentSearchKey) return []
      return searchResponse.matches.flatMap((match) => {
        const fragment = fragmentById.get(match.fragmentId)
        return fragment ? [{ fragment, match }] : []
      })
    },
    [currentSearchKey, fragmentById, responseKey, searchResponse.matches]
  )
  const activeOptionId = visibleMatches[selectedIndex]
    ? getOptionId(visibleMatches[selectedIndex].fragment.id)
    : undefined
  const isBusy = Boolean(currentTrimmedQuery) &&
    (!isIndexReady ||
      isSearching ||
      query !== deferredQuery ||
      responseKey !== currentSearchKey)

  useEffect(() => {
    const worker = new Worker(
      new URL("../../workers/fragment-search.worker.ts", import.meta.url),
      { type: "module" }
    )
    const version = versionRef.current + 1
    versionRef.current = version
    workerRef.current = worker
    setIsIndexReady(false)
    setIsSearching(Boolean(query.trim()))
    setSearchError(null)
    setSearchResponse({ matches: [], total: 0 })
    setResponseKey("")

    worker.onmessage = (
      event: MessageEvent<FragmentSearchWorkerResponse>
    ) => {
      const response = event.data
      if (response.version !== versionRef.current) return

      if (response.type === "ready") {
        setIsIndexReady(true)
        return
      }

      if (response.requestId !== latestRequestIdRef.current) return
      setSearchResponse(response.response)
      setResponseKey(latestRequestKeyRef.current)
      setIsSearching(false)
    }

    worker.onerror = () => {
      setIsIndexReady(false)
      setIsSearching(false)
      setSearchError("搜索索引暂时不可用")
    }

    worker.postMessage({
      documents: fragments.map(toFragmentSearchDocument),
      type: "index",
      version,
    } satisfies FragmentSearchWorkerRequest)

    return () => {
      worker.terminate()
      if (workerRef.current === worker) workerRef.current = null
    }
  }, [fragments, workerRestartKey])

  useEffect(() => {
    const worker = workerRef.current
    if (!trimmedQuery) {
      latestRequestIdRef.current += 1
      setSearchResponse({ matches: [], total: 0 })
      setResponseKey("")
      setIsSearching(false)
      return
    }
    if (!worker || !isIndexReady) {
      setIsSearching(true)
      return
    }

    const requestId = latestRequestIdRef.current + 1
    latestRequestIdRef.current = requestId
    latestRequestKeyRef.current = requestedSearchKey
    setSearchError(null)
    setIsSearching(true)
    worker.postMessage({
      limit: MAX_RESULTS,
      query: trimmedQuery,
      requestId,
      scope,
      type: "search",
      version: versionRef.current,
    } satisfies FragmentSearchWorkerRequest)
  }, [isIndexReady, requestedSearchKey, scope, trimmedQuery])

  useEffect(() => {
    inputRef.current?.focus()
    if (focusSignal > 0) inputRef.current?.select()
  }, [focusSignal])

  useEffect(() => {
    if (!hasObservedInitialQueryRef.current) {
      hasObservedInitialQueryRef.current = true
      return
    }
    setSelectedIndex(0)
    restoredScrollRef.current = true
  }, [scope, trimmedQuery])

  useEffect(() => {
    if (visibleMatches.length === 0) return
    setSelectedIndex((current) =>
      Math.min(current, visibleMatches.length - 1)
    )
  }, [visibleMatches.length])

  useEffect(() => {
    if (
      restoredScrollRef.current ||
      !initialSession ||
      visibleMatches.length === 0
    ) {
      return
    }

    const viewport = viewportRef.current
    if (viewport) viewport.scrollTop = initialSession.resultScrollTop
    restoredScrollRef.current = true
  }, [initialSession, visibleMatches.length])

  useEffect(() => {
    const selected = visibleMatches[selectedIndex]
    const viewport = viewportRef.current
    const option = selected
      ? optionRefs.current.get(selected.fragment.id)
      : null
    if (!viewport || !option) return

    const viewportRect = viewport.getBoundingClientRect()
    const optionRect = option.getBoundingClientRect()
    const gutter = 8

    if (optionRect.top < viewportRect.top + gutter) {
      viewport.scrollTop -= viewportRect.top + gutter - optionRect.top
    } else if (optionRect.bottom > viewportRect.bottom - gutter) {
      viewport.scrollTop += optionRect.bottom - viewportRect.bottom + gutter
    }
  }, [selectedIndex, visibleMatches])

  function openSelectedResult(index = selectedIndex) {
    if (isBusy) return
    const selected = visibleMatches[index]
    if (!selected) return

    onOpenFragment(selected.fragment, {
      activeIndex: index,
      query,
      resultIds: visibleMatches.map(({ fragment }) => fragment.id),
      resultScrollTop: viewportRef.current?.scrollTop ?? 0,
      scope,
      total: searchResponse.total,
    })
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault()
      onExit()
      return
    }

    if (isComposingRef.current || event.nativeEvent.isComposing) return
    if (visibleMatches.length === 0) return

    if (event.key === "ArrowDown") {
      event.preventDefault()
      setSelectedIndex((current) =>
        Math.min(current + 1, visibleMatches.length - 1)
      )
      return
    }

    if (event.key === "ArrowUp") {
      event.preventDefault()
      setSelectedIndex((current) => Math.max(current - 1, 0))
      return
    }

    if (event.key === "Enter") {
      event.preventDefault()
      openSelectedResult()
    }
  }

  function clearQuery() {
    setQuery("")
    setSelectedIndex(0)
    inputRef.current?.focus()
  }

  return (
    <section className={styles.workspace} role="search">
      <header className={styles.header}>
        <div className={cn("shard-content-measure", styles.headerContent)}>
          <div className={styles.searchRow}>
            <Button
              aria-label="退出搜索"
              className={styles.backButton}
              onClick={onExit}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ArrowLeftIcon aria-hidden="true" />
            </Button>
            <div className={styles.inputWrap}>
              <SearchIcon aria-hidden="true" className={styles.searchIcon} />
              <Input
                aria-activedescendant={activeOptionId}
                aria-autocomplete="list"
                aria-controls={SEARCH_RESULTS_ID}
                aria-expanded={visibleMatches.length > 0}
                aria-label="搜索内容"
                className={styles.input}
                onChange={(event) => setQuery(event.target.value)}
                onCompositionEnd={() => {
                  isComposingRef.current = false
                }}
                onCompositionStart={() => {
                  isComposingRef.current = true
                }}
                onKeyDown={handleKeyDown}
                placeholder={contentType === "fragments" ? "搜索碎片正文或标签" : contentType === "notes" ? "搜索文档正文或标签" : "搜索碎片与文档"}
                ref={inputRef}
                role="combobox"
                value={query}
              />
              {query ? (
                <Button
                  aria-label="清空搜索"
                  className={styles.clearButton}
                  onClick={clearQuery}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <XIcon aria-hidden="true" />
                </Button>
              ) : null}
            </div>
            <div className={styles.searchActions}>
            <div
              aria-label="搜索范围"
              className={styles.scopeGroup}
              role="group"
            >
              {(
                [
                  ["all", "全部"],
                  ["active", "未删除"],
                  ["archive", "回收站"],
                ] as const
              ).map(([value, label]) => (
                <button
                  aria-pressed={scope === value}
                  className={styles.scopeButton}
                  key={value}
                  onClick={() => setScope(value)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
            {onFilterFragments ? <Button size="sm" variant="ghost" onClick={onFilterFragments}>筛选碎片</Button> : null}
            </div>
          </div>

          <div className={styles.statusRow}>
            <div className={styles.statusGroup}>
              <span>{contentType === "fragments" ? "碎片" : contentType === "notes" ? "文档" : "碎片与文档"}</span>
              <span aria-hidden="true">·</span>
              <span>{formatScopeDescription(scope)}</span>
              <span aria-hidden="true">·</span>
              <span className={styles.lockboxState}>
                <LockKeyholeIcon aria-hidden="true" />
                {lockboxSearchAvailable ? "包含已解锁密匣" : "密匣未搜索"}
              </span>
            </div>
            <span className={styles.resultCount} aria-live="polite">
              {currentTrimmedQuery
                ? isBusy
                  ? "正在搜索"
                  : formatResultCount(searchResponse.total, MAX_RESULTS)
                : `${fragments.length} 条可搜索内容`}
            </span>
          </div>
        </div>
      </header>

      <ScrollArea
        className={styles.resultsViewport}
        viewportRef={viewportRef}
      >
        <div
          aria-busy={isBusy}
          className={cn("shard-content-measure", styles.results)}
          id={SEARCH_RESULTS_ID}
          role="listbox"
        >
          {searchError ? (
            <SearchError
              message={searchError}
              onRetry={() => setWorkerRestartKey((current) => current + 1)}
            />
          ) : !currentTrimmedQuery ? (
            <SearchIntro fragmentCount={fragments.length} />
          ) : isBusy && visibleMatches.length === 0 ? (
            <SearchSkeleton />
          ) : visibleMatches.length === 0 && !isBusy ? (
            <SearchEmpty query={query} scope={scope} />
          ) : (
            visibleMatches.map(({ fragment, match }, index) => (
              <SearchResultRow
                fragment={fragment}
                index={index}
                isSelected={index === selectedIndex}
                key={fragment.id}
                match={match}
                onOpen={() => openSelectedResult(index)}
                onSelect={() => setSelectedIndex(index)}
                optionRef={(element) => {
                  if (element) optionRefs.current.set(fragment.id, element)
                  else optionRefs.current.delete(fragment.id)
                }}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <footer className={styles.footer}>
        <span><ArrowUpIcon aria-hidden="true" /><ArrowDownIcon aria-hidden="true" />选择</span>
        <span><kbd>Enter</kbd>打开所在空间</span>
        <span><kbd>Esc</kbd>返回</span>
      </footer>
    </section>
  )
}

export function SearchContextBar({
  onBack,
  onClose,
  onNavigate,
  session,
}: {
  onBack: () => void
  onClose: () => void
  onNavigate: (index: number) => void
  session: FragmentSearchSession
}) {
  const canGoPrevious = session.activeIndex > 0
  const canGoNext = session.activeIndex < session.resultIds.length - 1

  return (
    <div className={styles.contextBar}>
      <div className={cn("shard-content-measure", styles.contextBarContent)}>
        <Button onClick={onBack} size="sm" type="button" variant="ghost">
          <SearchIcon aria-hidden="true" />
          返回搜索结果
        </Button>
        <span className={styles.contextQuery} title={session.query}>
          “{session.query}”
        </span>
        <span className={styles.contextPosition}>
          {Math.min(session.activeIndex + 1, session.resultIds.length)} / {session.resultIds.length}
          {session.total > session.resultIds.length
            ? `（前 ${session.resultIds.length}，共 ${session.total} 条）`
            : null}
        </span>
        <div className={styles.contextActions}>
          <Button
            aria-label="上一个搜索结果"
            disabled={!canGoPrevious}
            onClick={() => onNavigate(session.activeIndex - 1)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
          <Button
            aria-label="下一个搜索结果"
            disabled={!canGoNext}
            onClick={() => onNavigate(session.activeIndex + 1)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ChevronRightIcon aria-hidden="true" />
          </Button>
          <Button
            aria-label="结束搜索"
            onClick={onClose}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function SearchResultRow({
  fragment,
  index,
  isSelected,
  match,
  onOpen,
  onSelect,
  optionRef,
}: {
  fragment: Fragment
  index: number
  isSelected: boolean
  match: FragmentSearchMatch
  onOpen: () => void
  onSelect: () => void
  optionRef: (element: HTMLButtonElement | null) => void
}) {
  const visibleTags = fragment.tags.filter(
    (tag) => tag !== "inbox" && tag !== LOCKBOX_TAG && !isTypeTag(tag)
  )
  const date = formatSearchDate(fragment.createdAt)

  return (
    <button
      aria-selected={isSelected}
      className={styles.resultRow}
      data-selected={isSelected ? "true" : undefined}
      id={getOptionId(fragment.id)}
      onClick={onOpen}
      onMouseEnter={onSelect}
      ref={optionRef}
      role="option"
      type="button"
    >
      <div className={styles.dateRail}>
        <span className={styles.ordinal}>{String(index + 1).padStart(2, "0")}</span>
        <strong>{date.day}</strong>
        <span>{date.time}</span>
      </div>
      <div className={styles.resultBody}>
        <p className={styles.excerpt}>
          {match.excerptStartsBefore ? "…" : null}
          <HighlightedText
            highlights={match.highlights}
            text={match.excerpt}
          />
          {match.excerptEndsAfter ? "…" : null}
        </p>
        <div className={styles.metadata}>
          <span className={styles.stateBadge}>{deriveKind(fragment.tags) === "note" ? "文档" : "碎片"}</span>
          {fragment.archived ? (
            <span className={styles.stateBadge}><Trash2Icon aria-hidden="true" />回收站</span>
          ) : fragment.lockbox ? (
            <span className={styles.stateBadge}><LockKeyholeIcon aria-hidden="true" />密匣</span>
          ) : null}
          {visibleTags.slice(0, 4).map((tag) => (
            <span
              className={cn(
                styles.tag,
                match.matchedTags.includes(tag) && styles.matchedTag
              )}
              key={tag}
            >
              #{tag}
            </span>
          ))}
          {visibleTags.length > 4 ? (
            <span className={styles.moreTags}>+{visibleTags.length - 4}</span>
          ) : null}
        </div>
      </div>
      <span className={styles.openHint}>{isSelected ? "Enter 定位" : "定位"}</span>
    </button>
  )
}

function HighlightedText({
  highlights,
  text,
}: {
  highlights: FragmentSearchHighlight[]
  text: string
}) {
  if (highlights.length === 0) return text

  const parts: Array<{ highlighted: boolean; text: string }> = []
  let offset = 0
  for (const range of highlights) {
    if (range.start > offset) {
      parts.push({ highlighted: false, text: text.slice(offset, range.start) })
    }
    parts.push({ highlighted: true, text: text.slice(range.start, range.end) })
    offset = range.end
  }
  if (offset < text.length) {
    parts.push({ highlighted: false, text: text.slice(offset) })
  }

  return parts.map((part, index) =>
    part.highlighted ? (
      <mark key={index}>{part.text}</mark>
    ) : (
      <span key={index}>{part.text}</span>
    )
  )
}

function SearchIntro({ fragmentCount }: { fragmentCount: number }) {
  return (
    <div className={styles.intro}>
      <span className={styles.introIndex}>RECALL</span>
      <h2>找回你记得的那句话</h2>
      <p>
        输入正文或标签名称，搜索当前范围中的 {fragmentCount} 条内容。
      </p>
      <div className={styles.introHints}>
        <span><kbd>↑</kbd><kbd>↓</kbd>浏览结果</span>
        <span><kbd>Enter</kbd>打开所在空间</span>
        <span><kbd>Esc</kbd>回到搜索前现场</span>
      </div>
    </div>
  )
}

function SearchSkeleton() {
  return (
    <div aria-label="正在准备搜索" className={styles.skeletonList}>
      {Array.from({ length: 5 }, (_, index) => (
        <div className={styles.skeletonRow} key={index}>
          <span />
          <div><i /><i /></div>
        </div>
      ))}
    </div>
  )
}

function SearchEmpty({
  query,
  scope,
}: {
  query: string
  scope: FragmentSearchScope
}) {
  return (
    <div className={styles.empty}>
      <SearchIcon aria-hidden="true" />
      <h2>没有找到“{query.trim()}”</h2>
      <p>
        {scope === "all"
          ? "试试缩短关键词，或换用内容里出现过的标签。"
          : `当前只搜索${scope === "active" ? "未删除" : "回收站中"}的内容，可切换到“全部”再试。`}
      </p>
    </div>
  )
}

function SearchError({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className={styles.empty}>
      <SearchIcon aria-hidden="true" />
      <h2>{message}</h2>
      <p>查询和当前时间线位置都已保留，可以重新准备索引。</p>
      <Button onClick={onRetry} type="button" variant="outline">
        重试
      </Button>
    </div>
  )
}

function formatSearchDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { day: "未知", time: "" }

  return {
    day: new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
    }).format(date),
    time: new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date),
  }
}

function formatResultCount(total: number, limit: number) {
  return total > limit ? `${total} 条，显示前 ${limit} 条` : `${total} 条结果`
}

function formatScopeDescription(scope: FragmentSearchScope) {
  if (scope === "active") return "只看未删除"
  if (scope === "archive") return "只看回收站"
  return "包含回收站"
}

function getOptionId(fragmentId: string) {
  return `shard-search-result-${fragmentId.replace(/[^a-zA-Z0-9_-]/gu, "-")}`
}

function getSearchKey(query: string, scope: FragmentSearchScope) {
  return `${scope}\u0000${query}`
}
