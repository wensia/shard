import { useEffect, useMemo, useRef, useState, type UIEvent } from "react"
import { InboxIcon } from "lucide-react"

import { FragmentCard } from "@/components/shard/fragment-card"
import { MindMapTimelineCard } from "@/components/shard/mind-map-timeline-card"
import type { Fragment, MindMapSummary } from "@/types"

const WIDE_TIMELINE_QUERY = "(min-width: 96rem)"

interface FragmentTimelineProps {
  editingFragmentId?: string | null
  emptyMessage?: string
  fragments: Fragment[]
  isLoading: boolean
  knownTags?: string[]
  mindMaps?: MindMapSummary[]
  onArchive?: (fragment: Fragment) => void
  onCancelEdit?: () => void
  onEdit?: (fragment: Fragment) => void
  onExportImage?: (fragment: Fragment) => void
  onOpenMindMap?: (map: MindMapSummary) => void
  onMoveToLockbox?: (fragment: Fragment) => void
  onOpenZen?: (fragment: Fragment) => void
  onPin?: (fragment: Fragment) => void
  onScrollDown?: () => void
  onScrollToFragmentComplete?: (fragmentId: string) => void
  onSave?: (id: string, content: string, tags: string[]) => Promise<Fragment>
  onToggleTask?: (fragment: Fragment, lineIndex: number) => void
  scrollToFragmentId?: string | null
  vaultPath?: string
}

