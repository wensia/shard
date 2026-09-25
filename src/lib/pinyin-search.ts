import { pinyin } from "pinyin-pro"

const DEFAULT_WORK_BUDGET = 8_192
const MAX_INDEX_CACHE_SIZE = 10_000
const MAX_CHARACTER_CACHE_SIZE = 20_000

export interface TextRange {
  end: number
  start: number
}

export interface PinyinMatchOptions {
  maxWork?: number
}

export type PinyinMatchResult =
  | { status: "matched"; ranges: readonly TextRange[]; work: number }
  | { status: "noMatch"; work: number }
  | { status: "budgetExceeded"; work: number }

interface PinyinUnit {
  end: number
  representations: readonly string[]
  start: number
}

export interface PinyinTitleIndex {
  asciiLetterMask: number
  maxRepresentations: number
  otherCharacters: ReadonlySet<string>
  units: readonly PinyinUnit[]
}

export interface PinyinQuery {
  asciiLetterMask: number
  otherCharacters: readonly string[]
  text: string
}

interface CharacterRepresentations {
  asciiLetterMask: number
  otherCharacters: ReadonlySet<string>
  values: readonly string[]
}

const titleIndexCache = new Map<string, PinyinTitleIndex>()
const characterRepresentationsCache = new Map<string, CharacterRepresentations>()

/** Privacy/session revocation can drop cached private title projections eagerly. */
export function clearPinyinSearchCache(): void {
  titleIndexCache.clear()
  characterRepresentationsCache.clear()
}

export function normalizeOpenSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
}

/**
 * Match literal Hanzi/ASCII, full pinyin and initials without expanding every
 * polyphonic permutation. The returned ranges always point into the original
 * title, so a mixed query such as `北jing` can highlight `北京` correctly.
 */
export function matchPinyinTitle(
  title: string,
  rawQuery: string,
  options: PinyinMatchOptions = {}
): PinyinMatchResult {
  return matchPreparedPinyinTitle(
    preparePinyinTitle(title),
    preparePinyinQuery(rawQuery),
    options
  )
}

export function preparePinyinQuery(rawQuery: string): PinyinQuery {
  const text = normalizeOpenSearchText(rawQuery).replace(/\s+/gu, "")
  let asciiLetterMask = 0
  const otherCharacters: string[] = []
  for (const character of text) {
    const mask = asciiLetterMaskFor(character)
    if (mask) asciiLetterMask |= mask
    else otherCharacters.push(character)
  }
  return { asciiLetterMask, otherCharacters: unique(otherCharacters), text }
}

export function preparePinyinTitle(title: string): PinyinTitleIndex {
  return getTitleIndex(title)
}

export function couldMatchPreparedPinyinTitle(
  index: PinyinTitleIndex,
  query: PinyinQuery
): boolean {
  return (
    (query.asciiLetterMask & ~index.asciiLetterMask) === 0 &&
    query.otherCharacters.every((character) => index.otherCharacters.has(character))
  )
}

export function matchPreparedPinyinTitle(
  index: PinyinTitleIndex,
  queryInput: PinyinQuery,
  options: PinyinMatchOptions = {}
): PinyinMatchResult {
  const query = queryInput.text
  if (!query) return { status: "noMatch", work: 0 }

  const maxWork = Math.max(0, Math.floor(options.maxWork ?? DEFAULT_WORK_BUDGET))
  const { units } = index
  const exhaustiveWorkBound = units.length * (query.length + 1) * index.maxRepresentations
  if (
    maxWork >= exhaustiveWorkBound &&
    !couldMatchPreparedPinyinTitle(index, queryInput)
  ) {
    return { status: "noMatch", work: 0 }
  }
  let work = 0
  let budgetExceeded = false
  const memoWidth = query.length + 1
  const memo = new Int32Array(units.length * memoWidth)
  memo.fill(-2)

  function spendWork() {
    if (work >= maxWork) {
      budgetExceeded = true
      return false
    }
    work += 1
    return true
  }

  function visit(unitIndex: number, queryIndex: number): number {
    if (queryIndex >= query.length) return unitIndex - 1
    if (unitIndex >= units.length) return -1

    const key = unitIndex * memoWidth + queryIndex
    const cached = memo[key]
    if (cached !== -2) return cached

    const remainingLength = query.length - queryIndex
    for (const representation of units[unitIndex].representations) {
      if (!spendWork()) return -1
      const consumed = Math.min(remainingLength, representation.length)
      if (!matchesAt(representation, query, queryIndex, consumed)) continue

      if (remainingLength <= representation.length) {
        memo[key] = unitIndex
        return unitIndex
      }

      const suffix = visit(unitIndex + 1, queryIndex + representation.length)
      if (suffix >= 0) {
        memo[key] = suffix
        return suffix
      }
      if (budgetExceeded) return -1
    }

    memo[key] = -1
    return -1
  }

  for (let start = 0; start < units.length; start += 1) {
    const matchedThrough = visit(start, 0)
    if (matchedThrough >= 0) {
      return {
        status: "matched",
        ranges: mergeUnitRanges(units.slice(start, matchedThrough + 1)),
        work,
      }
    }
    if (budgetExceeded) return { status: "budgetExceeded", work }
  }

  return budgetExceeded
    ? { status: "budgetExceeded", work }
    : { status: "noMatch", work }
}

