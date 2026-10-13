import { expect, test, type Page } from "@playwright/test"

import { fillEditor, readEditor } from "./editor-helpers"
import { installSearchIpcMock } from "./search-ipc-mock"

interface ShortcutControl {
  calls: Array<{ command: string; args: Record<string, unknown> }>
  failNextSave: boolean
  holdNextSave: boolean
  releaseSave: (() => void) | null
}

async function installShortcutMock(page: Page, options: { lockbox?: boolean } = {}) {
  await installSearchIpcMock(page)
  await page.addInitScript(({ withLockbox }) => {
    const stamp = "2026-09-10T08:00:00.000Z"
    const fragment = (id: string, content: string, path: string, tags: string[], lockbox = false) => ({
      id, content, path, tags, lockbox, createdAt: stamp, updatedAt: stamp,
      fileSha: `${id}-sha`, category: null, gitStatus: "committed", error: null,
      archived: false, pinned: false, related: [],
    })
    const publicFragment = fragment("public", "公开碎片", "fragments/public.md", ["inbox"])
    const note = fragment("note", "# 测试笔记\n原文", "notes/测试笔记.md", ["inbox", "note"])
    const secret = fragment("secret", "私密碎片", "lockbox/fragments/secret.shard", ["私密"], true)
    const git = { branch: "main", shortCommit: "abc1234", hasRemote: false,
      status: "ready", error: null, ahead: 0, behind: 0 }
    const lockbox = { configured: withLockbox, unlocked: false,
      expiresAt: null as string | null, ttlSeconds: 180 }
    const control: ShortcutControl = {
      calls: [], failNextSave: false, holdNextSave: false, releaseSave: null,
    }
    const clone = <T,>(value: T): T => structuredClone(value)
    const tree = () => ({
      entries: [{ name: "测试笔记.md", path: note.path, kind: "markdown", size: 0, modifiedAt: stamp }],
      assets: [], trashEntries: [], fragmentTrashEntries: [],
      fragmentStream: { totalCount: 1, years: [] },
    })
    const state = () => ({
      vaultPath: "/tmp/shard-workspace-shortcuts-test",
      fragments: [...[publicFragment, note], ...(lockbox.unlocked ? [secret] : [])],
      git, lockbox,
    })
    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_SHORTCUT_CONTROL__: control,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          control.calls.push({ command, args: clone(args) })
          if (command === "list_fragments") return clone(state())
          if (command === "list_library_tree") return clone(tree())
          if (command === "migrate_legacy_notes") return { tree: clone(tree()), migratedCount: 0 }
          if (command === "list_mind_maps" || command === "list_csv_files") return []
          if (command === "sync_vault") return clone(git)
          if (command === "plugin:app|version") return "0.1.3-test"
          if (command === "unlock_lockbox") { lockbox.unlocked = true; return clone(state()) }
          if (command === "lock_lockbox") { lockbox.unlocked = false; return clone(state()) }
          if (command === "update_fragment") {
            if (control.holdNextSave) {
              control.holdNextSave = false
              await new Promise<void>(resolve => { control.releaseSave = resolve })
            }
            if (control.failNextSave) {
              control.failNextSave = false
              throw new Error("测试保存失败")
            }
            note.content = String(args.content ?? note.content)
            note.fileSha = `${note.id}-saved-${control.calls.length}`
            return clone(note)
          }
          if (command === "checkpoint_vault") return { status: "no_changes", changes: 0, reason: null, git: clone(git) }
          throw new Error(`Unhandled Tauri test command: ${command}`)
        },
      },
    })
  }, { withLockbox: options.lockbox ?? false })
}

async function boot(page: Page, options: { lockbox?: boolean } = {}) {
  await installShortcutMock(page, options)
  await page.goto("/")
  await expect(page.getByRole("navigation", { name: "工作台导航" })).toBeVisible()
  await expect.poll(() => route(page)).toBe(expectedRoute("fragments"))
}

const route = (page: Page) => page.evaluate(() => localStorage.getItem("shard.workspace-route"))
const expectedRoute = (space: string) => JSON.stringify({ space, params: {} })
const calls = (page: Page, command: string) => page.evaluate((target) =>
  (globalThis as typeof globalThis & { __SHARD_SHORTCUT_CONTROL__: ShortcutControl })
    .__SHARD_SHORTCUT_CONTROL__.calls.filter(call => call.command === target), command)
