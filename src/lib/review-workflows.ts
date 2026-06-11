import type { CodexReviewFragment, Fragment } from "@/types"

const DAILY_REVIEW_COUNT = 8
const INSIGHT_REVIEW_COUNT = 28
const RANDOM_WALK_COUNT = 5
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000
const THREE_MONTHS_MS = 91 * 24 * 60 * 60 * 1000
const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000
const MAX_CODEX_FRAGMENT_CHARS = 1600
const DAILY_REVIEW_TAG_LIMIT = 2

interface ReviewCandidate {
  fragment: Fragment
  timestamp: number
}

export function dailyReviewFragments(
  fragments: Fragment[],
  seed: number,
  now = new Date()
) {
  const candidates = dailyReviewCandidates(fragments, now)

  return stratifiedDailyPick(candidates, seed, now)
}

export function dailyReviewCount(fragments: Fragment[], now = new Date()) {
  return Math.min(
    dailyReviewCandidates(fragments, now).length,
    DAILY_REVIEW_COUNT
  )
}

export function insightReviewFragments(
  fragments: Fragment[],
  seed: number,
  now = new Date()
) {
  const candidates = dailyReviewCandidates(fragments, now).map(
    (candidate) => candidate.fragment
  )

  return stablePick(candidates, seed, INSIGHT_REVIEW_COUNT, "insight-review")
}

export function insightReviewCount(fragments: Fragment[], now = new Date()) {
  return Math.min(
    dailyReviewCandidates(fragments, now).length,
    INSIGHT_REVIEW_COUNT
  )
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

export function reviewFragmentSummary(
  fragments: Fragment[],
  itemLabel = "片段"
) {
  if (fragments.length === 0) return `0 条${itemLabel}`
  const dates = fragments
    .map((fragment) => new Date(fragment.createdAt).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b)

  if (dates.length === 0) return `${fragments.length} 条${itemLabel}`

  return `${fragments.length} 条${itemLabel} · ${formatShortDate(dates[0])} - ${formatShortDate(
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

function dailyReviewCandidates(
  fragments: Fragment[],
  now: Date
): ReviewCandidate[] {
  const nowTime = now.getTime()
  const sixMonthCutoff = nowTime - SIX_MONTHS_MS
  const matureCutoff = nowTime - THREE_DAYS_MS
  const activeCandidates = fragments
    .map((fragment) => ({
      fragment,
      timestamp: new Date(fragment.createdAt).getTime(),
    }))
    .filter(
      (candidate) =>
        !candidate.fragment.archived && Number.isFinite(candidate.timestamp)
    )

  const matureCandidates = activeCandidates.filter(
    (candidate) => candidate.timestamp <= matureCutoff
  )
  const recentMatureCandidates = matureCandidates.filter(
    (candidate) => candidate.timestamp >= sixMonthCutoff
  )

  if (recentMatureCandidates.length >= DAILY_REVIEW_COUNT) {
    return recentMatureCandidates
  }
  if (matureCandidates.length > 0) return matureCandidates

  const recentCandidates = activeCandidates.filter(
    (candidate) => candidate.timestamp >= sixMonthCutoff
  )

  return recentCandidates.length > 0 ? recentCandidates : activeCandidates
}

function stratifiedDailyPick(
  candidates: ReviewCandidate[],
  seed: number,
  now: Date
) {
  const nowTime = now.getTime()
  const twoWeekCutoff = nowTime - TWO_WEEKS_MS
  const threeMonthCutoff = nowTime - THREE_MONTHS_MS
  const selected: Fragment[] = []
  const selectedIds = new Set<string>()
  const tagCounts = new Map<string, number>()
  const strata = [
    {
      count: 2,
      items: candidates.filter(
        (candidate) => candidate.timestamp >= twoWeekCutoff
      ),
      salt: "daily-review:recent",
    },
    {
      count: 3,
      items: candidates.filter(
        (candidate) =>
          candidate.timestamp >= threeMonthCutoff &&
          candidate.timestamp < twoWeekCutoff
      ),
      salt: "daily-review:middle",
    },
    {
      count: 3,
      items: candidates.filter(
        (candidate) => candidate.timestamp < threeMonthCutoff
      ),
      salt: "daily-review:older",
    },
  ]

  for (const stratum of strata) {
    pickDiverseFragments(
      stratum.items.map((candidate) => candidate.fragment),
      seed,
      stratum.count,
      stratum.salt,
      selected,
      selectedIds,
      tagCounts
    )
  }

  pickDiverseFragments(
    candidates.map((candidate) => candidate.fragment),
    seed,
    DAILY_REVIEW_COUNT - selected.length,
    "daily-review:fill",
    selected,
    selectedIds,
    tagCounts
  )

  return selected.slice(0, DAILY_REVIEW_COUNT)
}

function pickDiverseFragments(
  fragments: Fragment[],
  seed: number,
  count: number,
  salt: string,
  selected: Fragment[],
  selectedIds: Set<string>,
  tagCounts: Map<string, number>
) {
  if (count <= 0) return

  const ordered = stablePick(
    fragments.filter((fragment) => !selectedIds.has(fragment.id)),
    seed,
    fragments.length,
    salt
  )
  let pickedInPass = 0

  for (const fragment of ordered) {
    if (selected.length >= DAILY_REVIEW_COUNT) return
    if (pickedInPass >= count) break
    if (!fitsTagDiversity(fragment, tagCounts)) continue

    selected.push(fragment)
    selectedIds.add(fragment.id)
    addTagCounts(fragment, tagCounts)
    pickedInPass += 1
  }

  for (const fragment of ordered) {
    if (selected.length >= DAILY_REVIEW_COUNT) return
    if (pickedInPass >= count) return
    if (selectedIds.has(fragment.id)) continue

    selected.push(fragment)
    selectedIds.add(fragment.id)
    addTagCounts(fragment, tagCounts)
    pickedInPass += 1
  }
}

function fitsTagDiversity(fragment: Fragment, tagCounts: Map<string, number>) {
  const tags = reviewTags(fragment)
  return tags.every(
    (tag) => (tagCounts.get(tag) ?? 0) < DAILY_REVIEW_TAG_LIMIT
  )
}

function addTagCounts(fragment: Fragment, tagCounts: Map<string, number>) {
  for (const tag of reviewTags(fragment)) {
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  }
}

function reviewTags(fragment: Fragment) {
  return fragment.tags.filter((tag) => tag !== "inbox")
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
