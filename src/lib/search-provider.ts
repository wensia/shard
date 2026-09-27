import { deriveDocumentDigest, deriveKind, deriveNoteTitle } from "@/lib/content-kind"
import {
  toFragmentSearchDocument,
  type FragmentSearchHighlight,
  type FragmentSearchMatch,
  type FragmentSearchWorkerRequest,
  type FragmentSearchWorkerResponse,
} from "@/lib/fragment-search"
import { readOutlineContent } from "@/lib/mind-map-outline"
import { readFlowchartContent } from "@/lib/flowchart-content"
import { searchVault } from "@/lib/search-api"
import {
  searchTargetKey,
  type SearchField,
  type SearchHit,
  type SearchScope,
  type SearchTextPart,
  type SearchVaultRequest,
  type SearchVaultResponse,
} from "@/lib/search-contract"
import type { Fragment } from "@/types"

export interface ContentSearchProvider {
  search(request: SearchVaultRequest): Promise<SearchVaultResponse>
}

export interface DisposableContentSearchProvider extends ContentSearchProvider {
  dispose(): void
}

/** The public-only rollback remains available until native acceptance is complete. */
export function createPublicSearchProvider(
  fragments: readonly Fragment[]
): DisposableContentSearchProvider {
  if (import.meta.env.VITE_SEARCH_PUBLIC_LEGACY === "1") {
    return createLegacyPublicSearchProvider(fragments)
  }
  const provider = createRustSearchProvider("public")
  return { ...provider, dispose() {} }
}

export function createLegacyPublicSearchProvider(
  fragments: readonly Fragment[]
): DisposableContentSearchProvider {
  const publicFragments = fragments.filter((fragment) => !fragment.lockbox)
  const fragmentById = new Map(
    publicFragments.map((fragment) => [fragment.id, fragment])
  )
  let disposed = false
  let worker: Worker | null = null
  let workerVersion = 0
  let nextRequestId = 0
  let readyPromise: Promise<void> | null = null
  let rejectReady: ((reason?: unknown) => void) | null = null
  const pending = new Map<
    number,
    {
      reject: (reason?: unknown) => void
      request: SearchVaultRequest
      resolve: (response: SearchVaultResponse) => void
    }
  >()

  function ensureWorker() {
    if (disposed) throw new Error("searchProviderDisposed")
    if (worker && readyPromise) return { ready: readyPromise, worker }

    workerVersion += 1
    const currentVersion = workerVersion
    const currentWorker = new Worker(
      new URL("../workers/fragment-search.worker.ts", import.meta.url),
      { type: "module" }
    )
    worker = currentWorker
    readyPromise = new Promise<void>((resolve, reject) => {
      rejectReady = reject
      currentWorker.onmessage = (
        event: MessageEvent<FragmentSearchWorkerResponse>
      ) => {
        const response = event.data
        if (response.version !== currentVersion || disposed) return
        if (response.type === "ready") {
          rejectReady = null
          resolve()
          return
        }

        const request = pending.get(response.requestId)
        if (!request) return
        pending.delete(response.requestId)
        request.resolve(
          toSearchResponse(request.request, response.response.matches, response.response.total)
        )
      }
      currentWorker.onerror = () => {
        const error = { code: "internal", retryable: true } as const
        rejectReady?.(error)
        rejectReady = null
        for (const request of pending.values()) request.reject(error)
        pending.clear()
        if (worker === currentWorker) {
          currentWorker.terminate()
          worker = null
          readyPromise = null
        }
      }
    })

    currentWorker.postMessage({
      documents: publicFragments.map(toFragmentSearchDocument),
      type: "index",
      version: currentVersion,
    } satisfies FragmentSearchWorkerRequest)

    return { ready: readyPromise, worker: currentWorker }
  }

  function toSearchResponse(
    request: SearchVaultRequest,
    matches: readonly FragmentSearchMatch[],
    total: number
  ): SearchVaultResponse {
    return {
      clientRequestId: request.clientRequestId,
      context: {
        privacyEpoch: request.context?.privacyEpoch ?? "0",
        vaultEpoch: request.context?.vaultEpoch ?? "0",
        vaultPath: request.expectedVaultPath,
      },
      expiresAt: null,
      hits: matches.flatMap((match) => {
        const fragment = fragmentById.get(match.fragmentId)
        return fragment ? [legacyMatchToHit(request, fragment, match)] : []
      }),
      indexState: "ready",
      skippedFiles: 0,
      snapshotId: "legacy-public-worker",
      total,
      warning: null,
    }
  }

  return {
    dispose() {
      if (disposed) return
      disposed = true
      const error = { code: "internal", retryable: false } as const
      rejectReady?.(error)
      rejectReady = null
      for (const request of pending.values()) request.reject(error)
      pending.clear()
      worker?.terminate()
      worker = null
      readyPromise = null
    },
    async search(request) {
      if (request.scope !== "public") {
        return Promise.reject({
          code: "invalidRequest",
          reason: "publicProviderScopeMismatch",
        })
      }
      if (!request.expectedVaultPath) {
        return Promise.reject({
          code: "invalidRequest",
          reason: "missingVaultPath",
        })
      }

      const current = ensureWorker()
      await current.ready
      if (disposed || current.worker !== worker) {
        return Promise.reject({ code: "internal", retryable: true })
      }

      nextRequestId += 1
      const requestId = nextRequestId
      return new Promise<SearchVaultResponse>((resolve, reject) => {
        pending.set(requestId, { reject, request, resolve })
        current.worker.postMessage({
          limit: request.limit,
          query: request.query,
          requestId,
          scope: request.includeTrash ? "all" : "active",
          type: "search",
          version: workerVersion,
        } satisfies FragmentSearchWorkerRequest)
      })
    },
  }
}

