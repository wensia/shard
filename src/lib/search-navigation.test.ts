import { describe, expect, it, vi } from "vitest"

import {
  runSearchNavigation,
  type SearchNavigationHost,
} from "@/lib/search-navigation"
import type {
  SearchHit,
  SearchRevealHandle,
} from "@/lib/search-contract"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function hit(revision = "search-revision"): SearchHit {
  return {
    matchedFields: ["body"],
    preview: [{ hit: true, text: "needle" }],
    revealHint: "text",
    revision,
    tags: [],
    target: {
      archived: false,
      key: '["/vault","public","notes/a.md"]',
      kind: "note",
      objectId: "a",
      path: "notes/a.md",
      scope: "public",
      vaultPath: "/vault",
    },
    title: "A",
    titleParts: [{ hit: false, text: "A" }],
    updatedAt: null,
  }
}

function request() {
  return {
    hit: hit(),
    query: "needle",
    requestId: "navigation-1",
    sessionId: "session-1",
    uiEpoch: 4,
  }
}

function host(
  overrides: Partial<SearchNavigationHost> = {}
): SearchNavigationHost {
  return {
    flushBeforeLeave: vi.fn().mockResolvedValue(true),
    openTarget: vi.fn().mockResolvedValue({
      status: "ready",
      revision: "current-revision",
      reveal: null,
    }),
    ...overrides,
  }
}

describe("search navigation transaction", () => {
  it("save_failure_keeps_session_and_does_not_record_recent", async () => {
    const openTarget = vi.fn()
    const result = await runSearchNavigation(
      request(),
      host({
        flushBeforeLeave: vi.fn().mockResolvedValue(false),
        openTarget,
      }),
      () => true,
      new AbortController().signal
    )

    expect(result).toEqual({ status: "saveFailed" })
    expect(openTarget).not.toHaveBeenCalled()
  })

  it("only_latest_navigation_can_ack", async () => {
    const ready = deferred<ReturnType<SearchNavigationHost["openTarget"]> extends Promise<infer T> ? T : never>()
    let currentRequestId = "navigation-1"
    const running = runSearchNavigation(
      request(),
      host({ openTarget: vi.fn(() => ready.promise) }),
      () => currentRequestId === "navigation-1",
      new AbortController().signal
    )
    currentRequestId = "navigation-2"
    ready.resolve({ status: "ready", revision: "current", reveal: null })

    await expect(running).resolves.toEqual({ status: "cancelled" })
  })

  it("navigation_is_not_consumed_before_ready", async () => {
    const ready = deferred<ReturnType<SearchNavigationHost["openTarget"]> extends Promise<infer T> ? T : never>()
    const running = runSearchNavigation(
      request(),
      host({ openTarget: vi.fn(() => ready.promise) }),
      () => true,
      new AbortController().signal
    )
    let settled = false
    void running.then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    ready.resolve({ status: "ready", revision: "current", reveal: null })
    await expect(running).resolves.toMatchObject({ status: "ready" })
  })

  it("read_current_revision_before_reveal", async () => {
    const revealTerms = vi.fn<SearchRevealHandle["revealTerms"]>(async (plan) => ({
      activeIndex: 0,
      matchCount: 1,
      requestId: plan.requestId,
      revision: plan.revision,
      status: "revealed",
      targetKey: plan.target.key,
    }))
    const reveal: SearchRevealHandle = {
      clearHits: vi.fn(),
      revealTerms,
      stepHit: vi.fn(),
    }
    const result = await runSearchNavigation(
      request(),
      host({
        openTarget: vi.fn().mockResolvedValue({
          status: "ready",
          revision: "fresh-revision",
          reveal,
        }),
      }),
      () => true,
      new AbortController().signal
    )

    expect(result.status).toBe("ready")
    expect(revealTerms).toHaveBeenCalledWith(
      expect.objectContaining({ revision: "fresh-revision" }),
      expect.any(AbortSignal)
    )
  })
})
