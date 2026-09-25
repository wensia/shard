import { pinyin } from "pinyin-pro"

const NO_TAG_MATCH = Number.MAX_SAFE_INTEGER
// 多音字读法做笛卡尔积展开时的上限，防止长标签组合爆炸。
const MAX_PINYIN_VARIANTS = 8

export interface TagSearchEntry {
  /** 全拼变体（无空格、小写），多音字展开后最多 MAX_PINYIN_VARIANTS 条。 */
  full: string[]
  /** 首字母变体，口径同 full。 */
  initials: string[]
  searchText: string
  /** 逐字读法：汉字是它的全部拼音，字母数字是自身；其他符号不参与。 */
  syllables: string[][]
  tag: string
}

export function buildTagSearchIndex(tags: string[]): TagSearchEntry[] {
  return tags.map((tag) => {
    const syllables = getTagSyllables(tag)

    return {
      full: expandVariants(syllables),
      initials: expandVariants(
        syllables.map((readings) => unique(readings.map((reading) => reading[0])))
      ),
      searchText: normalizeTagSearchText(tag),
      syllables,
      tag,
    }
  })
}

export function getMatchingTagsBySearchQuery(
  index: TagSearchEntry[],
  rawQuery: string,
  limit: number
) {
  const query = normalizeTagSearchText(rawQuery)

  return index
    .map((entry) => ({
      entry,
      rank: getTagSearchRank(entry, query),
    }))
    .filter(({ rank }) => rank < NO_TAG_MATCH)
    .sort((first, second) => {
      if (first.rank !== second.rank) return first.rank - second.rank

      return first.entry.tag.localeCompare(second.entry.tag, "zh-CN")
    })
    .slice(0, limit)
    .map(({ entry }) => entry.tag)
}

// 原文优先、前缀优先：原文前缀 > 全拼前缀 > 首字母前缀 > 混拼前缀 > 原文包含 > 拼音包含。
function getTagSearchRank(entry: TagSearchEntry, query: string) {
  if (!query) return 0

  if (entry.searchText.startsWith(query)) return 0
  if (entry.full.some((variant) => variant.startsWith(query))) return 1
  if (entry.initials.some((variant) => variant.startsWith(query))) return 2
  if (matchesMixedPinyinPrefix(entry.syllables, query)) return 3
  if (entry.searchText.includes(query)) return 4
  if (
    entry.full.some((variant) => variant.includes(query)) ||
    entry.initials.some((variant) => variant.includes(query))
  ) {
    return 5
  }

  return NO_TAG_MATCH
}

/**
 * 混拼前缀：从第一个字起，每个字吃掉某个读法的非空前缀，直到 query 用完。
 * 例如「日程」可以被 `rcheng`（r + cheng）或 `rich`（ri + ch）命中。
 */
function matchesMixedPinyinPrefix(syllables: string[][], query: string) {
  const visit = (syllableIndex: number, queryIndex: number): boolean => {
    if (queryIndex === query.length) return true
    if (syllableIndex === syllables.length) return false

    return syllables[syllableIndex].some((reading) => {
      for (
        let length = Math.min(reading.length, query.length - queryIndex);
        length > 0;
        length -= 1
      ) {
        if (
          query.startsWith(reading.slice(0, length), queryIndex) &&
          visit(syllableIndex + 1, queryIndex + length)
        ) {
          return true
        }
      }
      return false
    })
  }

  return visit(0, 0)
}

function getTagSyllables(tag: string) {
  const syllables: string[][] = []

  for (const char of Array.from(tag)) {
    const normalized = char.toLocaleLowerCase("zh-CN")
    if (/^[a-z0-9]$/u.test(normalized)) {
      syllables.push([normalized])
      continue
    }
    if (!/\p{Script=Han}/u.test(char)) continue

    const readings = unique(
      pinyin(char, { multiple: true, toneType: "none", type: "array" })
        .map((reading) => reading.toLowerCase().replace(/[^a-z]/gu, ""))
        .filter(Boolean)
    )
    if (readings.length > 0) syllables.push(readings)
  }

  return syllables
}

function expandVariants(syllables: string[][]) {
  let variants = [""]

  for (const readings of syllables) {
    variants = variants
      .flatMap((prefix) => readings.map((reading) => prefix + reading))
      .slice(0, MAX_PINYIN_VARIANTS)
  }

  return syllables.length > 0 ? unique(variants) : []
}

function unique(values: string[]) {
  return Array.from(new Set(values))
}

function normalizeTagSearchText(value: string) {
  return value
    .trim()
    .replace(/^#+/u, "")
    .replace(/\s+/gu, "")
    .toLocaleLowerCase("zh-CN")
}
