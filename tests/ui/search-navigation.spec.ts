import { expect, test, type Page } from "@playwright/test"

import { fillEditor, readEditor } from "./editor-helpers"
import { installSearchIpcMock, updateSearchIpcMock } from "./search-ipc-mock"

interface NavigationFixture {
  calls: Array<{ args: Record<string, unknown>; command: string }>
  failNextUpdate: boolean
  fragments: Array<{
    id: string
    content: string
    updatedAt: string
    archived: boolean
    lockbox: boolean
    path: string
  }>
}

async function installNavigationFixture(page: Page) {
  await installSearchIpcMock(page)
  await page.addInitScript(() => {
    const now = "2026-09-25T08:00:00.000Z"
    const fragments = [
      fragment("source", "待保存源片段", "fragments/source.md", ["inbox"]),
      fragment("note-a", "# Alpha 搜索目标\n\n旧正文 needle", "notes/alpha.md", ["inbox", "note"]),
      fragment("note-b", "# Beta 搜索目标\n\n第二正文 needle", "notes/beta.md", ["inbox", "note"]),
      { ...fragment("archived", "# Archived 搜索目标\n\n归档正文 needle", ".trash/notes/archived.md", ["inbox", "note"]), archived: true },
      { ...fragment("private", "# Private 搜索目标\n\n密匣正文 needle", "lockbox/notes/private.shard", ["inbox", "note"]), lockbox: true },
    ]
    const git = {
      branch: "main", shortCommit: "t08test", hasRemote: false,
      status: "ready", error: null, ahead: 0, behind: 0,
    }
    const lockbox = {
      configured: true,
      unlocked: false,
      expiresAt: null,
      ttlSeconds: 900,
    }
    const tree = {
      entries: fragments.filter((item) => !item.archived && !item.lockbox && item.tags.includes("note")).map((item) => ({
        name: `${item.id}.md`, path: item.path, kind: "markdown", size: item.content.length, modifiedAt: item.updatedAt,
      })),
      assets: [],
      trashEntries: [],
      fragmentTrashEntries: [],
      fragmentStream: { totalCount: fragments.length, years: [] },
    }
    const fixture: NavigationFixture = { calls: [], failNextUpdate: false, fragments }
    const clone = <T,>(value: T): T => structuredClone(value)
    const state = () => ({
      vaultPath: "/tmp/shard-search-navigation",
      fragments: clone(fragments),
      git: clone(git),
      lockbox: clone(lockbox),
    })
    let callbackId = 0
    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_T08_FIXTURE__: fixture,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: () => ++callbackId,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          fixture.calls.push({ command, args: clone(args) })
          switch (command) {
            case "plugin:event|listen": return ++callbackId
            case "plugin:event|unlisten":
            case "unhide_pointer":
            case "set_window_controls_hidden": return null
            case "plugin:app|version": return "0.1.3-test"
            case "list_fragments": return state()
            case "list_library_tree": return clone(tree)
            case "migrate_legacy_notes": return { tree: clone(tree), migratedCount: 0 }
            case "list_mind_maps":
            case "list_csv_files":
            case "list_diagram_documents": return []
            case "update_fragment": {
              if (fixture.failNextUpdate) {
                fixture.failNextUpdate = false
                throw new Error("T08 save failed")
              }
              const target = fragments.find((item) => item.id === args.id)
              if (!target) throw new Error("Fragment not found")
              target.content = String(args.content ?? target.content)
              target.tags = Array.isArray(args.tags) ? args.tags as string[] : target.tags
              target.updatedAt = "2026-09-25T09:00:00.000Z"
              return clone(target)
            }
            case "unlock_lockbox":
              lockbox.unlocked = true
              lockbox.expiresAt = "2026-09-25T12:00:00.000Z"
              return state()
            case "lock_lockbox":
              lockbox.unlocked = false
              lockbox.expiresAt = null
              return state()
            case "sync_vault": return clone(git)
            case "checkpoint_vault": return { status: "noop", git: clone(git) }
            default: throw new Error(`Unhandled T08 command: ${command}`)
          }
        },
      },
    })

    function fragment(id: string, content: string, path: string, tags: string[]) {
      return {
        id, content, createdAt: now, updatedAt: now, tags, category: null, path,
        gitStatus: "committed", error: null, aiStatus: "none", archived: false,
        lockbox: false, pinned: false, related: [],
      }
    }
  })
}

