import { expect, test, type Page } from "@playwright/test"
import { installSearchIpcMock } from "./search-ipc-mock"

interface TestCall { command: string; args: Record<string, unknown> }

async function installCalendarMock(page: Page) {
  await installSearchIpcMock(page)
  await page.addInitScript(() => {
    const now = "2026-09-26T06:18:00.000Z"
    const fragments = [
      {
        id: "memo-fragment",
        path: "fragments/memo-fragment.md",
        content: "- [ ] 交电费 ⏰ 2026-09-25 09:00\n- [x] 取快递 ⏰ 2026-09-25 08:00",
        tags: ["inbox"],
        lockbox: false,
      },
      {
        id: "future-fragment",
        path: "fragments/future-fragment.md",
        content: "买菜\n- [ ] 给妈妈打电话 ⏰ 2026-09-26 19:30",
        tags: ["inbox"],
        lockbox: false,
      },
      {
        id: "lockbox-fragment",
        path: "fragments/lockbox-fragment.md",
        content: "- [ ] 私密 ⏰ 2026-09-25 09:00",
        tags: ["密匣"],
        lockbox: true,
      },
    ].map((fragment) => ({
      ...fragment, createdAt: fragment.id === "memo-fragment" ? "2026-09-25T06:18:00" : now, updatedAt: now, category: null,
      gitStatus: "committed", error: null, archived: false, pinned: false,
    }))
    const git = {
      branch: "main", shortCommit: "abc1234", hasRemote: false,
      status: "ready", error: null, ahead: 0, behind: 0,
    }
    const state = {
      vaultPath: "/tmp/shard-memo-reminder-mock-vault", fragments, git,
      lockbox: { configured: true, unlocked: false, expiresAt: null, ttlSeconds: 900 },
    }
    const tree = {
      entries: [], assets: [], trashEntries: [], fragmentTrashEntries: [],
      fragmentStream: { totalCount: 0, years: [] },
    }
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const calls: TestCall[] = []
    let callbackId = 0
    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_CALENDAR_CALLS__: calls,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++callbackId,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args: clone(args) })
          switch (command) {
            case "plugin:event|listen": return ++callbackId
            case "plugin:event|unlisten":
            case "unhide_pointer":
            case "set_window_controls_hidden":
            case "set_reminder_schedule": return null
            case "plugin:app|version": return "0.1.3"
            case "list_fragments": return clone(state)
            case "list_csv_files":
            case "list_mind_maps": return []
            case "list_library_tree": return clone(tree)
            case "migrate_legacy_notes": return { tree: clone(tree), migratedCount: 0 }
            case "sync_vault": return clone(git)
            case "checkpoint_vault":
              return { status: "no_changes", changes: 0, reason: null, git: clone(git) }
            case "github_cli_status":
              return { installed: true, authenticated: true, login: "shard-test", protocol: "https", error: null }
            case "update_fragment": {
              const fragment = fragments.find((item) => item.id === args.id)
              if (!fragment) throw new Error("Fragment not found")
              fragment.content = String(args.content ?? fragment.content)
              fragment.updatedAt = new Date().toISOString()
              return clone(fragment)
            }
            default: throw new Error(`Unhandled Tauri test command: ${command}`)
          }
        },
      },
    })
  })
}

test.describe("侧栏日历页", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 8, 26, 10, 0))
    await installCalendarMock(page)
    await page.goto("/")
    await page.getByRole("button", { name: /日历/ }).click()
  })

  test("格子内横幅：待办与碎片、到点警示、已完成划线、私有排除与跳转", async ({ page }) => {
    const grid = page.getByRole("grid", { name: "2026年9月" })
    await expect(grid.getByRole("button", { name: "2026-09-26" })).toHaveText("今")
    await expect(grid.getByRole("button", { name: "2026-09-26" })).toHaveAttribute("aria-current", "date")
    // 整页只有月历：底部不再有当日横幅区。
    await expect(page.getByRole("region", { name: /待办与记录/ })).toHaveCount(0)

    const cell = (date: string) => grid.getByRole("gridcell").filter({ has: page.getByRole("button", { name: date, exact: true }) })
    const due = cell("2026-09-25").locator('[data-kind="todo"][data-state="due"]')
    await expect(due).toContainText("交电费")
    await expect(due).toContainText("09:00")
    expect(await due.evaluate((node) => {
      const probe = document.createElement("span")
      probe.style.color = "var(--warning)"
      document.body.append(probe)
      const expected = getComputedStyle(probe).color
      probe.remove()
      return getComputedStyle(node).color === expected
    })).toBe(true)
    const done = cell("2026-09-25").locator('[data-kind="todo"][data-state="done"]')
    await expect(done).toContainText("取快递")
    expect(await done.locator("span").first().evaluate((node) => getComputedStyle(node).textDecorationLine)).toBe("line-through")
    await expect(cell("2026-09-26").locator('[data-kind="todo"][data-state="upcoming"]')).toContainText("给妈妈打电话")
    await expect(cell("2026-09-26").locator('[data-kind="fragment"]')).toContainText("买菜")
    await expect(page.getByText("私密")).toHaveCount(0)

    await cell("2026-09-25").locator('[data-kind="fragment"]').click()
    await expect(page.locator('[data-shard-fragment-id="memo-fragment"]')).toBeVisible()
  })

  test("方向键跨月、冷启动回到捕捉台及折叠头部避让", async ({ page }) => {
    await page.getByRole("grid").getByRole("button", { name: "2026-09-30" }).focus()
    await page.keyboard.press("ArrowRight")
    await expect(page.getByRole("grid", { name: "2026年10月" }).getByRole("button", { name: "2026-10-01" })).toBeFocused()
    // 捕捉门禁（App.tsx）：冷启动固定落在碎片台 composer，不恢复上次空间，日历也不例外。
    await page.reload()
    await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeVisible()
    await expect(page.getByRole("grid", { name: "2026年9月" })).toHaveCount(0)
    await page.getByRole("button", { name: "日历", exact: true }).click()
    await expect(page.getByRole("grid", { name: "2026年9月" })).toBeVisible()
    await page.getByRole("button", { name: "折叠侧边栏" }).click()
    const header = page.locator('header[data-tauri-drag-region="true"]')
    expect(await header.evaluate((node) => {
      const shell = node.closest('[data-sidebar-collapsed="true"]')
      const left = parseFloat(getComputedStyle(node).paddingLeft)
      const required = parseFloat(getComputedStyle(shell!).getPropertyValue("--shard-traffic-light-clearance"))
      return left >= required
    })).toBe(true)
  })
})
