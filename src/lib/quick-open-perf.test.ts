import { pinyin } from "pinyin-pro"
import { describe, expect, it } from "vitest"

import {
  clearQuickOpenMatchCache,
  rankOpenItems,
} from "@/lib/quick-open-match"
import { normalizeOpenSearchText, type TextRange } from "@/lib/pinyin-search"
import { searchTargetKey, type SearchField, type SearchHit } from "@/lib/search-contract"

const CATALOG_SIZE = 5_000
const QUERIES = ["zbrj", "zhoubao", "周报 rj", "chongqing", "rust", "d3", "shard sheji"]
const COLD_LIMIT_MS = 120
const WARM_P95_LIMIT_MS = 30
const WARM_RUNS = 20
const PINYIN_WORK_BUDGET = 8_192
const vaultPath = "/perf-vault"

interface NormalizedText {
  map: readonly TextRange[]
  text: string
}

interface ReferenceMatch {
  field: "title" | "path"
  penalty: number
  ranges: readonly TextRange[]
  tier: number
}

interface ReferenceRankedEntry {
  hit: SearchHit
  recentAt: number
  totalPenalty: number
  totalTier: number
  updatedAt: number
  worstTier: number
}

interface LegacyPinyinUnit {
  end: number
  representations: readonly string[]
  start: number
}

const titleCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
})
const legacyPinyinCache = new Map<string, readonly LegacyPinyinUnit[]>()

describe("quick open 5k performance", () => {
  const items = createCatalog(CATALOG_SIZE)
  const recent = createRecent(items)

  it("keeps cold startup and warmed query p95 within the CI guardrails", () => {
    clearQuickOpenMatchCache()
    const coldStarted = performance.now()
    rankOpenItems(items, QUERIES[0], recent)
    const coldMs = performance.now() - coldStarted

    const measurements = new Map<string, number[]>()
    for (const query of QUERIES) {
      rankOpenItems(items, query, recent)
      const durations: number[] = []
      for (let run = 0; run < WARM_RUNS; run += 1) {
        const started = performance.now()
        rankOpenItems(items, query, recent)
        durations.push(performance.now() - started)
      }
      measurements.set(query, durations)
    }

    const warmP95 = Array.from(measurements, ([query, durations]) => ({
      p95: percentile(durations, 0.95),
      query,
    }))
    console.info(
      `[quick-open-perf] cold=${coldMs.toFixed(2)}ms; ${warmP95
        .map(({ p95, query }) => `${query}=${p95.toFixed(2)}ms`)
        .join("; ")}`
    )

    expect(coldMs).toBeLessThanOrEqual(COLD_LIMIT_MS)
    for (const { p95 } of warmP95) {
      expect(p95).toBeLessThanOrEqual(WARM_P95_LIMIT_MS)
    }
  })

  it("matches the pre-optimization reference result item by item", () => {
    for (const query of QUERIES) {
      expect(rankOpenItems(items, query, recent)).toEqual(
        referenceRankOpenItems(items, query, recent)
      )
    }
  })
})

function createCatalog(size: number): SearchHit[] {
  let seed = 0x5a17c9e3
  const titleFactories = [
    (index: number) => `周报日记 ${index}`,
    (index: number) => `重庆计划 ${index}`,
    (index: number) => `Rust 周报 ${index}`,
    (index: number) => `Shard 设计 ${index}`,
    (index: number) => `产品日记 ${index}`,
    (index: number) => `设计备忘 ${index}`,
    (index: number) => `普通文档 ${index}`,
  ]

  return Array.from({ length: size }, (_, index) => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
    const path = `notes/d${String(index % 100).padStart(2, "0")}/f${String(index).padStart(4, "0")}.md`
    const title = titleFactories[seed % titleFactories.length](index)
    return {
      matchedFields: [],
      preview: [{ hit: false, text: path }],
      revealHint: "documentOnly",
      revision: null,
      tags: [],
      target: {
        archived: false,
        key: searchTargetKey(vaultPath, "public", path),
        kind: "document",
        objectId: String(index),
        path,
        scope: "public",
        vaultPath,
      },
      title,
      titleParts: [{ hit: false, text: title }],
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
    }
  })
}

