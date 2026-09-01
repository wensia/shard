import { expect, test, type Page } from "@playwright/test"

import { fillEditor, readEditor } from "./editor-helpers"

interface LibraryCall {
  args: Record<string, unknown>
  command: string
}

interface LockboxMockState {
  configured: boolean
  unlocked: boolean
  expiresAt: string | null
  ttlSeconds: number
}

// 全局默认是「密匣未配置」的初始态；需要解锁态的用例自行传入覆盖，
// 不要改这里的默认值（否则未配置引导流程的用例会拿到错误前提）。
const DEFAULT_LOCKBOX_STATE: LockboxMockState = {
  configured: false,
  unlocked: false,
  expiresAt: null,
  ttlSeconds: 900,
}

async function installLibraryTreeMock(
  page: Page,
  lockboxState: LockboxMockState = DEFAULT_LOCKBOX_STATE,
  includeAssets = true
) {
  await page.addInitScript(({ includeAssets, lockbox }: {
    includeAssets: boolean
    lockbox: LockboxMockState
  }) => {
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
        id: "fragment-archived",
        content: "回收站碎片正文",
        createdAt: "2026-06-12T08:00:00.000Z",
        updatedAt: now,
        tags: ["inbox"],
        category: null,
        path: ".trash/fragments/2026/06/20260612-080000.md",
        gitStatus: "committed",
        error: null,
        archived: true,
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
        size: 0,
        modifiedAt: now,
        children: [
          {
            name: "项目计划.md",
            path: "notes/项目/项目计划.md",
            kind: "markdown",
            size: 1_024,
            modifiedAt: now,
          },
        ],
      },
      {
        name: "旧笔记.md",
        path: "notes/旧笔记.md",
        kind: "markdown",
        size: 512,
        modifiedAt: now,
      },
      {
        name: "项目导图.shardmap.json",
        path: "notes/项目导图.shardmap.json",
        kind: "mindmap",
        mindMapId: "map-project",
        size: 768,
        modifiedAt: now,
      },
      {
        name: "清单.csv",
        path: "notes/清单.csv",
        kind: "csv",
        size: 256,
        modifiedAt: now,
      },
    ] as Array<Record<string, unknown>>
    const trashEntries = [
      {
        name: "fragments",
        path: ".trash/fragments",
        kind: "directory",
        size: 0,
        modifiedAt: now,
        children: [
          {
            name: "20260612-080000.md",
            path: ".trash/fragments/2026/06/20260612-080000.md",
            kind: "markdown",
            size: 128,
            modifiedAt: now,
          },
        ],
      },
    ] as Array<Record<string, unknown>>
    const mindMapSummary = {
      id: "map-project",
      title: "项目导图",
      createdAt: now,
      updatedAt: now,
      nodeCount: 1,
      path: "notes/项目导图.shardmap.json",
    }
    const mindMapFile = {
      kind: "shard.map",
      schemaVersion: 1,
      id: mindMapSummary.id,
      title: mindMapSummary.title,
      createdAt: now,
      updatedAt: now,
      savedWithAppVersion: "0.1.3-test",
      revision: 1,
      rootId: "root",
      hasProtectedLinks: false,
      nodes: {
        root: {
          id: "root",
          parentId: null,
          sortKey: "a",
          text: mindMapSummary.title,
          createdAt: now,
          updatedAt: now,
        },
      },
    }
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
      assets: includeAssets
        ? [{
            path: "assets/a3/a3f5e8c9d2aa0000000000000000000000000000000000000000000000000000.png",
            size: 2_048,
            modifiedAt: "2026-08-29T09:08:07.000Z",
            mimeType: "image/png",
          }]
        : [],
      trashEntries: clone(trashEntries),
      fragmentStream: {
        totalCount: fragments.filter((item) => !item.tags.includes("note") && !item.archived).length,
        years: [
          {
            year: "2026",
            totalCount: fragments.filter((item) => !item.tags.includes("note") && !item.archived).length,
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
    const rebaseEntryPaths = (
      entry: Record<string, unknown>,
      oldPrefix: string,
      nextPrefix: string
    ) => {
      entry.path = String(entry.path).replace(oldPrefix, nextPrefix)
      for (const child of (entry.children as typeof entries | undefined) ?? []) {
        rebaseEntryPaths(child, oldPrefix, nextPrefix)
      }
    }
    const trashDirectoryChildren = (originalDirectory: string) => {
      let children = trashEntries
      let path = ".trash"
      for (const part of originalDirectory.split("/").filter(Boolean)) {
        path = `${path}/${part}`
        let directory = children.find((entry) => entry.path === path)
        if (!directory) {
          directory = {
            name: part,
            path,
            kind: "directory",
            size: 0,
            modifiedAt: now,
            children: [],
          }
          children.push(directory)
        }
        children = (directory.children as typeof entries | undefined) ?? []
        directory.children = children
      }
      return children
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
        // 自定义协议：真实环境由 Tauri 注入，测试里回一个可辨识的占位地址。
        convertFileSrc: (path: string, scheme?: string) =>
          `${scheme ?? "asset"}://localhost/${path}`,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args: clone(args) })
          if (command === "list_fragments") {
            return clone({
              vaultPath: "/tmp/shard-library-tree-test",
              fragments,
              git,
              lockbox,
            })
          }
          if (command === "list_library_tree") return snapshot()
          if (command === "migrate_legacy_notes") {
            return { tree: snapshot(), migratedCount: 0 }
          }
          if (command === "list_mind_maps") return clone([mindMapSummary])
          if (command === "read_mind_map") {
            if (
              (globalThis as typeof globalThis & {
                __SHARD_FAIL_MIND_MAP_PREVIEW__?: boolean
              }).__SHARD_FAIL_MIND_MAP_PREVIEW__
            ) {
              throw new Error("Mind map preview failed")
            }
            return {
              file: clone(mindMapFile),
              path: mindMapSummary.path,
              lastSavedHash: "map-hash",
            }
          }
          if (command === "read_csv_file") {
            return Array.from(
              new TextEncoder().encode("事项,状态\r\n搭建预览,进行中")
            )
          }
          if (command === "read_fragment_image") {
            return "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="
          }
          if (command === "save_fragment_image") {
            return `assets/${String(args.fileName)}`
          }
          if (command === "list_csv_files") return []
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
              size: 0,
              modifiedAt: now,
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
              size: 0,
              modifiedAt: now,
            })
            return result(fragment)
          }
          if (command === "rename_library_entry") {
            const oldPath = String(args.path)
            const newName = String(args.newName)
            const entry = findEntry(oldPath)
            if (!entry) throw new Error("Entry not found")
            const extension = String(entry.kind) === "markdown"
              ? ".md"
              : String(entry.kind) === "csv"
                ? ".csv"
                : String(entry.kind) === "mindmap"
                  ? ".shardmap.json"
                  : ""
            const parentPath = oldPath.slice(0, oldPath.lastIndexOf("/"))
            const nextPath = `${parentPath}/${newName}${extension}`
            entry.name = `${newName}${extension}`
            entry.path = nextPath
            if (String(entry.kind) === "mindmap") mindMapSummary.path = nextPath
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
            if (String(entry.kind) === "mindmap") mindMapSummary.path = nextPath
            directoryChildren(destination).push(entry)
            const fragment = fragments.find((item) => item.path === oldPath)
            if (fragment) fragment.path = nextPath
            return result(fragment)
          }
          if (command === "delete_library_entry") {
            const oldPath = String(args.path)
            const entry = removeEntry(oldPath)
            if (!entry) throw new Error("Entry not found")
            rebaseEntryPaths(entry, oldPath, `.trash/${oldPath}`)
            const parentPath = oldPath.slice(0, oldPath.lastIndexOf("/"))
            trashDirectoryChildren(parentPath).push(entry)
            const fragment = fragments.find((item) => item.path === oldPath)
            if (fragment) {
              fragment.path = `.trash/${oldPath}`
              fragment.archived = true
            }
            return result()
          }
          if (command === "restore_from_trash") {
            const trashPath = String(args.path)
            const entry = removeEntry(trashPath, trashEntries)
            if (!entry) throw new Error("Trash entry not found")
            const originalPath = trashPath.replace(/^\.trash\//u, "")
            rebaseEntryPaths(entry, trashPath, originalPath)
            const parentPath = originalPath.slice(0, originalPath.lastIndexOf("/"))
            directoryChildren(parentPath).push(entry)
            const fragment = fragments.find((item) => item.path === trashPath)
            if (fragment) {
              fragment.path = originalPath
              fragment.archived = false
            }
            return result()
          }
          if (command === "purge_from_trash") {
            removeEntry(String(args.path), trashEntries)
            return result()
          }
          if (command === "empty_trash") {
            trashEntries.splice(0)
            return result()
          }
          if (command === "convert_fragment_to_note") {
            const fragment = fragments.find((item) => item.id === args.id)
            if (!fragment) throw new Error("Fragment not found")
            fragment.tags = [...fragment.tags, "note"]
            fragment.path = `${String(args.destinationDirectory ?? "notes")}/八月灵感.md`
            entries.push({
              name: "八月灵感.md",
              path: fragment.path,
              kind: "markdown",
              size: 0,
              modifiedAt: now,
            })
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
          if (command === "move_fragment_to_lockbox") {
            const fragment = fragments.find((item) => item.id === args.id)
            if (!fragment) throw new Error("Fragment not found")
            removeEntry(fragment.path)
            fragment.path = fragment.path
              .replace(/^notes\//u, "lockbox/notes/")
              .replace(/\.md$/iu, ".shard")
            fragment.lockbox = true
            return clone({
              vaultPath: "/tmp/shard-library-tree-test",
              fragments,
              git,
              lockbox,
            })
          }
          throw new Error(`Unhandled Tauri test command: ${command}`)
        },
      },
    })
  }, { includeAssets, lockbox: lockboxState })
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

