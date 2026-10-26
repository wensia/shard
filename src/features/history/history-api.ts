import { transport } from "@/lib/transport"

/** 一条修订（服务端 `shard_store::RevisionInfo`）。 */
export interface RevisionInfo {
  revId: number
  nodeId: number
  path: string
  /** 删除时刻的记录为空。 */
  sha: string | null
  size: number | null
  reason: RevisionReason
  device: string | null
  createdAt: string
}

export type RevisionReason =
  | "import"
  | "create"
  | "edit"
  | "rename"
  | "move"
  | "trash"
  | "restore"
  | "purge"
  | "conflict"
  | "revert"
  | "migrate"

export interface RevisionList {
  nodeId: number
  path: string | null
  revisions: RevisionInfo[]
}

/** 最近彻底删除、历史还在的文件。 */
export interface DeletedEntry {
  nodeId: number
  /** 删除前最后一条有内容的修订：「找回」恢复它。 */
  revId: number
  path: string
  sha: string | null
  purgedAt: string
  expiresAt: string
  revisions: number
}

export type HistoryTarget = { path: string } | { id: string } | { nodeId: number }

export function listRevisions(target: HistoryTarget) {
  return transport().invoke<RevisionList>("list_revisions", target)
}

export function listDeletedEntries() {
  return transport().invoke<{ entries: DeletedEntry[]; retentionDays: number }>("list_deleted_entries", {})
}

/** `expectedSha`：条目当前内容的 sha，恢复在用条目时防止盖掉别处刚做的修改。 */
export function restoreRevision(revId: number, expectedSha?: string | null) {
  return transport().invoke<{ path: string; sha: string; revived: boolean }>("restore_revision", {
    revId,
    expectedSha: expectedSha ?? null,
  })
}

export function eraseDeletedEntries(nodeIds: number[]) {
  return transport().invoke<{ nodes: number; revisions: number; blobs: number }>("erase_deleted_entries", { nodeIds })
}

export function revisionUrl(revId: number, download = false) {
  return `/api/history/${revId}${download ? "?download=1" : ""}`
}

export function exportZipUrl() {
  return `/api/export.zip?utcOffset=${-new Date().getTimezoneOffset()}`
}

/** 文本类修订的原文（预览用）。 */
export async function readRevisionText(revId: number) {
  const response = await fetch(revisionUrl(revId), { credentials: "same-origin" })
  if (!response.ok) throw new Error(`读取旧版本失败（${response.status}）`)
  return response.text()
}

export const REVISION_REASON_LABEL: Record<RevisionReason, string> = {
  import: "导入",
  create: "新建",
  edit: "编辑",
  rename: "改名",
  move: "移动",
  trash: "移入回收站",
  restore: "从回收站恢复",
  purge: "彻底删除",
  conflict: "冲突副本",
  revert: "恢复旧版本",
  migrate: "格式迁移",
}

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|svg|heic|heif|avif|bmp)$/iu
const TEXT_EXTENSION = /\.(?:md|csv|json|txt)$/iu

export function revisionPreviewKind(path: string): "image" | "text" | "binary" {
  if (IMAGE_EXTENSION.test(path)) return "image"
  if (TEXT_EXTENSION.test(path)) return "text"
  return "binary"
}

/** 「打开版本历史」：菜单只发事件，由挂在应用根部的宿主弹出对话框。 */
export const OPEN_HISTORY_EVENT = "shard:open-history"

export interface OpenHistoryDetail {
  target: HistoryTarget
  title: string
}

export function openRevisionHistory(detail: OpenHistoryDetail) {
  window.dispatchEvent(new CustomEvent<OpenHistoryDetail>(OPEN_HISTORY_EVENT, { detail }))
}
