import { expect, test, type Page } from "@playwright/test"

interface LockboxCall {
  args: Record<string, unknown>
  command: string
}

/**
 * 密匣一级空间（信息架构重整第二批 C）：
 * 传送门 = 资料库树上的上锁挂载点；安全区 = 整个密匣空间，离开即上锁。
 */
async function installLockboxSpaceMock(page: Page) {
  await page.addInitScript(() => {
    const now = "2026-08-30T10:00:00.000Z"
    const publicFragments = [
      {
        id: "public-1",
        content: "公开碎片",
        createdAt: "2026-08-30T08:00:00.000Z",
        updatedAt: now,
        tags: ["inbox"],
        category: null,
        path: "fragments/2026/08/20260830-080000.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
    ]
    const lockboxFragments = [
      {
        id: "secret-fragment",
        content: "密匣里的碎片",
        createdAt: "2026-08-29T08:00:00.000Z",
        updatedAt: now,
        tags: ["日记"],
        category: null,
        path: "lockbox/fragments/2026/08/20260829-080000.shard",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: true,
        pinned: false,
        related: [],
      },
      {
        id: "secret-note",
        content: "# 私密计划\n只在密匣可见",
        createdAt: "2026-08-28T08:00:00.000Z",
        updatedAt: now,
        tags: ["note", "私密"],
        category: null,
        path: "lockbox/notes/私密/私密计划.shard",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: true,
        pinned: false,
        related: [],
      },
    ]
    const lockbox = {
      configured: true,
      unlocked: false,
      expiresAt: null as string | null,
      ttlSeconds: 180,
    }
    const git = {
      branch: "main",
      shortCommit: "c2abc12",
      hasRemote: false,
      status: "ready",
      error: null,
      ahead: 0,
      behind: 0,
    }
    const calls: LockboxCall[] = []
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    // 与真实后端一致：上锁时密匣内容根本不出现在 list_fragments 结果里
    const state = () =>
      clone({
        vaultPath: "/tmp/shard-lockbox-space-test",
        fragments: lockbox.unlocked
          ? [...publicFragments, ...lockboxFragments]
          : publicFragments,
        git,
        lockbox,
      })
    const librarySnapshot = () => ({
      entries: [],
      assets: [],
      fragmentStream: {
        totalCount: 1,
        years: [
          { year: "2026", totalCount: 1, months: [{ month: "08", count: 1 }] },
        ],
      },
    })

    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_LOCKBOX_SPACE_CALLS__: calls,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args: clone(args) })
          if (command === "list_fragments") return state()
          if (command === "unlock_lockbox") {
            lockbox.unlocked = true
            return state()
          }
          if (command === "lock_lockbox") {
            lockbox.unlocked = false
            return state()
          }
          if (command === "list_library_tree") return librarySnapshot()
          if (command === "migrate_legacy_notes") {
            return { tree: librarySnapshot(), migratedCount: 0 }
          }
          if (command === "list_mind_maps" || command === "list_csv_files") {
            return []
          }
          if (command === "restore_window_frame") return null
          if (command === "plugin:app|version") return "0.1.3-test"
          if (command === "sync_vault") return clone(git)
          throw new Error(`Unhandled Tauri test command: ${command}`)
        },
      },
    })
  })
}

async function commandCalls(page: Page, command: string) {
  return page.evaluate(
    (target) =>
      (
        globalThis as typeof globalThis & {
          __SHARD_LOCKBOX_SPACE_CALLS__?: LockboxCall[]
        }
      ).__SHARD_LOCKBOX_SPACE_CALLS__?.filter(
        (call) => call.command === target
      ) ?? [],
    command
  )
}

async function unlockThroughPortal(page: Page) {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page
    .getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: "密匣（上锁空间）", exact: true })
    .click()
  await expect(page.getByRole("heading", { name: "解锁密匣" })).toBeVisible()
  await page.getByPlaceholder("密匣密码").fill("correct-password")
  await page.getByRole("button", { name: "解锁", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "密匣", exact: true })
  ).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await installLockboxSpaceMock(page)
})

test("旧的密匣 filter 路由值回退到纯捕捉页", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "shard.workspace-route",
      JSON.stringify({ space: "fragments", params: { filter: "lockbox" } })
    )
  })
  await page.goto("/")

  const sidebarNav = page.getByRole("navigation", { name: "工作台导航" })
  await expect(page.locator('[data-shard-editor="composer"]')).toBeVisible()
  await expect(sidebarNav.getByRole("button", { name: /^收件箱/ })).toHaveCount(0)
  // 侧栏碎片组不再有密匣项
  await expect(
    sidebarNav.getByRole("button", { name: /^密匣/ })
  ).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("shard.workspace-route"))
    )
    .toBe(JSON.stringify({ space: "fragments", params: {} }))
})

test("传送门：从资料库挂载点解锁进入密匣一级空间", async ({ page }) => {
  await page.goto("/")
  await unlockThroughPortal(page)

  // 路由持久化为一级空间，而不是碎片 filter
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("shard.workspace-route"))
    )
    .toBe(JSON.stringify({ space: "lockbox", params: {} }))

  // 笔记住在密匣自己的笔记树里（含子目录），碎片住在碎片流里，互不混排
  const notesTree = page.getByRole("navigation", { name: "密匣笔记" })
  await expect(
    notesTree.getByRole("button", { name: "私密", exact: true })
  ).toBeVisible()
  const noteButton = notesTree.getByRole("button", {
    name: "私密计划",
    exact: true,
  })
  await expect(noteButton).toBeVisible()
  await expect(
    page.locator('[data-shard-fragment-id="secret-fragment"]')
  ).toBeVisible()
  await expect(
    page.locator('[data-shard-fragment-id="secret-note"]')
  ).toHaveCount(0)

  // 点笔记进禅编辑器
  await noteButton.click()
  await expect(page.locator('[data-shard-editor="zen:secret-note"]')).toBeVisible()
})

test("离开密匣空间立即上锁，手动上锁送回资料库", async ({ page }) => {
  await page.goto("/")
  await unlockThroughPortal(page)

  // 手动上锁：回到传送门所在的资料库
  await page.getByRole("button", { name: "上锁", exact: true }).click()
  await expect.poll(() => commandCalls(page, "lock_lockbox")).toHaveLength(1)
  await expect(
    page.getByRole("complementary", { name: "资料库目录" })
  ).toBeVisible()

  // 再次进入需要重新解锁（安全区不残留会话）
  await unlockThroughPortal(page)

  // 切到碎片空间 = 离开安全区，自动上锁
  await page
    .getByRole("navigation", { name: "工作台导航" })
    .getByRole("button", { name: "碎片", exact: true })
    .click()
  await expect.poll(() => commandCalls(page, "lock_lockbox")).toHaveLength(2)
  await expect(
    page.locator('[data-shard-fragment-id="secret-fragment"]')
  ).toHaveCount(0)
})
