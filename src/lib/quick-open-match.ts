import {
  clearPinyinSearchCache,
  matchPreparedPinyinTitle,
  normalizeOpenSearchText,
  preparePinyinQuery,
  preparePinyinTitle,
  type PinyinQuery,
  type PinyinTitleIndex,
  type TextRange,
} from "@/lib/pinyin-search"
import type { SearchField, SearchHit, SearchTextPart } from "@/lib/search-contract"

const NO_RECENT = Number.NEGATIVE_INFINITY
const PINYIN_WORK_BUDGET = 8_192
const DEFAULT_BATCH_SIZE = 200
const MAX_ENTRY_CACHE_SIZE = 10_000

export type OpenSearchEntry = SearchHit

export interface RankOpenItemsResult {
  hits: readonly SearchHit[]
  /** True means at least one candidate hit the pinyin work cap. */
  pinyinDegraded: boolean
}

interface TermMatch {
  field: "title" | "path"
  penalty: number
  ranges: readonly TextRange[]
  tier: number
}

interface RankedEntry {
  hit: SearchHit
  pinyinDegraded: boolean
  recentAt: number
  totalPenalty: number
  totalTier: number
  updatedAt: number
  worstTier: number
}

interface RankEvaluation {
  entry: RankedEntry | null
  pinyinDegraded: boolean
}

interface NormalizedText {
  map: readonly TextRange[] | null
  text: string
}

interface PreparedOpenEntry {
  path: NormalizedText
  pathSource: string
  pinyin: PinyinTitleIndex
  title: NormalizedText
  titleSource: string
  updatedAt: number
  updatedAtSource: string | null
}

interface PreparedTerm {
  pinyin: PinyinQuery
  text: string
}

interface PreparedQuery {
  normalized: string
  terms: readonly PreparedTerm[]
}

const titleCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
})

const preparedEntryCache = new Map<string, PreparedOpenEntry>()

export function clearQuickOpenMatchCache(): void {
  preparedEntryCache.clear()
  clearPinyinSearchCache()
}

export function rankOpenItems(
  items: readonly OpenSearchEntry[],
  query: string,
  recent: ReadonlyMap<string, number>
): readonly SearchHit[] {
  return rankOpenItemsWithStatus(items, query, recent).hits
}

export function rankOpenItemsWithStatus(
  items: readonly OpenSearchEntry[],
  query: string,
  recent: ReadonlyMap<string, number>
): RankOpenItemsResult {
  const prepared = prepareQuery(query)
  const ranked: RankedEntry[] = []
  let pinyinDegraded = false
  for (const item of items) {
    const evaluation = rankOne(item, prepared, recent)
    pinyinDegraded ||= evaluation.pinyinDegraded
    if (evaluation.entry) ranked.push(evaluation.entry)
  }
  return finishRanking(ranked, pinyinDegraded)
}

/**
 * The palette can use this for large catalogs so ranking yields between
 * bounded chunks instead of monopolizing one keyboard event.
 */
export async function rankOpenItemsInBatches(
  items: readonly OpenSearchEntry[],
  query: string,
  recent: ReadonlyMap<string, number>,
  batchSize = DEFAULT_BATCH_SIZE
): Promise<RankOpenItemsResult> {
  const prepared = prepareQuery(query)
  const ranked: RankedEntry[] = []
  let pinyinDegraded = false
  const size = Math.max(1, Math.floor(batchSize))

  for (let start = 0; start < items.length; start += size) {
    const end = Math.min(items.length, start + size)
    for (let index = start; index < end; index += 1) {
      const item = items[index]
      const evaluation = rankOne(item, prepared, recent)
      pinyinDegraded ||= evaluation.pinyinDegraded
      if (evaluation.entry) ranked.push(evaluation.entry)
    }
    if (start + size < items.length) await yieldToBrowser()
  }

  return finishRanking(ranked, pinyinDegraded)
}

function rankOne(
  item: OpenSearchEntry,
  query: PreparedQuery,
  recent: ReadonlyMap<string, number>
): RankEvaluation {
  const prepared = prepareEntry(item)
  const recentAt = validNumber(recent.get(item.target.key), NO_RECENT)

  if (!query.normalized) {
    return {
      entry: {
        hit: resetHitParts(item),
        pinyinDegraded: false,
        recentAt,
        totalPenalty: 0,
        totalTier: 0,
        updatedAt: prepared.updatedAt,
        worstTier: 0,
      },
      pinyinDegraded: false,
    }
  }

  if (prepared.title.text === query.normalized) {
    return {
      entry: {
        hit: applyMatches(item, [{ field: "title", penalty: 0, ranges: fullRange(item.title), tier: 0 }]),
        pinyinDegraded: false,
        recentAt,
        totalPenalty: 0,
        totalTier: 0,
        updatedAt: prepared.updatedAt,
        worstTier: 0,
      },
      pinyinDegraded: false,
    }
  }

  const matches: TermMatch[] = []
  let pinyinDegraded = false
  for (const term of query.terms) {
    const result = matchTerm(prepared, term)
    pinyinDegraded ||= result.pinyinDegraded
    if (!result.match) return { entry: null, pinyinDegraded }
    matches.push(result.match)
  }

  let totalPenalty = 0
  let totalTier = 0
  let worstTier = 0
  for (const match of matches) {
    totalPenalty += match.penalty
    totalTier += match.tier
    worstTier = Math.max(worstTier, match.tier)
  }

  return {
    entry: {
      hit: applyMatches(item, matches),
      pinyinDegraded,
      recentAt,
      totalPenalty,
      totalTier,
      updatedAt: prepared.updatedAt,
      worstTier,
    },
    pinyinDegraded,
  }
}

