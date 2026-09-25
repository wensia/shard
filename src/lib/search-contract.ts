import type { Fragment } from "@/types"

export type SearchScope = "public" | "lockbox"
export type SearchMode = "fullText" | "open"

export type SearchKind =
  | "fragment"
  | "note"
  | "outline"
  | "document"
  | "mindmap"
  | "flowchart"
  | "canvas"
  | "table"
  | "csv"

export type SearchField = "title" | "tags" | "body" | "path"

export type SearchRevealHint = "text" | "documentOnly" | "external"

export interface SearchTarget {
  /** JSON.stringify([vaultPath, scope, path]) */
  key: string
  /** 当前 VaultState.vaultPath；不是任意文件系统读取授权。 */
  vaultPath: string
  scope: SearchScope
  /** vault 内相对路径；使用 /；不得含 ..、绝对路径或越界链接。 */
  path: string
  kind: SearchKind
  /** 文件格式内的对象 ID；CSV 等没有 ID 的对象为 null。 */
  objectId: string | null
  /** 后端按实际所在路径校正，不能信任前端传值。 */
  archived: boolean
}

export function searchTargetKey(
  vaultPath: string,
  scope: SearchScope,
  path: string
): string {
  return JSON.stringify([vaultPath, scope, path])
}

export interface SearchTextPart {
  text: string
  hit: boolean
}

export interface SearchHit {
  target: SearchTarget
  title: string
  /** 拼接后必须严格等于 title。 */
  titleParts: readonly SearchTextPart[]
  tags: readonly string[]
  updatedAt: string | null
  /** Rust 全文结果必须非空；前端 Open 元数据可以为 null。 */
  revision: string | null
  matchedFields: readonly SearchField[]
  /** 纯文本片段，不接受 HTML。首版列表只展示一个片段。 */
  preview: readonly SearchTextPart[]
  /** 提示而非定位成功保证；最终以 RevealResult 为准。 */
  revealHint: SearchRevealHint
}

export interface SearchContext {
  vaultPath: string
  /** 后端生成的十进制字符串，避免 JS number 精度问题。 */
  vaultEpoch: string
  privacyEpoch: string
}

export type SearchError =
  | { code: "invalidRequest"; reason: string }
  | { code: "vaultChanged" }
  | { code: "contextExpired" }
  | { code: "locked" }
  | { code: "notFound" }
  | { code: "targetChanged" }
  | { code: "unsupportedTarget" }
  | { code: "io"; retryable: boolean }
  | { code: "internal"; retryable: boolean }

export type SearchViewState =
  | "emptyQuery"
  | "noResults"
  | "indexing"
  | "results"
  | "stale"
  | "locked"
  | "targetUnavailable"
  | "error"

export interface SearchSession {
  id: string
  vaultPath: string
  scope: SearchScope

  /** 前端同步递增；用于丢弃迟到 Promise、延迟渲染和导航回调。 */
  uiEpoch: number
  mode: SearchMode
  drafts: Record<SearchMode, string>
  includeTrash: boolean
  querySequence: number

  state: SearchViewState
  context: SearchContext | null
  snapshotId: string | null
  expiresAt: string | null

  hits: readonly SearchHit[]
  total: number | null
  selectedKey: string | null
  openedKey: string | null

  pendingNavigation: {
    requestId: string
    targetKey: string
  } | null

  lastReveal: RevealResult | null
  error: SearchError | null
}

export interface RevealPlan {
  requestId: string
  sessionId: string | null
  uiEpoch: number
  target: SearchTarget

  /** 使用打开时重新读取的 revision，不使用过期搜索快照偏移。 */
  revision: string
  projectionVersion: 1
  terms: readonly string[]
  preferredText: string | null
  revealHint: SearchRevealHint

  /** documentFind 仅预留契约，本轮没有对应入口。 */
  origin: "globalSearch" | "documentFind"
}

interface RevealIdentity {
  requestId: string
  targetKey: string
  revision: string
}

export type RevealResult =
  | (RevealIdentity & {
      status: "revealed"
      matchCount: number
      /** 从 0 开始。 */
      activeIndex: number
    })
  | (RevealIdentity & {
      status: "documentOnly"
      reason:
        | "metadata"
        | "codeBlock"
        | "embed"
        | "unsupportedHost"
        | "highlightUnavailable"
        | "external"
    })
  | (RevealIdentity & {
      status: "noVisibleMatch"
    })
  | (RevealIdentity & {
      status: "stale"
      reason: "targetChanged" | "revisionChanged" | "privacyChanged"
    })
  | (RevealIdentity & {
      status: "cancelled"
    })

export interface SearchRevealHandle {
  revealTerms(
    plan: RevealPlan,
    signal?: AbortSignal
  ): Promise<RevealResult>

  stepHit(direction: 1 | -1): Promise<RevealResult>

  clearHits(reason: "exit" | "edit" | "revoke" | "unmount"): void
}

export type SearchRefresh = "auto" | "reconcile" | "rebuild"
export type SearchIndexState = "indexing" | "ready" | "stale"

export interface SearchVaultRequest {
  clientRequestId: string
  expectedVaultPath: string
  context: SearchContext | null
  scope: SearchScope
  includeTrash: boolean
  queryVersion: number
  projectionVersion: number
  query: string
  limit: number
  refresh: SearchRefresh
}

export interface SearchVaultResponse {
  clientRequestId: string
  context: SearchContext
  snapshotId: string | null
  indexState: SearchIndexState
  expiresAt: string | null
  hits: readonly SearchHit[]
  total: number | null
  skippedFiles: number
  warning: SearchError | null
}

export interface ReadSearchTargetRequest {
  clientRequestId: string
  expectedVaultPath: string
  context: SearchContext | null
  target: SearchTarget
  expectedRevision: string | null
}

export interface ReadSearchTargetResponse {
  clientRequestId: string
  context: SearchContext
  expiresAt: string | null
  target: SearchTarget
  revision: string
  readOnly: boolean
  fragment: Fragment
}

/** 保持现有 API 水合方式：Rust Fragment 不含前端派生的 kind。 */
export type StoredSearchFragment = Omit<Fragment, "kind">
