import { expect, test, type Page } from "@playwright/test"

import { fillEditor, focusEditor, readEditor } from "./editor-helpers"

interface TestCall {
  args: Record<string, unknown>
  command: string
}

async function installLibraryMock(page: Page, includeNotes = true) {
  await page.addInitScript((withNotes: boolean) => {
    const fragments = [
      {
        id: "fragment-1",
        content: "普通碎片",
        createdAt: "2026-08-30T08:00:00.000Z",
        updatedAt: "2026-08-30T08:00:00.000Z",
        tags: ["inbox", "work"],
        category: null,
        path: "fragments/fragment-1.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
      },
      ...(withNotes
        ? [
            {
              id: "note-new",
              content: "# 最近更新的笔记\n正文 #work",
              createdAt: "2026-08-29T08:00:00.000Z",
              updatedAt: "2026-08-30T10:00:00.000Z",
              tags: ["inbox", "note", "work"],
              category: null,
              path: "fragments/note-new.md",
              gitStatus: "committed",
              error: null,
              archived: false,
              lockbox: false,
              pinned: false,
            },
            {
              id: "note-old",
              content: "没有标题的旧笔记 #notes",
              createdAt: "2026-08-28T08:00:00.000Z",
              updatedAt: "2026-08-29T10:00:00.000Z",
              tags: ["inbox", "note", "notes"],
              category: null,
              path: "fragments/note-old.md",
              gitStatus: "committed",
              error: null,
              archived: false,
              lockbox: false,
              pinned: false,
            },
          ]
        : []),
    ]
    const git = {
      branch: "main",
      shortCommit: "abc1234",
      hasRemote: false,
      status: "ready",
      error: null,
      ahead: 0,
      behind: 0,
    }
    const lockbox = {
      configured: false,
      unlocked: false,
      expiresAt: null,
      ttlSeconds: 900,
    }
    const state = {
      vaultPath: "/tmp/shard-library-test",
      fragments,
      git,
      lockbox,
    }
    const calls: TestCall[] = []
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_LIBRARY_CALLS__: calls,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args: clone(args) })

          if (command === "list_fragments") return clone(state)
          if (command === "list_mind_maps") return []
          if (command === "sync_vault") return clone(git)
          if (command === "restore_window_frame") return null
          if (command === "update_fragment") {
            const fragment = fragments.find((item) => item.id === args.id)
            if (!fragment) throw new Error("Fragment not found")
            fragment.content = String(args.content ?? fragment.content)
            fragment.tags = Array.isArray(args.tags)
              ? (args.tags as string[])
              : fragment.tags
            fragment.updatedAt = "2026-08-30T12:00:00.000Z"
            return clone(fragment)
          }
          if (command === "create_fragment") {
            const created = {
              id: "fragment-created",
              content: String(args.content ?? ""),
              createdAt: "2026-08-30T12:00:00.000Z",
              updatedAt: "2026-08-30T12:00:00.000Z",
              tags: Array.isArray(args.tags) ? args.tags : ["inbox"],
              category: null,
              path: "fragments/fragment-created.md",
              gitStatus: "committed",
              error: null,
              archived: false,
              lockbox: false,
              pinned: false,
            }
            fragments.unshift(created)
            return clone(created)
          }

          throw new Error(`Unhandled Tauri test command: ${command}`)
        },
      },
    })
  }, includeNotes)
}

async function getUpdateCalls(page: Page) {
  return page.evaluate(() =>
    (
      globalThis as typeof globalThis & {
        __SHARD_LIBRARY_CALLS__?: TestCall[]
      }
    ).__SHARD_LIBRARY_CALLS__?.filter(
      (call) => call.command === "update_fragment"
    ) ?? []
  )
}

test("捕捉门禁：冷启动可输入保存并在时间线看见新条目", async ({ page }) => {
  await installLibraryMock(page)
  await page.goto("/")

  const composer = page.locator('[data-shard-editor="composer"] .cm-content')
  await expect(composer).toBeVisible()
  await fillEditor(page, "composer", "捕捉门禁回归 #work")
  await focusEditor(page, "composer")
  await page.keyboard.press("Control+Enter")

  await expect(
    page.locator("[data-shard-fragment-id]").getByText("捕捉门禁回归", { exact: true })
  ).toBeVisible()
  await expect(page.locator("[data-shard-fragment-id]")).toHaveCount(4)
  await expect.poll(() => readEditor(page, "composer")).toBe("")
})

test("资料库按更新时间列笔记，并在切笔记、切空间与捕捉时自动保存", async ({
  page,
}) => {
  await installLibraryMock(page)
  await page.goto("/")
  await page.getByRole("button", { name: "资料库", exact: true }).click()

  const list = page.getByRole("complementary", { name: "笔记列表" })
  const noteButtons = list.locator("button")
  await expect(noteButtons).toHaveCount(2)
  await expect(noteButtons.nth(0)).toContainText("最近更新的笔记")
  await expect(noteButtons.nth(0)).toContainText("#work")
  await expect(noteButtons.nth(1)).toContainText("没有标题的旧笔记")
  await expect(page.locator("[data-library-inspector-slot]")).toBeVisible()

  await fillEditor(page, "library:note-new", "# 已自动保存的新标题\n正文 #work")
  await noteButtons.nth(1).click()
  await expect.poll(() => getUpdateCalls(page)).toHaveLength(1)
  expect((await getUpdateCalls(page))[0].args).toMatchObject({
    id: "note-new",
    tags: ["inbox", "note", "work"],
  })
  await expect
    .poll(() => readEditor(page, "library:note-old").catch(() => null))
    .toBe(
    "没有标题的旧笔记 #notes"
  )

  await fillEditor(page, "library:note-old", "旧笔记离开空间前保存 #notes")
  await page.getByRole("button", { name: "碎片" }).click()
  await expect.poll(() => getUpdateCalls(page)).toHaveLength(2)
  await expect(page.locator('[data-shard-editor="composer"]')).toBeVisible()

  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await fillEditor(page, "library:note-new", "捕捉事件前保存 #work")
  await page.keyboard.press("ControlOrMeta+n")
  await expect.poll(() => getUpdateCalls(page)).toHaveLength(3)
  await expect(page.locator('[data-shard-editor="composer"] .cm-content')).toBeFocused()
})

test("空资料库保留入口并展示引导空状态", async ({ page }) => {
  await installLibraryMock(page, false)
  await page.goto("/")

  const libraryEntry = page.getByRole("button", { name: "资料库", exact: true })
  await expect(libraryEntry).toBeVisible()
  await libraryEntry.click()
  await expect(page.getByText("到碎片流把一条内容转为笔记")).toBeVisible()
})

test("窄屏资料库使用列表与编辑器两级导航", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installLibraryMock(page)
  await page.goto("/")
  await page.getByRole("button", { name: "资料库", exact: true }).click()

  const list = page.getByRole("complementary", { name: "笔记列表" })
  const editor = page.getByRole("article", { name: "笔记编辑器" })
  await expect(list).toBeVisible()
  await expect(editor).toBeHidden()

  await list.getByRole("button").first().click()
  await expect(list).toBeHidden()
  await expect(editor).toBeVisible()
  await expect(page.getByRole("button", { name: "返回笔记列表" })).toBeVisible()

  await page.getByRole("button", { name: "返回笔记列表" }).click()
  await expect(list).toBeVisible()
  await expect(editor).toBeHidden()
})
