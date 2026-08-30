import { expect, test, type Page } from "@playwright/test"

import { readEditor } from "./editor-helpers"

interface LibraryCall {
  args: Record<string, unknown>
  command: string
}

async function installLibraryTreeMock(page: Page) {
  await page.addInitScript(() => {
    const now = "2026-08-30T10:00:00.000Z"
    const fragments = [
      {
        id: "fragment-august",
        content: "# 八月灵感\n碎片正文",
        createdAt: "2026-08-30T08:01:02.000Z",
        updatedAt: now,
        tags: ["inbox", "灵感"],
        category: null,
        path: "fragments/2026/08/20260830-080102.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
      {
        id: "fragment-july",
        content: "七月碎片",
        createdAt: "2026-07-12T08:00:00.000Z",
        updatedAt: now,
        tags: ["inbox"],
        category: null,
        path: "fragments/2026/07/20260712-080000.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
      {
        id: "note-plan",
        content: "# 项目计划\n从 [[旧笔记|打开笔记]] 继续",
        createdAt: "2026-08-28T08:00:00.000Z",
        updatedAt: now,
        tags: ["inbox", "note", "工作"],
        category: null,
        path: "notes/项目/项目计划.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
      {
        id: "note-old",
        content: "# 旧笔记\n待重命名",
        createdAt: "2026-08-27T08:00:00.000Z",
        updatedAt: now,
        tags: ["inbox", "note"],
        category: null,
        path: "notes/旧笔记.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
    ]
    const entries = [
      {
        name: "项目",
        path: "notes/项目",
        kind: "directory",
        children: [
          {
            name: "项目计划.md",
            path: "notes/项目/项目计划.md",
            kind: "markdown",
          },
        ],
      },
      { name: "旧笔记.md", path: "notes/旧笔记.md", kind: "markdown" },
      { name: "清单.csv", path: "notes/清单.csv", kind: "csv" },
    ] as Array<Record<string, unknown>>
    const calls: LibraryCall[] = []
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const git = {
      branch: "main",
      shortCommit: "t6abc12",
      hasRemote: false,
      status: "ready",
      error: null,
      ahead: 0,
      behind: 0,
    }
    const snapshot = () => ({
      entries: clone(entries),
      fragmentStream: {
        totalCount: fragments.filter((item) => !item.tags.includes("note")).length,
        years: [
          {
            year: "2026",
            totalCount: fragments.filter((item) => !item.tags.includes("note")).length,
            months: [
              { month: "08", count: fragments.some((item) => item.id === "fragment-august") ? 1 : 0 },
              { month: "07", count: 1 },
            ].filter((item) => item.count > 0),
          },
        ],
      },
    })
    const removeEntry = (path: string, items = entries): Record<string, unknown> | null => {
      const index = items.findIndex((item) => item.path === path)
      if (index >= 0) return items.splice(index, 1)[0]
      for (const item of items) {
        const removed = removeEntry(path, (item.children as typeof entries | undefined) ?? [])
        if (removed) return removed
      }
      return null
    }
    const findEntry = (path: string, items = entries): Record<string, unknown> | null => {
      for (const item of items) {
        if (item.path === path) return item
        const found = findEntry(path, (item.children as typeof entries | undefined) ?? [])
        if (found) return found
      }
      return null
    }
    const directoryChildren = (path: string) => {
      if (path === "notes") return entries
      const directory = findEntry(path)
      if (!directory) throw new Error(`Directory not found: ${path}`)
      const children = (directory.children as typeof entries | undefined) ?? []
      directory.children = children
      return children
    }
    const result = (fragment?: (typeof fragments)[number], updatedLinks = 0) => ({
      tree: snapshot(),
      ...(fragment ? { fragment: clone(fragment) } : {}),
      updatedLinks,
    })

    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_LIBRARY_TREE_CALLS__: calls,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args: clone(args) })
          if (command === "list_fragments") {
            return clone({
              vaultPath: "/tmp/shard-library-tree-test",
              fragments,
              git,
              lockbox: {
                configured: false,
                unlocked: false,
                expiresAt: null,
                ttlSeconds: 900,
              },
            })
          }
          if (command === "list_library_tree") return snapshot()
          if (command === "migrate_legacy_notes") {
            return { tree: snapshot(), migratedCount: 0 }
          }
          if (command === "list_mind_maps" || command === "list_csv_files") return []
          if (command === "restore_window_frame" || command === "open_csv_file") return null
          if (command === "plugin:app|version") return "0.1.3-test"
          if (command === "sync_vault") return clone(git)
          if (command === "update_fragment") {
            const fragment = fragments.find((item) => item.id === args.id)
            if (!fragment) throw new Error("Fragment not found")
            fragment.content = String(args.content ?? fragment.content)
            fragment.tags = Array.isArray(args.tags) ? (args.tags as string[]) : fragment.tags
            return clone(fragment)
          }
          if (command === "create_library_directory") {
            const parentPath = String(args.parentPath)
            const name = String(args.name)
            directoryChildren(parentPath).push({
              name,
              path: `${parentPath}/${name}`,
              kind: "directory",
              children: [],
            })
            return result()
          }
          if (command === "create_library_note") {
            const parentPath = String(args.parentPath)
            const title = String(args.title)
            const fragment = {
              ...clone(fragments[0]),
              id: `note-created-${fragments.length}`,
              content: `# ${title}`,
              tags: ["inbox", "note"],
              path: `${parentPath}/${title}.md`,
            }
            fragments.push(fragment)
            directoryChildren(parentPath).push({
              name: `${title}.md`,
              path: fragment.path,
              kind: "markdown",
            })
            return result(fragment)
          }
          if (command === "rename_library_entry") {
            const oldPath = String(args.path)
            const newName = String(args.newName)
            const entry = findEntry(oldPath)
            if (!entry) throw new Error("Entry not found")
            const extension = String(entry.kind) === "markdown" ? ".md" : String(entry.kind) === "csv" ? ".csv" : ""
            const parentPath = oldPath.slice(0, oldPath.lastIndexOf("/"))
            const nextPath = `${parentPath}/${newName}${extension}`
            entry.name = `${newName}${extension}`
            entry.path = nextPath
            const fragment = fragments.find((item) => item.path === oldPath)
            if (fragment) {
              fragment.path = nextPath
              if (fragment.id === "note-old") fragment.content = "# 新笔记\n待重命名"
            }
            for (const item of fragments) {
              item.content = item.content.replaceAll("[[旧笔记]]", "[[新笔记]]").replaceAll("[[旧笔记|", "[[新笔记|")
            }
            return result(fragment, oldPath === "notes/旧笔记.md" ? 1 : 0)
          }
          if (command === "move_library_entry") {
            const oldPath = String(args.path)
            const destination = String(args.destinationDirectory)
            const entry = removeEntry(oldPath)
            if (!entry) throw new Error("Entry not found")
            const nextPath = `${destination}/${String(entry.name)}`
            entry.path = nextPath
            directoryChildren(destination).push(entry)
            const fragment = fragments.find((item) => item.path === oldPath)
            if (fragment) fragment.path = nextPath
            return result(fragment)
          }
          if (command === "delete_library_entry") {
            removeEntry(String(args.path))
            return result()
          }
          if (command === "convert_fragment_to_note") {
            const fragment = fragments.find((item) => item.id === args.id)
            if (!fragment) throw new Error("Fragment not found")
            fragment.tags = [...fragment.tags, "note"]
            fragment.path = `${String(args.destinationDirectory ?? "notes")}/八月灵感.md`
            entries.push({ name: "八月灵感.md", path: fragment.path, kind: "markdown" })
            return result(fragment)
          }
          if (command === "convert_note_to_fragment") {
            const fragment = fragments.find((item) => item.id === args.id)
            if (!fragment) throw new Error("Fragment not found")
            removeEntry(fragment.path)
            fragment.tags = fragment.tags.filter((tag) => tag !== "note")
            fragment.path = "fragments/2026/08/20260830-100000.md"
            return result(fragment)
          }
          throw new Error(`Unhandled Tauri test command: ${command}`)
        },
      },
    })
  })
}

