import { expect, test, type Page } from "@playwright/test"

import { installSearchIpcMock, updateSearchIpcMock } from "./search-ipc-mock"

interface MutableSearchFixture {
  vaultPath: string
  fragments: Array<Record<string, unknown>>
  lockbox: { configured: boolean; unlocked: boolean; expiresAt: string | null }
}

async function installMutableFixture(page: Page) {
  await page.addInitScript(() => {
    const state: MutableSearchFixture = {
      vaultPath: "/tmp/shard-search-ipc",
      fragments: [
        {
          id: "public-active",
          path: "notes/计划.md",
          content: "# 季度计划\n\n公开正文",
          tags: ["note", "工作"],
          createdAt: "2026-09-25T08:00:00.000Z",
          updatedAt: "2026-09-25T08:00:00.000Z",
          category: null,
          gitStatus: "saved",
          error: null,
          aiStatus: "none",
          archived: false,
          lockbox: false,
          pinned: false,
          related: [],
        },
        {
          id: "public-trash",
          path: ".trash/notes/归档计划.md",
          content: "# 归档计划\n\n回收站正文",
          tags: ["note"],
          createdAt: "2026-09-24T08:00:00.000Z",
          updatedAt: "2026-09-24T08:00:00.000Z",
          category: null,
          gitStatus: "saved",
          error: null,
          aiStatus: "none",
          archived: true,
          lockbox: false,
          pinned: false,
          related: [],
        },
        {
          id: "private-active",
          path: "lockbox/notes/私密计划.shard",
          content: "# 私密计划\n\n密匣正文",
          tags: ["note", "私密"],
          createdAt: "2026-09-25T09:00:00.000Z",
          updatedAt: "2026-09-25T09:00:00.000Z",
          category: null,
          gitStatus: "saved",
          error: null,
          aiStatus: "none",
          archived: false,
          lockbox: true,
          pinned: false,
          related: [],
        },
      ],
      lockbox: { configured: true, unlocked: false, expiresAt: null },
    }
    Object.assign(globalThis, {
      __SHARD_MUTABLE_SEARCH_FIXTURE__: state,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (command === "list_fragments") return structuredClone(state)
          throw new Error(`Unknown command: ${command}`)
        },
      },
    })
  })
  await installSearchIpcMock(page)
  await page.goto("data:text/html,<title>search-ipc</title>")
}

