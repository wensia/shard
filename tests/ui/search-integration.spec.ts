import { expect, test, type Page } from "@playwright/test"

import { installSearchIpcMock, updateSearchIpcMock } from "./search-ipc-mock"

interface IntegrationFragment {
  id: string
  content: string
  path: string
  lockbox: boolean
}

interface IntegrationFixture {
  failLock?: boolean
  fragments: IntegrationFragment[]
  lockbox: { configured: boolean; unlocked: boolean; expiresAt: string | null; ttlSeconds: number }
  vaultPath: string
}

const VAULT_A = "/tmp/shard-search-integration-a"
const VAULT_B = "/tmp/shard-search-integration-b"

async function installIntegrationFixture(page: Page) {
  await installSearchIpcMock(page)
  await page.addInitScript(() => {
    const now = new Date().toISOString()
    const fragment = (id: string, content: string, lockbox = false) => ({
      id,
      content,
      createdAt: now,
      updatedAt: now,
      tags: ["inbox"],
      category: null,
      path: lockbox ? `lockbox/fragments/${id}.shard` : `fragments/${id}.md`,
      gitStatus: "committed",
      error: null,
      aiStatus: "none",
      archived: false,
      lockbox,
      pinned: false,
      related: [],
    })
    const fragments = [
      fragment("public-target", "公开检索目标 oldword"),
      ...Array.from({ length: 56 }, (_, index) =>
        fragment(`filler-${index}`, `普通片段 ${index} 时间线填充内容`)
      ),
      fragment("deep-target", "时间线深处定位词 deepneedle"),
      fragment("private-target", "密匣检索目标 secretonly", true),
    ]
    fragments.forEach((item, index) => {
      item.createdAt = new Date(Date.now() - index * 1_000).toISOString()
      item.updatedAt = item.createdAt
    })
    const fixture: IntegrationFixture = {
      fragments,
      lockbox: { configured: true, unlocked: false, expiresAt: null, ttlSeconds: 180 },
      vaultPath: "/tmp/shard-search-integration-a",
    }
    const git = {
      branch: "main", shortCommit: "t11test", hasRemote: false,
      status: "ready", error: null, ahead: 0, behind: 0,
    }
    const tree = {
      entries: [], assets: [], trashEntries: [], fragmentTrashEntries: [],
      fragmentStream: { totalCount: fragments.length - 1, years: [] },
    }
    const clone = <T,>(value: T): T => structuredClone(value)
    const state = () => ({
      vaultPath: fixture.vaultPath,
      fragments: clone(fixture.fragments.filter((item) => fixture.lockbox.unlocked || !item.lockbox)),
      lockbox: clone(fixture.lockbox),
      git: clone(git),
    })
    let callbackId = 0
    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_T11_FIXTURE__: fixture,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: () => ++callbackId,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          switch (command) {
            case "plugin:event|listen": return ++callbackId
            case "plugin:event|unlisten":
            case "unhide_pointer":
            case "set_window_controls_hidden": return null
            case "plugin:app|version": return "0.1.3-test"
            case "plugin:dialog|open": return "/tmp/shard-search-integration-b"
            case "list_fragments": return state()
            case "set_vault_path":
              fixture.vaultPath = String(args.path)
              return state()
            case "list_library_tree": return clone(tree)
            case "migrate_legacy_notes": return { tree: clone(tree), migratedCount: 0 }
            case "list_mind_maps":
            case "list_csv_files":
            case "list_diagram_documents": return []
            case "unlock_lockbox":
              fixture.lockbox.unlocked = true
              fixture.lockbox.expiresAt = new Date(Date.now() + 180_000).toISOString()
              return state()
            case "lock_lockbox":
              if (fixture.failLock) throw new Error("simulated lock failure")
              fixture.lockbox.unlocked = false
              fixture.lockbox.expiresAt = null
              return state()
            case "move_fragment_to_lockbox": {
              const target = fixture.fragments.find((item) => item.id === args.id)
              if (!target) throw new Error("Fragment not found")
              target.lockbox = true
              target.path = `lockbox/fragments/${target.id}.shard`
              return state()
            }
            case "sync_vault": return clone(git)
            case "checkpoint_vault": return { status: "noop", git: clone(git) }
            default: throw new Error(`Unhandled T11 command: ${command}`)
          }
        },
      },
    })
  })
}