test("点击树目录会同时展开节点并在第三栏浏览内容", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  const viewer = page.getByRole("article", { name: "资料库查看器" })

  await treePane.getByRole("button", { name: "项目", exact: true }).click()

  await expect(
    treePane.getByRole("button", { name: "项目计划.md", exact: true })
  ).toHaveCount(0)
  const directoryList = viewer.getByRole("region", {
    name: "notes/项目 目录列表",
    exact: true,
  })
  await expect(directoryList).toBeVisible()
  await expect(
    directoryList.getByRole("button", {
      name: "打开文件 项目计划.md",
      exact: true,
    })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "进入禅模式", exact: true })
  ).toHaveCount(0)
  const inspector = page.getByRole("complementary", { name: "笔记检查器" })
  await expect(inspector.locator("button, input, textarea, [role=list]")).toHaveCount(0)
})

test("目录列表与宫格切换会持久化，宫格可进入子目录并打开笔记", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: "资料库根目录（2）",
    exact: true,
  }).click()
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  const gridButton = viewer.getByRole("button", { name: "宫格视图", exact: true })

  await expect(
    viewer.getByRole("button", { name: "列表视图", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  const rootList = viewer.getByRole("region", {
    name: "notes 目录列表",
    exact: true,
  })
  await expect(
    rootList.getByRole("button", { name: "打开文件 旧笔记.md", exact: true })
  ).toBeVisible()
  await expect(
    rootList.getByRole("button", {
      name: "打开文件 项目导图.shardmap.json",
      exact: true,
    })
  ).toBeVisible()
  await gridButton.click()
  await expect(gridButton).toHaveAttribute("aria-pressed", "true")
  const rootGrid = viewer.getByRole("list", {
    name: "notes 目录宫格",
    exact: true,
  })
  await expect(
    rootGrid.getByRole("button", { name: "打开文件 旧笔记.md", exact: true })
  ).toBeVisible()
  await expect(
    rootGrid.getByRole("button", {
      name: "打开文件 项目导图.shardmap.json",
      exact: true,
    })
  ).toBeVisible()
  await expect.poll(() => page.evaluate(() =>
    localStorage.getItem("shard.library-directory-view")
  )).toBe("grid")

  await viewer.getByRole("button", { name: "打开目录 项目", exact: true }).click()
  await expect(viewer.getByRole("list", { name: "notes/项目 目录宫格", exact: true })).toBeVisible()
  await viewer.getByRole("button", {
    name: "打开文件 项目计划.md",
    exact: true,
  }).click()
  await expect(page.locator('[data-shard-editor="library:note-plan"]')).toBeVisible()

  await page.reload()
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: "资料库根目录（2）", exact: true })
    .click()
  await expect(
    page.getByRole("article", { name: "资料库查看器" })
      .getByRole("button", { name: "宫格视图", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
})

test("目录宫格按文件类型显示内容缩略图，列表视图保持密集元数据", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: "资料库根目录（2）",
    exact: true,
  }).click()
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  const rootList = viewer.getByRole("region", {
    name: "notes 目录列表",
    exact: true,
  })
  await expect(rootList).toBeVisible()
  await expect(rootList.locator('[data-library-preview], img')).toHaveCount(0)
  await expect(rootList.getByText("待重命名", { exact: true })).toHaveCount(0)

  await viewer.getByRole("button", { name: "宫格视图", exact: true }).click()
  const rootGrid = viewer.getByRole("list", {
    name: "notes 目录宫格",
    exact: true,
  })
  const markdownCard = rootGrid.getByRole("button", {
    name: "打开文件 旧笔记.md",
    exact: true,
  })
  await expect(markdownCard.getByText("待重命名", { exact: true })).toBeVisible()
  await expect(markdownCard.locator('[data-kind="markdown"]')).toHaveCount(0)

  const mindMapCard = rootGrid.getByRole("button", {
    name: "打开文件 项目导图.shardmap.json",
    exact: true,
  })
  const mindMapPreview = mindMapCard.locator(
    'svg[data-library-preview="mindmap"]'
  )
  await expect(mindMapPreview.locator("rect")).toHaveCount(1)
  await expect(mindMapPreview.locator("text")).toHaveCount(0)

  const csvCard = rootGrid.getByRole("button", {
    name: "打开文件 清单.csv",
    exact: true,
  })
  await expect(
    csvCard.locator('table[data-library-preview="table"]')
  ).toBeVisible()
  await expect(csvCard.getByText("事项", { exact: true })).toBeVisible()
})

