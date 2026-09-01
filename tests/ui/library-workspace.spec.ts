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
              path: "notes/最近更新的笔记.md",
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
              path: "notes/没有标题的旧笔记.md",
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
            const staleWindow = window as { __SHARD_STALE_ONCE__?: boolean }
            if (staleWindow.__SHARD_STALE_ONCE__) {
              delete staleWindow.__SHARD_STALE_ONCE__
              fragment.content = "# 远端更新版本"
              fragment.updatedAt = "2026-08-31T09:00:00.000Z"
              throw new Error(
                "STALE_BASE:磁盘上的笔记内容已变化（可能来自同步或外部编辑），保存已中止"
              )
            }
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

          if (command === "list_csv_files") return []
          if (command === "list_library_tree") {
            return {
              entries: withNotes
                ? [
                    {
                      name: "最近更新的笔记.md",
                      path: "notes/最近更新的笔记.md",
                      kind: "markdown",
                      size: 0,
                      modifiedAt: "",
                    },
                    {
                      name: "没有标题的旧笔记.md",
                      path: "notes/没有标题的旧笔记.md",
                      kind: "markdown",
                      size: 0,
                      modifiedAt: "",
                    },
                  ]
                : [],
              assets: [],
              trashEntries: [],
              fragmentStream: { totalCount: 0, years: [] },
            }
          }
          if (command === "migrate_legacy_notes") {
            return {
              tree: {
                entries: withNotes
                  ? [
                      {
                        name: "最近更新的笔记.md",
                        path: "notes/最近更新的笔记.md",
                        kind: "markdown",
                        size: 0,
                        modifiedAt: "",
                      },
                      {
                        name: "没有标题的旧笔记.md",
                        path: "notes/没有标题的旧笔记.md",
                        kind: "markdown",
                        size: 0,
                        modifiedAt: "",
                      },
                    ]
                  : [],
                assets: [],
                trashEntries: [],
                fragmentStream: { totalCount: 0, years: [] },
              },
              migratedCount: 0,
            }
          }
          if (
            command === "create_library_note" ||
            command === "create_library_directory" ||
            command === "rename_library_entry" ||
            command === "move_library_entry" ||
            command === "delete_library_entry" ||
            command === "convert_fragment_to_note" ||
            command === "convert_note_to_fragment"
          ) {
            return {
              tree: {
                entries: [],
                assets: [],
                trashEntries: [],
                fragmentStream: { totalCount: 0, years: [] },
              },
              fragment: null,
              updatedLinks: 0,
            }
          }
          if (command === "checkpoint_vault") {
            return {
              status: "no_changes",
              changes: 0,
              reason: null,
              git: {
                branch: "main",
                shortCommit: "abc1234",
                hasRemote: false,
                status: "ready",
                error: null,
                ahead: 0,
                behind: 0,
              },
            }
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

async function openRootDirectory(page: Page) {
  await page.getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: /^资料库根目录/ })
    .click()
  return page.getByRole("region", { name: "notes 目录列表", exact: true })
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

test("资料库第三栏选择笔记，并在切笔记、切空间与捕捉时自动保存", async ({
  page,
}) => {
  await installLibraryMock(page)
  await page.goto("/")
  await page.getByRole("button", { name: "资料库", exact: true }).click()

  let directory = await openRootDirectory(page)
  let newestNote = directory.getByRole("button", {
    name: "打开文件 最近更新的笔记.md",
    exact: true,
  })
  const oldestNote = directory.getByRole("button", {
    name: "打开文件 没有标题的旧笔记.md",
    exact: true,
  })
  await expect(newestNote).toBeVisible()
  await expect(oldestNote).toBeVisible()
  await expect(page.locator("[data-library-inspector-slot]")).toBeVisible()

  await newestNote.click()
  await fillEditor(page, "library:note-new", "# 已自动保存的新标题\n正文 #work")
  // 树只剩目录后，切文件要先经第三栏的「返回所在目录」回到列表。
  await page.getByRole("button", { name: "返回所在目录", exact: true }).click()
  await oldestNote.click()
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
  await page.getByRole("button", { name: "碎片", exact: true }).click()
  await expect.poll(() => getUpdateCalls(page)).toHaveLength(2)
  await expect(page.locator('[data-shard-editor="composer"]')).toBeVisible()

  await page.getByRole("button", { name: "资料库", exact: true }).click()
  directory = await openRootDirectory(page)
  newestNote = directory.getByRole("button", {
    name: "打开文件 最近更新的笔记.md",
    exact: true,
  })
  await newestNote.click()
  await fillEditor(page, "library:note-new", "捕捉事件前保存 #work")
  await page.keyboard.press("ControlOrMeta+n")
  await expect.poll(() => getUpdateCalls(page)).toHaveLength(3)
  await expect(page.locator('[data-shard-editor="composer"] .cm-content')).toBeFocused()
})