export function FragmentTimeline({
  editingFragmentId = null,
  emptyMessage = "还没有片段。写下第一条，按 Cmd/Ctrl+Enter 保存。",
  fragments,
  isLoading,
  knownTags = [],
  mindMaps = [],
  onArchive,
  onCancelEdit,
  onEdit,
  onExportImage,
  onOpenMindMap,
  onMoveToLockbox,
  onOpenZen,
  onPin,
  onScrollDown,
  onScrollToFragmentComplete,
  onSave,
  onToggleTask,
  scrollToFragmentId = null,
  vaultPath,
}: FragmentTimelineProps) {
  const lastScrollTopRef = useRef(0)
  const highlightFrameRef = useRef<number | null>(null)
  const highlightTimeoutRef = useRef<number | null>(null)
  const programmaticScrollFrameRef = useRef<number | null>(null)
  const programmaticScrollRef = useRef(false)
  const programmaticScrollTimeoutRef = useRef<number | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [highlightedFragmentId, setHighlightedFragmentId] = useState<
    string | null
  >(null)
  const [usesWaterfallColumns, setUsesWaterfallColumns] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia(WIDE_TIMELINE_QUERY).matches
  )
  const timelineItems = useMemo(
    () => buildTimelineItems(fragments, mindMaps),
    [fragments, mindMaps]
  )
  const timelineColumns = useMemo(
    () => splitIntoColumns(timelineItems, usesWaterfallColumns ? 2 : 1),
    [timelineItems, usesWaterfallColumns]
  )

  useEffect(() => {
    const mediaQuery = window.matchMedia(WIDE_TIMELINE_QUERY)

    function handleTimelineWidthChange() {
      setUsesWaterfallColumns(mediaQuery.matches)
    }

    handleTimelineWidthChange()
    mediaQuery.addEventListener("change", handleTimelineWidthChange)

    return () => {
      mediaQuery.removeEventListener("change", handleTimelineWidthChange)
    }
  }, [])

  useEffect(() => {
    return () => {
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
    }
  }, [])

  useEffect(() => {
    if (!scrollToFragmentId || isLoading) return

    let retryFrame = 0
    const frame = window.requestAnimationFrame(() => {
      const didScroll = scrollFragmentIntoViewport(
        viewportRef.current,
        scrollToFragmentId,
        (targetScrollTop, behavior) => {
          beginProgrammaticViewportScroll(
            targetScrollTop,
            behavior,
            scrollToFragmentId
          )
        }
      )

      if (didScroll) {
        onScrollToFragmentComplete?.(scrollToFragmentId)
        return
      }

      retryFrame = window.requestAnimationFrame(() => {
        const didRetryScroll = scrollFragmentIntoViewport(
          viewportRef.current,
          scrollToFragmentId,
          (targetScrollTop, behavior) => {
            beginProgrammaticViewportScroll(
              targetScrollTop,
              behavior,
              scrollToFragmentId
            )
          }
        )

        if (didRetryScroll) {
          onScrollToFragmentComplete?.(scrollToFragmentId)
        }
      })
    })

    return () => {
      window.cancelAnimationFrame(frame)
      if (retryFrame) window.cancelAnimationFrame(retryFrame)
    }
  }, [
    isLoading,
    onScrollToFragmentComplete,
    scrollToFragmentId,
    timelineColumns,
  ])

  function handleViewportScroll(event: UIEvent<HTMLDivElement>) {
    const nextScrollTop = event.currentTarget.scrollTop

    if (programmaticScrollRef.current) {
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
      () => clearProgrammaticViewportScroll(fragmentId),
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
    flashFragmentCard(fragmentId)
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={handleViewportScroll}
        ref={viewportRef}
      >
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm font-medium text-muted-foreground">
            正在读取 Shard vault...
          </div>
        ) : timelineItems.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
            <InboxIcon className="size-8" />
            <div className="text-sm font-semibold text-balance">
              {emptyMessage}
            </div>
          </div>
        ) : (
          <div className="shard-content-inset pb-[var(--shard-space-8)]">
            <div className="shard-content-measure grid grid-cols-1 items-start gap-[var(--shard-card-gap)] 2xl:grid-cols-2">
              {timelineColumns.map((column, columnIndex) => (
                <div
                  className="flex min-w-0 flex-col gap-[var(--shard-card-gap)]"
                  key={columnIndex}
                >
                  {column.map((item) =>
                    item.kind === "fragment" ? (
                      <FragmentCard
                        fragment={item.fragment}
                        isHighlighted={highlightedFragmentId === item.fragment.id}
                        isEditing={editingFragmentId === item.fragment.id}
                        key={item.id}
                        knownTags={knownTags}
                        onArchive={onArchive}
                        onCancelEdit={onCancelEdit}
                        onEdit={onEdit}
                        onExportImage={onExportImage}
                        onMoveToLockbox={onMoveToLockbox}
                        onOpenZen={onOpenZen}
                        onPin={onPin}
                        onSave={onSave}
                        onToggleTask={onToggleTask}
                        vaultPath={vaultPath}
                      />
                    ) : (
                      <MindMapTimelineCard
                        key={item.id}
                        map={item.map}
                        onOpen={onOpenMindMap}
                      />
                    )
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function scrollFragmentIntoViewport(
  viewport: HTMLDivElement | null,
  fragmentId: string,
  beforeScroll: (targetScrollTop: number, behavior: ScrollBehavior) => void
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
  const behavior: ScrollBehavior = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches
    ? "auto"
    : "smooth"

  beforeScroll(nextScrollTop, behavior)
  viewport.scrollTo({
    behavior,
    top: nextScrollTop,
  })

  return true
}

function getCssPx(element: Element, property: string, fallback: number) {
  const value = window.getComputedStyle(element).getPropertyValue(property)
  const parsed = Number.parseFloat(value)

  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

type TimelineItem =
  | {
      id: string
      kind: "fragment"
      fragment: Fragment
      pinned: boolean
      timestamp: string
    }
  | {
      id: string
      kind: "mindMap"
      map: MindMapSummary
      pinned: false
      timestamp: string
    }

function buildTimelineItems(
  fragments: Fragment[],
  mindMaps: MindMapSummary[]
): TimelineItem[] {
  return [
    ...fragments.map((fragment) => ({
      id: `fragment:${fragment.id}`,
      kind: "fragment" as const,
      fragment,
      pinned: fragment.pinned,
      timestamp: fragment.createdAt,
    })),
    ...mindMaps.map((map) => ({
      id: `mind-map:${map.id}`,
      kind: "mindMap" as const,
      map,
      pinned: false as const,
      timestamp: map.createdAt,
    })),
  ].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.timestamp.localeCompare(a.timestamp)
  })
}

function splitIntoColumns(items: TimelineItem[], columnCount: number) {
  const columns = Array.from({ length: columnCount }, () => [] as TimelineItem[])

  items.forEach((item, index) => {
    columns[index % columnCount].push(item)
  })

  return columns
}