test("异步缩略图读取失败时保留类型图标且不抛页面错误", async ({ page }) => {
  const pageErrors: Error[] = []
  page.on("pageerror", (error) => pageErrors.push(error))
  await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & {
      __SHARD_FAIL_MIND_MAP_PREVIEW__?: boolean
    }
    runtime.__SHARD_FAIL_MIND_MAP_PREVIEW__ = true
  })

  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: "资料库根目录（2）",
    exact: true,
  }).click()
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  await viewer.getByRole("button", { name: "宫格视图", exact: true }).click()
  const mindMapCard = viewer.getByRole("list", {
    name: "notes 目录宫格",
    exact: true,
  }).getByRole("button", {
    name: "打开文件 项目导图.shardmap.json",
    exact: true,
  })

  await expect(mindMapCard.locator('[data-kind="mindmap"]')).toBeVisible()
  await expect(
    mindMapCard.locator('[data-library-preview="mindmap"]')
  ).toHaveCount(0)
  expect(pageErrors).toEqual([])
})

test("空目录显示目录空态", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", { name: "新建目录", exact: true }).click()
  const input = treePane.getByRole("textbox", { name: "新目录名称", exact: true })
  await input.fill("待整理")
  await input.press("Enter")
  await treePane.getByRole("button", { name: "待整理", exact: true }).click()

  await expect(
    page.getByRole("article", { name: "资料库查看器" })
      .getByText("这个目录还是空的", { exact: true })
  ).toBeVisible()
})

test("脏笔记进入目录前先保存草稿", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: "资料库根目录（2）",
    exact: true,
  }).click()
  await page.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 旧笔记.md", exact: true })
    .click()
  await fillEditor(page, "library:note-old", "# 旧笔记\n先保存再浏览目录")
  await treePane.getByRole("button", { name: "项目", exact: true }).click()

  await expect.poll(() => commandCalls(page, "update_fragment")).toHaveLength(1)
  await expect(
    page.getByRole("region", { name: "notes/项目 目录列表", exact: true })
  ).toBeVisible()
})

