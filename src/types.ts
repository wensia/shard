export type FragmentStatus =
  | "saved"
  | "committed"
  | "sync_pending"
  | "commit_failed"

export type FragmentFilter =
  | "inbox"
  | "tagged"
  | "lockbox"
  | "dailyReview"
  | "insight"
  | "walk"
  | "archive"

export interface Fragment {
  id: string
  content: string
  createdAt: string
  updatedAt: string
  tags: string[]
  category: string | null
  path: string
  gitStatus: FragmentStatus
  error: string | null
  aiStatus?: "none" | "pending" | "suggested" | "accepted" | "skipped"
  archived: boolean
  lockbox: boolean
  pinned: boolean
  /**
   * 非空表示这是一份冲突副本，值是原件的 id。
   *
   * 同步遇到"两端都改过同一条"时不覆盖，把本地那版另存成这样一条。
   */
  conflictOf?: string
}

export interface GitInfo {
  branch: string
  shortCommit: string
  hasRemote: boolean
  status: "ready" | "no_git" | "dirty" | "syncing" | "error"
  error: string | null
  ahead: number
  behind: number
}

export interface GithubCliInfo {
  installed: boolean
  authenticated: boolean
  login: string | null
  protocol: string | null
  error: string | null
}

export interface CodexAgentStatus {
  installed: boolean
  version: string | null
  path: string | null
  error: string | null
}

export type CodexReviewTask = "insight" | "walk"

export type CodexInsightLens =
  | "default"
  | "values"
  | "reverse"
  | "secondOrder"
  | "cbt"
  | "mbti"

export interface CodexReviewFragment {
  id: string
  content: string
  createdAt: string
  tags: string[]
  path: string
}

export interface CodexReviewTaskResult {
  text: string
}

export interface MindMapSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  nodeCount: number
  path: string
}

export interface MindMapReadResult {
  file: ShardMapFile
  path: string
  lastSavedHash: string
}

export interface ShardMapFile {
  kind: "shard.map"
  schemaVersion: 1
  id: string
  title: string
  createdAt: string
  updatedAt: string
  savedWithAppVersion: string
  revision: number
  rootId: string
  hasProtectedLinks: false
  nodes: Record<string, ShardMapNode>
  viewport?: ShardMapViewport
}

export interface ShardMapViewport {
  x: number
  y: number
  zoom: number
}

export interface ShardMapNode {
  id: string
  parentId: string | null
  sortKey: string
  text: string
  note?: string
  collapsed?: boolean
  /** 用户手动设置的节点宽度（布局单位）；未设置时按文字自适应。 */
  width?: number
  createdAt: string
  updatedAt: string
  links?: ShardDocumentLink[]
  style?: {
    tone?: "default" | "accent" | "success" | "warning"
  }
}

export type ShardDocumentLink =
  | ShardFragmentLink
  | ShardMarkdownPathLink
  | ShardMapLink

export interface ShardFragmentLink {
  id: string
  targetType: "fragment"
  targetId: string
}

export interface ShardMarkdownPathLink {
  id: string
  targetType: "markdownPath"
  path: string
}

export interface ShardMapLink {
  id: string
  targetType: "map"
  targetId: string
}

export interface VaultState {
  vaultPath: string
  fragments: Fragment[]
  git: GitInfo
  lockbox: LockboxState
}

export interface LockboxState {
  configured: boolean
  unlocked: boolean
  expiresAt: string | null
  ttlSeconds: number
}

export interface LockboxSetupResult {
  recoveryKey: string
  vault: VaultState
}

export type DebtDirection = "borrow_in" | "lend_out"
// 沿用 snake_case 字符串字面量的既有先例，与 Rust 侧
// 原始字符串值一一对应，不做 camelCase 改写。

export interface Repayment {
  id: string
  debtId: string
  amountCents: number
  paidOn: string // "YYYY-MM-DD"
  note: string
  createdAt: string // RFC3339
}

export interface Debt {
  id: string
  direction: DebtDirection
  counterparty: string
  principalCents: number
  dueDate: string | null // "YYYY-MM-DD" | null
  note: string
  tags: string[]
  createdAt: string
  updatedAt: string
  archived: boolean
  paidCents: number
  remainingCents: number
  settled: boolean
  repayments: Repayment[]
}

/** 对应 Rust `TursoConfigView`：不含 token 明文，只回传是否已配置。 */
export interface TursoConfigView {
  url: string | null
  hasToken: boolean
}

// —— 以下类型纯前端派生，没有对应的 Rust struct ——

export type DebtUrgency = "overdue" | "dueSoon" | "settled" | "noDueDate" | "normal"

export interface ContactDebtSummary {
  counterpartyKey: string
  counterpartyDisplayName: string
  netCents: number // 正数=对方净欠我；负数=我净欠对方
  lendOutRemainingCents: number
  borrowInRemainingCents: number
  activeDebtCount: number // 未结清且未归档
  overdueCount: number
  debts: Debt[]
}
