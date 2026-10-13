import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from "react"
import { InboxIcon, type ShardIcon } from "@/components/icons"

import { FragmentCard } from "@/components/shard/fragment-card"
import { FragmentMasonry } from "@/components/shard/fragment-masonry"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { createDomSearchRevealHandle } from "@/lib/search-dom-highlight"
import type { SearchRevealHandle } from "@/lib/search-contract"
import { useFragmentRelations } from "@/lib/use-fragment-relations"
import type { CsvFileSummary, Fragment } from "@/types"
import styles from "./fragment-timeline.module.css"

const RENDER_BATCH = 40
const timelinePositions = new Map<string, { top: number; count: number }>()

interface FragmentTimelineProps {
  csvFiles?: CsvFileSummary[]
  editingFragmentId?: string | null
  emptyIcon?: ShardIcon
  emptyMessage?: string
  footer?: ReactNode
  fragments: Fragment[]
  isLoading: boolean
  knownTags?: string[]
  onArchive?: (fragment: Fragment) => void
  onCancelEdit?: () => void
  onRegisterEditorFlush?: (flush: (() => Promise<boolean>) | null) => void
  onEdit?: (fragment: Fragment) => void
  onExportImage?: (fragment: Fragment) => void
  onOpenTag?: (tag: string) => void
  onOpenZen?: (fragment: Fragment) => void
  onPin?: (fragment: Fragment) => void
  onRefreshFragments?: () => Promise<void> | void
  onRequestOutlineUpgrade?: (fragmentId: string) => Promise<void> | void
  onNavigateToFragment?: (fragmentId: string) => void
  onScrollDown?: () => void
  onScrollToFragmentComplete?: (
    fragmentId: string,
    navigationId?: string,
    reveal?: SearchRevealHandle | null
  ) => void
  onSave?: (
    id: string,
    content: string,
    tags: string[],
    expectedFileSha?: string
  ) => Promise<Fragment>
  onToggleTask?: (fragment: Fragment, lineIndex: number) => void
  onUnlinkFragment?: (
    sourceId: string,
    targetId: string
  ) => Promise<void> | void
  /**
   * 关联候选与反链索引的数据域。展示列表可以是切片（如捕捉页最近 5 条），
   * 但关联目标必须能指向全量，不传时退回展示列表。
   */
  relationFragments?: Fragment[]
  scrollToFragmentId?: string | null
  scrollNavigationId?: string | null
  /** Include vault and active filters; changing scope resets the render window. */
  scopeKey?: string
  /**
   * card：卡片流（默认，容器背景为 --background 时用）。
   * flat：扁平列表，条目透明底、细实线分割（容器背景本身是 --card 时用，如资料库中列）。
   */
  variant?: "card" | "flat"
  vaultPath?: string
}

