import type { CodexReviewFragment, Fragment } from "@/types"

const DAILY_REVIEW_COUNT = 8
const RANDOM_WALK_COUNT = 5
const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000
const MAX_CODEX_FRAGMENT_CHARS = 1600

export function dailyReviewFragments(
  fragments: Fragment[],
  seed: number,
  now = new Date()
) {
  const cutoff = now.getTime() - SIX_MONTHS_MS
  const eligible = fragments.filter((fragment) => {
    const createdAt = new Date(fragment.createdAt).getTime()
    return !fragment.archived && Number.isFinite(createdAt) && createdAt >= cutoff
  })

  return stablePick(eligible, seed, DAILY_REVIEW_COUNT, "daily-review")
}

export function randomWalkFragments(fragments: Fragment[], seed: number) {
  const eligible = fragments.filter((fragment) => !fragment.archived)

  return stablePick(eligible, seed, RANDOM_WALK_COUNT, "random-walk")
}

export function codexReviewFragments(
  fragments: Fragment[]
): CodexReviewFragment[] {
  return fragments.map((fragment) => ({
    id: fragment.id,
    content: truncateForCodex(fragment.content.trim()),
    createdAt: fragment.createdAt,
    tags: fragment.tags,
    path: fragment.path,
  }))
}

export function reviewFragmentSummary(fragments: Fragment[]) {
  if (fragments.length === 0) return "0 条片段"
  const dates = fragments
    .map((fragment) => new Date(fragment.createdAt).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b)

  if (dates.length === 0) return `${fragments.length} 条片段`

  return `${fragments.length} 条片段 · ${formatShortDate(dates[0])} - ${formatShortDate(
    dates[dates.length - 1]
  )}`
}

function stablePick(
  fragments: Fragment[],
  seed: number,
  count: number,
  salt: string
) {
  return [...fragments]
    .sort((a, b) => {
      const scoreA = stableHash(`${salt}:${seed}:${a.id}:${a.createdAt}`)
      const scoreB = stableHash(`${salt}:${seed}:${b.id}:${b.createdAt}`)
      return scoreA - scoreB || b.createdAt.localeCompare(a.createdAt)
    })
    .slice(0, count)
}

function truncateForCodex(content: string) {
  if (content.length <= MAX_CODEX_FRAGMENT_CHARS) return content
  return `${content.slice(0, MAX_CODEX_FRAGMENT_CHARS).trimEnd()}\n...`
}

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function formatShortDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  })
}
