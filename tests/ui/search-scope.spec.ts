import { expect, test, type Page } from "@playwright/test"

interface WorkerMessage {
  documents?: Array<{ id: string }>
  query?: string
  type?: string
}

interface SearchScopeMockOptions {
  delayLock?: boolean
  delayUnlock?: boolean
  initialUnlocked?: boolean
}

async function installSearchScopeMock(
  page: Page,
  options: SearchScopeMockOptions = {}
) {
  await page.addInitScript((mockOptions) => {
    const publicFragment = {
      id: "public-result",
      content: "公开唯一词，只能出现在公开搜索中",
      createdAt: "2026-09-25T08:00:00.000Z",
      updatedAt: "2026-09-25T08:00:00.000Z",
      tags: ["inbox"],
      category: null,
      path: "fragments/2026/09/public-result.md",
      gitStatus: "committed",
      error: null,
      aiStatus: "none",
      archived: false,
      lockbox: false,
      pinned: false,
      related: [],
    }
    const lockboxFragment = {
      id: "lockbox-result",
      content: "密匣唯一词，绝不能进入公开 Worker",
      createdAt: "2026-09-25T09:00:00.000Z",
      updatedAt: "2026-09-25T09:00:00.000Z",
      tags: ["私密"],
      category: null,
      path: "lockbox/fragments/2026/09/lockbox-result.shard",
      gitStatus: "committed",
      error: null,
      aiStatus: "none",
      archived: false,
      lockbox: true,
      pinned: false,
      related: [],
    }
    const lockbox = {
      configured: true,
      unlocked: Boolean(mockOptions.initialUnlocked),
      expiresAt: mockOptions.initialUnlocked
        ? "2026-09-25T12:00:00.000Z"
        : null,
      ttlSeconds: 180,
    }
    const git = {
      branch: "main",
      shortCommit: "search01",
      hasRemote: false,
      status: "ready",
      error: null,
      ahead: 0,
      behind: 0,
    }
    const clone = <T,>(value: T): T => structuredClone(value)
    const workerMessages: WorkerMessage[] = []
    const NativeWorker = globalThis.Worker
    class ObservedWorker extends NativeWorker {
      override postMessage(message: unknown, options?: StructuredSerializeOptions) {
        workerMessages.push(clone(message as WorkerMessage))
        if (options === undefined) super.postMessage(message)
        else super.postMessage(message, options)
      }
    }

    let releaseUnlock: (() => void) | null = null
    const unlockGate = mockOptions.delayUnlock
      ? new Promise<void>((resolve) => {
          releaseUnlock = resolve
        })
      : Promise.resolve()
    let releaseLock: (() => void) | null = null
    const lockGate = mockOptions.delayLock
      ? new Promise<void>((resolve) => {
          releaseLock = resolve
        })
      : Promise.resolve()
    const calls: string[] = []
    const state = () =>
      clone({
        vaultPath: "/tmp/shard-search-scope",
        fragments: [publicFragment, lockboxFragment].filter(
          (fragment) => lockbox.unlocked || !fragment.lockbox
        ),
        git,
        lockbox,
      })
    const libraryTree = () => ({
      entries: [],
      trashEntries: [],
      fragmentTrashEntries: [],
      assets: [],
      fragmentStream: {
        totalCount: 1,
        years: [
          {
            year: "2026",
            totalCount: 1,
            months: [{ month: "09", count: 1 }],
          },
        ],
      },
    })

    Object.assign(globalThis, {
      Worker: ObservedWorker,
      isTauri: true,
      __SHARD_SEARCH_SCOPE_CALLS__: calls,
      __SHARD_SEARCH_WORKER_MESSAGES__: workerMessages,
      __SHARD_SEARCH_LOCKBOX_UNLOCKED__: () => lockbox.unlocked,
      __SHARD_RELEASE_SEARCH_UNLOCK__: () => releaseUnlock?.(),
      __SHARD_RELEASE_SEARCH_LOCK__: () => releaseLock?.(),
      __TAURI_INTERNALS__: {
        invoke: async (
          command: string,
          args: Record<string, unknown> = {}
        ) => {
          calls.push(command)
          if (command === "list_fragments") return state()
          if (command === "unlock_lockbox") {
            await unlockGate
            lockbox.unlocked = true
            lockbox.expiresAt = "2026-09-25T12:00:00.000Z"
            return state()
          }
          if (command === "lock_lockbox") {
            await lockGate
            lockbox.unlocked = false
            lockbox.expiresAt = null
            return state()
          }
          if (command === "move_fragment_to_lockbox") {
            if (args.id !== publicFragment.id) {
              throw new Error("Fragment not found")
            }
            publicFragment.lockbox = true
            publicFragment.path =
              "lockbox/fragments/2026/09/public-result.shard"
            return state()
          }
          if (command === "list_library_tree") return libraryTree()
          if (command === "migrate_legacy_notes") {
            return { tree: libraryTree(), migratedCount: 0 }
          }
          if (
            command === "list_mind_maps" ||
            command === "list_csv_files" ||
            command === "list_diagram_documents"
          ) {
            return []
          }
          if (command === "plugin:app|version") return "0.1.3-test"
          if (command === "sync_vault") return clone(git)
          if (command === "checkpoint_vault") {
            return { status: "noop", git: clone(git) }
          }
          throw new Error(`Unhandled Tauri test command: ${command}`)
        },
      },
    })
  }, options)
}