function createRecent(items: readonly SearchHit[]): ReadonlyMap<string, number> {
  return new Map(
    items
      .filter((_, index) => index % 173 === 0)
      .map((item, index) => [item.target.key, 1_000_000 - index] as const)
  )
}

function referenceRankOpenItems(
  items: readonly SearchHit[],
  rawQuery: string,
  recent: ReadonlyMap<string, number>
): readonly SearchHit[] {
  const normalized = normalizeOpenSearchText(rawQuery).trim().replace(/\s+/gu, " ")
  const terms = unique(normalized.split(" ").filter(Boolean))
  const ranked: ReferenceRankedEntry[] = []

  for (const item of items) {
    const title = normalizeWithMap(item.title)
    const path = normalizeWithMap(item.target.path)
    const recentAt = validNumber(recent.get(item.target.key), Number.NEGATIVE_INFINITY)
    const updatedAt = parseTimestamp(item.updatedAt)

    if (!normalized) {
      ranked.push({
        hit: resetHitParts(item),
        recentAt,
        totalPenalty: 0,
        totalTier: 0,
        updatedAt,
        worstTier: 0,
      })
      continue
    }

    if (title.text === normalized) {
      ranked.push({
        hit: applyMatches(item, [
          { field: "title", penalty: 0, ranges: fullRange(item.title), tier: 0 },
        ]),
        recentAt,
        totalPenalty: 0,
        totalTier: 0,
        updatedAt,
        worstTier: 0,
      })
      continue
    }

    const matches: ReferenceMatch[] = []
    let rejected = false
    for (const term of terms) {
      const match = referenceMatchTerm(item.title, title, path, term)
      if (!match) {
        rejected = true
        break
      }
      matches.push(match)
    }
    if (rejected) continue

    ranked.push({
      hit: applyMatches(item, matches),
      recentAt,
      totalPenalty: matches.reduce((total, match) => total + match.penalty, 0),
      totalTier: matches.reduce((total, match) => total + match.tier, 0),
      updatedAt,
      worstTier: Math.max(...matches.map((match) => match.tier)),
    })
  }

  ranked.sort((left, right) => {
    if (left.worstTier !== right.worstTier) return left.worstTier - right.worstTier
    if (left.totalTier !== right.totalTier) return left.totalTier - right.totalTier
    if (left.totalPenalty !== right.totalPenalty) return left.totalPenalty - right.totalPenalty
    if (left.recentAt !== right.recentAt) return right.recentAt - left.recentAt
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
    const titleOrder = titleCollator.compare(left.hit.title, right.hit.title)
    if (titleOrder) return titleOrder
    return left.hit.target.key.localeCompare(right.hit.target.key)
  })
  return ranked.map(({ hit }) => hit)
}

function referenceMatchTerm(
  originalTitle: string,
  title: NormalizedText,
  path: NormalizedText,
  term: string
): ReferenceMatch | null {
  if (title.text === term) return titleMatch(title, 0, term.length, 0, 0)
  if (title.text.startsWith(term)) {
    return titleMatch(title, 0, term.length, 1, title.text.length - term.length)
  }

  const boundaryIndex = findBoundaryMatch(title.text, term)
  if (boundaryIndex >= 0) {
    return titleMatch(title, boundaryIndex, boundaryIndex + term.length, 2, boundaryIndex)
  }

  const substringIndex = title.text.indexOf(term)
  if (substringIndex >= 0) {
    return titleMatch(title, substringIndex, substringIndex + term.length, 3, substringIndex)
  }

  const pinyinRanges = legacyPinyinMatch(originalTitle, term, PINYIN_WORK_BUDGET)
  if (pinyinRanges) {
    return {
      field: "title",
      penalty: pinyinRanges[0]?.start ?? 0,
      ranges: pinyinRanges,
      tier: 4,
    }
  }

  const fuzzy = fuzzySubsequence(title, term)
  if (fuzzy) {
    return { field: "title", penalty: fuzzy.penalty, ranges: fuzzy.ranges, tier: 5 }
  }

  const pathIndex = path.text.indexOf(term)
  return pathIndex < 0
    ? null
    : {
        field: "path",
        penalty: pathIndex,
        ranges: mappedRange(path, pathIndex, pathIndex + term.length),
        tier: 6,
      }
}

