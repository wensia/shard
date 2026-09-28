import { expect, test, type Page } from "@playwright/test"
import { installSearchIpcMock } from "./search-ipc-mock"
import { readEditor, selectEditorText, typeEditor } from "./editor-helpers"

interface LockboxCall {
  args: Record<string, unknown>
  command: string
}

/**
 * 密匣一级空间（信息架构重整第二批 C）：
 * 传送门 = 资料库树上的上锁挂载点；安全区 = 整个密匣空间，离开即上锁。
 */
async function installLockboxSpaceMock(page: Page) {
  await installSearchIpcMock(page)
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
        content: "密匣里的碎片\\\n\\\n呼吸也不顺畅",
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
      trashEntries: [],
      fragmentTrashEntries: [],
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
          if (command === "update_fragment") {
            const fragment = lockboxFragments.find(item => item.id === args.id)
            if (!fragment) throw new Error("Fragment not found")
            fragment.content = String(args.content ?? fragment.content)
            return clone(fragment)
          }
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
  // 推门先落进上锁的一级空间，解锁就在主体区完成，全程无弹窗；
  // 上锁态整页只有解锁面板，头部标题条要等解锁后才出现
  await expect(
    page.getByRole("heading", { name: "密匣已上锁", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "密匣", exact: true })
  ).toHaveCount(0)
  await expect(page.getByRole("dialog")).toHaveCount(0)
  const gate = page.getByRole("form", { name: "解锁密匣" })
  await gate.getByPlaceholder("密匣密码").fill("correct-password")
  await gate.getByRole("button", { name: "解锁", exact: true }).click()
  await expect(gate).toHaveCount(0)
  await expect(page.getByRole("dialog")).toHaveCount(0)
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

test("解锁密码框：text-security 遮蔽生效，大写提示走图标规范", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page
    .getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: "密匣（上锁空间）", exact: true })
    .click()
  // 推门先落上锁页，密码框直接在主体区
  const gate = page.getByRole("form", { name: "解锁密匣" })
  await expect(gate).toBeVisible()

  const input = gate.getByPlaceholder("密匣密码")
  // 安全线：密码框刻意不是 type="password"（那会让 WKWebView 画出关不掉的
  // 实底 Caps Lock 指示器），遮蔽改由 text-security 承担——一旦这条 CSS 或
  // data 属性丢了，密码就会明文显示，所以在这里守住。
  await expect(input).toHaveAttribute("type", "text")
  await expect(input).toHaveAttribute("data-shard-password", "true")
  await expect(input).toHaveAttribute("autocomplete", "off")
  const security = await input.evaluate(
    (el) => getComputedStyle(el).webkitTextSecurity
  )
  expect(security).toBe("disc")

  // 合成带 CapsLock 修饰态的按键，规范内的细线 ⇪ 提示应出现
  await input.evaluate((el) => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        key: "a",
        modifierCapsLock: true,
      })
    )
  })
  const hint = page.getByRole("status").filter({ hasText: "大写锁定已开启" })
  await expect(hint).toBeVisible()
  const metrics = await hint
    .locator("svg")
    .evaluate((svg) => {
      const cs = getComputedStyle(svg)
      return { width: cs.width, stroke: cs.strokeWidth }
    })
  expect(metrics.width).toBe("14px")
  expect(["1.5px", "1.75px"]).toContain(metrics.stroke)
})

test("密匣页内可原路返回资料库，上锁与解锁态都有出口", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page
    .getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: "密匣（上锁空间）", exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: "密匣已上锁", exact: true })
  ).toBeVisible()

  // 上锁态：面板上方的返回按钮直接回资料库，不必绕去侧栏
  const back = page.getByRole("button", { name: "返回资料库", exact: true })
  await back.click()
  await expect(
    page.getByRole("complementary", { name: "资料库目录" })
  ).toBeVisible()

  // 解锁后头部同样留着出口
  await unlockThroughPortal(page)
  await back.click()
  await expect(
    page.getByRole("complementary", { name: "资料库目录" })
  ).toBeVisible()
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

test("密匣卡片隐藏硬换行标记，编辑保存后仍保留空行", async ({ page }) => {
  await page.goto("/")
  await unlockThroughPortal(page)
  const target = page.locator('[data-shard-fragment-id="secret-fragment"]')
  const body = target.locator(".shard-fragment-card-content")
  await expect(body).toHaveText("密匣里的碎片\n\n呼吸也不顺畅")
  await target.getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click()
  const editorId = "fragment:secret-fragment"
  const editor = page.locator(`[data-shard-editor="${editorId}"] .ProseMirror`)
  await expect(editor).toBeVisible()
  await expect(editor).not.toContainText("\\")
  expect(await readEditor(page, editorId)).toBe("密匣里的碎片\\\n\\\n呼吸也不顺畅")
  await selectEditorText(page, editorId, "顺畅", { collapse: "end" })
  await typeEditor(page, editorId, "！")
  await page.getByRole("heading", { name: "密匣", exact: true }).click()
  await expect.poll(async () => (await commandCalls(page, "update_fragment")).at(-1)?.args.content)
    .toBe("密匣里的碎片\\\n\\\n呼吸也不顺畅！")
  await expect(body).toHaveText("密匣里的碎片\n\n呼吸也不顺畅！")
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
