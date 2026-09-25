import type {
  RevealPlan,
  RevealResult,
  SearchRevealHandle,
  SearchTarget,
} from "@/lib/search-contract"
import { normalizeSearchText } from "@/lib/search-normalize"

type RevealIdentity = Pick<RevealPlan, "requestId" | "revision"> & {
  targetKey: string
}

interface HighlightLike {
  clear(): void
}

interface HighlightRegistryLike {
  delete(name: string): boolean
  get(name: string): HighlightLike | undefined
  set(name: string, highlight: HighlightLike): void
}

interface HighlightEnvironment {
  createHighlight(ranges: readonly Range[]): HighlightLike
  registry: HighlightRegistryLike
}

export interface DomSearchRevealHost {
  expandCard?: (card: HTMLElement, target: SearchTarget) => Promise<void> | void
  getCard(target: SearchTarget): HTMLElement | null
  getRoot(target: SearchTarget, card: HTMLElement): HTMLElement | null
  getViewport(): HTMLElement | null
  scrollRange?: (range: Range, viewport: HTMLElement) => Promise<void> | void
  showCardOutline?: (target: SearchTarget) => void
}

export interface DomSearchRevealOptions {
  environment?: HighlightEnvironment | null
  waitTimeoutMs?: number
}

export interface SearchTermSpan {
  end: number
  segmentIndex: number
  start: number
}

interface DomPosition {
  end: number
  node: Text
  start: number
}

interface DomTextSegment {
  normalized: string
  positions: DomPosition[]
}

interface ActiveReveal {
  activeIndex: number
  identity: RevealIdentity
  ranges: Range[]
  root: HTMLElement
  sourceText: string | null
  target: SearchTarget
  uiEpoch: number
}

interface DomProjection {
  excludedReason: "codeBlock" | "embed" | null
  ranges: Range[]
}

const SEARCH_EXCLUDE_SELECTOR = "[data-markdown-search-exclude]"
const SEARCH_BLOCK_SELECTOR = "[data-markdown-search-block]"
const DEFAULT_WAIT_TIMEOUT_MS = 3_000
let nextHandleId = 0

function identityOf(plan: RevealPlan): RevealIdentity {
  return {
    requestId: plan.requestId,
    revision: plan.revision,
    targetKey: plan.target.key,
  }
}

function resultIdentity(identity: RevealIdentity) {
  return {
    requestId: identity.requestId,
    revision: identity.revision,
    targetKey: identity.targetKey,
  }
}

function cancelled(identity: RevealIdentity): RevealResult {
  return { ...resultIdentity(identity), status: "cancelled" }
}

function stale(
  identity: RevealIdentity,
  reason: "revisionChanged" | "privacyChanged"
): RevealResult {
  return { ...resultIdentity(identity), reason, status: "stale" }
}

function normalizedTerms(rawTerms: readonly string[]) {
  return [...new Set(rawTerms.map(normalizeSearchText).filter(Boolean))]
}

/** Pure matcher shared by the DOM adapter and node-only unit tests. */
export function findSearchTermSpans(
  normalizedSegments: readonly string[],
  rawTerms: readonly string[]
): SearchTermSpan[] {
  const terms = normalizedTerms(rawTerms)
  const spans: SearchTermSpan[] = []

  normalizedSegments.forEach((segment, segmentIndex) => {
    for (const term of terms) {
      let offset = 0
      while (offset <= segment.length - term.length) {
        const start = segment.indexOf(term, offset)
        if (start < 0) break
        spans.push({ end: start + term.length, segmentIndex, start })
        offset = start + Math.max(term.length, 1)
      }
    }
  })

  spans.sort(
    (left, right) =>
      left.segmentIndex - right.segmentIndex ||
      left.start - right.start ||
      left.end - right.end
  )

  const merged: SearchTermSpan[] = []
  for (const span of spans) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      previous.segmentIndex === span.segmentIndex &&
      span.start < previous.end
    ) {
      previous.end = Math.max(previous.end, span.end)
    } else {
      merged.push({ ...span })
    }
  }
  return merged
}

function appendText(segment: DomTextSegment, node: Text) {
  let offset = 0
  for (const character of node.data) {
    const width = character.length
    const normalized = normalizeSearchText(character)
    segment.normalized += normalized
    for (let index = 0; index < normalized.length; index += 1) {
      segment.positions.push({ end: offset + width, node, start: offset })
    }
    offset += width
  }
}