function legacyPinyinMatch(title: string, rawQuery: string, maxWork: number) {
  const query = normalizeOpenSearchText(rawQuery).replace(/\s+/gu, "")
  if (!query) return null
  const units = legacyPinyinUnits(title)
  let work = 0
  let budgetExceeded = false
  const memo = new Map<string, readonly number[] | null>()

  const visit = (unitIndex: number, queryIndex: number): readonly number[] | null => {
    if (queryIndex >= query.length) return []
    if (unitIndex >= units.length) return null
    const key = `${unitIndex}:${queryIndex}`
    if (memo.has(key)) return memo.get(key) ?? null
    const remaining = query.slice(queryIndex)
    for (const representation of units[unitIndex].representations) {
      if (work >= maxWork) {
        budgetExceeded = true
        return null
      }
      work += 1
      const consumed = Math.min(remaining.length, representation.length)
      if (!representation.startsWith(remaining.slice(0, consumed))) continue
      if (remaining.length <= representation.length) {
        const result = [unitIndex]
        memo.set(key, result)
        return result
      }
      const suffix = visit(unitIndex + 1, queryIndex + representation.length)
      if (suffix) {
        const result = [unitIndex, ...suffix]
        memo.set(key, result)
        return result
      }
      if (budgetExceeded) return null
    }
    memo.set(key, null)
    return null
  }

  for (let start = 0; start < units.length; start += 1) {
    const matchedUnits = visit(start, 0)
    if (matchedUnits) return mergeRanges(matchedUnits.map((index) => units[index]))
    if (budgetExceeded) return null
  }
  return null
}

function legacyPinyinUnits(title: string): readonly LegacyPinyinUnit[] {
  const cached = legacyPinyinCache.get(title)
  if (cached) return cached
  const units: LegacyPinyinUnit[] = []
  let offset = 0
  for (const char of Array.from(title)) {
    const start = offset
    offset += char.length
    const literal = normalizeOpenSearchText(char)
    const readings = /\p{Script=Han}/u.test(char)
      ? pinyin(char, { multiple: true, toneType: "none", type: "array" })
          .map((reading) => reading.toLowerCase().replace(/[^a-z]/gu, ""))
          .filter(Boolean)
      : []
    const representations = unique([
      literal,
      ...readings,
      ...readings.map((reading) => reading[0]),
    ]).filter(Boolean)
    if (representations.length > 0) units.push({ end: offset, representations, start })
  }
  legacyPinyinCache.set(title, units)
  return units
}

function titleMatch(
  title: NormalizedText,
  start: number,
  end: number,
  tier: number,
  penalty: number
): ReferenceMatch {
  return { field: "title", penalty, ranges: mappedRange(title, start, end), tier }
}

function applyMatches(item: SearchHit, matches: readonly ReferenceMatch[]): SearchHit {
  const titleRanges = mergeRanges(
    matches.filter(({ field }) => field === "title").flatMap(({ ranges }) => ranges)
  )
  const pathRanges = mergeRanges(
    matches.filter(({ field }) => field === "path").flatMap(({ ranges }) => ranges)
  )
  return {
    ...item,
    matchedFields: unique(matches.map(({ field }) => field as SearchField)),
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

function mappedRange(value: NormalizedText, start: number, end: number): TextRange[] {
  if (start >= end || start < 0 || end > value.map.length) return []
  return [{ end: value.map[end - 1].end, start: value.map[start].start }]
}

function splitTextParts(text: string, ranges: readonly TextRange[]) {
  if (!text) return []
  if (ranges.length === 0) return [{ hit: false, text }]
  const parts: Array<{ hit: boolean; text: string }> = []
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

function parseTimestamp(value: string | null) {
  const timestamp = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY
}

function validNumber(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function percentile(values: readonly number[], ratio: number) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0
}

function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values))
}
