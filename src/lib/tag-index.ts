const PINYIN_INITIALS = "abcdefghjklmnopqrstwxyz"
const PINYIN_BOUNDARIES = "阿芭擦搭蛾发噶哈击喀垃妈拿哦啪期然撒塌挖昔压匝"
const PINYIN_COLLATOR = new Intl.Collator("zh-CN")
const NO_TAG_MATCH = Number.MAX_SAFE_INTEGER

export interface TagSearchEntry {
  initials: string
  searchText: string
  tag: string
}

export function buildTagSearchIndex(tags: string[]): TagSearchEntry[] {
  return tags.map((tag) => ({
    initials: getTagInitials(tag),
    searchText: normalizeTagSearchText(tag),
    tag,
  }))
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

function getTagSearchRank(entry: TagSearchEntry, query: string) {
  if (!query) return 0

  if (entry.searchText.startsWith(query)) return 0

  if (entry.initials.startsWith(query)) return 1
  if (entry.searchText.includes(query)) return 2
  if (entry.initials.includes(query)) return 3

  return NO_TAG_MATCH
}

function getTagInitials(tag: string) {
  return Array.from(tag)
    .map((char) => getCharInitial(char))
    .join("")
}

function getCharInitial(char: string) {
  const normalized = char.toLocaleLowerCase("zh-CN")
  if (/^[a-z0-9]$/u.test(normalized)) return normalized
  if (!/\p{Script=Han}/u.test(char)) return ""

  for (let index = PINYIN_BOUNDARIES.length - 1; index >= 0; index -= 1) {
    if (PINYIN_COLLATOR.compare(char, PINYIN_BOUNDARIES[index]) >= 0) {
      return PINYIN_INITIALS[index]
    }
  }

  return ""
}

function normalizeTagSearchText(value: string) {
  return value
    .trim()
    .replace(/^#+/u, "")
    .replace(/\s+/gu, "")
    .toLocaleLowerCase("zh-CN")
}