test("资料库树只展示目录与特殊入口，碎片流无下级菜单", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })

  await expect(treePane.getByRole("button", { name: "项目", exact: true })).toBeVisible()
  await expect(treePane.getByRole("button", { name: "旧笔记.md", exact: true })).toHaveCount(0)
  await expect(
    treePane.getByRole("button", {
      name: "项目导图.shardmap.json",
      exact: true,
    })
  ).toHaveCount(0)
  await expect(treePane.getByRole("button", { name: "清单.csv", exact: true })).toHaveCount(0)
  await expect(treePane.getByRole("button", { name: "碎片流（2）", exact: true })).toBeVisible()
  await expect(treePane.getByRole("button", { name: "图片（1）", exact: true })).toBeVisible()
  await expect(treePane.getByRole("button", { name: "密匣（上锁空间）", exact: true })).toBeVisible()
  await expect(
    treePane.getByRole("button", { name: /^思维导图（/ })
  ).toHaveCount(0)
  await expect(treePane.getByText("assets", { exact: true })).toHaveCount(0)
  await expect(treePane.getByText("八月灵感", { exact: true })).toHaveCount(0)

  // 碎片流是一个入口，不再展开年月子树。
  await treePane.getByRole("button", { name: "碎片流（2）", exact: true }).click()
  await expect(treePane.getByRole("tree", { name: "碎片流年月" })).toHaveCount(0)
  await expect(treePane.getByRole("button", { name: /^2026（/ })).toHaveCount(0)

  await expect(
    treePane.getByRole("button", { name: "回收站（2）", exact: true })
  ).toBeVisible()
  await expect(treePane.getByRole("button", { name: /^归档（/ })).toHaveCount(0)

  await expect(page.locator('[data-shard-fragment-id="fragment-august"]')).toBeVisible()
  await expect(page.locator('[data-shard-fragment-id="fragment-july"]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem("shard.workspace-route"))).toBe(
    JSON.stringify({ space: "library", params: {} })
  )
  await expect(page.getByRole("button", { name: "进入禅模式", exact: true })).toHaveCount(0)
})

test("碎片流标签与回收站 DirectoryView 列表宫格都在资料库查看器内工作", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  const viewer = page.getByRole("article", { name: "资料库查看器" })

  await treePane.getByRole("button", { name: "碎片流（2）", exact: true }).click()
  await expect(viewer.locator('[data-shard-fragment-id="fragment-august"]')).toBeVisible()
  await expect(viewer.locator('[data-shard-fragment-id="fragment-july"]')).toBeVisible()

  await viewer.getByRole("button", { name: "#灵感 1", exact: true }).click()
  await expect(viewer.locator('[data-shard-fragment-id="fragment-august"]')).toBeVisible()
  await expect(viewer.locator('[data-shard-fragment-id="fragment-july"]')).toHaveCount(0)

  await viewer.getByRole("button", { name: "新建标签", exact: true }).click()
  await viewer.getByRole("textbox", { name: "新标签名", exact: true }).fill("稍后")
  await viewer.getByRole("textbox", { name: "新标签名", exact: true }).press("Enter")
  await expect(viewer.getByRole("button", { name: "#稍后 0", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  )

  await treePane.getByRole("button", { name: "回收站（2）", exact: true }).click()
  const trashList = viewer.getByRole("region", {
    name: ".trash 目录列表",
    exact: true,
  })
  await expect(trashList).toBeVisible()
  await trashList.getByRole("button", { name: "fragments 操作", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "恢复", exact: true })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "彻底删除", exact: true })).toBeVisible()
  for (const forbidden of ["重命名", "移动到…", "转为碎片", "移入密匣"]) {
    await expect(page.getByRole("menuitem", { name: forbidden, exact: true })).toHaveCount(0)
  }
  await page.keyboard.press("Escape")

  await viewer.getByRole("button", { name: "宫格视图", exact: true }).click()
  await expect(viewer.getByRole("list", { name: ".trash 目录宫格", exact: true })).toBeVisible()
  await viewer.getByRole("button", { name: "列表视图", exact: true }).click()
  await expect(trashList).toBeVisible()
  await expect(viewer.getByRole("button", { name: "进入禅模式", exact: true })).toHaveCount(0)
})