async function openSearch(page: Page, query = "搜索目标") {
  await page.keyboard.press("Control+k")
  await page.getByRole("combobox", { name: "搜索内容" }).fill(query)
  await expect(page.getByRole("option")).not.toHaveCount(0)
}

async function selectResult(page: Page, name: RegExp) {
  await page.getByRole("option", { name }).click()
}

async function fixture(page: Page) {
  return page.evaluate(() => structuredClone((globalThis as typeof globalThis & {
    __SHARD_T08_FIXTURE__: NavigationFixture
  }).__SHARD_T08_FIXTURE__))
}

async function setFixture(page: Page, patch: Partial<Pick<NavigationFixture, "failNextUpdate">>) {
  await page.evaluate((next) => Object.assign((globalThis as typeof globalThis & {
    __SHARD_T08_FIXTURE__: NavigationFixture
  }).__SHARD_T08_FIXTURE__, next), patch)
}

test("save_failure_keeps_session_and_does_not_record_recent", async ({ page }) => {
  await installNavigationFixture(page)
  await page.goto("/")
  const card = page.locator('[data-shard-fragment-id="source"]')
  await card.getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click()
  await fillEditor(page, "fragment:source", "未保存的 T08 草稿")
  await setFixture(page, { failNextUpdate: true })

  await openSearch(page)
  await page.getByRole("option", { name: /Alpha 搜索目标/ }).click()

  await expect(page.getByRole("dialog", { name: "搜索" })).toBeVisible()
  await expect(page.getByRole("dialog", { name: "搜索" })).toHaveAttribute("data-search-pending", "false")
  expect((await fixture(page)).calls.filter(({ command }) => command === "update_fragment")).toHaveLength(1)
  const nativeCalls = await page.evaluate(() => (globalThis as typeof globalThis & {
    __SHARD_SEARCH_IPC_MOCK__: { calls: Array<{ command: string }> }
  }).__SHARD_SEARCH_IPC_MOCK__.calls)
  expect(nativeCalls.filter(({ command }) => command === "read_search_target")).toHaveLength(0)
  expect(await page.evaluate(() => localStorage.getItem("shard.recent./tmp/shard-search-navigation"))).toBeNull()
})

test("only_latest_navigation_can_ack", async ({ page }) => {
  await installNavigationFixture(page)
  await page.goto("/")
  await openSearch(page)
  await updateSearchIpcMock(page, { delayMs: 250 })
  await selectResult(page, /Alpha 搜索目标/)
  await selectResult(page, /Beta 搜索目标/)

  await expect(page.getByRole("heading", { name: "Beta 搜索目标" })).toBeVisible()
  const recent = await page.evaluate(() => JSON.parse(localStorage.getItem("shard.recent./tmp/shard-search-navigation") ?? "[]"))
  expect(recent).toHaveLength(1)
  expect(recent[0].key).toContain("notes/beta.md")
})

test("navigation_is_not_consumed_before_ready", async ({ page }) => {
  await installNavigationFixture(page)
  await page.goto("/")
  await openSearch(page)
  await updateSearchIpcMock(page, { delayMs: 300 })
  await selectResult(page, /Alpha 搜索目标/)
  await selectResult(page, /Alpha 搜索目标/)

  const dialog = page.getByRole("dialog", { name: "搜索" })
  await expect(dialog).toHaveAttribute("data-search-pending", "true")
  expect(await page.evaluate(() => localStorage.getItem("shard.recent./tmp/shard-search-navigation"))).toBeNull()
  await expect(dialog).toBeHidden()
  await expect(page.getByText("2 / 2", { exact: false })).toBeVisible()
  const reads = await page.evaluate(() => (globalThis as typeof globalThis & {
    __SHARD_SEARCH_IPC_MOCK__: { calls: Array<{ command: string }> }
  }).__SHARD_SEARCH_IPC_MOCK__.calls.filter((call) => call.command === "read_search_target"))
  expect(reads).toHaveLength(1)
})

