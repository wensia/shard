import { useEffect, useMemo, useRef, useState, type UIEvent } from "react"
import { InboxIcon } from "lucide-react"

import { FragmentCard } from "@/components/shard/fragment-card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useFragmentRelations } from "@/lib/use-fragment-relations"
import type { Fragment } from "@/types"

const WIDE_TIMELINE_QUERY = "(min-width: 96rem)"

interface FragmentTimelineProps {
  editingFragmentId?: string | null
  emptyMessage?: string
  fragments: Fragment[]
  isLoading: boolean
  knownTags?: string[]
  onArchive?: (fragment: Fragment) => void
  onCancelEdit?: () => void
  onEdit?: (fragment: Fragment) => void
  onExportImage?: (fragment: Fragment) => void
  onLinkFragment?: (
    sourceId: string,
    targetId: string
  ) => Promise<void> | void
  onMoveToLockbox?: (fragment: Fragment) => void
  onOpenZen?: (fragment: Fragment) => void
  onPin?: (fragment: Fragment) => void
  onNavigateToFragment?: (fragmentId: string) => void
  onScrollDown?: () => void
  onScrollToFragmentComplete?: (fragmentId: string) => void
  onSave?: (id: string, content: string, tags: string[]) => Promise<Fragment>
  onToggleTask?: (fragment: Fragment, lineIndex: number) => void
  onUnlinkFragment?: (
    sourceId: string,
    targetId: string
  ) => Promise<void> | void
  scrollToFragmentId?: string | null
  vaultPath?: string
}

export function FragmentTimeline({
  editingFragmentId = null,
  emptyMessage = "还没有片段。写下第一条，按 Cmd/Ctrl+Enter 保存。",
  fragments,
  isLoading,
  knownTags = [],
  onArchive,
  onCancelEdit,
  onEdit,
  onExportImage,
  onLinkFragment,
  onMoveToLockbox,
  onNavigateToFragment,
  onOpenZen,
  onPin,
  onScrollDown,
  onScrollToFragmentComplete,
  onSave,
  onToggleTask,
  onUnlinkFragment,
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
  // 关系 worker 挂在时间线层级，整条时间线共用一个实例
  const { requestRelated } = useFragmentRelations(fragments)
  const [highlightedFragmentId, setHighlightedFragmentId] = useState<
    string | null
  >(null)
  const [usesWaterfallColumns, setUsesWaterfallColumns] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia(WIDE_TIMELINE_QUERY).matches
  )
  const timelineItems = useMemo(() => buildTimelineItems(fragments), [fragments])
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
    <div style={{ display: "flex", minHeight: 0, flex: 1, flexDirection: "column" }}>
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
        ) : timelineItems.length === 0 ? (
          <div
            className="flex h-full items-center justify-center gap-3"
            style={{
              flexDirection: "column",
              textAlign: "center",
              color: "var(--muted-foreground)",
            }}
          >
            <InboxIcon size={32} />
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
        ) : (
          <div
            className="shard-content-inset"
            style={{ paddingBottom: "var(--shard-space-8)" }}
          >
            <div
              className="shard-content-measure"
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${usesWaterfallColumns ? 2 : 1}, minmax(0, 1fr))`,
                alignItems: "start",
                gap: "var(--shard-space-4)",
              }}
            >
              {timelineColumns.map((column, columnIndex) => (
                <div
                  key={columnIndex}
                  style={{
                    display: "flex",
                    minWidth: 0,
                    flexDirection: "column",
                    gap: "var(--shard-space-4)",
                  }}
                >
                  {column.map((item) => (
                    <FragmentCard
                      fragment={item.fragment}
                      fragments={fragments}
                      isHighlighted={highlightedFragmentId === item.fragment.id}
                      isEditing={editingFragmentId === item.fragment.id}
                      key={item.id}
                      knownTags={knownTags}
                      onArchive={onArchive}
                      onCancelEdit={onCancelEdit}
                      onEdit={onEdit}
                      onExportImage={onExportImage}
                      onLinkFragment={onLinkFragment}
                      onMoveToLockbox={onMoveToLockbox}
                      onNavigateToFragment={onNavigateToFragment}
                      onOpenZen={onOpenZen}
                      onPin={onPin}
                      onSave={onSave}
                      onToggleTask={onToggleTask}
                      onUnlinkFragment={onUnlinkFragment}
                      requestRelated={requestRelated}
                      vaultPath={vaultPath}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </ScrollArea>
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

function splitIntoColumns(items: TimelineItem[], columnCount: number) {
  const columns = Array.from({ length: columnCount }, () => [] as TimelineItem[])

  items.forEach((item, index) => {
    columns[index % columnCount].push(item)
  })

  return columns
}
