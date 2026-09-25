import { describe, expect, it } from "vitest"

import {
  searchTargetKey,
  type SearchError,
  type SearchHit,
  type SearchVaultRequest,
} from "@/lib/search-contract"

describe("search contract", () => {
  it("uses one stable target identity without a third scope", () => {
    expect(
      searchTargetKey("/vault/A", "public", "notes/季度复盘.md")
    ).toBe('["/vault/A","public","notes/季度复盘.md"]')
  })

  it("keeps title parts lossless and errors structured", () => {
    const hit: SearchHit = {
      target: {
        key: searchTargetKey("/vault/A", "public", "notes/计划.md"),
        vaultPath: "/vault/A",
        scope: "public",
        path: "notes/计划.md",
        kind: "note",
        objectId: "note-1",
        archived: false,
      },
      title: "季度计划",
      titleParts: [
        { text: "季度", hit: true },
        { text: "计划", hit: false },
      ],
      tags: ["工作"],
      updatedAt: null,
      revision: null,
      matchedFields: ["title"],
      preview: [{ text: "季度计划", hit: true }],
      revealHint: "text",
    }
    const error: SearchError = { code: "io", retryable: true }

    expect(hit.titleParts.map((part) => part.text).join("")).toBe(hit.title)
    expect(error).toEqual({ code: "io", retryable: true })
  })

  it("mirrors the camelCase search request DTO", () => {
    const request: SearchVaultRequest = {
      clientRequestId: "request-1",
      expectedVaultPath: "/vault/A",
      context: null,
      scope: "lockbox",
      includeTrash: false,
      queryVersion: 1,
      projectionVersion: 1,
      query: "计划",
      limit: 50,
      refresh: "auto",
    }

    expect(Object.keys(request)).toEqual([
      "clientRequestId",
      "expectedVaultPath",
      "context",
      "scope",
      "includeTrash",
      "queryVersion",
      "projectionVersion",
      "query",
      "limit",
      "refresh",
    ])
  })
})
