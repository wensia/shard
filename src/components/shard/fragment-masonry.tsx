import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react"

import { layoutMasonry } from "@/lib/masonry-layout"

type Position = { id: string; left: number; top: number; height: number }

interface FragmentMasonryProps {
  children: ReactNode
  /** Ordered item identity and explicit navigation changes that need a layout pass. */
  layoutKey: string
  renderLimit: number
  onBeforeScroll: () => void
  /** Returns true while explicit fragment navigation owns the viewport. */
  onLayout: (beforeNavigate: () => void) => boolean
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
  renderLimit,
  onBeforeScroll,
  onLayout,
  variant,
  viewportRef,
}: FragmentMasonryProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const previousPositions = useRef<Position[]>([])
  const callbacksRef = useRef({ onBeforeScroll, onLayout, renderLimit })
  const requestLayoutRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    callbacksRef.current = { onBeforeScroll, onLayout, renderLimit }
  }, [onBeforeScroll, onLayout, renderLimit])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    let frame = 0
    let measured = false
    let previousWidth = 0
    let previousColumns = 0
    let previousLimit = renderLimit
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const animations = new Map<HTMLElement, Animation>()
    const stopAnimations = () => {
      animations.forEach((animation) => animation.cancel())
      animations.clear()
    }
    motion.addEventListener("change", stopAnimations)

    const measure = () => {
      cancelAnimationFrame(frame)
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
      const previous = new Map(previousPositions.current.map((position) => [position.id, position]))
      const identityChanged = items.length !== previousPositions.current.length
        || items.some((item, index) => item.dataset.timelineItemId !== previousPositions.current[index]?.id)
      // Initial data, filter mounts and appending another page need no entrance.
      const loadingMore = callbacksRef.current.renderLimit > previousLimit
      const animateChange = measured && identityChanged && !loadingMore && !motion.matches
        && previousWidth === width && previousColumns === columns
      // Read in-flight visual offsets before any writes, so rapid changes can
      // continue from their current frame instead of snapping to an old target.
      const animatedStyles = new Map(Array.from(animations.keys(), (item) => {
        const computed = getComputedStyle(item)
        return [item, { transform: new DOMMatrixReadOnly(computed.transform), opacity: computed.opacity }] as const
      }))
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
        left: columns > 1 ? positions[index].column * (width + gap) / columns : 0,
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
      previousWidth = width
      previousColumns = columns
      previousLimit = callbacksRef.current.renderLimit
      measured = true

      if (callbacksRef.current.onLayout(stopAnimations)) return

      const nextAnchor = anchor && nextPositions.find((item) => item.id === anchor.id)
      const delta = nextAnchor ? nextAnchor.top - anchor!.top : 0
      if (scrollTop > 0 && Math.abs(delta) > 0.5) {
        callbacksRef.current.onBeforeScroll()
        viewport.scrollTop = scrollTop + delta
      }

      const scrollDelta = viewport.scrollTop - scrollTop
      for (const [item, animation] of animations) {
        if (!container.contains(item)) {
          animation.cancel()
          animations.delete(item)
        }
      }
      items.forEach((item, index) => {
        const next = nextPositions[index]
        const before = previous.get(next.id)
        const running = animations.get(item)
        const changed = before && (before.left !== next.left || before.top !== next.top || scrollDelta !== 0)
        if (!animateChange && !(running && changed)) return
        const visibleStart = viewport.scrollTop - containerTop
        const visibleEnd = visibleStart + viewport.clientHeight
        const wasVisible = before && before.top + before.height > visibleTop && before.top < visibleTop + viewport.clientHeight
        const isVisible = next.top + next.height > visibleStart && next.top < visibleEnd
        if (motion.matches || (!wasVisible && !isVisible)) {
          running?.cancel()
          animations.delete(item)
          return
        }
        const visual = animatedStyles.get(item)
        const x = before ? before.left - next.left + (visual?.transform.m41 ?? 0) : 0
        const y = before ? before.top - next.top + scrollDelta + (visual?.transform.m42 ?? 0) : -Math.min(8, gap || 8)
        const opacity = visual?.opacity ?? (before ? "1" : "0")
        if (before && Math.abs(x) < 0.5 && Math.abs(y) < 0.5 && opacity === "1") {
          running?.cancel()
          animations.delete(item)
          return
        }
        running?.cancel()
        const from = `translate(${x}px, ${y}px)`
        const changesColumn = Math.abs(x) > 0.5
        // Crossing columns would sweep one card's text over its neighbours.
        // Change lanes only while invisible; same-column cards keep their FLIP.
        const keyframes = changesColumn ? [
          { transform: from, opacity, offset: 0, easing: "ease-out" },
          { transform: from, opacity: "0", offset: 0.35 },
          { transform: "translate(0, -8px)", opacity: "0", offset: 0.35, easing: "ease-out" },
          { transform: "translate(0, 0)", opacity: "1", offset: 1 },
        ] : [
          { transform: from, opacity },
          { transform: "translate(0, 0)", opacity: "1" },
        ]
        const animation = item.animate(keyframes, {
          duration: 200,
          easing: changesColumn ? "linear" : "cubic-bezier(0.2, 0, 0, 1)",
        })
        animations.set(item, animation)
        animation.onfinish = () => {
          if (animations.get(item) === animation) animations.delete(item)
        }
      })
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
      // Identity changes must be placed and inverted before the first paint;
      // ResizeObserver still batches subsequent image/editor growth in a frame.
      measure()
    }

    return () => {
      requestLayoutRef.current = null
      observer.disconnect()
      cancelAnimationFrame(frame)
      motion.removeEventListener("change", stopAnimations)
      stopAnimations()
    }
  }, [viewportRef])

  useLayoutEffect(() => {
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