test("删除笔记移入回收站并可从原位置恢复", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  await treePane.getByRole("button", {
    name: "资料库根目录（2）",
    exact: true,
  }).click()
  const rootList = viewer.getByRole("region", { name: "notes 目录列表", exact: true })
  await rootList.getByRole("button", { name: "旧笔记.md 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "删除", exact: true }).click()
  const deleteDialog = page.getByRole("dialog", { name: "确认删除", exact: true })
  await expect(deleteDialog).toContainText("将移入回收站，之后仍可恢复")
  await deleteDialog.getByRole("button", { name: "删除", exact: true }).click()
  await expect(rootList.getByRole("button", { name: "打开文件 旧笔记.md", exact: true })).toHaveCount(0)

  await treePane.getByRole("button", { name: "回收站（4）", exact: true }).click()
  await viewer.getByRole("button", { name: "打开目录 notes", exact: true }).click()
  const trashNotes = viewer.getByRole("region", {
    name: ".trash/notes 目录列表",
    exact: true,
  })
  await expect(trashNotes.getByText("旧笔记.md", { exact: true })).toBeVisible()
  await trashNotes.getByRole("button", { name: "旧笔记.md 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "恢复", exact: true }).click()

  await expect.poll(() => commandCalls(page, "restore_from_trash")).toHaveLength(1)
  await treePane.getByRole("button", {
    name: "资料库根目录（2）",
    exact: true,
  }).click()
  await expect(
    viewer.getByRole("region", { name: "notes 目录列表", exact: true })
      .getByRole("button", { name: "打开文件 旧笔记.md", exact: true })
  ).toBeVisible()
})

test("清空回收站必须二次确认且确认后才调用命令", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", { name: "回收站（2）", exact: true }).click()
  await page.getByRole("button", { name: "清空回收站", exact: true }).click()

  const dialog = page.getByRole("dialog", { name: "确认清空回收站", exact: true })
  await expect(dialog).toContainText("永久删除，此操作不可恢复")
  await expect.poll(() => commandCalls(page, "empty_trash")).toHaveLength(0)
  await dialog.getByRole("button", { name: "清空回收站", exact: true }).click()
  await expect.poll(() => commandCalls(page, "empty_trash")).toHaveLength(1)
  await expect(treePane.getByRole("button", { name: "回收站（0）", exact: true })).toBeVisible()
  await expect(page.getByText("回收站是空的", { exact: true })).toBeVisible()
})

test("脏笔记进入碎片流前先保存草稿", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: "资料库根目录（2）",
    exact: true,
  }).click()
  await page.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 旧笔记.md", exact: true })
    .click()
  await fillEditor(page, "library:note-old", "# 旧笔记\n先保存再看碎片")
  await treePane.getByRole("button", { name: "碎片流（2）", exact: true }).click()

  await expect.poll(() => commandCalls(page, "update_fragment")).toHaveLength(1)
  await expect(
    page.getByRole("article", { name: "资料库查看器" })
      .locator('[data-shard-fragment-id="fragment-august"]')
  ).toBeVisible()
})

test("资料库普通导图条目在第三栏打开并保留侧栏与目录树", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  const sidebar = page.getByRole("navigation", { name: "工作台导航" })

  await expect(
    treePane.getByRole("button", { name: /^思维导图（/ })
  ).toHaveCount(0)
  await treePane.getByRole("button", {
    name: "资料库根目录（2）",
    exact: true,
  }).click()
  const rootList = page.getByRole("region", {
    name: "notes 目录列表",
    exact: true,
  })
  const mapEntry = rootList.getByRole("button", {
    name: "打开文件 项目导图.shardmap.json",
    exact: true,
  })
  await expect(mapEntry).toBeVisible()
  await expect(
    rootList.getByRole("button", {
      name: "项目导图.shardmap.json 操作",
      exact: true,
    })
  ).toBeVisible()

  await mapEntry.click()
  await expect(page.getByLabel("思维导图编辑器", { exact: true })).toBeVisible()
  await expect(sidebar).toBeVisible()
  await expect(treePane).toBeVisible()
  await expect(
    treePane.getByRole("button", { name: "项目导图.shardmap.json", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "退出思维导图", exact: true })
  ).toHaveCount(0)
})

test("资料库笔记禅模式进出后保留同一份草稿", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", { name: "项目", exact: true }).click()
  await page.getByRole("region", { name: "notes/项目 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 项目计划.md", exact: true })
    .click()

  const editorId = "library:note-plan"
  const zenDraft = "# 项目计划\n禅模式共用草稿"
  await fillEditor(page, editorId, zenDraft)
  await page.getByRole("button", { name: "进入禅模式", exact: true }).click()

  const zenSurface = page.getByLabel("资料库笔记禅模式", { exact: true })
  await expect(zenSurface).toBeVisible()
  await expect.poll(() => readEditor(page, editorId)).toBe(zenDraft)

  const editedInZen = `${zenDraft}\n退出后仍然存在`
  await fillEditor(page, editorId, editedInZen)
  await page.keyboard.press("Escape")

  await expect(zenSurface).toHaveCount(0)
  await expect(treePane).toBeVisible()
  await expect(page.locator(`[data-shard-editor="${editorId}"]`)).toBeVisible()
  await expect.poll(() => readEditor(page, editorId)).toBe(editedInZen)
})

test("资料库思维导图可进入并退出禅模式", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: "资料库根目录（2）",
    exact: true,
  }).click()
  await page.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", {
      name: "打开文件 项目导图.shardmap.json",
      exact: true,
    })
    .click()
  await expect(page.getByLabel("思维导图编辑器", { exact: true })).toBeVisible()

  await page.getByRole("button", { name: "进入禅模式", exact: true }).click()
  const zenSurface = page.getByLabel("资料库思维导图禅模式", { exact: true })
  await expect(zenSurface).toBeVisible()
  await expect(
    zenSurface.getByLabel("思维导图编辑器", { exact: true })
  ).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(zenSurface).toHaveCount(0)
  await expect(treePane).toBeVisible()
  await expect(page.getByLabel("思维导图编辑器", { exact: true })).toBeVisible()
})

