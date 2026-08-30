import { extractTags, parseMarkdownImageLine } from "@/lib/editor-format"
import type { Fragment, LockboxState } from "@/types"

export const LOCKBOX_TAG = "密匣"

export function hasLockboxTag(tags: readonly string[]) {
  return tags.some((tag) => tag === LOCKBOX_TAG)
}

export function wantsLockbox(content: string, tags: readonly string[]) {
  return hasLockboxTag(tags) || hasLockboxTag(extractTags(content))
}

export function hasMarkdownImage(content: string) {
  return content.split("\n").some((line) => parseMarkdownImageLine(line) !== null)
}

export function isLockboxReady(lockbox: LockboxState | null) {
  return Boolean(lockbox?.configured && lockbox.unlocked)
}

export function publicFragments(fragments: readonly Fragment[]) {
  return fragments.filter((fragment) => !fragment.lockbox)
}
