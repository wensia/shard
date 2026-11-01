import { invoke, isTauri } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { openUrl } from "@tauri-apps/plugin-opener"

export interface KdocsConnection {
  fileId: string
  sheetId: string
  url: string
}

export interface KdocsStatus {
  cliAvailable: boolean
  authenticated: boolean
  connection: KdocsConnection | null
}

export interface KdocsAttachment {
  objectId: string
  name: string
  size: number
  type: string
}

export interface KdocsRecord {
  id: string
  shardId: string
  content: string
  tags: string[]
  createdAt: string
  attachments: KdocsAttachment[]
}

export interface KdocsRecordPage {
  records: KdocsRecord[]
  hasMore: boolean
  nextCursor: string | null
}

export interface KdocsSaveInput {
  requestId: string
  content: string
  tags: string[]
  attachmentPaths: string[]
}

export const MAX_ATTACHMENTS = 10
export const MAX_CONTENT_LENGTH = 20_000
export const KDOCS_DESKTOP_MESSAGE = "请在 Shard 桌面应用中使用金山文档。"

function kdocsInvoke<T>(command: string, args?: Record<string, unknown>) {
  if (!isTauri()) return Promise.reject(new Error(KDOCS_DESKTOP_MESSAGE))
  return invoke<T>(command, args)
}

export function getKdocsStatus() {
  return kdocsInvoke<KdocsStatus>("kdocs_status")
}

export function initializeKdocs() {
  return kdocsInvoke<KdocsStatus>("kdocs_initialize")
}

export function listKdocsRecords(cursor: string | null = null) {
  return kdocsInvoke<KdocsRecordPage>("kdocs_list_records", { cursor })
}

export function saveKdocsRecord(input: KdocsSaveInput) {
  return kdocsInvoke<KdocsRecord>("kdocs_save_record", { input })
}

export function getKdocsAttachmentUrl(objectId: string) {
  return kdocsInvoke<string>("kdocs_attachment_url", { objectId })
}

export async function chooseKdocsAttachments() {
  if (!isTauri()) throw new Error(KDOCS_DESKTOP_MESSAGE)
  const selected = await open({ multiple: true, directory: false, title: "添加附件" })
  return selected === null ? [] : Array.isArray(selected) ? selected : [selected]
}

/** Only web URLs may cross into the system opener; attachment links are fetched on demand. */
export async function openKdocsUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("文档链接无效")
  }
  await openUrl(url.href)
}

export function kdocsErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/u, "").replace(/^KDOCS_EDITABLE:\s*/u, "")
}

export function isEditableKdocsError(error: unknown) {
  return /^KDOCS_EDITABLE:/u.test((error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/u, ""))
}

export function normalizeKdocsTags(value: string) {
  return [...new Set(value.split(/[\s,，;；]+/u).map(tag => tag.replace(/^#+/u, "").trim()).filter(Boolean))]
}

export function attachmentFileName(path: string) {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path
}
