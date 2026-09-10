import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react"

import { layoutMasonry } from "@/lib/masonry-layout"

type Position = { id: string; top: number; height: number }

interface FragmentMasonryProps {
  children: ReactNode
  /** Ordered item identity and explicit navigation changes that need a layout pass. */
  layoutKey: string
  onBeforeScroll: () => void
  /** Returns true while explicit fragment navigation owns the viewport. */
  onLayout: () => boolean
  variant: "card" | "flat"
  viewportRef: RefObject<HTMLDivElement | null>
}

/**
 * One keyed sibling list owns card identity. Measurement never updates React
 * state or reparses Markdown, and changing columns never remounts an editor.
 */
export function FragmentMasonry({
  children,
  layoutKey,
  onBeforeScroll,
  onLayout,
  variant,
  viewportRef,
}: FragmentMasonryProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const previousPositions = useRef<Position[]>([])
  const callbacksRef = useRef({ onBeforeScroll, onLayout })
  const requestLayoutRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    callbacksRef.current = { onBeforeScroll, onLayout }
  }, [onBeforeScroll, onLayout])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let frame = 0

    const measure = () => {
      frame = 0
      const viewport = viewportRef.current
      const width = container.getBoundingClientRect().width
      // Hidden routes retain their last geometry until they become visible.
      if (!viewport || width === 0) return

      const style = getComputedStyle(container)
      const columns = Number(style.getPropertyValue("--shard-timeline-columns")) || 1
      const gap = Number.parseFloat(style.rowGap) || 0
      const items = Array.from(container.children) as HTMLElement[]
      const scrollTop = viewport.scrollTop
      // Batch all geometry reads before writing any positions.
      const heights = items.map((item) => item.getBoundingClientRect().height)
      const { positions, height } = layoutMasonry(heights, columns, gap)
      const containerTop = container.getBoundingClientRect().top
        - viewport.getBoundingClientRect().top + scrollTop
      const visibleTop = scrollTop - containerTop
      // Prefer the most recently started visible card over a very long card
      // that happens to overlap the entire viewport in the other column.
      const currentIds = new Set(items.map((item) => item.dataset.timelineItemId))
      let anchor: Position | undefined
      for (const item of previousPositions.current) {
        if (!currentIds.has(item.id) || item.top + item.height <= visibleTop
          || item.top >= visibleTop + viewport.clientHeight) continue
        if (!anchor || Math.abs(item.top - visibleTop) < Math.abs(anchor.top - visibleTop)) {
          anchor = item
        }
      }
      const nextPositions = items.map((item, index) => ({
        id: item.dataset.timelineItemId!,
        top: positions[index].top,
        height: heights[index],
      }))

      container.dataset.columns = String(columns)
      // Keep the last measured extent even in normal flow. Otherwise a CSS
      // column change can shrink the scroll range and clamp scrollTop before
      // this observer gets a chance to capture the reading anchor.
      const nextHeight = `${height}px`
      if (container.style.minHeight !== nextHeight) container.style.minHeight = nextHeight
      items.forEach((item, index) => {
        const { column, top } = positions[index]
        const left = columns > 1 ? `${column * (width + gap) / columns}px` : ""
        const nextTop = columns > 1 ? `${top}px` : ""
        if (item.style.left !== left) item.style.left = left
        if (item.style.top !== nextTop) item.style.top = nextTop
      })
      previousPositions.current = nextPositions

      if (callbacksRef.current.onLayout()) return

      const nextAnchor = anchor && nextPositions.find((item) => item.id === anchor.id)
      const delta = nextAnchor ? nextAnchor.top - anchor!.top : 0
      if (scrollTop > 0 && Math.abs(delta) > 0.5) {
        callbacksRef.current.onBeforeScroll()
        viewport.scrollTop = scrollTop + delta
      }
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(schedule)
    const observedItems = new Set<Element>()
    observer.observe(container, { box: "border-box" })
    // Keep the observer alive across React renders. Only new/removed cards need
    // subscriptions; content, image and editor growth arrive through ResizeObserver.
    requestLayoutRef.current = () => {
      const items = new Set(container.children)
      for (const item of observedItems) {
        if (!items.has(item)) {
          observer.unobserve(item)
          observedItems.delete(item)
        }
      }
      for (const item of items) {
        if (!observedItems.has(item)) {
          observer.observe(item, { box: "border-box" })
          observedItems.add(item)
        }
      }
      schedule()
    }

    return () => {
      requestLayoutRef.current = null
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [viewportRef])

  useEffect(() => {
    requestLayoutRef.current?.()
  }, [layoutKey, variant, viewportRef])

  return (
    <div className="shard-content-measure shard-timeline-container">
      <div
        className="shard-timeline-layout"
        data-variant={variant}
        ref={containerRef}
      >
        {children}
      </div>
    </div>
  )
}
