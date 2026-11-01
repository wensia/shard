import { MAX_ATTACHMENTS, MAX_CONTENT_LENGTH, normalizeKdocsTags } from "./api"

export const KDOCS_DRAFT_KEY = "shard.kdocs-draft.v1"

export interface KdocsDraft {
  content: string
  tags: string
  attachmentPaths: string[]
  requestId: string
}

export interface KdocsDraftState extends KdocsDraft {
  submitted: KdocsDraft | null
}

function newDraft(): KdocsDraftState {
  return { content: "", tags: "", attachmentPaths: [], requestId: crypto.randomUUID(), submitted: null }
}

function isDraft(value: unknown): value is KdocsDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const draft = value as Partial<KdocsDraft>
  return typeof draft.content === "string" && draft.content.length <= MAX_CONTENT_LENGTH
    && typeof draft.tags === "string" && draft.tags.length <= 2048
    && typeof draft.requestId === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(draft.requestId)
    && Array.isArray(draft.attachmentPaths) && draft.attachmentPaths.length <= MAX_ATTACHMENTS
    && draft.attachmentPaths.every(path => typeof path === "string" && path.length <= 4096 && !path.includes("\0") && /^(?:\/|[a-z]:[\\/])/iu.test(path))
}

function cleanDraft(draft: KdocsDraft): KdocsDraft {
  return { content: draft.content, tags: draft.tags, attachmentPaths: [...new Set(draft.attachmentPaths)], requestId: draft.requestId }
}

export function isPrivateKdocsDraft(draft: KdocsDraft) {
  return draft.content.toLowerCase().includes("#lockbox") || draft.content.includes("#密匣")
    || normalizeKdocsTags(draft.tags).some(tag => tag.split("/").some(part => part.toLowerCase() === "lockbox" || part === "密匣"))
}

export function sameKdocsDraft(left: KdocsDraft, right: KdocsDraft) {
  return left.content === right.content && left.tags === right.tags
    && left.attachmentPaths.length === right.attachmentPaths.length
    && left.attachmentPaths.every((path, index) => path === right.attachmentPaths[index])
}

export function readKdocsDraft(): KdocsDraftState {
  try {
    const raw = window.localStorage.getItem(KDOCS_DRAFT_KEY)
    if (!raw || raw.length > 150_000) return newDraft()
    const value: unknown = JSON.parse(raw)
    if (!isDraft(value)) return newDraft()
    const submitted = (value as Partial<KdocsDraftState>).submitted
    if (submitted !== undefined && submitted !== null && (!isDraft(submitted) || submitted.requestId !== value.requestId)) return newDraft()
    if (isPrivateKdocsDraft(value) || (isDraft(submitted) && isPrivateKdocsDraft(submitted))) {
      window.localStorage.removeItem(KDOCS_DRAFT_KEY)
      return newDraft()
    }
    return { ...cleanDraft(value), submitted: isDraft(submitted) ? cleanDraft(submitted) : null }
  } catch {
    return newDraft()
  }
}

export function persistKdocsDraft(draft: KdocsDraftState) {
  try {
    if (isPrivateKdocsDraft(draft) || (draft.submitted && isPrivateKdocsDraft(draft.submitted))
      || (!draft.content && !draft.tags && draft.attachmentPaths.length === 0 && !draft.submitted)) {
      window.localStorage.removeItem(KDOCS_DRAFT_KEY)
    } else {
      window.localStorage.setItem(KDOCS_DRAFT_KEY, JSON.stringify(draft))
    }
    return true
  } catch {
    // Storage may be unavailable; keep the in-memory draft usable.
    return false
  }
}
