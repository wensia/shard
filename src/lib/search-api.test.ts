import { beforeEach, describe, expect, it, vi } from "vitest"

const { invoke, isTauri } = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri }))

import { readSearchTarget, searchVault } from "@/lib/search-api"
import type {
  ReadSearchTargetRequest,
  SearchVaultRequest,
} from "@/lib/search-contract"

const context = {
  vaultPath: "/vault/A",
  vaultEpoch: "1",
  privacyEpoch: "0",
}

const searchRequest: SearchVaultRequest = {
  clientRequestId: "search-1",
  expectedVaultPath: "/vault/A",
  context: null,
  scope: "public",
  includeTrash: false,
  queryVersion: 1,
  projectionVersion: 1,
  query: "计划",
  limit: 50,
  refresh: "auto",
}

const readRequest: ReadSearchTargetRequest = {
  clientRequestId: "read-1",
  expectedVaultPath: "/vault/A",
  context,
  target: {
    key: '["/vault/A","public","notes/计划.md"]',
    vaultPath: "/vault/A",
    scope: "public",
    path: "notes/计划.md",
    kind: "note",
    objectId: "note-1",
    archived: false,
  },
  expectedRevision: "old-revision",
}

beforeEach(() => {
  invoke.mockReset()
  isTauri.mockReturnValue(true)
})

describe("search API", () => {
  it("search_api_preserves_structured_error", async () => {
    invoke.mockRejectedValueOnce({ code: "io", retryable: true })
    await expect(searchVault(searchRequest)).rejects.toEqual({
      code: "io",
      retryable: true,
    })

    invoke.mockRejectedValueOnce({ unexpected: "private detail" })
    await expect(searchVault(searchRequest)).rejects.toEqual({
      code: "internal",
      retryable: false,
    })
  })

  it("search_api_hydrates_fragment_kind", async () => {
    invoke.mockResolvedValueOnce({
      clientRequestId: "read-1",
      context,
      expiresAt: null,
      target: readRequest.target,
      revision: "new-revision",
      readOnly: true,
      fragment: {
        id: "note-1",
        content: "# 计划",
        createdAt: "2026-09-25T08:00:00.000Z",
        updatedAt: "2026-09-25T09:00:00.000Z",
        tags: ["note"],
        category: null,
        path: "notes/计划.md",
        gitStatus: "saved",
        error: null,
        aiStatus: "none",
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
    })

    const response = await readSearchTarget(readRequest)

    expect(response.fragment.kind).toBe("note")
    expect(invoke).toHaveBeenCalledWith("read_search_target", {
      request: readRequest,
    })
  })
})
