import type {
  SearchMode,
  SearchScope,
  SearchSession,
} from "@/lib/search-contract"
import type { Fragment } from "@/types"
import type { WorkspaceRoute } from "@/workspace/route"

export type SearchRevokeReason =
  | "close"
  | "spaceChanged"
  | "vaultChanged"
  | "locked"
  | "expired"
  | "targetMoved"
  | "unmount"

interface MutableRef<T> {
  current: T
}

export interface SearchSessionIdentity {
  sessionId: string
  uiEpoch: number
  querySequence: number
  vaultPath: string
  scope: SearchScope
  vaultEpoch: string | null
  privacyEpoch: string | null
}

export interface SearchSessionRevocationTarget {
  sessionRef: MutableRef<SearchSession | null>
  uiEpochRef: MutableRef<number>
  clear: (reason: SearchRevokeReason) => void
}

export interface CreateSearchSessionOptions {
  id: string
  mode?: SearchMode
  scope: SearchScope
  uiEpoch: number
  vaultPath: string
}

export function scopeForSpace(
  space: WorkspaceRoute["space"]
): SearchScope {
  return space === "lockbox" ? "lockbox" : "public"
}

/**
 * T01 过渡边界：旧 Worker 只允许处理公开对象；密匣全文等待 Rust provider。
 */
export function legacyWorkerFragmentsForScope(
  fragments: readonly Fragment[],
  scope: SearchScope
): Fragment[] {
  if (scope === "lockbox") return []
  return fragments.filter((fragment) => !fragment.lockbox)
}

export function createSearchSession({
  id,
  mode = "fullText",
  scope,
  uiEpoch,
  vaultPath,
}: CreateSearchSessionOptions): SearchSession {
  return {
    id,
    vaultPath,
    scope,
    uiEpoch,
    mode,
    drafts: { fullText: "", open: "" },
    includeTrash: false,
    querySequence: 0,
    state: "emptyQuery",
    context: null,
    snapshotId: null,
    expiresAt: null,
    hits: [],
    total: null,
    selectedKey: null,
    openedKey: null,
    pendingNavigation: null,
    lastReveal: null,
    error: null,
  }
}

export function captureSearchSessionIdentity(
  session: SearchSession
): SearchSessionIdentity {
  return {
    sessionId: session.id,
    uiEpoch: session.uiEpoch,
    querySequence: session.querySequence,
    vaultPath: session.vaultPath,
    scope: session.scope,
    vaultEpoch: session.context?.vaultEpoch ?? null,
    privacyEpoch: session.context?.privacyEpoch ?? null,
  }
}

export function acceptsSearchSessionIdentity(
  session: SearchSession | null,
  identity: SearchSessionIdentity
): boolean {
  if (!session) return false
  if (
    session.id !== identity.sessionId ||
    session.uiEpoch !== identity.uiEpoch ||
    session.querySequence !== identity.querySequence ||
    session.vaultPath !== identity.vaultPath ||
    session.scope !== identity.scope
  ) {
    return false
  }

  if (identity.vaultEpoch !== null) {
    if (session.context?.vaultEpoch !== identity.vaultEpoch) return false
  }
  if (identity.privacyEpoch !== null) {
    if (session.context?.privacyEpoch !== identity.privacyEpoch) return false
  }
  return true
}

/** uiEpoch 必须先同步递增，迟到回调才能在 React 清状态前立即失效。 */
export function revokeSearchSession(
  target: SearchSessionRevocationTarget,
  reason: SearchRevokeReason
): void {
  target.uiEpochRef.current += 1
  target.sessionRef.current = null
  target.clear(reason)
}

export interface VaultStateRequestToken {
  kind: VaultStateRequestKind
  generation: number
  privacyEpoch: number
  vaultEpoch: number
  expectedVaultPath: string | null
}

export type VaultStateRequestKind = "read" | "privacy"

export interface VaultStateGenerationGate {
  begin(
    expectedVaultPath: string | null,
    kind?: VaultStateRequestKind
  ): VaultStateRequestToken
  completePrivacyChange(): number
  invalidate(): number
  accepts(token: VaultStateRequestToken, actualVaultPath: string): boolean
  current(): number
}

/**
 * 只读请求不作废在途隐私变更；隐私变更的开始与完成都会作废旧只读响应。
 * vaultEpoch 保留跨 vault 单调性，因此 A→B→A 后旧 A 响应仍会被拒绝。
 */
export function createVaultStateGenerationGate(): VaultStateGenerationGate {
  let privacyEpoch = 0
  let readGeneration = 0
  let vaultEpoch = 0

  return {
    begin(expectedVaultPath, kind = "read") {
      if (kind === "privacy") {
        privacyEpoch += 1
        return {
          kind,
          generation: privacyEpoch,
          privacyEpoch,
          vaultEpoch,
          expectedVaultPath,
        }
      }

      readGeneration += 1
      return {
        kind,
        generation: readGeneration,
        privacyEpoch,
        vaultEpoch,
        expectedVaultPath,
      }
    },
    completePrivacyChange() {
      privacyEpoch += 1
      return privacyEpoch
    },
    invalidate() {
      vaultEpoch += 1
      privacyEpoch += 1
      readGeneration += 1
      return vaultEpoch
    },
    accepts(token, actualVaultPath) {
      return (
        token.vaultEpoch === vaultEpoch &&
        token.privacyEpoch === privacyEpoch &&
        (token.kind === "privacy" || token.generation === readGeneration) &&
        (token.expectedVaultPath === null ||
          token.expectedVaultPath === actualVaultPath)
      )
    },
    current() {
      return vaultEpoch
    },
  }
}