test("碎片禅编辑器仍可打开并通过 Escape 关闭", async ({ page }) => {
  const fragmentCard = page.locator('[data-shard-fragment-id="fragment-august"]')
  await fragmentCard.getByRole("button", { name: "片段操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "禅模式", exact: true }).click()

  const zenEditor = page.getByLabel("禅模式片段编辑器", { exact: true })
  await expect(zenEditor).toBeVisible()
  await page.keyboard.press("Escape")

  await expect(zenEditor).toHaveCount(0)
  await expect(fragmentCard).toBeVisible()
})

test("侧栏思维导图入口仍打开原有全屏工作区", async ({ page }) => {
  const sidebar = page.getByRole("navigation", { name: "工作台导航" })
  await sidebar.getByRole("button", { name: "思维导图 1", exact: true }).click()
  await page.getByLabel("打开思维导图：项目导图", { exact: true }).click()

  const exitButton = page.getByRole("button", {
    name: "退出思维导图",
    exact: true,
  })
  await expect(exitButton).toBeVisible()
  await expect(page.getByLabel("思维导图编辑器", { exact: true })).toBeVisible()
  await expect(sidebar).toHaveCount(0)

  await exitButton.click()
  await expect(exitButton).toHaveCount(0)
  await expect(sidebar).toBeVisible()
})

test("资料库笔记粘贴图片会调用共享上传命令", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", { name: "项目", exact: true }).click()
  await page.getByRole("region", { name: "notes/项目 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 项目计划.md", exact: true })
    .click()

  const editor = page.locator('[data-shard-editor="library:note-plan"]')
  await editor.locator(".cm-content").evaluate((element) => {
    const clipboardData = new DataTransfer()
    clipboardData.items.add(
      new File([new Uint8Array([137, 80, 78, 71])], "library-paste.png", {
        type: "image/png",
      })
    )
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      })
    )
  })

  await expect.poll(() => commandCalls(page, "save_fragment_image")).toHaveLength(1)
  expect((await commandCalls(page, "save_fragment_image"))[0].args).toEqual({
    bytes: [137, 80, 78, 71],
    fileName: "library-paste.png",
  })
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
  await treePane.getByRole("button", {
    name: "资料库根目录（3）",
    exact: true,
  }).click()
  const rootList = page.getByRole("region", { name: "notes 目录列表", exact: true })
  await expect(rootList.getByRole("button", { name: "打开文件 八月灵感.md", exact: true })).toBeVisible()
  await rootList.getByRole("button", { name: "八月灵感.md 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "转为碎片", exact: true }).click()

  await expect.poll(() => commandCalls(page, "convert_note_to_fragment")).toHaveLength(1)
  expect((await commandCalls(page, "convert_note_to_fragment"))[0].args).toEqual({
    id: "fragment-august",
  })
  await expect(rootList.getByRole("button", { name: "打开文件 八月灵感.md", exact: true })).toHaveCount(0)
})

test("未配置密匣时点击树上挂载点直接进入设置流程", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })

  const mount = treePane.getByRole("button", {
    name: "密匣（上锁空间）",
    exact: true,
  })
  await expect(mount).toBeVisible()
  // 挂载点是一扇门不是文件夹：无展开箭头、不列子文件
  await expect(mount.locator("svg")).toHaveCount(1)
  await mount.click()
  await expect(page.getByRole("heading", { name: "设置密匣" })).toBeVisible()
})

test("解锁密匣后从资料库菜单移入笔记并刷新资料库树", async ({ page }) => {
  // 本用例需要已配置且解锁的密匣：局部覆盖全局的「未配置」默认 mock
  await installLibraryTreeMock(page, {
    configured: true,
    unlocked: true,
    expiresAt: null,
    ttlSeconds: 900,
  })
  await page.goto("/")
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: "资料库根目录（2）",
    exact: true,
  }).click()
  const rootList = page.getByRole("region", { name: "notes 目录列表", exact: true })
  const note = rootList.getByRole("button", { name: "打开文件 旧笔记.md", exact: true })
  await expect(note).toBeVisible()

  page.once("dialog", (dialog) => dialog.accept())
  await rootList
    .getByRole("button", { name: "旧笔记.md 操作", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "移入密匣", exact: true }).click()

  await expect.poll(() => commandCalls(page, "move_fragment_to_lockbox")).toHaveLength(1)
  expect((await commandCalls(page, "move_fragment_to_lockbox"))[0].args).toEqual({
    id: "note-old",
  })
  await expect(note).toHaveCount(0)
})

test("目录列表里的文件可重命名、移动和删除", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: "资料库根目录（2）",
    exact: true,
  }).click()
  const rootList = page.getByRole("region", { name: "notes 目录列表", exact: true })

  await rootList.getByRole("button", {
    name: "项目导图.shardmap.json 操作",
    exact: true,
  }).click()
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click()
  const renameInput = rootList.getByRole("textbox", {
    name: "重命名名称",
    exact: true,
  })
  await expect(renameInput).toHaveValue("项目导图")
  await renameInput.fill("架构总览")
  await renameInput.press("Enter")
  await expect(
    rootList.getByRole("button", {
      name: "打开文件 架构总览.shardmap.json",
      exact: true,
    })
  ).toBeVisible()

  await rootList.getByRole("button", {
    name: "架构总览.shardmap.json 操作",
    exact: true,
  }).click()
  await page.getByRole("menuitem", { name: "移动到…", exact: true }).hover()
  await page.getByRole("menuitem", { name: "项目", exact: true }).click()
  await treePane.getByRole("button", { name: "项目", exact: true }).click()
  const projectList = page.getByRole("region", {
    name: "notes/项目 目录列表",
    exact: true,
  })
  await expect(
    projectList.getByRole("button", {
      name: "打开文件 架构总览.shardmap.json",
      exact: true,
    })
  ).toBeVisible()

  await projectList.getByRole("button", {
    name: "架构总览.shardmap.json 操作",
    exact: true,
  }).click()
  await page.getByRole("menuitem", { name: "删除", exact: true }).click()
  await page.getByRole("dialog", { name: "确认删除" })
    .getByRole("button", { name: "删除", exact: true })
    .click()

  await expect.poll(() => commandCalls(page, "rename_library_entry")).toHaveLength(1)
  await expect.poll(() => commandCalls(page, "move_library_entry")).toHaveLength(1)
  await expect.poll(() => commandCalls(page, "delete_library_entry")).toHaveLength(1)
  expect((await commandCalls(page, "rename_library_entry"))[0].args).toEqual({
    newName: "架构总览",
    path: "notes/项目导图.shardmap.json",
  })
  expect((await commandCalls(page, "move_library_entry"))[0].args).toEqual({
    destinationDirectory: "notes/项目",
    path: "notes/架构总览.shardmap.json",
  })
  expect((await commandCalls(page, "delete_library_entry"))[0].args).toEqual({
    path: "notes/项目/架构总览.shardmap.json",
  })
  await expect(
    projectList.getByRole("button", {
      name: "打开文件 架构总览.shardmap.json",
      exact: true,
    })
  ).toHaveCount(0)
})