const updates = (page: Page) => calls(page, "update_fragment")

async function openNote(page: Page) {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: /^文件（/u }).click()
  await page.getByRole("region", { name: "notes 目录列表" })
    .getByRole("button", { name: "打开文件 测试笔记.md" }).click()
  await expect(page.locator('[data-shard-editor="library:note"]')).toBeVisible()
}

test("⌘1/2/3 切到固定空间，同空间不清理现场，折叠后仍有效", async ({ page }) => {
  await boot(page)
  await page.keyboard.press("ControlOrMeta+2")
  await expect.poll(() => route(page)).toBe(expectedRoute("calendar"))
  await page.keyboard.press("ControlOrMeta+3")
  await expect.poll(() => route(page)).toBe(expectedRoute("library"))
  await page.keyboard.press("ControlOrMeta+1")
  await expect.poll(() => route(page)).toBe(expectedRoute("fragments"))
  await expect(page.locator("html")).toHaveAttribute("data-focus-mode", "keyboard")
  await expect.poll(() => page.evaluate(() =>
    document.activeElement?.closest("[data-focus-region]")?.getAttribute("data-focus-region")))
    .toBe("content")

  await page.getByRole("button", { name: "折叠侧边栏" }).click()
  await page.keyboard.press("ControlOrMeta+2")
  await expect.poll(() => route(page)).toBe(expectedRoute("calendar"))
  await expect(page.getByRole("button", { name: "展开侧边栏" })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+2")
  await expect(page.getByRole("button", { name: "展开侧边栏" })).toBeVisible()
})

test("未注册数字和带 Shift / Alt 的组合保持当前空间", async ({ page }) => {
  await boot(page)
  for (const shortcut of ["ControlOrMeta+4", "ControlOrMeta+9", "ControlOrMeta+Shift+1", "ControlOrMeta+Alt+1"]) {
    await page.keyboard.press(shortcut)
    expect(await route(page)).toBe(expectedRoute("fragments"))
  }
})

test("资料库正文草稿保存后切换；保存失败时保留路由与草稿", async ({ page }) => {
  await boot(page)
  await openNote(page)
  await fillEditor(page, "library:note", "# 待保存的正文")
  await page.locator('[data-shard-editor="library:note"] .ProseMirror').focus()
  await page.keyboard.press("ControlOrMeta+2")
  await expect.poll(() => route(page)).toBe(expectedRoute("calendar"))
  await expect.poll(() => updates(page)).toHaveLength(1)

  await openNote(page)
  await fillEditor(page, "library:note", "# 保存失败仍在编辑")
  await page.locator('[data-shard-editor="library:note"] .ProseMirror').focus()
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __SHARD_SHORTCUT_CONTROL__: ShortcutControl })
      .__SHARD_SHORTCUT_CONTROL__.failNextSave = true
  })
  await page.keyboard.press("ControlOrMeta+1")
  await expect.poll(() => updates(page)).toHaveLength(2)
  expect(await route(page)).toBe(expectedRoute("library"))
  expect(await readEditor(page, "library:note")).toBe("# 保存失败仍在编辑")
})

test("速记框草稿切空间后保留", async ({ page }) => {
  await boot(page)
  await fillEditor(page, "composer", "尚未提交的速记")
  await page.locator('[data-shard-editor="composer"] .ProseMirror').focus()
  await page.keyboard.press("ControlOrMeta+2")
  await expect.poll(() => route(page)).toBe(expectedRoute("calendar"))
  await page.keyboard.press("ControlOrMeta+1")
  await expect.poll(() => readEditor(page, "composer")).toBe("尚未提交的速记")
})

test("资料库重命名输入聚焦时不切空间", async ({ page }) => {
  await boot(page)
  await openNote(page)
  await page.getByRole("button", { name: "重命名文件", exact: true }).click()
  const input = page.getByRole("textbox", { name: "重命名名称", exact: true })
  await expect(input).toBeFocused()
  const before = await input.inputValue()
  await page.keyboard.press("ControlOrMeta+2")
  expect(await route(page)).toBe(expectedRoute("library"))
  await expect(input).toHaveValue(before)
})

