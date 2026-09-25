export const SEARCH_QUERY_MAX_CHARACTERS = 256
export const SEARCH_QUERY_MAX_TERMS = 8

export type SearchQueryErrorReason = "queryTooLong" | "tooManyTerms"

export class SearchQueryError extends Error {
  readonly reason: SearchQueryErrorReason

  constructor(reason: SearchQueryErrorReason) {
    super(
      reason === "queryTooLong"
        ? `搜索内容不能超过 ${SEARCH_QUERY_MAX_CHARACTERS} 个字符。`
        : `搜索关键词不能超过 ${SEARCH_QUERY_MAX_TERMS} 个。`
    )
    this.name = "SearchQueryError"
    this.reason = reason
  }
}

export function normalizeSearchText(text: string): string {
  let normalized = ""

  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break
    const width = codePoint > 0xffff ? 2 : 1

    if (codePoint === 0x0d) {
      normalized += "\n"
      if (text.charCodeAt(index + 1) === 0x0a) index += 1
    } else if (codePoint === 0x3000) {
      normalized += " "
    } else {
      const folded =
        codePoint >= 0xff01 && codePoint <= 0xff5e
          ? codePoint - 0xfee0
          : codePoint
      normalized += String.fromCodePoint(
        folded >= 0x41 && folded <= 0x5a ? folded + 0x20 : folded
      )
    }

    index += width
  }

  return normalized
}

export function parseSearchTerms(query: string): readonly string[] {
  if (Array.from(query).length > SEARCH_QUERY_MAX_CHARACTERS) {
    throw new SearchQueryError("queryTooLong")
  }

  const terms = Array.from(
    new Set(normalizeSearchText(query).split(/\s+/u).filter(Boolean))
  )

  if (terms.length > SEARCH_QUERY_MAX_TERMS) {
    throw new SearchQueryError("tooManyTerms")
  }

  return terms
}