test("目录宫格里的文件可重命名、移动和删除，菜单按 hover 或 focus 显形", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: "资料库根目录（2）",
    exact: true,
  }).click()
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  await viewer.getByRole("button", { name: "宫格视图", exact: true }).click()
  const rootGrid = viewer.getByRole("list", { name: "notes 目录宫格", exact: true })
  const noteCard = rootGrid.getByRole("button", {
    name: "打开文件 旧笔记.md",
    exact: true,
  })
  const noteMenu = rootGrid.getByRole("button", {
    name: "旧笔记.md 操作",
    exact: true,
  })

  await expect(noteMenu.locator("..")).toHaveCSS("opacity", "0")
  await noteCard.hover()
  await expect(noteMenu.locator("..")).toHaveCSS("opacity", "1")
  await noteMenu.click()
  await expect(page.getByRole("menuitem", { name: "转为碎片", exact: true })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "移入密匣", exact: true })).toBeVisible()
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click()
  const renameInput = rootGrid.getByRole("textbox", {
    name: "重命名名称",
    exact: true,
  })
  await renameInput.fill("宫格笔记")
  await renameInput.press("Enter")

  await treePane.getByRole("button", {
    name: "资料库根目录（2）",
    exact: true,
  }).click()
  const renamedMenu = viewer.getByRole("list", {
    name: "notes 目录宫格",
    exact: true,
  }).getByRole("button", { name: "宫格笔记.md 操作", exact: true })
  await renamedMenu.focus()
  await expect(renamedMenu.locator("..")).toHaveCSS("opacity", "1")
  await renamedMenu.click()
  await page.getByRole("menuitem", { name: "移动到…", exact: true }).hover()
  await page.getByRole("menuitem", { name: "项目", exact: true }).click()

  await treePane.getByRole("button", { name: "项目", exact: true }).click()
  const projectGrid = viewer.getByRole("list", {
    name: "notes/项目 目录宫格",
    exact: true,
  })
  const projectMenu = projectGrid.getByRole("button", {
    name: "宫格笔记.md 操作",
    exact: true,
  })
  // 宫格菜单靠 hover/focus 显形，直接 click 会被缩略图挡住命中测试。
  await projectMenu.focus()
  await projectMenu.click()
  await page.getByRole("menuitem", { name: "删除", exact: true }).click()
  await page.getByRole("dialog", { name: "确认删除" })
    .getByRole("button", { name: "删除", exact: true })
    .click()

  await expect.poll(() => commandCalls(page, "rename_library_entry")).toHaveLength(1)
  await expect.poll(() => commandCalls(page, "move_library_entry")).toHaveLength(1)
  await expect.poll(() => commandCalls(page, "delete_library_entry")).toHaveLength(1)
  await expect(projectGrid.getByRole("button", {
    name: "打开文件 宫格笔记.md",
    exact: true,
  })).toHaveCount(0)
})

test("第三栏菜单只给 Markdown 提供转碎片和移入密匣", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: "资料库根目录（2）",
    exact: true,
  }).click()
  const rootList = page.getByRole("region", { name: "notes 目录列表", exact: true })

  await rootList.getByRole("button", { name: "旧笔记.md 操作", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "转为碎片", exact: true })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "移入密匣", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  // 菜单需完全卸载再开下一个，否则两个菜单并存会撞 strict mode。
  await expect(page.getByRole("menu")).toHaveCount(0)

  for (const name of ["清单.csv", "项目导图.shardmap.json", "项目"]) {
    await rootList.getByRole("button", { name: `${name} 操作`, exact: true }).click()
    await expect(page.getByRole("menuitem", { name: "重命名", exact: true })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "移动到…", exact: true })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "删除", exact: true })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "转为碎片", exact: true })).toHaveCount(0)
    await expect(page.getByRole("menuitem", { name: "移入密匣", exact: true })).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(page.getByRole("menu")).toHaveCount(0)
  }
})