function matchTerm(
  entry: PreparedOpenEntry,
  term: PreparedTerm
): { match: TermMatch | null; pinyinDegraded: boolean } {
  const { path, title } = entry
  if (title.text === term.text) {
    return {
      match: titleMatch(title, 0, term.text.length, 0, 0),
      pinyinDegraded: false,
    }
  }

  if (title.text.startsWith(term.text)) {
    return {
      match: titleMatch(
        title,
        0,
        term.text.length,
        1,
        title.text.length - term.text.length
      ),
      pinyinDegraded: false,
    }
  }

  const boundaryIndex = findBoundaryMatch(title.text, term.text)
  if (boundaryIndex >= 0) {
    return {
      match: titleMatch(
        title,
        boundaryIndex,
        boundaryIndex + term.text.length,
        2,
        boundaryIndex
      ),
      pinyinDegraded: false,
    }
  }

  const substringIndex = title.text.indexOf(term.text)
  if (substringIndex >= 0) {
    return {
      match: titleMatch(
        title,
        substringIndex,
        substringIndex + term.text.length,
        3,
        substringIndex
      ),
      pinyinDegraded: false,
    }
  }

  const pinyinMatch = matchPreparedPinyinTitle(entry.pinyin, term.pinyin, {
    maxWork: PINYIN_WORK_BUDGET,
  })
  if (pinyinMatch.status === "matched") {
    return {
      match: {
        field: "title",
        penalty: pinyinMatch.ranges[0]?.start ?? 0,
        ranges: pinyinMatch.ranges,
        tier: 4,
      },
      pinyinDegraded: false,
    }
  }

  const fuzzy = fuzzySubsequence(title, term.text)
  if (fuzzy) {
    return {
      match: { field: "title", penalty: fuzzy.penalty, ranges: fuzzy.ranges, tier: 5 },
      pinyinDegraded: pinyinMatch.status === "budgetExceeded",
    }
  }

  const pathIndex = path.text.indexOf(term.text)
  if (pathIndex >= 0) {
    return {
      match: {
        field: "path",
        penalty: pathIndex,
        ranges: mappedRange(path, pathIndex, pathIndex + term.text.length),
        tier: 6,
      },
      pinyinDegraded: pinyinMatch.status === "budgetExceeded",
    }
  }

  return {
    match: null,
    pinyinDegraded: pinyinMatch.status === "budgetExceeded",
  }
}

function titleMatch(
  title: NormalizedText,
  start: number,
  end: number,
  tier: number,
  penalty: number
): TermMatch {
  return {
    field: "title",
    penalty,
    ranges: mappedRange(title, start, end),
    tier,
  }
}

function finishRanking(
  entries: RankedEntry[],
  pinyinDegraded: boolean
): RankOpenItemsResult {
  entries.sort((left, right) => {
    if (left.worstTier !== right.worstTier) return left.worstTier - right.worstTier
    if (left.totalTier !== right.totalTier) return left.totalTier - right.totalTier
    if (left.totalPenalty !== right.totalPenalty) return left.totalPenalty - right.totalPenalty
    if (left.recentAt !== right.recentAt) return right.recentAt - left.recentAt
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
    const titleOrder = titleCollator.compare(left.hit.title, right.hit.title)
    if (titleOrder) return titleOrder
    return left.hit.target.key.localeCompare(right.hit.target.key)
  })

  return {
    hits: entries.map(({ hit }) => hit),
    pinyinDegraded,
  }
}

function applyMatches(item: SearchHit, matches: readonly TermMatch[]): SearchHit {
  const titleRanges = mergeRanges(
    matches.filter(({ field }) => field === "title").flatMap(({ ranges }) => ranges)
  )
  const pathRanges = mergeRanges(
    matches.filter(({ field }) => field === "path").flatMap(({ ranges }) => ranges)
  )
  const matchedFields = unique(
    matches.map(({ field }) => field as SearchField)
  )

  return {
    ...item,
    matchedFields,
    preview: splitTextParts(item.target.path, pathRanges),
    titleParts: splitTextParts(item.title, titleRanges),
  }
}

function resetHitParts(item: SearchHit): SearchHit {
  return {
    ...item,
    matchedFields: [],
    preview: [{ hit: false, text: item.target.path }],
    titleParts: [{ hit: false, text: item.title }],
  }
}

