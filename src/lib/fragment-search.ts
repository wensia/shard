import { LOCKBOX_TAG } from "@/lib/lockbox"
import type { Fragment } from "@/types"

export type FragmentSearchScope = "all" | "active" | "archive"

export interface FragmentSearchDocument {
  archived: boolean
  content: string
  createdAt: string
  id: string
  tags: string[]
}

export interface FragmentSearchHighlight {
  end: number
  start: number
}

export interface FragmentSearchMatch {
  excerpt: string
  excerptEndsAfter: boolean
  excerptStartsBefore: boolean
  fragmentId: string
  highlights: FragmentSearchHighlight[]
  matchedTags: string[]
  score: number
}

export interface FragmentSearchResponse {
  matches: FragmentSearchMatch[]
  total: number
}

interface FragmentSearchIndexItem extends FragmentSearchDocument {
  normalizedContent: string
  normalizedTags: string[]
  plainContent: string
  visibleTags: string[]
}

export type FragmentSearchWorkerRequest =
  | {
      documents: FragmentSearchDocument[]
      type: "index"
      version: number
    }
  | {
      limit: number
      query: string
      requestId: number
      scope: FragmentSearchScope
      type: "search"
      version: number
    }

export type FragmentSearchWorkerResponse =
  | {
      type: "ready"
      version: number
    }
  | {
      requestId: number
      response: FragmentSearchResponse
      type: "results"
      version: number
    }

export function toFragmentSearchDocument(
  fragment: Fragment
): FragmentSearchDocument {
  return {
    archived: fragment.archived,
    content: fragment.content,
    createdAt: fragment.createdAt,
    id: fragment.id,
    tags: fragment.tags,
  }
}

export function buildFragmentSearchIndex(
  documents: FragmentSearchDocument[]
): FragmentSearchIndexItem[] {
  return documents.map((document) => {
    const visibleTags = document.tags.filter(
      (tag) => tag !== "inbox" && tag !== LOCKBOX_TAG
    )
    const plainContent = markdownToSearchText(document.content)

    return {
      ...document,
      normalizedContent: normalizeSearchText(plainContent),
      normalizedTags: visibleTags.map(normalizeSearchText),
      plainContent,
      visibleTags,
    }
  })
}

export function searchFragmentIndex(
  index: FragmentSearchIndexItem[],
  rawQuery: string,
  scope: FragmentSearchScope,
  limit = 80
): FragmentSearchResponse {
  const query = normalizeSearchText(rawQuery.trim())
  if (!query) return { matches: [], total: 0 }

  const terms = Array.from(
    new Set(
      query
        .split(/\s+/u)
        .map((term) => term.replace(/^#+/u, ""))
        .filter(Boolean)
    )
  )
  if (terms.length === 0) return { matches: [], total: 0 }

  const matches: FragmentSearchMatch[] = []
  const createdAtById = new Map(index.map((item) => [item.id, item.createdAt]))

  for (const item of index) {
    if (scope === "active" && item.archived) continue
    if (scope === "archive" && !item.archived) continue

    const bodyTermIndexes = terms.map((term) =>
      item.normalizedContent.indexOf(term)
    )
    const matchedTagIndexes = item.normalizedTags
      .map((tag, tagIndex) =>
        terms.some((term) => tag.includes(term)) ? tagIndex : -1
      )
      .filter((tagIndex) => tagIndex >= 0)
    const everyTermMatches = terms.every((term, termIndex) => {
      if (bodyTermIndexes[termIndex] >= 0) return true
      return item.normalizedTags.some((tag) => tag.includes(term))
    })

    if (!everyTermMatches) continue

    const phraseIndex = item.normalizedContent.indexOf(query)
    const bodyIndexes = bodyTermIndexes.filter((position) => position >= 0)
    const firstBodyIndex = bodyIndexes.length > 0 ? Math.min(...bodyIndexes) : 0
    const exactTagMatch = item.normalizedTags.some((tag) => tag === query)
    const score = phraseIndex >= 0
      ? phraseIndex
      : exactTagMatch
        ? 2_000
        : bodyIndexes.length > 0
          ? 4_000 + firstBodyIndex
          : 8_000
    const excerpt = createExcerpt(item.plainContent, firstBodyIndex, terms)

    matches.push({
      ...excerpt,
      fragmentId: item.id,
      matchedTags: matchedTagIndexes.map(
        (tagIndex) => item.visibleTags[tagIndex]
      ),
      score,
    })
  }

  matches.sort((first, second) => {
    if (first.score !== second.score) return first.score - second.score
    return (createdAtById.get(second.fragmentId) ?? "").localeCompare(
      createdAtById.get(first.fragmentId) ?? ""
    )
  })

  return {
    matches: matches.slice(0, limit),
    total: matches.length,
  }
}

function createExcerpt(
  content: string,
  firstMatchIndex: number,
  terms: string[]
) {
  const excerptLength = 260
  const contextBefore = 72
  let start = Math.max(0, firstMatchIndex - contextBefore)

  if (start > 0) {
    const nextSpace = content.indexOf(" ", start)
    if (nextSpace >= 0 && nextSpace < firstMatchIndex) start = nextSpace + 1
  }

  let end = Math.min(content.length, start + excerptLength)
  if (end < content.length) {
    const previousSpace = content.lastIndexOf(" ", end)
    if (previousSpace > firstMatchIndex) end = previousSpace
  }

  const excerpt = content.slice(start, end).trim()

  return {
    excerpt,
    excerptEndsAfter: end < content.length,
    excerptStartsBefore: start > 0,
    highlights: findHighlightRanges(excerpt, terms),
  }
}

function findHighlightRanges(
  content: string,
  terms: string[]
): FragmentSearchHighlight[] {
  const normalizedContent = normalizeSearchText(content)
  const ranges: FragmentSearchHighlight[] = []

  for (const term of terms) {
    let offset = 0
    while (offset < normalizedContent.length) {
      const start = normalizedContent.indexOf(term, offset)
      if (start < 0) break
      ranges.push({ start, end: start + term.length })
      offset = start + Math.max(term.length, 1)
    }
  }

  ranges.sort((first, second) => first.start - second.start)
  return ranges.reduce<FragmentSearchHighlight[]>((merged, range) => {
    const previous = merged[merged.length - 1]
    if (!previous || range.start > previous.end) {
      merged.push({ ...range })
    } else {
      previous.end = Math.max(previous.end, range.end)
    }
    return merged
  }, [])
}

export function markdownToSearchText(markdown: string) {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^\s*(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gmu, "")
    .replace(/```[^\n]*\n?/gu, "")
    // GFM 表格：分隔行整行丢弃，竖线换成空格，避免 `| :---: |` 污染搜索文本
    .replace(/^[^\S\n]*\|?[^\S\n]*:?-{2,}:?[^\S\n]*(?:\|[^\S\n]*:?-{2,}:?[^\S\n]*)*\|?[^\S\n]*$/gmu, "")
    .replace(/\|/gu, " ")
    .replace(/[*_~`]/gu, "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
}

function normalizeSearchText(value: string) {
  return value.toLocaleLowerCase("zh-CN")
}
