import type { Fragment } from "@/types"

const LINKED_SCORE = Number.MAX_SAFE_INTEGER
const DEFAULT_LIMIT = 8

export interface RelatedFragment {
  fragment: Fragment
  reason: "linked" | "tag"
  score: number
  note?: string
  /** 该边存放在哪一侧的 frontmatter 里 */
  linkOwnerId?: string
}

/** 全局标签统计，供 idf 加权；建索引时算一次 */
export interface RelationsIndex {
  byId: Map<string, Fragment>
  /** tag -> 含该标签的片段 id 集合 */
  tagBuckets: Map<string, Set<string>>
  /** targetId -> 指向它的 source id 集合（反向边） */
  backlinks: Map<string, Set<string>>
  total: number
}

export type FragmentRelationsWorkerRequest =
  | { type: "index"; version: number; fragments: Fragment[] }
  | {
      type: "query"
      version: number
      requestId: string
      targetId: string
      limit?: number
    }

export type FragmentRelationsWorkerResponse =
  | { type: "ready"; version: number }
  | {
      type: "results"
      version: number
      requestId: string
      related: RelatedFragment[]
    }

export function buildRelationsIndex(fragments: Fragment[]): RelationsIndex {
  const byId = new Map<string, Fragment>()
  const tagBuckets = new Map<string, Set<string>>()
  const backlinks = new Map<string, Set<string>>()

  for (const fragment of fragments) {
    byId.set(fragment.id, fragment)

    for (const tag of fragment.tags) {
      let bucket = tagBuckets.get(tag)
      if (!bucket) {
        bucket = new Set<string>()
        tagBuckets.set(tag, bucket)
      }
      bucket.add(fragment.id)
    }

    for (const relation of fragment.related ?? []) {
      let sources = backlinks.get(relation.targetId)
      if (!sources) {
        sources = new Set<string>()
        backlinks.set(relation.targetId, sources)
      }
      sources.add(fragment.id)
    }
  }

  return {
    byId,
    tagBuckets,
    backlinks,
    total: fragments.length,
  }
}

export function computeRelated(
  index: RelationsIndex,
  targetId: string,
  limit = DEFAULT_LIMIT
): RelatedFragment[] {
  const target = index.byId.get(targetId)
  if (!target) return []

  const linked = new Map<string, RelatedFragment>()
  const addLinked = (
    fragmentId: string,
    linkOwnerId: string,
    note?: string
  ) => {
    if (linked.has(fragmentId)) return

    const fragment = index.byId.get(fragmentId)
    if (!isEligibleCandidate(fragment, targetId)) return

    linked.set(fragmentId, {
      fragment,
      reason: "linked",
      score: LINKED_SCORE,
      linkOwnerId,
      ...(note !== undefined ? { note } : {}),
    })
  }

  for (const relation of target.related ?? []) {
    addLinked(relation.targetId, target.id, relation.note)
  }

  for (const sourceId of index.backlinks.get(targetId) ?? []) {
    const source = index.byId.get(sourceId)
    const note = source?.related?.find(
      (relation) => relation.targetId === targetId
    )?.note
    addLinked(sourceId, sourceId, note)
  }

  const tagScores = new Map<string, number>()
  for (const tag of new Set(target.tags)) {
    if (tag === "inbox") continue

    const bucket = index.tagBuckets.get(tag)
    if (!bucket || bucket.size === 0) continue

    const idf = Math.log(index.total / bucket.size)
    for (const fragmentId of bucket) {
      if (linked.has(fragmentId)) continue

      const fragment = index.byId.get(fragmentId)
      if (!isEligibleCandidate(fragment, targetId)) continue

      tagScores.set(fragmentId, (tagScores.get(fragmentId) ?? 0) + idf)
    }
  }

  const related = [
    ...linked.values(),
    ...Array.from(tagScores, ([fragmentId, score]) => ({
      fragment: index.byId.get(fragmentId)!,
      reason: "tag" as const,
      score,
    })),
  ]

  related.sort((first, second) => {
    if (first.score !== second.score) return second.score - first.score
    return second.fragment.createdAt.localeCompare(first.fragment.createdAt)
  })

  return related.slice(0, limit)
}

function isEligibleCandidate(
  fragment: Fragment | undefined,
  targetId: string
): fragment is Fragment {
  return Boolean(
    fragment &&
      fragment.id !== targetId &&
      !fragment.archived &&
      !fragment.lockbox
  )
}