function fuzzySubsequence(text: NormalizedText, query: string) {
  const positions: number[] = []
  let cursor = 0
  for (const char of Array.from(query)) {
    const index = text.text.indexOf(char, cursor)
    if (index < 0) return null
    positions.push(index)
    cursor = index + char.length
  }

  const ranges = positions.flatMap((position) => mappedRange(text, position, position + 1))
  let gaps = 0
  let boundaryMisses = 0
  for (let index = 0; index < positions.length; index += 1) {
    if (index > 0) gaps += Math.max(0, positions[index] - positions[index - 1] - 1)
    if (!isBoundary(text.text, positions[index])) boundaryMisses += 1
  }

  return {
    penalty: (positions[0] ?? 0) + gaps * 4 + boundaryMisses,
    ranges: mergeRanges(ranges),
  }
}

function findBoundaryMatch(text: string, query: string) {
  let from = 1
  while (from < text.length) {
    const index = text.indexOf(query, from)
    if (index < 0) return -1
    if (isBoundary(text, index)) return index
    from = index + 1
  }
  return -1
}

function isBoundary(text: string, index: number) {
  if (index <= 0) return true
  const previous = text[index - 1]
  const current = text[index]
  if (/[/\s_.-]/u.test(previous)) return true
  return charClass(previous) !== charClass(current)
}

function charClass(char: string) {
  if (/\p{Script=Han}/u.test(char)) return "han"
  if (/[a-z0-9]/iu.test(char)) return "latin"
  return "other"
}

function normalizeWithMap(value: string): NormalizedText {
  if (/^[\u0000-\u007f\u3400-\u4dbf\u4e00-\u9fff]*$/u.test(value)) {
    const text = normalizeOpenSearchText(value)
    if (text.length === value.length) {
      return {
        map: null,
        text,
      }
    }
  }

  let text = ""
  const map: TextRange[] = []
  let offset = 0
  for (const char of Array.from(value)) {
    const start = offset
    offset += char.length
    const normalized = normalizeOpenSearchText(char)
    text += normalized
    for (let index = 0; index < normalized.length; index += 1) {
      map.push({ end: offset, start })
    }
  }
  return { map, text }
}

function prepareEntry(item: OpenSearchEntry): PreparedOpenEntry {
  const key = item.target.key
  const cached = preparedEntryCache.get(key)
  if (
    cached &&
    cached.titleSource === item.title &&
    cached.pathSource === item.target.path &&
    cached.updatedAtSource === item.updatedAt
  ) {
    return cached
  }

  const prepared = {
    path: normalizeWithMap(item.target.path),
    pathSource: item.target.path,
    pinyin: preparePinyinTitle(item.title),
    title: normalizeWithMap(item.title),
    titleSource: item.title,
    updatedAt: parseTimestamp(item.updatedAt),
    updatedAtSource: item.updatedAt,
  }
  preparedEntryCache.set(key, prepared)
  if (preparedEntryCache.size > MAX_ENTRY_CACHE_SIZE) {
    const oldest = preparedEntryCache.keys().next().value
    if (oldest !== undefined) preparedEntryCache.delete(oldest)
  }
  return prepared
}

function mappedRange(value: NormalizedText, start: number, end: number): TextRange[] {
  if (start >= end || start < 0 || end > value.text.length) return []
  if (value.map === null) return [{ end, start }]
  return [{ end: value.map[end - 1].end, start: value.map[start].start }]
}

function splitTextParts(text: string, ranges: readonly TextRange[]): SearchTextPart[] {
  if (!text) return []
  if (ranges.length === 0) return [{ hit: false, text }]

  const parts: SearchTextPart[] = []
  let cursor = 0
  for (const range of mergeRanges(ranges)) {
    if (range.start > cursor) parts.push({ hit: false, text: text.slice(cursor, range.start) })
    if (range.end > range.start) parts.push({ hit: true, text: text.slice(range.start, range.end) })
    cursor = Math.max(cursor, range.end)
  }
  if (cursor < text.length) parts.push({ hit: false, text: text.slice(cursor) })
  return parts
}

function mergeRanges(ranges: readonly TextRange[]): TextRange[] {
  const sorted = [...ranges]
    .filter(({ start, end }) => start >= 0 && end > start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: TextRange[] = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

function fullRange(text: string): TextRange[] {
  return text ? [{ end: text.length, start: 0 }] : []
}

function prepareQuery(rawQuery: string): PreparedQuery {
  const normalized = normalizeOpenSearchText(rawQuery).trim().replace(/\s+/gu, " ")
  return {
    normalized,
    terms: unique(normalized.split(" ").filter(Boolean)).map((text) => ({
      pinyin: preparePinyinQuery(text),
      text,
    })),
  }
}

function parseTimestamp(value: string | null) {
  const timestamp = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY
}

function validNumber(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values))
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}