test("目录树 MVP 支持新建、重命名、菜单移动和非空目录整棵移入回收站", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })

  await treePane.getByRole("button", { name: "新建目录", exact: true }).click()
  const dirInput = treePane.getByRole("textbox", {
    name: "新目录名称",
    exact: true,
  })
  await dirInput.fill("空目录")
  await dirInput.press("Enter")
  await expect(treePane.getByRole("button", { name: "空目录", exact: true })).toBeVisible()

  await treePane.getByRole("button", { name: "新建笔记", exact: true }).click()
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  const noteNameInput = viewer.getByRole("textbox", {
    name: "重命名名称",
    exact: true,
  })
  await expect(noteNameInput).toHaveValue("未命名")
  await noteNameInput.press("Escape")
  const rootList = viewer.getByRole("region", { name: "notes 目录列表", exact: true })
  await expect(rootList.getByRole("button", { name: "打开文件 未命名.md", exact: true })).toBeVisible()

  await rootList.getByRole("button", { name: "打开文件 未命名.md", exact: true }).click()
  await page.getByRole("button", { name: "重命名文件", exact: true }).click()
  const editorRenameInput = page.getByRole("textbox", {
    name: "重命名名称",
    exact: true,
  })
  await editorRenameInput.fill("已改名")
  await editorRenameInput.press("Enter")
  await expect(page.getByRole("button", { name: "重命名文件", exact: true })).toHaveText(
    "已改名"
  )
  await expect.poll(() => readEditor(page, "library:note-created-5")).toBe("# 未命名")

  await treePane.getByRole("button", {
    name: "资料库根目录（3）",
    exact: true,
  }).click()
  await viewer.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "已改名.md 操作", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "移动到…", exact: true }).hover()
  await page.getByRole("menuitem", { name: "项目", exact: true }).click()
  await treePane.getByRole("button", { name: "项目", exact: true }).click()
  await expect(viewer.getByRole("region", { name: "notes/项目 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 已改名.md", exact: true })).toBeVisible()

  await treePane.getByRole("button", {
    name: "资料库根目录（3）",
    exact: true,
  }).click()
  await viewer.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "项目 操作", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "删除", exact: true }).click()
  const projectDialog = page.getByRole("dialog", { name: "确认删除", exact: true })
  await projectDialog.getByRole("button", { name: "删除", exact: true }).click()
  await expect.poll(() => commandCalls(page, "delete_library_entry")).toHaveLength(1)
  await expect(treePane.getByRole("button", { name: "项目", exact: true })).toHaveCount(0)

  await treePane.getByRole("button", { name: "空目录 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "删除", exact: true }).last().click()
  const dialog = page.getByRole("dialog", { name: "确认删除" })
  await dialog.getByRole("button", { name: "删除", exact: true }).click()
  await expect.poll(() => commandCalls(page, "delete_library_entry")).toHaveLength(2)
  await expect(treePane.getByRole("button", { name: "空目录", exact: true })).toHaveCount(0)
  expect((await commandCalls(page, "create_library_directory"))[0].args).toEqual({
    name: "空目录",
    parentPath: "notes",
  })
  expect((await commandCalls(page, "create_library_note"))[0].args).toEqual({
    parentPath: "notes",
    title: "未命名",
  })
  expect((await commandCalls(page, "rename_library_entry"))[0].args).toEqual({
    newName: "已改名",
    path: "notes/未命名.md",
  })
  expect((await commandCalls(page, "move_library_entry"))[0].args).toEqual({
    destinationDirectory: "notes/项目",
    path: "notes/已改名.md",
  })
})

test("重命名批量更新旧 wikilink 后仍可从别名链接导航", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: "资料库根目录（2）",
    exact: true,
  }).click()
  const rootList = page.getByRole("region", { name: "notes 目录列表", exact: true })

  await rootList.getByRole("button", { name: "旧笔记.md 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click()
  const renameInput = rootList.getByRole("textbox", {
    name: "重命名名称",
    exact: true,
  })
  await renameInput.fill("新笔记")
  await renameInput.press("Enter")
  await expect(page.getByText("已更新 1 处双链引用", { exact: true })).toBeVisible()
  expect((await commandCalls(page, "rename_library_entry"))[0].args).toEqual({
    newName: "新笔记",
    path: "notes/旧笔记.md",
  })

  await treePane.getByRole("button", { name: "项目", exact: true }).click()
  await page.getByRole("region", { name: "notes/项目 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 项目计划.md", exact: true })
    .click()
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

test("资料库图片分组在第三栏打开网格并保留侧栏与目录树", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  const sidebar = page.getByRole("navigation", { name: "工作台导航" })

  const group = treePane.getByRole("button", { name: "图片（1）", exact: true })
  await expect(group).toBeVisible()
  await group.click()

  // 网格就地展示，不接管窗口——侧栏与目录树都还在。
  await expect(page.getByRole("list", { name: "图片列表" })).toBeVisible()
  await expect(
    page.getByRole("list", { name: "图片列表" }).locator("img")
  ).toHaveAttribute(
    "src",
    "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="
  )
  await expect(sidebar).toBeVisible()
  await expect(treePane).toBeVisible()

  // 网格是列表视图，没有「专注编辑」语义。
  await expect(
    page.getByRole("button", { name: "进入禅模式", exact: true })
  ).toHaveCount(0)
})

test("图片网格可进单张视图并返回", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", { name: "图片（1）", exact: true }).click()

  await page.getByRole("list", { name: "图片列表" }).getByRole("button").first().click()
  await expect(
    page.getByRole("button", { name: "返回图片列表", exact: true })
  ).toBeVisible()

  // 单张大图有专注语义，禅按钮回来了。
  await expect(
    page.getByRole("button", { name: "进入禅模式", exact: true })
  ).toBeVisible()

  await page.getByRole("button", { name: "返回图片列表", exact: true }).click()
  await expect(page.getByRole("list", { name: "图片列表" })).toBeVisible()
})

test("没有图片时不渲染图片分组", async ({ page }) => {
  await installLibraryTreeMock(page, DEFAULT_LOCKBOX_STATE, false)
  await page.goto("/")

  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await expect(treePane.getByRole("button", { name: /^图片（/ })).toHaveCount(0)
  // 其余分组不受影响。
  await expect(
    treePane.getByRole("button", {
      name: "项目导图.shardmap.json",
      exact: true,
    })
  ).toHaveCount(0)
  await expect(
    treePane.getByRole("button", { name: /^思维导图（/ })
  ).toHaveCount(0)
})