function invokeSearch(page: Page, command: string, request: Record<string, unknown>) {
  return page.evaluate(
    ({ command, request }) =>
      (
        globalThis as typeof globalThis & {
          __TAURI_INTERNALS__: {
            invoke(command: string, args: Record<string, unknown>): Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__.invoke(command, { request }),
    { command, request }
  )
}

function invokeSearchFailure(
  page: Page,
  command: string,
  request: Record<string, unknown>
) {
  return page.evaluate(
    async ({ command, request }) => {
      try {
        await (
          globalThis as typeof globalThis & {
            __TAURI_INTERNALS__: {
              invoke(command: string, args: Record<string, unknown>): Promise<unknown>
            }
          }
        ).__TAURI_INTERNALS__.invoke(command, { request })
        return null
      } catch (error) {
        return error
      }
    },
    { command, request }
  )
}

test("new search commands work in mutable fixtures", async ({ page }) => {
  await installMutableFixture(page)
  const baseRequest = {
    clientRequestId: "search-1",
    expectedVaultPath: "/tmp/shard-search-ipc",
    context: null,
    scope: "public",
    includeTrash: false,
    queryVersion: 1,
    projectionVersion: 1,
    query: "计划",
    limit: 50,
    refresh: "auto",
  }

  const ready = await invokeSearch(page, "search_vault", baseRequest) as {
    context: Record<string, unknown>
    hits: Array<{ revision: string; target: Record<string, unknown> }>
    total: number
    indexState: string
  }
  expect(ready.indexState).toBe("ready")
  expect(ready.total).toBe(1)
  expect(ready.hits[0].target.objectId).toBe("public-active")

  const oldRevision = ready.hits[0].revision
  await page.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        __SHARD_MUTABLE_SEARCH_FIXTURE__: MutableSearchFixture
      }
    ).__SHARD_MUTABLE_SEARCH_FIXTURE__
    const fragment = state.fragments.find((item) => item.id === "public-active")!
    fragment.content = "# 季度计划\n\n保存后的新正文"
    fragment.updatedAt = "2026-09-25T10:00:00.000Z"
  })
  const read = await invokeSearch(page, "read_search_target", {
    clientRequestId: "read-1",
    expectedVaultPath: baseRequest.expectedVaultPath,
    context: ready.context,
    target: ready.hits[0].target,
    expectedRevision: oldRevision,
  }) as { revision: string; fragment: { content: string } }
  expect(read.revision).not.toBe(oldRevision)
  expect(read.fragment.content).toContain("保存后的新正文")

  const trash = await invokeSearch(page, "search_vault", {
    ...baseRequest,
    clientRequestId: "search-trash",
    includeTrash: true,
  }) as { total: number }
  expect(trash.total).toBe(2)

  await updateSearchIpcMock(page, { indexState: "indexing" })
  const indexing = await invokeSearch(page, "search_vault", {
    ...baseRequest,
    clientRequestId: "search-indexing",
  }) as { indexState: string; total: null }
  expect(indexing).toMatchObject({ indexState: "indexing", total: null })

  await updateSearchIpcMock(page, { indexState: "stale", delayMs: 5 })
  const stale = await invokeSearch(page, "search_vault", {
    ...baseRequest,
    clientRequestId: "search-stale",
  }) as { indexState: string }
  expect(stale.indexState).toBe("stale")

  await expect(
    invokeSearchFailure(page, "search_vault", {
      ...baseRequest,
      clientRequestId: "search-locked",
      scope: "lockbox",
    })
  ).resolves.toMatchObject({ code: "locked" })
  await page.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        __SHARD_MUTABLE_SEARCH_FIXTURE__: MutableSearchFixture
      }
    ).__SHARD_MUTABLE_SEARCH_FIXTURE__
    state.lockbox.unlocked = true
    state.lockbox.expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()
  })
  await updateSearchIpcMock(page, { indexState: "ready", delayMs: 0 })
  const lockbox = await invokeSearch(page, "search_vault", {
    ...baseRequest,
    clientRequestId: "search-lockbox",
    scope: "lockbox",
  }) as { total: number; hits: Array<{ target: { objectId: string } }> }
  expect(lockbox.total).toBe(1)
  expect(lockbox.hits[0].target.objectId).toBe("private-active")

  await updateSearchIpcMock(page, {
    nextError: {
      command: "search_vault",
      error: { code: "io", retryable: true },
    },
  })
  await expect(
    invokeSearchFailure(page, "search_vault", {
      ...baseRequest,
      clientRequestId: "search-error",
    })
  ).resolves.toMatchObject({ code: "io", retryable: true })

  await page.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        __SHARD_MUTABLE_SEARCH_FIXTURE__: MutableSearchFixture
      }
    ).__SHARD_MUTABLE_SEARCH_FIXTURE__
    state.fragments = state.fragments.filter((item) => item.id !== "public-active")
  })
  await expect(
    invokeSearchFailure(page, "read_search_target", {
      clientRequestId: "read-missing",
      expectedVaultPath: baseRequest.expectedVaultPath,
      context: null,
      target: ready.hits[0].target,
      expectedRevision: oldRevision,
    })
  ).resolves.toMatchObject({ code: "notFound" })
})

test("unknown commands still fail loudly", async ({ page }) => {
  await installMutableFixture(page)
  await expect(
    page.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          __TAURI_INTERNALS__: { invoke(command: string): Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke("list_search_catalog")
    )
  ).rejects.toThrow("Unknown command: list_search_catalog")
})
