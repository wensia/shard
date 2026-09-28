import type { ContentKind } from "@/lib/content-kind"
import type { PropertyType } from "@/lib/properties"

export type FragmentStatus =
  | "saved"
  | "committed"
  | "sync_pending"
  | "commit_failed"

export type FragmentFilter =
  | "inbox"
  | "tagged"
  | "lockbox"
  | "archive"

export interface FragmentRelation {
  targetId: string
  /** walk / insight 仅用于读取已有笔记的历史关联来源。 */
  origin: "manual" | "walk" | "insight" | "tag" | "wikilink"
  createdAt: string
  note?: string
}

export type PropertyValue =
  | { kind: "text"; text: string }
  | { kind: "number"; text: string }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "list"; items: string[] }
  | { kind: "other"; raw: string }

export interface FragmentProperty {
  key: string
  value: PropertyValue
  editable: boolean
}

export interface PropertyRegistry {
  version: number
  properties: Record<string, { type: PropertyType }>
}

export interface PropertyRegistryRead {
  registry: PropertyRegistry
  sha: string
}

export interface Fragment {
  id: string
  content: string
  fileSha?: string
  kind: ContentKind
  createdAt: string
  updatedAt: string
  tags: string[]
  category: string | null
  path: string
  gitStatus: FragmentStatus
  error: string | null
  aiStatus?: "none" | "pending" | "suggested" | "accepted" | "skipped"
  /** 兼容字段名；现在表示该公开片段位于回收站中。 */
  archived: boolean
  lockbox: boolean
  pinned: boolean
  related?: FragmentRelation[]
  /** 可选以兼容旧版后端与 UI 测试 mock。 */
  properties?: FragmentProperty[]
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

export interface CheckpointResult {
  status: "not_git" | "blocked" | "no_changes" | "committed"
  changes: number
  reason: string | null
  git: GitInfo
}

export type OutlineUpgradeStatus = "lossless" | "lossy" | "blocked"

export interface OutlineUpgradeIssue {
  kind:
    | "discardedNonListLine"
    | "continuationLine"
    | "codeFence"
    | "truncatedNodeText"
  count: number
  samples: string[]
}

export interface OutlineUpgradePreflightItem {
  id: string
  path: string
  title: string
  fileSha: string
  nodeCount: number
  status: OutlineUpgradeStatus
  issues: OutlineUpgradeIssue[]
  reason: string | null
}

export interface OutlineUpgradeSelection {
  id: string
  fileSha: string
}

export interface OutlineUpgradeItemResult {
  id: string
  path: string | null
  status: "upgraded" | "skipped" | "failed"
  reason: string | null
  issues: OutlineUpgradeIssue[]
}

export interface OutlineUpgradeRunResult {
  results: OutlineUpgradeItemResult[]
  backupPath: string | null
  checkpointStatus: "committed" | "no_changes" | null
  commitError: string | null
}

export interface CsvFileSummary {
  name: string
  path: string
}

export type LibraryTreeEntryKind =
  | "directory"
  | "markdown"
  | "csv"
  | "mindmap"
  | "flowchart"
  | "canvas"
  | "table"
  | "image"
  | "file"

export interface LibraryTreeEntry {
  name: string
  path: string
  kind: LibraryTreeEntryKind
  size: number
  createdAt?: string | null
  modifiedAt: string
  mindMapId?: string
  children?: LibraryTreeEntry[]
}

export interface LibraryFragmentMonth {
  month: string
  count: number
}

export interface LibraryFragmentYear {
  year: string
  totalCount: number
  months: LibraryFragmentMonth[]
}

export interface LibraryFragmentStream {
  totalCount: number
  years: LibraryFragmentYear[]
}

export interface LibraryAssetEntry {
  path: string
  size: number
  modifiedAt: string
  mimeType: string
}

export interface LibraryTreeSnapshot {
  assets: LibraryAssetEntry[]
  entries: LibraryTreeEntry[]
  fragmentStream: LibraryFragmentStream
  trashEntries: LibraryTreeEntry[]
  fragmentTrashEntries?: LibraryTreeEntry[]
}

export interface LibraryMutationResult {
  tree: LibraryTreeSnapshot
  fragment?: Fragment
  updatedLinks: number
}

export interface LegacyNoteMigrationResult {
  tree: LibraryTreeSnapshot
  migratedCount: number
}

export interface GithubCliInfo {
  installed: boolean
  authenticated: boolean
  login: string | null
  protocol: string | null
  error: string | null
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

export interface DiagramDocumentSummary {
  id: string
  title: string
  path: string
  kind: "mindmap" | "flowchart"
  nodeCount: number
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
  | ShardFlowLink

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

export interface ShardFlowLink {
  id: string
  targetType: "flow"
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