function getTitleIndex(title: string): PinyinTitleIndex {
  const cached = titleIndexCache.get(title)
  if (cached) return cached

  const units: PinyinUnit[] = []
  let asciiLetterMask = 0
  const otherCharacters = new Set<string>()
  let offset = 0
  for (const char of Array.from(title)) {
    const start = offset
    offset += char.length
    const representationIndex = representationsForCharacter(char)
    const representations = representationIndex.values
    asciiLetterMask |= representationIndex.asciiLetterMask
    for (const character of representationIndex.otherCharacters) {
      otherCharacters.add(character)
    }

    if (representations.length > 0) {
      units.push({ end: offset, representations, start })
    }
  }

  const maxRepresentations = units.reduce(
    (maximum, unit) => Math.max(maximum, unit.representations.length),
    0
  )
  const index = { asciiLetterMask, maxRepresentations, otherCharacters, units }
  titleIndexCache.set(title, index)
  if (titleIndexCache.size > MAX_INDEX_CACHE_SIZE) {
    const oldest = titleIndexCache.keys().next().value
    if (oldest !== undefined) titleIndexCache.delete(oldest)
  }
  return index
}

function representationsForCharacter(char: string): CharacterRepresentations {
  const cached = characterRepresentationsCache.get(char)
  if (cached) return cached

  const literal = normalizeOpenSearchText(char)
  const readings = /\p{Script=Han}/u.test(char)
    ? pinyin(char, { multiple: true, toneType: "none", type: "array" })
        .map((reading) => reading.toLowerCase().replace(/[^a-z]/gu, ""))
        .filter(Boolean)
    : []
  const values = unique([
    literal,
    ...readings,
    ...readings.map((reading) => reading[0]),
  ]).filter(Boolean)
  let asciiLetterMask = 0
  const otherCharacters = new Set<string>()
  for (const representation of values) {
    for (const character of representation) {
      const mask = asciiLetterMaskFor(character)
      if (mask) asciiLetterMask |= mask
      else otherCharacters.add(character)
    }
  }
  const representations = { asciiLetterMask, otherCharacters, values }
  characterRepresentationsCache.set(char, representations)
  if (characterRepresentationsCache.size > MAX_CHARACTER_CACHE_SIZE) {
    const oldest = characterRepresentationsCache.keys().next().value
    if (oldest !== undefined) characterRepresentationsCache.delete(oldest)
  }
  return representations
}

function asciiLetterMaskFor(character: string) {
  const code = character.charCodeAt(0) - 97
  return code >= 0 && code < 26 ? 1 << code : 0
}

function matchesAt(
  representation: string,
  query: string,
  queryIndex: number,
  length: number
) {
  for (let index = 0; index < length; index += 1) {
    if (representation[index] !== query[queryIndex + index]) return false
  }
  return true
}

function mergeUnitRanges(units: readonly PinyinUnit[]): TextRange[] {
  const ranges: TextRange[] = []
  for (const unit of units) {
    const previous = ranges[ranges.length - 1]
    if (previous && previous.end === unit.start) {
      previous.end = unit.end
    } else {
      ranges.push({ end: unit.end, start: unit.start })
    }
  }
  return ranges
}

function unique(values: readonly string[]) {
  return Array.from(new Set(values))
}
