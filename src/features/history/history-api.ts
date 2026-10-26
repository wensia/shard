import { writeExportFile } from "@/lib/export-file"
import { transport } from "@/lib/transport"
import { readRemoteRevision } from "@/lib/transport/desktop-remote"

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

/**
 * 桌面连接服务器：webview 与服务器不同源、也没有登录会话，修订原文经 Rust 带设备令牌读取
 *（预览图片用 blob 地址，下载走系统的保存对话框）；网页直接用 {@link revisionUrl}。
 */
export function readsRevisionsViaDevice() {
  return transport().kind === "tauri-remote"
}

/** 一条修订的原始字节（只在 {@link readsRevisionsViaDevice} 时用）。 */
export async function readRevisionBytes(revId: number) {
  return readRemoteRevision(revId)
}

/** 桌面连接服务器时的「下载这个版本」：选好位置后写到本机。返回是否保存了。 */
export async function saveRevisionCopy(revision: Pick<RevisionInfo, "revId" | "path">) {
  const { save } = await import("@tauri-apps/plugin-dialog")
  const target = await save({ defaultPath: revision.path.split("/").pop() || "旧版本", title: "下载这个版本" })
  if (!target) return false
  const { bytes } = await readRemoteRevision(revision.revId)
  await writeExportFile(target, bytes)
  return true
}

/** 文本类修订的原文（预览用）。 */
export async function readRevisionText(revId: number) {
  if (readsRevisionsViaDevice()) {
    const { bytes } = await readRemoteRevision(revId)
    return new TextDecoder().decode(bytes)
  }
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