function textNodeBlock(root: HTMLElement, node: Text) {
  const parent = node.parentElement
  if (!parent) return null
  const block = parent.closest<HTMLElement>(SEARCH_BLOCK_SELECTOR)
  return block && root.contains(block) ? block : null
}

function isHiddenTextNode(root: HTMLElement, node: Text) {
  const parent = node.parentElement
  if (!parent || !root.contains(parent)) return true
  const hiddenAncestor = parent.closest<HTMLElement>("[hidden], [aria-hidden='true']")
  return Boolean(
    hiddenAncestor &&
    (hiddenAncestor === root || root.contains(hiddenAncestor))
  )
}

function collectDomSegments(root: HTMLElement) {
  const segments: DomTextSegment[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let currentBlock: HTMLElement | null = null
  let current: DomTextSegment | null = null

  const flush = () => {
    if (current?.normalized) segments.push(current)
    current = null
    currentBlock = null
  }

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    const parent = text.parentElement
    if (
      !text.data ||
      isHiddenTextNode(root, text) ||
      parent?.closest(SEARCH_EXCLUDE_SELECTOR)
    ) {
      flush()
      continue
    }

    const block = textNodeBlock(root, text)
    if (!block) {
      flush()
      continue
    }
    if (currentBlock !== block) {
      flush()
      currentBlock = block
      current = { normalized: "", positions: [] }
    }
    appendText(current as DomTextSegment, text)
  }
  flush()
  return segments
}

function excludedReason(
  root: HTMLElement,
  terms: readonly string[]
): DomProjection["excludedReason"] {
  let fallback: DomProjection["excludedReason"] = null
  for (const element of root.querySelectorAll<HTMLElement>(SEARCH_EXCLUDE_SELECTOR)) {
    const kind = element.dataset.markdownSearchExclude
    const text = normalizeSearchText(element.textContent ?? "")
    if (!terms.some((term) => text.includes(term))) continue
    if (kind === "codeBlock") return "codeBlock"
    fallback = "embed"
  }
  return fallback
}

function projectDomRanges(
  root: HTMLElement,
  rawTerms: readonly string[]
): DomProjection {
  const terms = normalizedTerms(rawTerms)
  const segments = collectDomSegments(root)
  const spans = findSearchTermSpans(
    segments.map((segment) => segment.normalized),
    terms
  )
  const ranges: Range[] = []

  for (const span of spans) {
    const segment = segments[span.segmentIndex]
    const first = segment?.positions[span.start]
    const last = segment?.positions[span.end - 1]
    if (!first || !last) continue
    const range = document.createRange()
    range.setStart(first.node, first.start)
    range.setEnd(last.node, last.end)
    ranges.push(range)
  }

  return { excludedReason: excludedReason(root, terms), ranges }
}

function browserHighlightEnvironment(): HighlightEnvironment | null {
  const css = globalThis.CSS as typeof CSS & {
    highlights?: HighlightRegistryLike
  }
  const HighlightConstructor = (
    globalThis as typeof globalThis & {
      Highlight?: new (...ranges: Range[]) => HighlightLike
    }
  ).Highlight
  if (!css?.highlights || typeof HighlightConstructor !== "function") return null
  return {
    createHighlight: (ranges) => new HighlightConstructor(...ranges),
    registry: css.highlights,
  }
}

function validLayout(element: HTMLElement) {
  if (!element.isConnected || element.getAttribute("aria-busy") === "true") {
    return false
  }
  const rects = element.getClientRects()
  return rects.length > 0 && Array.from(rects).some((rect) => rect.width > 0 && rect.height > 0)
}

function validRangeLayout(range: Range) {
  return Array.from(range.getClientRects()).some(
    (rect) => rect.width > 0 && rect.height > 0
  )
}

