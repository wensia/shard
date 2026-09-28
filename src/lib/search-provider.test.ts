import { afterEach, describe, expect, it, vi } from "vitest"

import {
  type FragmentSearchDocument,
  type FragmentSearchWorkerRequest,
  type FragmentSearchWorkerResponse,
} from "@/lib/fragment-search"
import { parseMindMapOutline } from "@/lib/mind-map-outline"
import { createLegacyPublicSearchProvider } from "@/lib/search-provider"
import type { SearchVaultRequest } from "@/lib/search-contract"
import type { Fragment } from "@/types"

function fragment(overrides: Partial<Fragment>): Fragment {
  return {
    archived: false,
    category: null,
    content: "正文",
    createdAt: "2026-09-01T00:00:00.000Z",
    error: null,
    gitStatus: "saved",
    id: "fragment-id",
    kind: "outline",
    lockbox: false,
    path: "fragments/2026/09/fragment.md",
    pinned: false,
    tags: ["outline"],
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  }
}

const request: SearchVaultRequest = {
  clientRequestId: "search-1",
  context: null,
  expectedVaultPath: "/vault",
  includeTrash: false,
  limit: 50,
  projectionVersion: 1,
  query: "大纲",
  queryVersion: 1,
  refresh: "auto",
  scope: "public",
}

class FakeWorker {
  private documents: FragmentSearchDocument[] = []
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessage: ((event: MessageEvent<FragmentSearchWorkerResponse>) => void) | null = null

  postMessage(message: FragmentSearchWorkerRequest) {
    if (message.type === "index") {
      this.documents = message.documents
      this.emit({ type: "ready", version: message.version })
      return
    }

    this.emit({
      requestId: message.requestId,
      response: {
        matches: this.documents.map((document) => ({
          excerpt: document.content,
          excerptEndsAfter: false,
          excerptStartsBefore: false,
          fragmentId: document.id,
          highlights: [],
          matchedTags: [],
          score: 0,
        })),
        total: this.documents.length,
      },
      type: "results",
      version: message.version,
    })
  }

  terminate() {}

  private emit(data: FragmentSearchWorkerResponse) {
    this.onmessage?.({ data } as MessageEvent<FragmentSearchWorkerResponse>)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("legacy public search outline titles", () => {
  it("fragment result title hides hard-break marker", async () => {
    vi.stubGlobal("Worker", FakeWorker)
    const provider = createLegacyPublicSearchProvider([
      fragment({ content: "首行\\\n续行", kind: "fragment", tags: [] }),
    ])

    try {
      const response = await provider.search(request)
      expect(response.hits[0]?.title).toBe("首行")
    } finally {
      provider.dispose()
    }
  })

  it("uses JSON roots while retaining invalid JSON and truncated legacy fallbacks", async () => {
    vi.stubGlobal("Worker", FakeWorker)
    const jsonFile = parseMindMapOutline("- JSON 根标题\n  - 子节点").file
    expect(jsonFile).not.toBeNull()
    const provider = createLegacyPublicSearchProvider([
      fragment({
        content: `前置正文\n\n\`\`\`shardmap\n${JSON.stringify(jsonFile)}\n\`\`\``,
        id: "json-outline",
      }),
      fragment({
        content: "```shardmap\n{not json}\n```",
        id: "invalid-outline",
      }),
      fragment({
        content: [
          "- 旧式根标题",
          ...Array.from({ length: 201 }, (_, index) => `  - 子节点 ${index}`),
        ].join("\n"),
        id: "legacy-outline",
      }),
    ])

    try {
      const response = await provider.search(request)
      expect(response.hits.map(({ target, title }) => ({
        id: target.objectId,
        title,
      }))).toEqual([
        { id: "json-outline", title: "JSON 根标题" },
        { id: "invalid-outline", title: "未命名大纲" },
        { id: "legacy-outline", title: "旧式根标题" },
      ])
    } finally {
      provider.dispose()
    }
  })
})
