import { LOCKBOX_TAG } from "@/lib/lockbox"
import type { Fragment } from "@/types"

export interface FragmentSearchResult {
  fragment: Fragment
  matchEnd?: number
  matchStart?: number
  matchedTags: string[]
  score: number
}

/**
 * Filters fragments by a free-text query over body and tags. The candidate set
 * is the caller's responsibility (it already encodes visibility: public +
 * unlocked lockbox, archived excluded), so this stays a pure ranking pass.
 */
export function searchFragments(
  fragments: Fragment[],
  rawQuery: string
): FragmentSearchResult[] {
  const query = rawQuery.trim().toLowerCase()
  if (query.length === 0) return []

  const results: FragmentSearchResult[] = []

  for (const fragment of fragments) {
    const body = fragment.content
    const bodyIndex = body.toLowerCase().indexOf(query)
    const matchedTags = fragment.tags.filter(
      (tag) =>
        tag !== "inbox" &&
        tag !== LOCKBOX_TAG &&
        tag.toLowerCase().includes(query)
    )

    if (bodyIndex === -1 && matchedTags.length === 0) continue

    results.push({
      fragment,
      matchEnd: bodyIndex === -1 ? undefined : bodyIndex + query.length,
      matchStart: bodyIndex === -1 ? undefined : bodyIndex,
      matchedTags,
      // body hit earlier in the text ranks higher; tag-only hits sink slightly
      score: bodyIndex === -1 ? 1_000_000 : bodyIndex,
    })
  }

  return results.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    return b.fragment.createdAt.localeCompare(a.fragment.createdAt)
  })
}