test("编辑停顿后自动保存，Cmd+S 立即保存", async ({ page }) => {
  await installLibraryMock(page)
  await page.goto("/")
  await page.getByRole("button", { name: "资料库", exact: true }).click()

  await (await openRootDirectory(page))
    .getByRole("button", { name: "打开文件 最近更新的笔记.md", exact: true })
    .click()

  // 停止输入 800ms 后防抖自动保存，无需切换笔记或空间
  await fillEditor(page, "library:note-new", "# 停顿自动保存\n正文 #work")
  await expect.poll(() => getUpdateCalls(page)).toHaveLength(1)
  expect((await getUpdateCalls(page))[0].args).toMatchObject({
    id: "note-new",
    tags: ["inbox", "note", "work"],
  })
  await expect(
    page.getByRole("contentinfo", { name: "状态栏" }).getByText("已保存")
  ).toBeVisible()

  // Cmd/Ctrl+S 显式保存，不等待防抖
  await fillEditor(page, "library:note-new", "# 停顿自动保存\n第二段 #work")
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => getUpdateCalls(page)).toHaveLength(2)
  await expect(
    page.getByRole("contentinfo", { name: "状态栏" }).getByText("已保存")
  ).toBeVisible()
})

test("保存基线过期：取消对话框后载入磁盘最新版本", async ({ page }) => {
  await installLibraryMock(page)
  await page.goto("/")
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await (await openRootDirectory(page))
    .getByRole("button", { name: "打开文件 最近更新的笔记.md", exact: true })
    .click()

  // 模拟远端已改写磁盘：下一次保存抛 STALE_BASE，mock 磁盘内容换成远端版
  await page.evaluate(() => {
    ;(window as { __SHARD_STALE_ONCE__?: boolean }).__SHARD_STALE_ONCE__ = true
  })
  page.once("dialog", (dialog) => void dialog.dismiss())

  await fillEditor(page, "library:note-new", "# 本地草稿版本")
  // 放弃草稿 → 刷新后编辑器换入远端版本
  await expect
    .poll(() => readEditor(page, "library:note-new"))
    .toBe("# 远端更新版本")
  await expect(
    page.getByRole("contentinfo", { name: "状态栏" }).getByText("已保存")
  ).toBeVisible()
})

test("保存基线过期：确认对话框后强制覆盖磁盘版本", async ({ page }) => {
  await installLibraryMock(page)
  await page.goto("/")
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await (await openRootDirectory(page))
    .getByRole("button", { name: "打开文件 最近更新的笔记.md", exact: true })
    .click()

  await page.evaluate(() => {
    ;(window as { __SHARD_STALE_ONCE__?: boolean }).__SHARD_STALE_ONCE__ = true
  })
  page.once("dialog", (dialog) => void dialog.accept())

  await fillEditor(page, "library:note-new", "# 本地草稿版本")
  // 覆盖：冲突后立即重存（不带基线哈希），草稿保留
  await expect.poll(() => getUpdateCalls(page).then((calls) => calls.length)).toBe(2)
  const calls = await getUpdateCalls(page)
  expect(calls[1].args).toMatchObject({ id: "note-new" })
  expect((calls[1].args as { expectedSha?: string }).expectedSha).toBeUndefined()
  await expect
    .poll(() => readEditor(page, "library:note-new"))
    .toBe("# 本地草稿版本")
  await expect(
    page.getByRole("contentinfo", { name: "状态栏" }).getByText("已保存")
  ).toBeVisible()
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

  const list = page.getByRole("complementary", { name: "资料库目录" })
  const editor = page.getByRole("article", { name: "资料库查看器" })
  await expect(list).toBeVisible()
  await expect(editor).toBeHidden()

  await list.getByRole("button", { name: /^资料库根目录/ }).click()
  await expect(list).toBeHidden()
  await expect(editor).toBeVisible()
  await editor.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 最近更新的笔记.md", exact: true })
    .click()
  await expect(page.getByRole("button", { name: "返回资料库目录" })).toBeVisible()

  await page.getByRole("button", { name: "返回资料库目录" }).click()
  await expect(list).toBeVisible()
  await expect(editor).toBeHidden()
})