export function createRustSearchProvider(
  scope: SearchScope
): ContentSearchProvider {
  return {
    search(request) {
      if (request.scope !== scope) {
        return Promise.reject({
          code: "invalidRequest",
          reason: `${scope}ProviderScopeMismatch`,
        })
      }
      return searchVault(request)
    },
  }
}

function legacyMatchToHit(
  request: SearchVaultRequest,
  fragment: Fragment,
  match: FragmentSearchMatch
): SearchHit {
  const title = fragmentSearchTitle(fragment)
  const matchedFields: SearchField[] = []
  if (match.highlights.length > 0) matchedFields.push("body")
  if (match.matchedTags.length > 0) matchedFields.push("tags")
  if (matchedFields.length === 0) matchedFields.push("body")

  return {
    matchedFields,
    preview: excerptParts(match),
    revealHint: "text",
    revision: fragment.updatedAt || fragment.createdAt || "legacy-public-worker",
    tags: fragment.tags,
    target: {
      archived: fragment.archived,
      key: searchTargetKey(request.expectedVaultPath, "public", fragment.path),
      kind: deriveKind(fragment.tags),
      objectId: fragment.id,
      path: fragment.path,
      scope: "public",
      vaultPath: request.expectedVaultPath,
    },
    title,
    titleParts: [{ hit: false, text: title }],
    updatedAt: fragment.updatedAt || null,
  }
}

function fragmentSearchTitle(fragment: Fragment) {
  const kind = deriveKind(fragment.tags)
  if (kind === "note") return deriveNoteTitle(fragment.content) || "未命名笔记"
  if (kind === "document") {
    return deriveDocumentDigest(fragment.content).title || "未命名文档"
  }
  if (kind === "outline") {
    const file = readOutlineContent(fragment.content)?.file
    return file?.nodes[file.rootId]?.text.trim() || "未命名大纲"
  }
  if (kind === "flowchart") {
    return readFlowchartContent(fragment.content)?.file.title.trim() || "未命名流程图"
  }

  const firstVisibleLine = fragment.content
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^#{1,6}\s+/u, ""))
    .find(Boolean)
  return firstVisibleLine || "未命名碎片"
}

function excerptParts(match: FragmentSearchMatch): SearchTextPart[] {
  const parts = splitHighlightParts(match.excerpt, match.highlights)
  if (match.excerptStartsBefore) parts.unshift({ hit: false, text: "…" })
  if (match.excerptEndsAfter) parts.push({ hit: false, text: "…" })
  return parts
}

function splitHighlightParts(
  text: string,
  highlights: readonly FragmentSearchHighlight[]
): SearchTextPart[] {
  if (!text) return []
  if (highlights.length === 0) return [{ hit: false, text }]

  const parts: SearchTextPart[] = []
  let offset = 0
  for (const range of highlights) {
    const start = Math.max(offset, Math.min(text.length, range.start))
    const end = Math.max(start, Math.min(text.length, range.end))
    if (start > offset) parts.push({ hit: false, text: text.slice(offset, start) })
    if (end > start) parts.push({ hit: true, text: text.slice(start, end) })
    offset = end
  }
  if (offset < text.length) parts.push({ hit: false, text: text.slice(offset) })
  return parts
}
