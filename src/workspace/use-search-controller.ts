import { useCallback, useEffect, useMemo, useRef } from "react"

import {
  rankOpenItemsInBatches,
  type RankOpenItemsResult,
} from "@/lib/quick-open-match"
import {
  acceptsSearchSessionIdentity,
  captureSearchSessionIdentity,
  type SearchSessionIdentity,
} from "@/lib/search-session"
import type { ContentSearchProvider } from "@/lib/search-provider"
import type {
  SearchError,
  SearchHit,
  SearchIndexState,
  SearchMode,
  SearchScope,
  SearchSession,
  SearchVaultRequest,
  SearchVaultResponse,
} from "@/lib/search-contract"

const FULL_TEXT_LIMIT = 50
const OPEN_LIMIT = 50
export const SEARCH_RETRY_DELAYS_MS = [120, 240, 480] as const

interface SearchQueueTask<T> {
  onReject: (error: unknown) => void
  onResolve: (value: T) => void
  run: () => Promise<T>
  scope: SearchScope
}

interface SearchQueueLane<T> {
  pending: SearchQueueTask<T> | null
  running: boolean
}

export interface LatestSearchQueue<T> {
  clear(scope?: SearchScope): void
  enqueue(task: SearchQueueTask<T>): void
}

/** One active native/Worker query per scope; only the newest queued task survives. */
export function createLatestSearchQueue<T>(): LatestSearchQueue<T> {
  const lanes: Record<SearchScope, SearchQueueLane<T>> = {
    lockbox: { pending: null, running: false },
    public: { pending: null, running: false },
  }

  const start = (task: SearchQueueTask<T>) => {
    const lane = lanes[task.scope]
    lane.running = true
    void task
      .run()
      .then(task.onResolve, task.onReject)
      .finally(() => {
        lane.running = false
        const next = lane.pending
        lane.pending = null
        if (next) start(next)
      })
  }

  return {
    clear(scope) {
      if (scope) {
        lanes[scope].pending = null
        return
      }
      lanes.public.pending = null
      lanes.lockbox.pending = null
    },
    enqueue(task) {
      const lane = lanes[task.scope]
      if (lane.running) {
        lane.pending = task
        return
      }
      start(task)
    },
  }
}

export function searchRetryDelay(
  indexState: SearchIndexState,
  retryAttempt: number
): number | null {
  if (indexState !== "indexing" && indexState !== "stale") return null
  return SEARCH_RETRY_DELAYS_MS[retryAttempt] ?? null
}

export function sessionAfterSearchResponse(
  session: SearchSession,
  identity: SearchSessionIdentity,
  response: SearchVaultResponse,
  now = Date.now()
): SearchSession | null {
  if (!acceptsSearchSessionIdentity(session, identity)) return null
  if (response.clientRequestId.length === 0) return null
  if (response.context.vaultPath !== session.vaultPath) return null
  if (
    identity.vaultEpoch !== null &&
    response.context.vaultEpoch !== identity.vaultEpoch
  ) {
    return null
  }
  if (
    identity.privacyEpoch !== null &&
    response.context.privacyEpoch !== identity.privacyEpoch
  ) {
    return null
  }
  if (
    response.expiresAt &&
    (!Number.isFinite(Date.parse(response.expiresAt)) ||
      Date.parse(response.expiresAt) <= now)
  ) {
    return {
      ...session,
      context: response.context,
      error: { code: "locked" },
      expiresAt: response.expiresAt,
      hits: [],
      selectedKey: null,
      state: "locked",
      total: null,
    }
  }

  const state =
    response.indexState === "indexing"
      ? "indexing"
      : response.indexState === "stale"
        ? "stale"
        : response.hits.length > 0
          ? "results"
          : "noResults"
  const selectedKey = response.hits.some(
    (hit) => hit.target.key === session.selectedKey
  )
    ? session.selectedKey
    : response.hits[0]?.target.key ?? null

  return {
    ...session,
    context: response.context,
    error: response.warning,
    expiresAt: response.expiresAt,
    hits: response.hits,
    selectedKey,
    snapshotId: response.snapshotId,
    state,
    total: response.total,
  }
}

export function sessionAfterRetryExhausted(
  session: SearchSession,
  indexState: SearchIndexState
): SearchSession {
  if (indexState !== "indexing") return session
  return {
    ...session,
    error: { code: "internal", retryable: true },
    state: "error",
  }
}

export interface UseSearchControllerOptions {
  getSession: () => SearchSession | null
  isLockboxAvailable: boolean
  lockboxProvider: ContentSearchProvider
  openCatalog: readonly SearchHit[]
  publicProvider: ContentSearchProvider
  recent: ReadonlyMap<string, number>
  replaceSession: (session: SearchSession) => void
  session: SearchSession | null
}

export interface SearchController {
  onIncludeTrashChange(includeTrash: boolean): void
  onModeChange(mode: SearchMode): void
  onQueryChange(query: string): void
  onSelect(hit: SearchHit): void
  onSelectedKeyChange(key: string | null): void
}