async function openSearch(page: Page, query: string) {
  await page.keyboard.press("Control+k")
  const palette = page.getByRole("dialog", { name: "搜索", exact: true })
  await palette.getByRole("combobox", { name: "搜索内容" }).fill(query)
  return palette
}

async function searchCalls(page: Page, command: string) {
  return page.evaluate((target) =>
    (
      globalThis as typeof globalThis & {
        __SHARD_SEARCH_IPC_MOCK__: {
          calls: Array<{ command: string; request: Record<string, unknown> }>
        }
      }
    ).__SHARD_SEARCH_IPC_MOCK__.calls.filter((call) => call.command === target), command)
}

async function unlockThroughPortal(page: Page) {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: "密匣（上锁空间）", exact: true }).click()
  const gate = page.getByRole("form", { name: "解锁密匣" })
  await gate.getByPlaceholder("密匣密码").fill("correct-password")
  await gate.getByRole("button", { name: "解锁", exact: true }).click()
  await expect(page.getByRole("heading", { name: "密匣", exact: true })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await installIntegrationFixture(page)
})

test("late private search cannot reappear after lock", async ({ page }) => {
  await page.goto("/")
  await unlockThroughPortal(page)
  await updateSearchIpcMock(page, { delayMs: 350 })
  const palette = await openSearch(page, "secretonly")
  await expect.poll(async () => (await searchCalls(page, "search_vault")).length).toBe(1)

  // The lock action can be activated while the delayed search owns the modal.
  await page.getByRole("button", { name: "上锁", exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole("heading", { name: "密匣已上锁" })).toHaveCount(0)
  await expect(page.getByRole("complementary", { name: "资料库目录" })).toBeVisible()
  await expect(palette.getByRole("option")).toHaveCount(0)
  await expect.poll(async () => (await searchCalls(page, "search_vault"))[0]?.request.scope).toBe("lockbox")
  await expect(page.getByText("密匣检索目标 secretonly")).toHaveCount(0)
})

test("native lease expiry revokes private results without another action", async ({ page }) => {
  await page.goto("/")
  await unlockThroughPortal(page)
  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __SHARD_T11_FIXTURE__: IntegrationFixture
    }).__SHARD_T11_FIXTURE__
    fixture.lockbox.expiresAt = new Date(Date.now() + 2_000).toISOString()
  })
  const palette = await openSearch(page, "secretonly")
  await expect(palette.getByRole("option")).toHaveCount(1)
  await expect(palette).toHaveCount(0, { timeout: 5_000 })
  await expect(page.getByText("密匣检索目标 secretonly")).toHaveCount(0)
  await expect(page.getByRole("complementary", { name: "资料库目录" })).toBeVisible()
  await expect.poll(async () => (await searchCalls(page, "search_vault")).length).toBeGreaterThan(0)
})

test("failed native lock still hides private results and reports failure", async ({ page }) => {
  await page.goto("/")
  await unlockThroughPortal(page)
  const palette = await openSearch(page, "secretonly")
  await expect(palette.getByRole("option")).toHaveCount(1)
  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __SHARD_T11_FIXTURE__: IntegrationFixture
    }).__SHARD_T11_FIXTURE__
    fixture.failLock = true
  })
  await page.getByRole("button", { name: "上锁", exact: true, includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(palette).toHaveCount(0)
  await expect(page.getByText("密匣检索目标 secretonly")).toHaveCount(0)
  await expect(page.getByText(/密匣上锁失败/)).toBeVisible()
})

test("late target read cannot navigate after vault switch", async ({ page }) => {
  await page.goto("/")
  const palette = await openSearch(page, "oldword")
  await expect(palette.getByRole("option")).toHaveCount(1)
  await updateSearchIpcMock(page, { delayMs: 2_500 })
  await palette.getByRole("option").click()
  await expect.poll(async () => (await searchCalls(page, "read_search_target")).length).toBe(1)

  // Drive the app's vault switch while the modal and read are both pending.
  // The modal makes background controls inert to pointer input, so invoke their
  // existing click handlers without closing the search session first.
  await expect(palette).toHaveAttribute("data-search-pending", "true")
  await page.locator("[data-shard-utility-menu-trigger]:visible")
    .evaluate((button: HTMLButtonElement) => button.click())
  await page.getByRole("menuitem", { name: "设置", includeHidden: true })
    .evaluate((item: HTMLElement) => item.click())
  await page.getByRole("button", { name: "选择已有目录", includeHidden: true })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect.poll(() => page.evaluate(() =>
    (globalThis as typeof globalThis & { __SHARD_T11_FIXTURE__: IntegrationFixture })
      .__SHARD_T11_FIXTURE__.vaultPath
  )).toBe(VAULT_B)
  await page.waitForTimeout(2_600)
  await expect(page.getByRole("button", { name: "返回搜索结果" })).toHaveCount(0)
  await expect(page.locator('[data-shard-editor="zen:public-target"]')).toHaveCount(0)
  expect((await searchCalls(page, "read_search_target"))[0].request.expectedVaultPath).toBe(VAULT_A)
})

