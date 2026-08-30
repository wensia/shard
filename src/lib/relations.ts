import type { Fragment, FragmentRelation } from "@/types"

const LINKED_SCORE = Number.MAX_SAFE_INTEGER
const DEFAULT_LIMIT = 8

export interface RelatedFragment {
  fragment: Fragment
  direction?: "backlink" | "outgoing"
  origin?: FragmentRelation["origin"]
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
  backlinks: Map<
    string,
    Array<{ relation: FragmentRelation; sourceId: string }>
  >
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
  const backlinks = new Map<
    string,
    Array<{ relation: FragmentRelation; sourceId: string }>
  >()

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
      let entries = backlinks.get(relation.targetId)
      if (!entries) {
        entries = []
        backlinks.set(relation.targetId, entries)
      }
      entries.push({ relation, sourceId: fragment.id })
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

  const linked: RelatedFragment[] = []
  const linkedFragmentIds = new Set<string>()
  const addLinked = (
    fragmentId: string,
    linkOwnerId: string,
    relation: FragmentRelation,
    direction: "backlink" | "outgoing"
  ) => {
    const fragment = index.byId.get(fragmentId)
    if (!isEligibleCandidate(fragment, targetId)) return

    linkedFragmentIds.add(fragmentId)
    linked.push({
      direction,
      fragment,
      origin: relation.origin,
      reason: "linked",
      score: LINKED_SCORE,
      linkOwnerId,
      ...(relation.note !== undefined ? { note: relation.note } : {}),
    })
  }

  for (const relation of target.related ?? []) {
    addLinked(relation.targetId, target.id, relation, "outgoing")
  }

  for (const { relation, sourceId } of index.backlinks.get(targetId) ?? []) {
    addLinked(sourceId, sourceId, relation, "backlink")
  }

  const tagScores = new Map<string, number>()
  for (const tag of new Set(target.tags)) {
    if (tag === "inbox") continue

    const bucket = index.tagBuckets.get(tag)
    if (!bucket || bucket.size === 0) continue

    const idf = Math.log(index.total / bucket.size)
    for (const fragmentId of bucket) {
      if (linkedFragmentIds.has(fragmentId)) continue

      const fragment = index.byId.get(fragmentId)
      if (!isEligibleCandidate(fragment, targetId)) continue

      tagScores.set(fragmentId, (tagScores.get(fragmentId) ?? 0) + idf)
    }
  }

  const related = [
    ...linked,
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