export function useSearchController({
  getSession,
  isLockboxAvailable,
  lockboxProvider,
  openCatalog,
  publicProvider,
  recent,
  replaceSession,
  session,
}: UseSearchControllerOptions): SearchController {
  const queueRef = useRef<LatestSearchQueue<SearchVaultResponse> | null>(null)
  if (!queueRef.current) {
    queueRef.current = createLatestSearchQueue<SearchVaultResponse>()
  }
  const openQueueRef = useRef<LatestSearchQueue<RankOpenItemsResult> | null>(
    null
  )
  if (!openQueueRef.current) {
    openQueueRef.current = createLatestSearchQueue<RankOpenItemsResult>()
  }
  const retryTimerRef = useRef<number | null>(null)
  const runEpochRef = useRef(0)
  const nextRequestIdRef = useRef(0)
  const replaceSessionRef = useRef(replaceSession)
  replaceSessionRef.current = replaceSession
  const getSessionRef = useRef(getSession)
  getSessionRef.current = getSession

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current === null) return
    window.clearTimeout(retryTimerRef.current)
    retryTimerRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      runEpochRef.current += 1
      clearRetry()
      queueRef.current?.clear()
      openQueueRef.current?.clear()
    }
  }, [clearRetry])

  useEffect(() => {
    runEpochRef.current += 1
    const runEpoch = runEpochRef.current
    clearRetry()
    queueRef.current?.clear()
    openQueueRef.current?.clear()
    if (!session) return

    const current = getSessionRef.current()
    if (!current || current.id !== session.id || current.uiEpoch !== session.uiEpoch) {
      return
    }
    if (current.scope === "lockbox" && !isLockboxAvailable) {
      replaceSessionRef.current({
        ...current,
        error: { code: "locked" },
        hits: [],
        selectedKey: null,
        state: "locked",
        total: null,
      })
      return
    }

    if (current.mode === "open") {
      const identity = captureSearchSessionIdentity(current)
      replaceSessionRef.current({
        ...current,
        error: null,
        hits: [],
        selectedKey: null,
        state: "indexing",
        total: null,
      })
      openQueueRef.current?.enqueue({
        onReject(error) {
          if (runEpochRef.current !== runEpoch) return
          const latest = getSessionRef.current()
          if (!latest || !acceptsSearchSessionIdentity(latest, identity)) return
          const searchError = normalizeControllerError(error)
          replaceSessionRef.current({
            ...latest,
            error: searchError,
            hits: [],
            selectedKey: null,
            state: "error",
            total: null,
          })
        },
        onResolve(result) {
          if (runEpochRef.current !== runEpoch) return
          const latest = getSessionRef.current()
          if (!latest || !acceptsSearchSessionIdentity(latest, identity)) return
          const hits = result.hits.slice(0, OPEN_LIMIT)
          replaceSessionRef.current({
            ...latest,
            error: null,
            hits,
            selectedKey: hits[0]?.target.key ?? null,
            state: hits.length > 0 ? "results" : "noResults",
            total: result.hits.length,
          })
        },
        run: () =>
          rankOpenItemsInBatches(
            openCatalog,
            current.drafts.open,
            current.scope === "public" ? recent : new Map()
          ),
        scope: current.scope,
      })
      return
    }

    const query = current.drafts.fullText.trim()
    if (!query) {
      replaceSessionRef.current({
        ...current,
        error: null,
        hits: [],
        selectedKey: null,
        state: "emptyQuery",
        total: null,
      })
      return
    }

    replaceSessionRef.current({
      ...current,
      error: null,
      hits: [],
      selectedKey: null,
      state: "indexing",
      total: null,
    })
    enqueueFullTextSearch(current, 0, "auto", runEpoch)

    function enqueueFullTextSearch(
      sourceSession: SearchSession,
      retryAttempt: number,
      refresh: SearchVaultRequest["refresh"],
      expectedRunEpoch: number
    ) {
      const identity = captureSearchSessionIdentity(sourceSession)
      nextRequestIdRef.current += 1
      const clientRequestId = [
        sourceSession.id,
        sourceSession.uiEpoch,
        sourceSession.querySequence,
        nextRequestIdRef.current,
      ].join(":")
      const request: SearchVaultRequest = {
        clientRequestId,
        context: sourceSession.context,
        expectedVaultPath: sourceSession.vaultPath,
        includeTrash: sourceSession.includeTrash,
        limit: FULL_TEXT_LIMIT,
        projectionVersion: 1,
        query: sourceSession.drafts.fullText.trim(),
        queryVersion: 1,
        refresh,
        scope: sourceSession.scope,
      }
      const provider =
        sourceSession.scope === "lockbox" ? lockboxProvider : publicProvider

      queueRef.current?.enqueue({
        onReject(error) {
          if (runEpochRef.current !== expectedRunEpoch) return
          const latest = getSessionRef.current()
          if (!latest || !acceptsSearchSessionIdentity(latest, identity)) return
          const searchError = normalizeControllerError(error)
          replaceSessionRef.current({
            ...latest,
            error: searchError,
            hits: [],
            selectedKey: null,
            state: viewStateForError(searchError),
            total: null,
          })
        },
        onResolve(response) {
          if (
            runEpochRef.current !== expectedRunEpoch ||
            response.clientRequestId !== clientRequestId
          ) {
            return
          }
          const latest = getSessionRef.current()
          if (!latest) return
          const next = sessionAfterSearchResponse(latest, identity, response)
          if (!next) return
          replaceSessionRef.current(next)

          const delay = searchRetryDelay(response.indexState, retryAttempt)
          if (delay === null) {
            const exhausted = sessionAfterRetryExhausted(
              next,
              response.indexState
            )
            if (exhausted !== next) replaceSessionRef.current(exhausted)
            return
          }
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null
            if (runEpochRef.current !== expectedRunEpoch) return
            const retrySession = getSessionRef.current()
            if (!retrySession || !sameBaseIdentity(retrySession, identity)) return
            enqueueFullTextSearch(
              retrySession,
              retryAttempt + 1,
              "reconcile",
              expectedRunEpoch
            )
          }, delay)
        },
        run: () => provider.search(request),
        scope: sourceSession.scope,
      })
    }
  }, [
    clearRetry,
    isLockboxAvailable,
    lockboxProvider,
    openCatalog,
    publicProvider,
    recent,
    session?.drafts.fullText,
    session?.drafts.open,
    session?.id,
    session?.includeTrash,
    session?.mode,
    session?.querySequence,
    session?.scope,
    session?.uiEpoch,
    session?.vaultPath,
  ])

  const updateSession = useCallback(
    (update: (current: SearchSession) => SearchSession) => {
      clearRetry()
      queueRef.current?.clear()
      openQueueRef.current?.clear()
      const current = getSessionRef.current()
      if (!current) return
      replaceSessionRef.current(update(current))
    },
    [clearRetry]
  )

  return useMemo(() => ({
    onIncludeTrashChange(includeTrash) {
      updateSession((current) => ({
        ...current,
        error: null,
        hits: [],
        includeTrash,
        querySequence: current.querySequence + 1,
        selectedKey: null,
        state: current.drafts.fullText.trim() ? "indexing" : "emptyQuery",
        total: null,
      }))
    },
    onModeChange(mode) {
      updateSession((current) => {
        if (current.mode === mode) return current
        return {
          ...current,
          error: null,
          hits: [],
          mode,
          querySequence: current.querySequence + 1,
          selectedKey: null,
          state:
            mode === "fullText" && !current.drafts.fullText.trim()
              ? "emptyQuery"
              : "indexing",
          total: null,
        }
      })
    },
    onQueryChange(query) {
      updateSession((current) => ({
        ...current,
        drafts: { ...current.drafts, [current.mode]: query },
        error: null,
        hits: [],
        querySequence: current.querySequence + 1,
        selectedKey: null,
        state:
          current.mode === "fullText" && !query.trim()
            ? "emptyQuery"
            : "indexing",
        total: null,
      }))
    },
    onSelect(hit) {
      updateSession((current) => {
        if (!current.hits.some((candidate) => candidate.target.key === hit.target.key)) {
          return current
        }
        if (current.pendingNavigation?.targetKey === hit.target.key) {
          return current
        }
        nextRequestIdRef.current += 1
        return {
          ...current,
          pendingNavigation: {
            requestId: `navigation:${current.id}:${nextRequestIdRef.current}`,
            targetKey: hit.target.key,
          },
          selectedKey: hit.target.key,
        }
      })
    },
    onSelectedKeyChange(key) {
      updateSession((current) => ({ ...current, selectedKey: key }))
    },
  }), [updateSession])
}

function normalizeControllerError(error: unknown): SearchError {
  if (!error || typeof error !== "object") {
    return { code: "internal", retryable: false }
  }
  const candidate = error as SearchError
  if (typeof candidate.code !== "string") {
    return { code: "internal", retryable: false }
  }
  return candidate
}

function viewStateForError(error: SearchError): SearchSession["state"] {
  if (error.code === "locked" || error.code === "contextExpired") return "locked"
  if (
    error.code === "notFound" ||
    error.code === "targetChanged" ||
    error.code === "unsupportedTarget"
  ) {
    return "targetUnavailable"
  }
  return "error"
}

function sameBaseIdentity(
  session: SearchSession,
  identity: SearchSessionIdentity
) {
  return (
    session.id === identity.sessionId &&
    session.uiEpoch === identity.uiEpoch &&
    session.querySequence === identity.querySequence &&
    session.vaultPath === identity.vaultPath &&
    session.scope === identity.scope
  )
}