async function workerMessages(page: Page, type: string) {
  return page.evaluate((messageType) => {
    const messages = (
      globalThis as typeof globalThis & {
        __SHARD_SEARCH_WORKER_MESSAGES__?: WorkerMessage[]
      }
    ).__SHARD_SEARCH_WORKER_MESSAGES__ ?? []
    return messages.filter((message) => message.type === messageType)
  }, type)
}

async function commandCalls(page: Page, command: string) {
  return page.evaluate((target) => {
    const calls = (
      globalThis as typeof globalThis & {
        __SHARD_SEARCH_SCOPE_CALLS__?: string[]
      }
    ).__SHARD_SEARCH_SCOPE_CALLS__ ?? []
    return calls.filter((call) => call === target)
  }, command)
}

async function unlockThroughPortal(page: Page) {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const librarySidebar = page.getByRole("complementary", {
    name: "资料库目录",
  })
  await expect(librarySidebar).toBeVisible()
  await librarySidebar
    .getByRole("button", { name: "密匣（上锁空间）", exact: true })
    .click()
  const gate = page.getByRole("form", { name: "解锁密匣" })
  await gate.getByPlaceholder("密匣密码").fill("correct-password")
  await gate.getByRole("button", { name: "解锁", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "密匣", exact: true })
  ).toBeVisible()
}

test("public search excludes unlocked lockbox objects", async ({ page }) => {
  await installSearchScopeMock(page, {
    delayLock: true,
    initialUnlocked: true,
  })
  await page.goto("/")

  await page.keyboard.press("Control+k")
  const input = page.getByRole("combobox", { name: "搜索内容" })
  await expect(input).toBeVisible()
  await expect
    .poll(async () => {
      const indexes = await workerMessages(page, "index")
      return indexes.at(-1)?.documents?.map((document) => document.id) ?? []
    })
    .toEqual(["public-result"])

  await input.fill("公开唯一词")
  await expect(
    page.getByRole("option").filter({ hasText: "公开唯一词" })
  ).toBeVisible()
  await input.fill("密匣唯一词")
  await expect(page.getByRole("option")).toHaveCount(0)
  await expect(page.getByText("没有找到“密匣唯一词”")).toBeVisible()
})

test("lockbox space never shows public search results", async ({ page }) => {
  await installSearchScopeMock(page)
  await page.goto("/")
  await unlockThroughPortal(page)
  const before = await workerMessages(page, "index")

  await page.keyboard.press("Control+k")

  await expect(
    page.getByText("密匣全文搜索将在 Rust 搜索接入后恢复")
  ).toBeVisible()
  await expect(page.getByRole("combobox", { name: "搜索内容" })).toHaveCount(0)
  await expect.poll(() => workerMessages(page, "index")).toHaveLength(
    before.length
  )
  await expect(page.getByRole("option").filter({ hasText: "公开唯一词" })).toHaveCount(0)
})