export function FragmentTimeline({
  csvFiles = [],
  editingFragmentId = null,
  emptyIcon: EmptyIcon = InboxIcon,
  emptyMessage = "还没有片段。写下第一条，按 Cmd/Ctrl+Enter 保存。",
  footer,
  fragments,
  isLoading,
  knownTags = [],
  onArchive,
  onCancelEdit,
  onRegisterEditorFlush,
  onEdit,
  onExportImage,
  onOpenTag,
  onNavigateToFragment,
  onOpenZen,
  onPin,
  onRefreshFragments,
  onRequestOutlineUpgrade,
  onScrollDown,
  onScrollToFragmentComplete,
  onSave,
  onToggleTask,
  onUnlinkFragment,
  relationFragments = fragments,
  scrollToFragmentId = null,
  scrollNavigationId = null,
  scopeKey,
  variant = "card",
  vaultPath,
}: FragmentTimelineProps) {
  const [renderWindow, setRenderWindow] = useState(() => ({
    scope: scopeKey,
    count: scopeKey ? timelinePositions.get(scopeKey)?.count ?? RENDER_BATCH : RENDER_BATCH,
  }))
  const renderLimit = renderWindow.scope === scopeKey ? renderWindow.count
    : scopeKey ? timelinePositions.get(scopeKey)?.count ?? RENDER_BATCH : RENDER_BATCH
  const savedRenderLimitRef = useRef(renderLimit)
  const restorePositionRef = useRef<number | null>(null)
  const lastScrollTopRef = useRef(0)
  const highlightFrameRef = useRef<number | null>(null)
  const highlightTimeoutRef = useRef<number | null>(null)
  const programmaticScrollFrameRef = useRef<number | null>(null)
  const programmaticScrollRef = useRef(false)
  const programmaticScrollTimeoutRef = useRef<number | null>(null)
  const completedScrollTargetRef = useRef<string | null>(null)
  const positionedEditorIdRef = useRef<string | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const layoutScrollFrameRef = useRef<number | null>(null)
  const layoutScrollingRef = useRef(false)
  const suppressLayoutScroll = useCallback(() => {
    layoutScrollingRef.current = true
    if (layoutScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(layoutScrollFrameRef.current)
    }
    layoutScrollFrameRef.current = window.requestAnimationFrame(() => {
      layoutScrollingRef.current = false
      layoutScrollFrameRef.current = null
    })
  }, [])
  // 关系 worker 挂在时间线层级，整条时间线共用一个实例
  const { indexVersion, requestRelated } = useFragmentRelations(relationFragments)
  const [highlightedFragmentId, setHighlightedFragmentId] = useState<
    string | null
  >(null)
  const searchRevealHandle = useMemo(
    () =>
      createDomSearchRevealHandle({
        getCard(target) {
          if (!target.objectId) return null
          return findFragmentCard(viewportRef.current, target.objectId)
        },
        getRoot(_target, card) {
          return card.querySelector<HTMLElement>("[data-markdown-search-root='true']")
        },
        getViewport() {
          return viewportRef.current
        },
        scrollRange(range, viewport) {
          return scrollSearchRangeIntoViewport(range, viewport)
        },
        showCardOutline(target) {
          if (target.objectId) flashFragmentCard(target.objectId)
        },
      }),
    []
  )
  const timelineItems = useMemo(() => buildTimelineItems(fragments.slice(0, renderLimit)), [fragments, renderLimit])

  useLayoutEffect(() => {
    const saved = scopeKey ? timelinePositions.get(scopeKey) : undefined
    restorePositionRef.current = saved?.top ?? 0
    setRenderWindow({ scope: scopeKey, count: saved?.count ?? RENDER_BATCH })
    return () => {
      if (scopeKey) timelinePositions.set(scopeKey, {
        // StrictMode may clean up before masonry applies the saved position.
        top: restorePositionRef.current ?? lastScrollTopRef.current,
        count: savedRenderLimitRef.current,
      })
    }
  }, [scopeKey])

  useLayoutEffect(() => {
    savedRenderLimitRef.current = renderLimit
  }, [renderLimit])

  useEffect(() => {
    if (!scrollToFragmentId) return
    const targetIndex = fragments.findIndex((fragment) => fragment.id === scrollToFragmentId)
    if (targetIndex < renderLimit) return
    const frame = window.requestAnimationFrame(() => {
      setRenderWindow({ scope: scopeKey, count: Math.min(renderLimit + RENDER_BATCH, targetIndex + 1) })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [fragments, renderLimit, scopeKey, scrollToFragmentId])

  const scrollTargetIdentity = scrollToFragmentId
    ? `${scrollNavigationId ?? "browse"}:${scrollToFragmentId}`
    : null

  useEffect(() => {
    completedScrollTargetRef.current = null
  }, [scrollTargetIdentity])

  useEffect(() => {
    return () => {
      if (layoutScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(layoutScrollFrameRef.current)
      }
      if (highlightFrameRef.current !== null) {
        window.cancelAnimationFrame(highlightFrameRef.current)
      }
      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current)
      }
      if (programmaticScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(programmaticScrollFrameRef.current)
      }
      if (programmaticScrollTimeoutRef.current !== null) {
        window.clearTimeout(programmaticScrollTimeoutRef.current)
      }
      searchRevealHandle.clearHits("unmount")
    }
  }, [searchRevealHandle])

  // Navigation runs after measured geometry is applied. Keep its target until
  // scrolling settles, so late image/editor resizes can re-align it first.
  function handleTimelineLayout(beforeNavigate: () => void) {
    if (!scrollToFragmentId && restorePositionRef.current !== null && !isLoading) {
      const viewport = viewportRef.current
      if (viewport) {
        beforeNavigate()
        suppressLayoutScroll()
        viewport.scrollTop = restorePositionRef.current
        lastScrollTopRef.current = viewport.scrollTop
        restorePositionRef.current = null
        return true
      }
    }
    const enteringEditor = editingFragmentId !== positionedEditorIdRef.current
    positionedEditorIdRef.current = editingFragmentId
    if (enteringEditor && editingFragmentId && !isLoading
      && (!scrollToFragmentId || completedScrollTargetRef.current === scrollTargetIdentity)) {
      const viewport = viewportRef.current
      const card = findFragmentCard(viewport, editingFragmentId)
      if (viewport && card) {
        // 阅读态允许时间戳滚出顶部；编辑态正文取代时间戳，必须露出编辑区上缘。
        // 仅在进入编辑这一帧修正 timeline，不能持续劫持用户后续的滚动。
        beforeNavigate()
        const delta = card.getBoundingClientRect().top - viewport.getBoundingClientRect().top
        if (delta < 0) {
          suppressLayoutScroll()
          viewport.scrollTop += delta
          lastScrollTopRef.current = viewport.scrollTop
        }
        return true
      }
    }
    if (!scrollToFragmentId || isLoading
      || completedScrollTargetRef.current === scrollTargetIdentity) return false
    beforeNavigate()
    return scrollFragmentIntoViewport(
      viewportRef.current,
      scrollToFragmentId,
      (targetScrollTop, behavior) => {
        beginProgrammaticViewportScroll(targetScrollTop, behavior, scrollToFragmentId)
      }
    )
  }

  function handleViewportScroll(event: UIEvent<HTMLDivElement>) {
    const nextScrollTop = event.currentTarget.scrollTop
    const viewport = event.currentTarget
    if (!isLoading && renderLimit < fragments.length
      && viewport.scrollHeight - nextScrollTop - viewport.clientHeight < viewport.clientHeight) {
      setRenderWindow({ scope: scopeKey, count: renderLimit + RENDER_BATCH })
    }

    if (programmaticScrollRef.current || layoutScrollingRef.current) {
      lastScrollTopRef.current = nextScrollTop
      return
    }

    if (nextScrollTop > lastScrollTopRef.current + 2) {
      onScrollDown?.()
    }

    lastScrollTopRef.current = nextScrollTop
  }

  function beginProgrammaticViewportScroll(
    targetScrollTop: number,
    behavior: ScrollBehavior,
    fragmentId: string
  ) {
    programmaticScrollRef.current = true

    if (programmaticScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(programmaticScrollFrameRef.current)
    }
    if (programmaticScrollTimeoutRef.current !== null) {
      window.clearTimeout(programmaticScrollTimeoutRef.current)
    }

    if (behavior === "auto") {
      programmaticScrollFrameRef.current = window.requestAnimationFrame(
        () => clearProgrammaticViewportScroll(fragmentId)
      )
      return
    }

    function waitForSmoothScrollToSettle() {
      const viewport = viewportRef.current
      if (!viewport || Math.abs(viewport.scrollTop - targetScrollTop) <= 1) {
        programmaticScrollFrameRef.current = window.requestAnimationFrame(
          () => clearProgrammaticViewportScroll(fragmentId)
        )
        return
      }

      programmaticScrollFrameRef.current = window.requestAnimationFrame(
        waitForSmoothScrollToSettle
      )
    }

    programmaticScrollFrameRef.current = window.requestAnimationFrame(
      waitForSmoothScrollToSettle
    )
    programmaticScrollTimeoutRef.current = window.setTimeout(
      () => {
        // A WebView may interrupt a smooth animation when its scroll extent
        // changes. Finish at the current measured target before acknowledging it.
        const didScroll = scrollFragmentIntoViewport(
          viewportRef.current,
          fragmentId,
          (top, nextBehavior) => beginProgrammaticViewportScroll(top, nextBehavior, fragmentId),
          "auto"
        )
        if (!didScroll) clearProgrammaticViewportScroll(fragmentId)
      },
      700
    )
  }

  function clearProgrammaticViewportScroll(fragmentId: string) {
    if (programmaticScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(programmaticScrollFrameRef.current)
    }
    if (programmaticScrollTimeoutRef.current !== null) {
      window.clearTimeout(programmaticScrollTimeoutRef.current)
    }

    const viewport = viewportRef.current
    if (viewport) {
      lastScrollTopRef.current = viewport.scrollTop
    }

    programmaticScrollRef.current = false
    programmaticScrollFrameRef.current = null
    programmaticScrollTimeoutRef.current = null
    completedScrollTargetRef.current = `${scrollNavigationId ?? "browse"}:${fragmentId}`
    restorePositionRef.current = null
    flashFragmentCard(fragmentId)
    const target = fragments.find((fragment) => fragment.id === fragmentId)
    const reveal = target?.kind === "fragment" && editingFragmentId !== fragmentId
      ? searchRevealHandle
      : null
    onScrollToFragmentComplete?.(
      fragmentId,
      scrollNavigationId ?? undefined,
      reveal
    )
  }

  function scrollSearchRangeIntoViewport(range: Range, viewport: HTMLElement) {
    const rangeRect = range.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    const inset = getCssPx(viewport, "--shard-card-gap", 16)
    let delta = 0
    if (rangeRect.top < viewportRect.top + inset) {
      delta = rangeRect.top - viewportRect.top - inset
    } else if (rangeRect.bottom > viewportRect.bottom - inset) {
      delta = rangeRect.bottom - viewportRect.bottom + inset
    }
    if (Math.abs(delta) <= 1) return

    programmaticScrollRef.current = true
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    viewport.scrollTop = clamp(viewport.scrollTop + delta, 0, maxScrollTop)
    return new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        lastScrollTopRef.current = viewport.scrollTop
        programmaticScrollRef.current = false
        resolve()
      })
    })
  }

  function flashFragmentCard(fragmentId: string) {
    if (highlightFrameRef.current !== null) {
      window.cancelAnimationFrame(highlightFrameRef.current)
    }
    if (highlightTimeoutRef.current !== null) {
      window.clearTimeout(highlightTimeoutRef.current)
    }

    setHighlightedFragmentId(null)
    highlightFrameRef.current = window.requestAnimationFrame(() => {
      setHighlightedFragmentId(fragmentId)
      highlightFrameRef.current = null
    })
    highlightTimeoutRef.current = window.setTimeout(() => {
      setHighlightedFragmentId((current) =>
        current === fragmentId ? null : current
      )
      highlightTimeoutRef.current = null
    }, 1400)
  }

  return (
    <div className={styles.root}>
      <ScrollArea
        className="min-h-0 flex-1"
        onViewportScroll={handleViewportScroll}
        viewportRef={viewportRef}
      >
        {isLoading ? (
          <div
            style={{
              display: "flex",
              height: "100%",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "var(--font-size-sm)",
              fontWeight: "var(--font-weight-medium)",
              color: "var(--muted-foreground)",
            }}
          >
            正在读取 Shard vault...
          </div>
        ) : (
          <>
          {timelineItems.length === 0 ? (
          <div
            className="flex h-full items-center justify-center gap-3"
            style={{
              flexDirection: "column",
              textAlign: "center",
              color: "var(--muted-foreground)",
            }}
          >
            <EmptyIcon className="size-(--shard-icon-size-xl)" />
            <div
              style={{
                fontSize: "var(--font-size-sm)",
                fontWeight: "var(--font-weight-semibold)",
                textWrap: "balance",
              }}
            >
              {emptyMessage}
            </div>
          </div>
          ) : null}
          <div
            className="shard-content-inset"
            style={{ paddingBottom: timelineItems.length ? "var(--shard-space-8)" : 0 }}
          >
            <FragmentMasonry
              key={scopeKey}
              layoutKey={JSON.stringify([isLoading, scrollTargetIdentity, editingFragmentId, timelineItems.map((item) => item.id)])}
              renderLimit={renderLimit}
              onBeforeScroll={suppressLayoutScroll}
              onLayout={handleTimelineLayout}
              variant={variant}
              viewportRef={viewportRef}
            >
              {timelineItems.map((item) => (
                <div
                  className="shard-timeline-item"
                  data-timeline-item-id={item.fragment.id}
                  key={item.id}
                >
                  <FragmentCard
                    csvFiles={csvFiles}
                    fragment={item.fragment}
                    fragments={relationFragments}
                    variant={variant}
                    isHighlighted={highlightedFragmentId === item.fragment.id}
                    isEditing={editingFragmentId === item.fragment.id}
                    knownTags={knownTags}
                    onArchive={onArchive}
                    onCancelEdit={onCancelEdit}
                    onRegisterEditorFlush={onRegisterEditorFlush}
                    onEdit={onEdit}
                    onExportImage={onExportImage}
                    onOpenTag={onOpenTag}
                    onNavigateToFragment={onNavigateToFragment}
                    onOpenZen={onOpenZen}
                    onPin={onPin}
                    onRefreshFragments={onRefreshFragments}
                    onRequestOutlineUpgrade={onRequestOutlineUpgrade}
                    onSave={onSave}
                    onToggleTask={onToggleTask}
                    onUnlinkFragment={onUnlinkFragment}
                    relationIndexVersion={indexVersion}
                    requestRelated={requestRelated}
                    vaultPath={vaultPath}
                  />
                </div>
              ))}
            </FragmentMasonry>
            {renderLimit < fragments.length ? (
              <div className={styles.loadMore}>
                <Button size="sm" variant="outline" onClick={() => {
                  setRenderWindow({ scope: scopeKey, count: renderLimit + RENDER_BATCH })
                }}>显示更多碎片</Button>
              </div>
            ) : null}
            {footer}
          </div>
          </>
        )}
      </ScrollArea>
    </div>
  )
}

