import { parseSearchTerms } from "@/lib/search-normalize"
import type {
  RevealPlan,
  RevealResult,
  SearchHit,
  SearchRevealHandle,
  SearchTarget,
} from "@/lib/search-contract"

export interface SearchNavigationHost {
  flushBeforeLeave(): Promise<boolean>

  openTarget(
    target: SearchTarget,
    requestId: string,
    signal: AbortSignal
  ): Promise<
    | {
        status: "ready"
        revision: string | null
        reveal: SearchRevealHandle | null
      }
    | { status: "externalAccepted" }
  >
}

export interface SearchNavigationRequest {
  hit: SearchHit
  query: string
  requestId: string
  sessionId: string
  uiEpoch: number
}

export type SearchNavigationResult =
  | {
      status: "ready"
      reveal: RevealResult
      revealHandle: SearchRevealHandle | null
    }
  | { status: "cancelled" }
  | { status: "saveFailed" }
  | { status: "failed"; error: unknown }

/**
 * Runs the frozen T08 transaction. The caller owns the successful ack and must
 * still re-check its session before mutating UI state or recording recent.
 */
export async function runSearchNavigation(
  request: SearchNavigationRequest,
  host: SearchNavigationHost,
  isCurrent: () => boolean,
  signal: AbortSignal
): Promise<SearchNavigationResult> {
  try {
    if (!isActive(isCurrent, signal)) return { status: "cancelled" }

    if (!(await host.flushBeforeLeave())) return { status: "saveFailed" }
    if (!isActive(isCurrent, signal)) return { status: "cancelled" }

    const opened = await host.openTarget(
      request.hit.target,
      request.requestId,
      signal
    )
    if (!isActive(isCurrent, signal)) return { status: "cancelled" }

    if (opened.status === "externalAccepted") {
      return {
        status: "ready",
        revealHandle: null,
        reveal: documentOnly(request, request.hit.revision ?? "", "external"),
      }
    }

    const revision = opened.revision ?? request.hit.revision ?? ""
    if (
      request.hit.revealHint !== "text" ||
      !opened.reveal ||
      !revision
    ) {
      return {
        status: "ready",
        revealHandle: opened.reveal,
        reveal: documentOnly(
          request,
          revision,
          request.hit.revealHint === "text"
            ? "highlightUnavailable"
            : "unsupportedHost"
        ),
      }
    }

    const plan: RevealPlan = {
      origin: "globalSearch",
      preferredText: previewText(request.hit),
      projectionVersion: 1,
      requestId: request.requestId,
      revealHint: request.hit.revealHint,
      revision,
      sessionId: request.sessionId,
      target: request.hit.target,
      terms: parseSearchTerms(request.query),
      uiEpoch: request.uiEpoch,
    }
    const reveal = await opened.reveal.revealTerms(plan, signal)
    if (!isActive(isCurrent, signal)) return { status: "cancelled" }
    if (reveal.status === "cancelled" || reveal.status === "stale") {
      return { status: "cancelled" }
    }
    return { status: "ready", reveal, revealHandle: opened.reveal }
  } catch (error) {
    if (!isActive(isCurrent, signal)) return { status: "cancelled" }
    return { status: "failed", error }
  }
}

function isActive(isCurrent: () => boolean, signal: AbortSignal) {
  return !signal.aborted && isCurrent()
}

function previewText(hit: SearchHit) {
  const text = hit.preview.map((part) => part.text).join("").trim()
  return text || null
}

function documentOnly(
  request: SearchNavigationRequest,
  revision: string,
  reason: Extract<RevealResult, { status: "documentOnly" }>["reason"]
): RevealResult {
  return {
    reason,
    requestId: request.requestId,
    revision,
    status: "documentOnly",
    targetKey: request.hit.target.key,
  }
}