async function commandCalls(page: Page, command: string) {
  return page.evaluate((target) =>
    (
      globalThis as typeof globalThis & {
        __SHARD_LIBRARY_TREE_CALLS__?: LibraryCall[]
      }
    ).__SHARD_LIBRARY_TREE_CALLS__?.filter((call) => call.command === target) ?? [],
  command)
}

test.beforeEach(async ({ page }) => {
  await installLibraryTreeMock(page)
  await page.goto("/")
})

test("资料库文件树只展示 notes 内容，碎片流止于年月并写入月份路由", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })

  await expect(treePane.getByRole("button", { name: "项目", exact: true })).toBeVisible()
  await expect(treePane.getByRole("button", { name: "旧笔记.md", exact: true })).toBeVisible()
  await expect(treePane.getByRole("button", { name: "清单.csv", exact: true })).toBeVisible()
  await expect(treePane.getByText("assets", { exact: true })).toHaveCount(0)
  await expect(treePane.getByText("八月灵感", { exact: true })).toHaveCount(0)

  await treePane.getByRole("button", { name: "碎片流（2）", exact: true }).click()
  await treePane.getByRole("button", { name: "2026（2）", exact: true }).click()
  const monthTree = treePane.getByRole("tree", { name: "碎片流年月" })
  await expect(monthTree.getByRole("button", { name: "08（1）", exact: true })).toBeVisible()
  await expect(monthTree.getByRole("button", { name: "07（1）", exact: true })).toBeVisible()
  await expect(monthTree.getByText("20260830-080102.md", { exact: true })).toHaveCount(0)

  await monthTree.getByRole("button", { name: "08（1）", exact: true }).click()
  await expect(page.locator('[data-shard-fragment-id="fragment-august"]')).toBeVisible()
  await expect(page.locator('[data-shard-fragment-id="fragment-july"]')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => localStorage.getItem("shard.workspace-route"))).toBe(
    JSON.stringify({ space: "fragments", params: { filter: "inbox", month: "2026-08" } })
  )
})