test("moving public content into lockbox removes old search and recent", async ({ page }) => {
  await page.goto("/")
  const palette = await openSearch(page, "oldword")
  await palette.getByRole("option").click()
  await expect(palette).toHaveCount(0)
  await expect.poll(() => page.evaluate((vaultPath) =>
    JSON.parse(localStorage.getItem(`shard.recent.${vaultPath}`) ?? "[]").length,
    VAULT_A
  )).toBe(1)

  const card = page.locator('[data-shard-fragment-id="public-target"]')
  await expect(card).toBeVisible()
  page.once("dialog", (dialog) => dialog.accept())
  await card.getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "移入密匣", exact: true }).click()
  await expect(card).toHaveCount(0)
  await expect.poll(() => page.evaluate((vaultPath) =>
    JSON.parse(localStorage.getItem(`shard.recent.${vaultPath}`) ?? "[]").length,
    VAULT_A
  )).toBe(0)

  const reopened = await openSearch(page, "oldword")
  await expect(reopened.getByRole("option")).toHaveCount(0)
  await expect(reopened.getByText("没有找到“oldword”")).toBeVisible()
  const requests = await searchCalls(page, "search_vault")
  expect(requests.at(-1)?.request.scope).toBe("public")
})

test("stale results update without another keystroke", async ({ page }) => {
  await page.goto("/")
  await updateSearchIpcMock(page, { indexState: "stale" })
  const palette = await openSearch(page, "oldword")
  await expect(palette).toHaveAttribute("data-search-state", "stale")
  await expect(palette.getByRole("option")).toHaveCount(1)
  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __SHARD_T11_FIXTURE__: IntegrationFixture
    }).__SHARD_T11_FIXTURE__
    fixture.fragments.find((item) => item.id === "public-target")!.content = "公开检索目标 refreshed"
  })
  await updateSearchIpcMock(page, { indexState: "ready" })
  await expect.poll(async () => (await searchCalls(page, "search_vault")).length).toBeGreaterThan(1)
  await expect(palette.getByRole("option")).toHaveCount(0)
  await expect(palette.getByRole("combobox", { name: "搜索内容" })).toHaveValue("oldword")
  await expect(palette).toHaveAttribute("data-search-state", "noResults")
})

test("new search preserves existing scroll and focus invariants", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto("/")
  const composer = page.locator('[data-shard-editor="composer"]')
  const topBefore = (await composer.boundingBox())!.y
  const documentBefore = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)
  const palette = await openSearch(page, "deepneedle")
  await expect(palette.getByRole("combobox", { name: "搜索内容" })).toBeFocused()
  await expect(palette.getByRole("option")).toHaveCount(1)
  await palette.getByRole("option").click()
  const target = page.locator('[data-shard-fragment-id="deep-target"]')
  await expect(target).toBeVisible()
  await expect(target).toBeInViewport()
  await expect(page.getByRole("button", { name: "返回搜索结果" })).toBeVisible()
  const geometry = await target.evaluate((element) => {
    const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
    return {
      documentScroll: document.scrollingElement?.scrollTop ?? 0,
      viewportScroll: viewport?.scrollTop ?? 0,
    }
  })
  expect(geometry.documentScroll).toBe(documentBefore)
  expect(geometry.viewportScroll).toBeGreaterThan(0)
  expect((await composer.boundingBox())!.y).toBe(topBefore)

  await page.getByRole("button", { name: "返回搜索结果" }).click()
  await expect(palette.getByRole("combobox", { name: "搜索内容" })).toBeFocused()
  await expect(palette.getByRole("combobox", { name: "搜索内容" })).toHaveValue("deepneedle")
})