test("leaving lockbox clears query results and pending navigation", async ({
  page,
}) => {
  await installSearchScopeMock(page, { delayUnlock: true })
  await page.goto("/")

  await page.keyboard.press("Control+k")
  const searchInput = page.getByRole("combobox", { name: "搜索内容" })
  await searchInput.fill("公开唯一词")
  await page.getByRole("option").filter({ hasText: "公开唯一词" }).click()
  await expect(
    page.getByRole("button", { name: "返回搜索结果" })
  ).toBeVisible()

  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page
    .getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: "密匣（上锁空间）", exact: true })
    .click()
  const gate = page.getByRole("form", { name: "解锁密匣" })
  await gate.getByPlaceholder("密匣密码").fill("correct-password")
  await gate.getByRole("button", { name: "解锁", exact: true }).click()

  await page
    .getByRole("navigation", { name: "工作台导航" })
    .getByRole("button", { name: "碎片", exact: true })
    .click()
  await page.evaluate(() => {
    ;(
      globalThis as typeof globalThis & {
        __SHARD_RELEASE_SEARCH_UNLOCK__?: () => void
      }
    ).__SHARD_RELEASE_SEARCH_UNLOCK__?.()
  })

  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("shard.workspace-route"))
    )
    .toBe(JSON.stringify({ space: "fragments", params: {} }))
  await expect(
    page.getByRole("button", { name: "返回搜索结果" })
  ).toHaveCount(0)
  await expect(
    page.locator('[data-shard-fragment-id="lockbox-result"]')
  ).toHaveCount(0)

  await page.keyboard.press("Control+k")
  const reopenedInput = page.getByRole("combobox", { name: "搜索内容" })
  await expect(reopenedInput).toHaveValue("")
  await expect(page.getByRole("option")).toHaveCount(0)
})

test("moving a public fragment into a locked lockbox needs no unlock and keeps it locked", async ({
  page,
}) => {
  await installSearchScopeMock(page)
  await page.goto("/")

  const fragment = page.locator('[data-shard-fragment-id="public-result"]')
  await expect(fragment).toBeVisible()
  page.once("dialog", (dialog) => dialog.accept())
  await fragment.getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "移入密匣", exact: true }).click()

  await expect.poll(() => commandCalls(page, "move_fragment_to_lockbox")).toHaveLength(1)
  await expect(fragment).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "解锁密匣" })).toHaveCount(0)
  expect(await commandCalls(page, "unlock_lockbox")).toHaveLength(0)
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            __SHARD_SEARCH_LOCKBOX_UNLOCKED__?: () => boolean
          }
        ).__SHARD_SEARCH_LOCKBOX_UNLOCKED__?.()
      )
    )
    .toBe(false)
})

test("silent refresh during unlock does not relock", async ({ page }) => {
  await installSearchScopeMock(page, { delayUnlock: true })
  await page.goto("/")
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page
    .getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: "密匣（上锁空间）", exact: true })
    .click()

  const gate = page.getByRole("form", { name: "解锁密匣" })
  await gate.getByPlaceholder("密匣密码").fill("correct-password")
  const listCallsBeforeRefresh = await commandCalls(page, "list_fragments")
  await gate.getByRole("button", { name: "解锁", exact: true }).click()

  await page.waitForTimeout(5_100)
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect
    .poll(() => commandCalls(page, "list_fragments"))
    .toHaveLength(listCallsBeforeRefresh.length + 1)
  await page.evaluate(() => {
    ;(
      globalThis as typeof globalThis & {
        __SHARD_RELEASE_SEARCH_UNLOCK__?: () => void
      }
    ).__SHARD_RELEASE_SEARCH_UNLOCK__?.()
  })

  await expect(
    page.getByRole("heading", { name: "密匣", exact: true })
  ).toBeVisible()
  await expect.poll(() => commandCalls(page, "lock_lockbox")).toHaveLength(0)
})