test("碎片与笔记通过菜单双向搬移并刷新资料库树", async ({ page }) => {
  const fragmentCard = page.locator('[data-shard-fragment-id="fragment-august"]')
  await fragmentCard.getByRole("button", { name: "片段操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "转为笔记", exact: true }).click()
  await expect.poll(() => commandCalls(page, "convert_fragment_to_note")).toHaveLength(1)
  expect((await commandCalls(page, "convert_fragment_to_note"))[0].args).toEqual({
    destinationDirectory: null,
    id: "fragment-august",
  })

  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await expect(treePane.getByRole("button", { name: "八月灵感.md", exact: true })).toBeVisible()
  await treePane.getByRole("button", { name: "八月灵感.md 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "转为碎片", exact: true }).click()

  await expect.poll(() => commandCalls(page, "convert_note_to_fragment")).toHaveLength(1)
  expect((await commandCalls(page, "convert_note_to_fragment"))[0].args).toEqual({
    id: "fragment-august",
  })
  await expect(treePane.getByRole("button", { name: "八月灵感.md", exact: true })).toHaveCount(0)
})

test("目录树 MVP 支持新建、重命名、菜单移动和非空目录删除阻止", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })

  await treePane.getByRole("button", { name: "新建目录", exact: true }).click()
  let dialog = page.getByRole("dialog", { name: "新建目录" })
  await dialog.getByLabel("名称", { exact: true }).fill("空目录")
  await dialog.getByRole("button", { name: "确认", exact: true }).click()
  await expect(treePane.getByRole("button", { name: "空目录", exact: true })).toBeVisible()

  await treePane.getByRole("button", { name: "新建笔记", exact: true }).click()
  dialog = page.getByRole("dialog", { name: "新建笔记" })
  await dialog.getByLabel("笔记标题", { exact: true }).fill("新笔记")
  await dialog.getByRole("button", { name: "确认", exact: true }).click()
  await expect(treePane.getByRole("button", { name: "新笔记.md", exact: true })).toBeVisible()

  await treePane.getByRole("button", { name: "新笔记.md 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click()
  dialog = page.getByRole("dialog", { name: "重命名" })
  await dialog.getByLabel("名称", { exact: true }).fill("已改名")
  await dialog.getByRole("button", { name: "确认", exact: true }).click()
  await expect(treePane.getByRole("button", { name: "已改名.md", exact: true })).toBeVisible()

  await treePane.getByRole("button", { name: "已改名.md 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "移动到…", exact: true }).hover()
  await page.getByRole("menuitem", { name: "项目", exact: true }).click()
  await treePane.getByRole("button", { name: "项目", exact: true }).click()
  await expect(treePane.getByRole("button", { name: "已改名.md", exact: true })).toBeVisible()

  await treePane.getByRole("button", { name: "项目 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "删除", exact: true }).click()
  await expect(page.getByText("目录非空，不能删除", { exact: true })).toBeVisible()
  await expect.poll(() => commandCalls(page, "delete_library_entry")).toHaveLength(0)

  await treePane.getByRole("button", { name: "空目录 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "删除", exact: true }).last().click()
  dialog = page.getByRole("dialog", { name: "确认删除" })
  await dialog.getByRole("button", { name: "删除", exact: true }).click()
  await expect.poll(() => commandCalls(page, "delete_library_entry")).toHaveLength(1)
  await expect(treePane.getByRole("button", { name: "空目录", exact: true })).toHaveCount(0)
  expect((await commandCalls(page, "create_library_directory"))[0].args).toEqual({
    name: "空目录",
    parentPath: "notes",
  })
  expect((await commandCalls(page, "create_library_note"))[0].args).toEqual({
    parentPath: "notes",
    title: "新笔记",
  })
  expect((await commandCalls(page, "rename_library_entry"))[0].args).toEqual({
    newName: "已改名",
    path: "notes/新笔记.md",
  })
  expect((await commandCalls(page, "move_library_entry"))[0].args).toEqual({
    destinationDirectory: "notes/项目",
    path: "notes/已改名.md",
  })
})

test("重命名批量更新旧 wikilink 后仍可从别名链接导航", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })

  await treePane.getByRole("button", { name: "旧笔记.md 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "重命名" })
  await dialog.getByLabel("名称", { exact: true }).fill("新笔记")
  await dialog.getByRole("button", { name: "确认", exact: true }).click()
  await expect(page.getByText("已更新 1 处双链引用", { exact: true })).toBeVisible()
  expect((await commandCalls(page, "rename_library_entry"))[0].args).toEqual({
    newName: "新笔记",
    path: "notes/旧笔记.md",
  })

  await treePane.getByRole("button", { name: "项目", exact: true }).click()
  await treePane.getByRole("button", { name: "项目计划.md", exact: true }).click()
  const sourceEditor = page.locator('[data-shard-editor="library:note-plan"]')
  await expect.poll(() => readEditor(page, "library:note-plan")).toContain(
    "[[新笔记|打开笔记]]"
  )
  await expect(sourceEditor.locator(".shard-cm-wikilink")).toHaveText(
    "[[新笔记|打开笔记]]"
  )
  await sourceEditor.locator(".shard-cm-wikilink").click()
  await expect(page.locator('[data-shard-editor="library:note-old"]')).toBeVisible()
})