function scrollFragmentIntoViewport(
  viewport: HTMLDivElement | null,
  fragmentId: string,
  beforeScroll: (targetScrollTop: number, behavior: ScrollBehavior) => void,
  behaviorOverride?: ScrollBehavior
) {
  if (!viewport) return false

  const target = Array.from(
    viewport.querySelectorAll<HTMLElement>("[data-shard-fragment-id]")
  ).find(
    (element) => element.getAttribute("data-shard-fragment-id") === fragmentId
  )

  if (!target) return false

  const viewportRect = viewport.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const topInset = getCssPx(viewport, "--shard-card-gap", 16)
  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
  const nextScrollTop = clamp(
    viewport.scrollTop + targetRect.top - viewportRect.top - topInset,
    0,
    maxScrollTop
  )
  const behavior: ScrollBehavior = behaviorOverride ?? (window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches
    ? "auto"
    : "smooth")

  beforeScroll(nextScrollTop, behavior)
  viewport.scrollTo({
    behavior,
    top: nextScrollTop,
  })

  return true
}

function findFragmentCard(
  viewport: HTMLElement | null,
  fragmentId: string
) {
  if (!viewport) return null
  return Array.from(
    viewport.querySelectorAll<HTMLElement>("[data-shard-fragment-id]")
  ).find(
    (element) => element.getAttribute("data-shard-fragment-id") === fragmentId
  ) ?? null
}

function getCssPx(element: Element, property: string, fallback: number) {
  const value = window.getComputedStyle(element).getPropertyValue(property)
  const parsed = Number.parseFloat(value)

  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

type TimelineItem = {
  id: string
  fragment: Fragment
  pinned: boolean
  timestamp: string
}

function buildTimelineItems(fragments: Fragment[]): TimelineItem[] {
  return fragments
    .map((fragment) => ({
      id: `fragment:${fragment.id}`,
      fragment,
      pinned: fragment.pinned,
      timestamp: fragment.createdAt,
    }))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.timestamp.localeCompare(a.timestamp)
    })
}