test("read_current_revision_before_reveal", async ({ page }) => {
  await installNavigationFixture(page)
  await page.goto("/")
  await openSearch(page)
  await page.evaluate(() => {
    const target = (globalThis as typeof globalThis & { __SHARD_T08_FIXTURE__: NavigationFixture })
      .__SHARD_T08_FIXTURE__.fragments.find((item) => item.id === "note-a")!
    target.content = "# Alpha 搜索目标\n\n打开时的新 revision 正文"
    target.updatedAt = "2026-09-25T10:00:00.000Z"
  })
  await selectResult(page, /Alpha 搜索目标/)

  await expect.poll(() => readEditor(page, "library:note-a")).toContain("打开时的新 revision 正文")
  const reads = await page.evaluate(() => (globalThis as typeof globalThis & {
    __SHARD_SEARCH_IPC_MOCK__: { calls: Array<{ command: string; request: Record<string, unknown> }> }
  }).__SHARD_SEARCH_IPC_MOCK__.calls.filter((call) => call.command === "read_search_target"))
  expect(reads).toHaveLength(1)
  expect(reads[0].request.expectedRevision).toBe("2026-09-25T08:00:00.000Z")
})

test("same_id_refreshed_document_uses_new_content", async ({ page }) => {
  await installNavigationFixture(page)
  await page.goto("/")
  await openSearch(page)
  await selectResult(page, /Alpha 搜索目标/)
  await expect.poll(() => readEditor(page, "library:note-a")).toContain("旧正文")

  await page.getByRole("button", { name: "返回搜索结果" }).click()
  await page.evaluate(() => {
    const target = (globalThis as typeof globalThis & { __SHARD_T08_FIXTURE__: NavigationFixture })
      .__SHARD_T08_FIXTURE__.fragments.find((item) => item.id === "note-a")!
    target.content = "# Alpha 搜索目标\n\n同 ID 的刷新正文"
    target.updatedAt = "2026-09-25T11:00:00.000Z"
  })
  await selectResult(page, /Alpha 搜索目标/)
  await expect.poll(() => readEditor(page, "library:note-a")).toContain("同 ID 的刷新正文")
})

test("archived note opens read only without entering global fragment list", async ({ page }) => {
  await installNavigationFixture(page)
  await page.goto("/")
  await page.keyboard.press("Control+k")
  await page.getByRole("button", { name: "包含回收站" }).click()
  await page.getByRole("combobox", { name: "搜索内容" }).fill("Archived 搜索目标")
  await selectResult(page, /Archived 搜索目标/)

  await expect(page.locator('[data-shard-editor="library:archived"] .ProseMirror')).toHaveAttribute("contenteditable", "false")
  await expect(page.locator('[data-shard-fragment-id="archived"]')).toHaveCount(0)
  await expect(page.getByText("只读", { exact: true })).toHaveText("只读")
  await expect(page.getByRole("button", { name: "重命名文件" })).toBeDisabled()
})

test("lockbox result remains inside lockbox space", async ({ page }) => {
  await installNavigationFixture(page)
  await page.goto("/")
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: "密匣（上锁空间）", exact: true }).click()
  const gate = page.getByRole("form", { name: "解锁密匣" })
  await gate.getByPlaceholder("密匣密码").fill("correct-password")
  await gate.getByRole("button", { name: "解锁", exact: true }).click()
  await expect(page.getByRole("heading", { name: "密匣", exact: true })).toBeVisible()
  await openSearch(page, "Private 搜索目标")
  await selectResult(page, /Private 搜索目标/)
  await expect(page.locator('[data-shard-editor="zen:private"]')).toBeVisible()
  await page.getByRole("button", { name: "退出编辑" }).click()
  await expect(page.getByRole("heading", { name: "密匣", exact: true })).toBeVisible()
})

test("result navigation and in-document hit navigation are distinct", async ({ page }) => {
  await installNavigationFixture(page)
  await page.goto("/")
  await openSearch(page)
  await selectResult(page, /Beta 搜索目标/)
  await expect(page.getByText("1 / 2", { exact: false })).toBeVisible()
  await expect(page.getByRole("button", { name: "下一个搜索结果" })).toBeVisible()
  await expect(page.getByRole("button", { name: "当前文档下一个命中" })).toHaveCount(0)

  await page.keyboard.press("Control+g")
  await expect(page.getByText("1 / 2", { exact: false })).toBeVisible()
  await page.getByRole("button", { name: "下一个搜索结果" }).click()
  await expect(page.getByRole("heading", { name: "Alpha 搜索目标" })).toBeVisible()
  await expect(page.getByText("2 / 2", { exact: false })).toBeVisible()
})
