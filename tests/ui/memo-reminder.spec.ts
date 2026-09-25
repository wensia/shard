import { expect, test, type Page } from "@playwright/test"

import { fillEditor, readEditor } from "./editor-helpers"
import { installSearchIpcMock } from "./search-ipc-mock"

interface TestCall {
  command: string
  args: Record<string, unknown>
}

const COMPOSER = '[data-shard-editor="composer"]'
const INLINE = '[data-shard-editor="fragment:memo-fragment"]'

// 固定「现在」：快捷项与到点判定都按 2026-09-25 10:00（本地时间）计算。
const NOW = new Date(2026, 8, 25, 10, 0)

// Exercise the real workbench route with an in-memory vault; no user's files are written.
async function installReminderMock(page: Page) {
  await installSearchIpcMock(page)
  await page.addInitScript(() => {
    const now = "2026-09-10T08:00:00.000Z"
    const fragments = [
      {
        id: "memo-fragment",
        path: "fragments/memo-fragment.md",
        content: "- [ ] 买菜 ⏰ 2026-09-20 09:00\n  番茄、鸡蛋",
        tags: ["inbox"],
        lockbox: false,
      },
      {
        id: "future-fragment",
        path: "fragments/future-fragment.md",
        content: "- [ ] 以后 ⏰ 2026-10-01 09:00\n- [x] 已完成 ⏰ 2026-09-01 09:00",
        tags: ["inbox"],
        lockbox: false,
      },
      {
        id: "lockbox-fragment",
        path: "fragments/lockbox-fragment.md",
        content: "- [ ] 私密 ⏰ 2026-09-20 09:00",
        tags: ["密匣"],
        lockbox: true,
      },
    ].map((fragment) => ({
      ...fragment, createdAt: now, updatedAt: now, category: null,
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
      __SHARD_REMINDER_CALLS__: calls,
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

async function scheduleCalls(page: Page) {
  return page.evaluate(() => {
    const calls = (globalThis as typeof globalThis & { __SHARD_REMINDER_CALLS__: TestCall[] })
      .__SHARD_REMINDER_CALLS__
    return calls
      .filter((call) => call.command === "set_reminder_schedule")
      .map((call) => call.args.dueAt as number[])
  })
}

test.describe("备忘卡片提醒", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(NOW)
    await installReminderMock(page)
    await page.goto("/")
    await expect(page.locator(`${COMPOSER} .ProseMirror`)).toBeFocused()
  })

  test("启动后推送未勾选、非密匣的提醒时间，已过期的也在内", async ({ page }) => {
    await expect.poll(() => scheduleCalls(page)).toContainEqual([
      new Date(2026, 8, 20, 9, 0).getTime(),
      new Date(2026, 9, 1, 9, 0).getTime(),
    ])
  })

  test("铃铛快捷项写入 ⏰，芯片清除后回到原文", async ({ page }) => {
    await fillEditor(page, "composer", "- [ ] 买菜\n  番茄")
    const composer = page.locator(COMPOSER)
    await composer.getByRole("button", { name: "设置提醒", exact: true }).click()
    await page.getByRole("button", { name: "明天 09:00", exact: true }).click()
    await expect.poll(() => readEditor(page, "composer")).toBe("- [ ] 买菜 ⏰ 2026-09-26 09:00\n  番茄")

    const chip = composer.locator(".shard-rich-reminder")
    await expect(chip).toHaveText("9月26日 09:00")
    await expect(chip).toHaveAttribute("title", "提醒：2026-09-26 09:00")
    await expect(chip).not.toHaveAttribute("data-due", "true")
    // 芯片替换铃铛占据右侧控件位，标题正文里不再有芯片。
    await expect(composer.locator(".shard-rich-task-reminder-slot .shard-rich-reminder")).toHaveCount(1)
    await expect(composer.locator(".shard-rich-task-body .shard-rich-reminder")).toHaveCount(0)
    await expect(composer.getByRole("button", { name: "设置提醒", exact: true })).toHaveCount(0)

    await chip.click()
    await page.getByRole("button", { name: "清除提醒", exact: true }).click()
    await expect.poll(() => readEditor(page, "composer")).toBe("- [ ] 买菜\n  番茄")
    await expect(composer.locator(".shard-rich-reminder")).toHaveCount(0)
    await expect(composer.getByRole("button", { name: "设置提醒", exact: true })).toHaveCount(1)
  })

  test("自定义日期与时间在同一个对话框里选完再确定", async ({ page }) => {
    await fillEditor(page, "composer", "- [ ] 开会\n  带电脑")
    await page.locator(COMPOSER).getByRole("button", { name: "设置提醒", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "设置提醒", exact: true })
    const summary = dialog.locator('[data-slot="picker-summary"]')
    await expect(dialog).toBeVisible()
    await expect(summary).toHaveText(/提醒时间\s*选择日期和时间/)
    await expect(dialog.getByRole("button", { name: "确定", exact: true })).toBeDisabled()
    await expect(dialog.getByRole("button", { name: "清除提醒", exact: true })).toBeDisabled()
    // 日历、时间列直接内嵌：不再有第二层日期 / 时间浮层。
    await expect(page.locator('[data-slot="date-picker-content"], [data-slot="time-picker-content"]')).toHaveCount(0)
    await expect(dialog.getByRole("button", { name: "2026-09-25", exact: true })).toHaveAttribute("aria-pressed", "true")

    await dialog.getByRole("button", { name: "2026-09-30", exact: true }).click()
    await expect(summary).toHaveText(/提醒时间\s*2026-09-30 --:--/)
    await dialog.getByRole("group", { name: "小时" }).getByRole("button", { name: "14", exact: true }).click()
    await expect(summary).toHaveText(/2026-09-30 14:--/)
    await expect(dialog.getByRole("button", { name: "确定", exact: true })).toBeDisabled()
    await dialog.getByRole("group", { name: "分钟" }).getByRole("button", { name: "30", exact: true }).click()
    await expect(dialog).toBeVisible()
    await expect(summary).toHaveText(/2026-09-30 14:30/)

    await dialog.getByRole("button", { name: "确定", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => readEditor(page, "composer")).toBe("- [ ] 开会 ⏰ 2026-09-30 14:30\n  带电脑")

    // 再次打开从当前值初始化；取消不写入。
    await page.locator(COMPOSER).locator(".shard-rich-reminder").click()
    await expect(summary).toHaveText(/2026-09-30 14:30/)
    await expect(dialog.getByRole("group", { name: "分钟" }).getByRole("button", { name: "30", exact: true })).toHaveAttribute("aria-pressed", "true")
    await dialog.getByRole("button", { name: "2026-10-01", exact: true }).click()
    await dialog.getByRole("button", { name: "取消", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => readEditor(page, "composer")).toBe("- [ ] 开会 ⏰ 2026-09-30 14:30\n  带电脑")
  })

  test("行内编辑：过期芯片警示，打开弹层不触发失焦提交", async ({ page }) => {
    await page.locator('[data-shard-fragment-id="memo-fragment"]')
      .getByRole("button", { name: "片段操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "编辑", exact: true }).click()
    const editor = page.locator(INLINE)
    await expect(editor.locator(".ProseMirror")).toBeVisible()

    const chip = editor.locator(".shard-rich-reminder")
    await expect(chip).toHaveAttribute("data-due", "true")
    const warning = await chip.evaluate((node) => {
      const probe = document.createElement("span")
      probe.style.color = "var(--warning)"
      document.body.append(probe)
      const expected = getComputedStyle(probe).color
      probe.remove()
      return { actual: getComputedStyle(node).color, expected }
    })
    expect(warning.actual).toBe(warning.expected)

    await editor.getByRole("button", { name: /^修改提醒/ }).click()
    const dialog = page.getByRole("dialog", { name: "设置提醒", exact: true })
    await dialog.getByRole("button", { name: "2026-09-29", exact: true }).click()
    await expect(editor.locator(".ProseMirror")).toBeVisible()
    // 点遮罩关闭：卡片不失焦提交、编辑态保留。
    await page.mouse.click(4, 4)
    await expect(dialog).toHaveCount(0)
    await expect(editor.locator(".ProseMirror")).toBeVisible()
    // 「取消」与 Escape 同样只关对话框。
    await editor.getByRole("button", { name: /^修改提醒/ }).click()
    await dialog.getByRole("button", { name: "取消", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await editor.getByRole("button", { name: /^修改提醒/ }).click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(editor.locator(".ProseMirror")).toBeVisible()
    await editor.getByRole("button", { name: /^修改提醒/ }).click()
    await dialog.getByRole("button", { name: "今天 18:00", exact: true }).click()
    await expect(editor.locator(".ProseMirror")).toBeVisible()
    await expect.poll(() => readEditor(page, "fragment:memo-fragment"))
      .toBe("- [ ] 买菜 ⏰ 2026-09-25 18:00\n  番茄、鸡蛋")
    await expect(chip).not.toHaveAttribute("data-due", "true")
  })
})
