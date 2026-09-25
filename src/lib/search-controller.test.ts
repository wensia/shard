import { describe, expect, it } from "vitest"

import {
  createLatestSearchQueue,
  SEARCH_RETRY_DELAYS_MS,
  searchRetryDelay,
  sessionAfterRetryExhausted,
  sessionAfterSearchResponse,
} from "@/workspace/use-search-controller"
import {
  captureSearchSessionIdentity,
  createSearchSession,
} from "@/lib/search-session"
import type { SearchVaultResponse } from "@/lib/search-contract"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function response(
  clientRequestId: string,
  indexState: SearchVaultResponse["indexState"] = "ready"
): SearchVaultResponse {
  return {
    clientRequestId,
    context: {
      privacyEpoch: "0",
      vaultEpoch: "1",
      vaultPath: "/vault",
    },
    expiresAt: null,
    hits: [],
    indexState,
    skippedFiles: 0,
    snapshotId: indexState === "indexing" ? null : "snapshot-1",
    total: indexState === "indexing" ? null : 0,
    warning: null,
  }
}

describe("search controller", () => {
  it("keeps one in-flight query and only the latest pending query per scope", async () => {
    const queue = createLatestSearchQueue<string>()
    const publicFirst = deferred<string>()
    const lockboxFirst = deferred<string>()
    const started: string[] = []
    const resolved: string[] = []

    const enqueue = (
      scope: "public" | "lockbox",
      name: string,
      run: () => Promise<string>
    ) => {
      queue.enqueue({
        onReject: () => undefined,
        onResolve: (value) => resolved.push(value),
        run: () => {
          started.push(name)
          return run()
        },
        scope,
      })
    }

    enqueue("public", "public-first", () => publicFirst.promise)
    enqueue("public", "public-dropped", async () => "public-dropped")
    enqueue("public", "public-latest", async () => "public-latest")
    enqueue("lockbox", "lockbox-first", () => lockboxFirst.promise)
    enqueue("lockbox", "lockbox-latest", async () => "lockbox-latest")

    expect(started).toEqual(["public-first", "lockbox-first"])

    publicFirst.resolve("public-first")
    lockboxFirst.resolve("lockbox-first")
    await Promise.all([publicFirst.promise, lockboxFirst.promise])
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))

    expect(started).toEqual([
      "public-first",
      "lockbox-first",
      "public-latest",
      "lockbox-latest",
    ])
    expect(started).not.toContain("public-dropped")
    expect(resolved).toEqual(
      expect.arrayContaining([
        "public-first",
        "public-latest",
        "lockbox-first",
        "lockbox-latest",
      ])
    )
  })

  it("rejects a response after the query identity changes", () => {
    const session = createSearchSession({
      id: "search-1",
      scope: "public",
      uiEpoch: 1,
      vaultPath: "/vault",
    })
    const identity = captureSearchSessionIdentity(session)
    const changed = { ...session, querySequence: session.querySequence + 1 }

    expect(
      sessionAfterSearchResponse(changed, identity, response("request-1"))
    ).toBeNull()

    const contextual = {
      ...session,
      context: {
        privacyEpoch: "4",
        vaultEpoch: "7",
        vaultPath: "/vault",
      },
    }
    const changedContext = response("request-2")
    changedContext.context = {
      ...changedContext.context,
      privacyEpoch: "5",
      vaultEpoch: "7",
    }
    expect(
      sessionAfterSearchResponse(
        contextual,
        captureSearchSessionIdentity(contextual),
        changedContext
      )
    ).toBeNull()
  })

  it("uses finite retries for indexing and stale responses", () => {
    expect(
      SEARCH_RETRY_DELAYS_MS.map((_, index) =>
        searchRetryDelay("indexing", index)
      )
    ).toEqual([...SEARCH_RETRY_DELAYS_MS])
    expect(searchRetryDelay("indexing", SEARCH_RETRY_DELAYS_MS.length)).toBeNull()
    expect(searchRetryDelay("stale", SEARCH_RETRY_DELAYS_MS.length)).toBeNull()
    expect(searchRetryDelay("ready", 0)).toBeNull()

    const session = createSearchSession({
      id: "search-retry",
      scope: "lockbox",
      uiEpoch: 1,
      vaultPath: "/vault",
    })
    expect(sessionAfterRetryExhausted(session, "indexing")).toMatchObject({
      error: { code: "internal", retryable: true },
      state: "error",
    })
    expect(sessionAfterRetryExhausted(session, "stale")).toBe(session)
  })
})