test("表格单元格编辑标记存在时不切空间且输入保留", async ({ page }) => {
  await boot(page)
  await page.evaluate(() => {
    const overlay = document.createElement("div")
    overlay.className = "table-cell-overlay"
    const input = document.createElement("textarea")
    input.setAttribute("aria-label", "编辑单元格")
    input.setAttribute("data-focus-editor", "")
    input.value = "编辑中的单元格"
    overlay.append(input)
    document.body.append(overlay)
    input.focus()
  })
  const cell = page.getByRole("textbox", { name: "编辑单元格" })
  await expect(cell).toBeFocused()
  await page.keyboard.press("ControlOrMeta+2")
  expect(await route(page)).toBe(expectedRoute("fragments"))
  await expect(cell).toHaveValue("编辑中的单元格")
})

test("围栏表格编辑输入聚焦时不切空间", async ({ page }) => {
  await boot(page)
  await page.evaluate(() => {
    const input = document.createElement("input")
    input.setAttribute("data-datatable-row", "0")
    input.setAttribute("aria-label", "围栏表格单元格")
    input.value = "围栏草稿"
    document.body.append(input)
    input.focus()
  })
  const cell = page.getByRole("textbox", { name: "围栏表格单元格" })
  await expect(cell).toBeFocused()
  await page.keyboard.press("ControlOrMeta+2")
  expect(await route(page)).toBe(expectedRoute("fragments"))
  await expect(cell).toHaveValue("围栏草稿")
})

test("保存延迟时连按 ⌘2、⌘3，只执行先到的导航", async ({ page }) => {
  await boot(page)
  await openNote(page)
  await fillEditor(page, "library:note", "# 延迟保存")
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __SHARD_SHORTCUT_CONTROL__: ShortcutControl })
      .__SHARD_SHORTCUT_CONTROL__.holdNextSave = true
  })
  await page.keyboard.press("ControlOrMeta+2")
  await expect.poll(() => updates(page)).toHaveLength(1)
  await page.keyboard.press("ControlOrMeta+3")
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __SHARD_SHORTCUT_CONTROL__: ShortcutControl })
      .__SHARD_SHORTCUT_CONTROL__.releaseSave?.()
  })
  await expect.poll(() => route(page)).toBe(expectedRoute("calendar"))
  expect(await updates(page)).toHaveLength(1)
})

test("搜索面板、设置对话框与输入法组合期间不切空间", async ({ page, context }) => {
  await boot(page)
  await page.keyboard.press("ControlOrMeta+k")
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.press("ControlOrMeta+2")
  expect(await route(page)).toBe(expectedRoute("fragments"))
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.locator("[data-shard-utility-menu-trigger]:visible").click()
  await page.getByRole("menuitem", { name: "设置" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.press("ControlOrMeta+2")
  expect(await route(page)).toBe(expectedRoute("fragments"))
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)

  const editor = page.locator('[data-shard-editor="composer"] .ProseMirror')
  await editor.click()
  const cdp = await context.newCDPSession(page)
  await cdp.send("Input.imeSetComposition", { text: "拼", selectionStart: 1, selectionEnd: 1 })
  await page.keyboard.press("ControlOrMeta+2")
  expect(await route(page)).toBe(expectedRoute("fragments"))
  await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 })
  await cdp.detach()
})

test("从已解锁密匣按 ⌘1 离开仍会自动上锁", async ({ page }) => {
  await boot(page, { lockbox: true })
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: "密匣（上锁空间）" }).click()
  const gate = page.getByRole("form", { name: "解锁密匣" })
  await gate.getByPlaceholder("密匣密码").fill("correct-password")
  await gate.getByRole("button", { name: "解锁", exact: true }).click()
  await expect(page.getByRole("heading", { name: "密匣", exact: true })).toBeVisible()
  await expect(page.getByRole("navigation", { name: "工作台导航" })
    .locator('[aria-current="page"]')).toHaveCount(0)
  await expect(page.getByRole("navigation", { name: "工作台导航" })
    .getByRole("button", { name: /^密匣/u })).toHaveCount(0)
  await page.keyboard.press("ControlOrMeta+1")
  await expect.poll(() => route(page)).toBe(expectedRoute("fragments"))
  await expect.poll(() => calls(page, "lock_lockbox")).toHaveLength(1)
  await expect(page.locator('[data-shard-fragment-id="secret"]')).toHaveCount(0)
})