function waitFor<T>(
  read: () => T | null,
  observeRoot: Node,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<T | null> {
  const immediate = read()
  if (immediate !== null) return Promise.resolve(immediate)
  if (signal?.aborted) return Promise.resolve(null)

  return new Promise((resolve) => {
    let frame = 0
    let finished = false
    const finish = (value: T | null) => {
      if (finished) return
      finished = true
      observer.disconnect()
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
      resolve(value)
    }
    const check = () => {
      const value = read()
      if (value !== null) finish(value)
      else frame = window.requestAnimationFrame(check)
    }
    const abort = () => finish(null)
    const observer = new MutationObserver(check)
    observer.observe(observeRoot, {
      attributes: true,
      childList: true,
      subtree: true,
    })
    const timeout = window.setTimeout(() => finish(null), timeoutMs)
    signal?.addEventListener("abort", abort, { once: true })
    frame = window.requestAnimationFrame(check)
  })
}

function defaultScrollRange(range: Range, viewport: HTMLElement) {
  const rangeRect = range.getBoundingClientRect()
  const viewportRect = viewport.getBoundingClientRect()
  const inset = 12
  if (rangeRect.top < viewportRect.top + inset) {
    viewport.scrollTop += rangeRect.top - viewportRect.top - inset
  } else if (rangeRect.bottom > viewportRect.bottom - inset) {
    viewport.scrollTop += rangeRect.bottom - viewportRect.bottom + inset
  }
}

/**
 * DOM renderer for static fragment cards. Ranges, observers and registry names
 * stay private to this handle and never enter SearchSession.
 */
export function createDomSearchRevealHandle(
  host: DomSearchRevealHost,
  options: DomSearchRevealOptions = {}
): SearchRevealHandle {
  const handleId = ++nextHandleId
  const normalName = `shard-search-hit-${handleId}`
  const activeName = `shard-search-hit-active-${handleId}`
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  let environment = options.environment === undefined
    ? browserHighlightEnvironment()
    : options.environment
  let active: ActiveReveal | null = null
  let observer: MutationObserver | null = null
  let resizeObserver: ResizeObserver | null = null
  let rescrollFrame: number | null = null
  let style: HTMLStyleElement | null = null
  let ownedActive: HighlightLike | null = null
  let ownedNormal: HighlightLike | null = null

  const clearOwned = () => {
    observer?.disconnect()
    observer = null
    resizeObserver?.disconnect()
    resizeObserver = null
    if (rescrollFrame !== null) window.cancelAnimationFrame(rescrollFrame)
    rescrollFrame = null
    if (ownedNormal) {
      ownedNormal.clear()
      if (environment?.registry.get(normalName) === ownedNormal) {
        environment.registry.delete(normalName)
      }
    }
    if (ownedActive) {
      ownedActive.clear()
      if (environment?.registry.get(activeName) === ownedActive) {
        environment.registry.delete(activeName)
      }
    }
    ownedNormal = null
    ownedActive = null
    style?.remove()
    style = null
    for (const range of active?.ranges ?? []) range.detach()
    active = null
  }

  const ensureStyle = () => {
    if (style?.isConnected) return
    style = document.createElement("style")
    style.dataset.searchHighlightOwner = String(handleId)
    style.textContent = `
      ::highlight(${normalName}) {
        background-color: rgb(var(--shard-warning-rgb) / var(--shard-alpha-13));
      }
      ::highlight(${activeName}) {
        background-color: rgb(var(--shard-warning-rgb) / var(--shard-alpha-21));
        text-decoration: underline rgb(var(--shard-warning-rgb) / var(--shard-alpha-55));
      }
    `
    document.head.append(style)
  }

  const registerHighlights = (ranges: readonly Range[], activeIndex: number) => {
    if (!environment) return
    ensureStyle()
    ownedNormal?.clear()
    ownedActive?.clear()
    ownedNormal = environment.createHighlight(ranges)
    ownedActive = environment.createHighlight(
      ranges[activeIndex] ? [ranges[activeIndex]] : []
    )
    environment.registry.set(normalName, ownedNormal)
    environment.registry.set(activeName, ownedActive)
  }

  const watchRoot = (reveal: ActiveReveal) => {
    const viewport = host.getViewport()
    if (!viewport) return
    observer = new MutationObserver(() => {
      const card = host.getCard(reveal.target)
      const root = card ? host.getRoot(reveal.target, card) : null
      if (
        !card?.isConnected ||
        root !== reveal.root ||
        !reveal.root.isConnected ||
        reveal.root.textContent !== reveal.sourceText
      ) {
        clearOwned()
      }
    })
    observer.observe(viewport, { attributes: true, childList: true, subtree: true })
    resizeObserver = new ResizeObserver(() => {
      if (rescrollFrame !== null) window.cancelAnimationFrame(rescrollFrame)
      rescrollFrame = window.requestAnimationFrame(() => {
        rescrollFrame = null
        if (active !== reveal || !reveal.root.isConnected) return
        const range = reveal.ranges[reveal.activeIndex]
        if (!range) return
        if (host.scrollRange) void host.scrollRange(range, viewport)
        else defaultScrollRange(range, viewport)
      })
    })
    resizeObserver.observe(viewport)
  }

  const scroll = async (range: Range) => {
    const viewport = host.getViewport()
    if (!viewport) return
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    if (host.scrollRange) await host.scrollRange(range, viewport)
    else defaultScrollRange(range, viewport)
  }

  return {
    async revealTerms(plan, signal) {
      const identity = identityOf(plan)
      if (signal?.aborted) return cancelled(identity)
      if (active && plan.uiEpoch < active.uiEpoch) {
        return stale(identity, "privacyChanged")
      }
      clearOwned()

      const viewport = host.getViewport()
      if (!viewport) return cancelled(identity)
      const card = await waitFor(
        () => host.getCard(plan.target),
        viewport,
        signal,
        waitTimeoutMs
      )
      if (!card || signal?.aborted) return cancelled(identity)

      await host.expandCard?.(card, plan.target)
      if (signal?.aborted) return cancelled(identity)

      const root = await waitFor(
        () => {
          const candidate = host.getRoot(plan.target, card)
          return candidate && validLayout(candidate) ? candidate : null
        },
        card,
        signal,
        waitTimeoutMs
      )
      if (!root || signal?.aborted) return cancelled(identity)

      const sourceText = root.textContent
      const projection = projectDomRanges(root, plan.terms)
      await Promise.resolve()
      if (signal?.aborted) {
        for (const range of projection.ranges) range.detach()
        return cancelled(identity)
      }
      if (
        host.getRoot(plan.target, card) !== root ||
        root.textContent !== sourceText
      ) {
        for (const range of projection.ranges) range.detach()
        return stale(identity, "revisionChanged")
      }

      environment = options.environment === undefined
        ? browserHighlightEnvironment()
        : options.environment
      if (!environment) {
        for (const range of projection.ranges) range.detach()
        host.showCardOutline?.(plan.target)
        return {
          ...resultIdentity(identity),
          reason: "highlightUnavailable",
          status: "documentOnly",
        }
      }

      if (projection.ranges.length === 0) {
        if (projection.excludedReason) {
          return {
            ...resultIdentity(identity),
            reason: projection.excludedReason,
            status: "documentOnly",
          }
        }
        return { ...resultIdentity(identity), status: "noVisibleMatch" }
      }

      active = {
        activeIndex: 0,
        identity,
        ranges: projection.ranges,
        root,
        sourceText,
        target: plan.target,
        uiEpoch: plan.uiEpoch,
      }
      registerHighlights(active.ranges, active.activeIndex)
      watchRoot(active)
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
      if (!active || !validRangeLayout(active.ranges[0])) {
        clearOwned()
        return cancelled(identity)
      }
      await scroll(active.ranges[0])
      if (signal?.aborted || !active || active.identity.requestId !== plan.requestId) {
        clearOwned()
        return cancelled(identity)
      }
      return {
        ...resultIdentity(identity),
        activeIndex: 0,
        matchCount: active.ranges.length,
        status: "revealed",
      }
    },

    async stepHit(direction) {
      if (!active) {
        return { requestId: "", revision: "", status: "cancelled", targetKey: "" }
      }
      const current = active
      const card = host.getCard(current.target)
      if (
        !card ||
        host.getRoot(current.target, card) !== current.root ||
        !current.root.isConnected
      ) {
        const identity = current.identity
        clearOwned()
        return stale(identity, "revisionChanged")
      }
      current.activeIndex =
        (current.activeIndex + direction + current.ranges.length) % current.ranges.length
      registerHighlights(current.ranges, current.activeIndex)
      await scroll(current.ranges[current.activeIndex])
      return {
        ...resultIdentity(current.identity),
        activeIndex: current.activeIndex,
        matchCount: current.ranges.length,
        status: "revealed",
      }
    },

    clearHits() {
      clearOwned()
    },
  }
}
