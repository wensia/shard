import { expect, test, type Locator, type Page } from "@playwright/test"
import type { LibraryTreeEntry, LibraryTreeSnapshot } from "../../src/types"

interface CommandCall {
  command: string
  args: Record<string, unknown>
}

interface SelectionMock {
  calls: CommandCall[]
  failPaths: string[]
  failAfterPaths: string[]
  snapshot(): LibraryTreeSnapshot
}

type MockWindow = Window & { __librarySelection: SelectionMock }

const FILES = [
  "A 笔记.md",
  "B 清单.csv",
  "C 表格.shardtable.json",
  "D 画布.shardcanvas.json",
  "E 导图.shardmap.json",
  "F 这是一份用于核对宫格文件卡片单行省略和完整名称提示的超长附件名称.pdf",
]

// A small in-memory vault: real UI and command contracts, no user's filesystem.
async function installSelectionMock(page: Page, extraFileCount = 0) {
  await page.addInitScript(({ longName, extraFileCount }: { longName: string; extraFileCount: number }) => {
    const now = "2026-09-08T10:00:00.000Z"
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const entry = (name: string, kind: LibraryTreeEntry["kind"], parent = "notes"): LibraryTreeEntry => ({
      name, kind, path: `${parent}/${name}`, size: 128, modifiedAt: now,
      ...(kind === "directory" ? { children: [] } : {}),
    })
    const entries = [
      entry("归档", "directory"),
      { ...entry("资料", "directory"), children: [
        entry("内页.md", "markdown", "notes/资料"),
        entry("子目录", "directory", "notes/资料"),
      ] },
      entry("A 笔记.md", "markdown"),
      entry("B 清单.csv", "csv"),
      entry("C 表格.shardtable.json", "table"),
      entry("D 画布.shardcanvas.json", "canvas"),
      entry("E 导图.shardmap.json", "mindmap"),
      entry(longName, "file"),
      ...Array.from({ length: extraFileCount }, (_, index) => entry(`Z 附件 ${String(index + 1).padStart(2, "0")}.pdf`, "file")),
    ]
    const fragments = ["notes/A 笔记.md", "notes/资料/内页.md"].map((path, index) => ({
      id: `note-${index}`, path, content: `# ${index ? "内页" : "A 笔记"}\n正文`,
      createdAt: now, updatedAt: now, tags: ["inbox", "note"], category: null,
      gitStatus: "committed", error: null, archived: false, lockbox: false, pinned: false, related: [],
    }))
    const trashEntries: LibraryTreeEntry[] = []
    const git = { branch: "main", shortCommit: "test123", hasRemote: false, status: "ready", error: null, ahead: 0, behind: 0 }
    const snapshot = (): LibraryTreeSnapshot => clone({
      entries, trashEntries, fragmentTrashEntries: [], assets: [], fragmentStream: { totalCount: 0, years: [] },
    })
    const state: SelectionMock = { calls: [], failPaths: [], failAfterPaths: [], snapshot }
    const find = (path: string, items = entries): LibraryTreeEntry | undefined => {
      for (const item of items) {
        if (item.path === path) return item
        const nested = find(path, item.children ?? [])
        if (nested) return nested
      }
    }
    const remove = (path: string, items = entries): LibraryTreeEntry | undefined => {
      const index = items.findIndex(item => item.path === path)
      if (index >= 0) return items.splice(index, 1)[0]
      for (const item of items) {
        const nested = remove(path, item.children ?? [])
        if (nested) return nested
      }
    }
    const rebase = (item: LibraryTreeEntry, oldPath: string, nextPath: string) => {
      item.path = nextPath + item.path.slice(oldPath.length)
      item.children?.forEach(child => rebase(child, oldPath, nextPath))
    }
    Object.assign(window, {
      isTauri: true,
      __librarySelection: state,
      __TAURI_INTERNALS__: {
        convertFileSrc: (path: string) => `asset://localhost/${path}`,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          state.calls.push({ command, args: clone(args) })
          if (command === "list_fragments") return clone({
            vaultPath: "/tmp/shard-multiselect-test", fragments, git,
            lockbox: { configured: false, unlocked: false, expiresAt: null, ttlSeconds: 900 },
          })
          if (command === "list_library_tree") return snapshot()
          if (command === "migrate_legacy_notes") return { tree: snapshot(), migratedCount: 0 }
          if (command === "list_mind_maps" || command === "list_csv_files") return []
          if (command === "plugin:app|version") return "0.1.3-test"
          if (command === "restore_window_frame") return null
          if (command === "sync_vault") return clone(git)
          if (command === "read_csv_file") return Array.from(new TextEncoder().encode("名称,状态\n测试,进行中"))
          if (command === "read_canvas") return { file: { nodes: [], edges: [] } }
          if (command === "rename_library_entry") {
            const path = String(args.path)
            const item = find(path)
            if (!item) throw new Error(`文件不存在：${path}`)
            const extension = item.name.match(/(\.shard(?:map|table|canvas|flow)\.json|\.md|\.csv)$/u)?.[1] ?? ""
            const name = String(args.newName)
            item.name = extension && !name.endsWith(extension) ? name + extension : name
            const nextPath = `${path.slice(0, path.lastIndexOf("/"))}/${item.name}`
            rebase(item, path, nextPath)
            const fragment = fragments.find(fragment => fragment.path === path)
            if (fragment) fragment.path = nextPath
            return { tree: snapshot(), updatedLinks: 0, ...(fragment ? { fragment: clone(fragment) } : {}) }
          }
          if (command === "create_library_directory" || command === "create_library_note") {
            const parentPath = String(args.parentPath)
            const children = parentPath === "notes" ? entries : find(parentPath)?.children
            if (!children) throw new Error(`目录不存在：${parentPath}`)
            if (command === "create_library_directory") {
              children.push(entry(String(args.name), "directory", parentPath))
              return { tree: snapshot(), updatedLinks: 0 }
            }
            const title = String(args.title)
            const item = entry(`${title}.md`, "markdown", parentPath)
            const fragment = { ...clone(fragments[0]), id: "note-created", path: item.path, content: `# ${title}` }
            children.push(item)
            fragments.push(fragment)
            return { tree: snapshot(), updatedLinks: 0, fragment: clone(fragment) }
          }
          if (command === "move_library_entry" || command === "delete_library_entry") {
            const path = String(args.path)
            if (state.failPaths.includes(path)) throw new Error(`${path}：模拟文件占用`)
            const item = remove(path)
            if (!item) throw new Error(`文件不存在：${path}`)
            const destination = command === "delete_library_entry" ? ".trash/notes" : String(args.destinationDirectory)
            const children = destination === ".trash/notes" ? trashEntries
              : destination === "notes" ? entries : find(destination)?.children
            if (!children) throw new Error(`目录不存在：${destination}`)
            const nextPath = `${destination}/${item.name}`
            rebase(item, path, nextPath)
            children.push(item)
            for (const fragment of fragments) {
              if (fragment.path === path || fragment.path.startsWith(`${path}/`)) {
                fragment.path = nextPath + fragment.path.slice(path.length)
                fragment.archived = command === "delete_library_entry"
              }
            }
            if (state.failAfterPaths.includes(path)) throw new Error(`${path}：操作后目录回包失败`)
            return { tree: snapshot(), updatedLinks: 0 }
          }
          throw new Error(`Unhandled selection test command: ${command}`)
        },
      },
    })
    localStorage.setItem("shard.library-directory-view", "list")
    localStorage.setItem("shard.library-directory-sort", JSON.stringify({ key: "name", direction: "asc" }))
  }, { longName: FILES[5], extraFileCount })
}

function checkbox(page: Page, name: string) {
  return page.getByRole("checkbox", { name: `选择 ${name}`, exact: true })
}

function entryButton(page: Page, name: string) {
  return page.getByRole("button", { name: new RegExp(`^(?:打开|选择)(?:文件|目录) ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "u") })
}

async function commandCalls(page: Page, command: string) {
  return page.evaluate(target => (window as MockWindow).__librarySelection.calls.filter(call => call.command === target), command)
}

async function select(page: Page, names: string[]) {
  await page.getByRole("button", { name: "多选文件", exact: true }).click()
  for (const name of names) await checkbox(page, name).click()
  await expect(page.getByText(`已选 ${names.length} 项`, { exact: true })).toBeVisible()
}

async function tokenColor(locator: Locator, token: string) {
  return locator.evaluate((element, variable) => {
    const probe = document.createElement("span")
    probe.style.backgroundColor = `var(${variable})`
    element.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  }, token)
}

async function expectSelectionToolbarColors(toolbar: Locator, selectionAction: "全选" | "取消全选") {
  const primary = await tokenColor(toolbar, "--primary")
  const done = toolbar.getByRole("button", { name: "完成", exact: true })
  await expect(done).toHaveCSS("background-color", primary)
  await expect(done).toHaveCSS("color", await tokenColor(toolbar, "--primary-foreground"))
  for (const name of [selectionAction, "移动到…"]) {
    const button = toolbar.getByRole("button", { name, exact: true })
    await expect(button).toHaveCSS("background-color", await tokenColor(toolbar, "--card"))
    await expect(button).toHaveCSS("color", await tokenColor(toolbar, "--foreground"))
  }
  const remove = toolbar.getByRole("button", { name: "批量删除", exact: true })
  await expect(remove).toHaveCSS("color", await tokenColor(toolbar, "--destructive"))
  await expect(remove).not.toHaveCSS("background-color", primary)
  const primaryActions = await toolbar.getByRole("button").evaluateAll((buttons, color) => buttons
    .filter(button => getComputedStyle(button).backgroundColor === color)
    .map(button => button.textContent?.trim()), primary)
  expect(primaryActions).toEqual(["完成"])
}

test.beforeEach(async ({ page }) => {
  await installSelectionMock(page)
  await page.goto("/")
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: /^文件（/u }).click()
  await expect(page.getByRole("region", { name: "notes 目录列表", exact: true })).toBeVisible()
})

test("列表和宫格都能选择混合文件，普通点击只切换选择且视图切换保留选择", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "多选文件", exact: true }).click()
  for (const name of FILES.slice(0, 5)) await entryButton(page, name).click()
  await expect(page.getByText("已选 5 项", { exact: true })).toBeVisible()
  for (const name of FILES.slice(0, 5)) await expect(checkbox(page, name)).toBeChecked()
  await expect(page.getByRole("region", { name: "notes 目录列表", exact: true })).toBeVisible()
  const toolbar = page.locator('[aria-label="文件批量操作"]')
  await page.mouse.move(0, 0)
  await expectSelectionToolbarColors(toolbar, "全选")

  const selectedRow = page.locator('tr[data-path="notes/A 笔记.md"]')
  await selectedRow.hover()
  await expect(selectedRow).toHaveCSS("background-color", await tokenColor(selectedRow, "--table-row-selected"))
  await page.screenshot({ path: testInfo.outputPath("multiselect-list.png") })
  await page.getByRole("button", { name: "宫格视图", exact: true }).click()
  await expect(page.getByRole("list", { name: "notes 目录宫格", exact: true })).toBeVisible()
  for (const name of FILES.slice(0, 5)) await expect(checkbox(page, name)).toBeChecked()
  const selectedCard = page.locator('li[data-path="notes/A 笔记.md"]')
  await expect(selectedCard).toHaveAttribute("data-selected", "true")
  await selectedCard.hover()
  const selectedBorder = await selectedCard.evaluate(element => getComputedStyle(element).borderColor)
  const unselectedBorder = await page.locator(`li[data-path="notes/${FILES[5]}"]`).evaluate(element => getComputedStyle(element).borderColor)
  expect(selectedBorder).not.toBe(unselectedBorder)
  await page.screenshot({ path: testInfo.outputPath("multiselect-grid.png") })
  await page.setViewportSize({ width: 640, height: 720 })
  await expect(toolbar.getByRole("button", { name: "完成", exact: true })).toBeVisible()
  const toolbarBounds = await toolbar.boundingBox()
  const actionBounds = await toolbar.getByRole("button", { name: "完成", exact: true }).boundingBox()
  expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(toolbarBounds!.x + toolbarBounds!.width + 1)
  expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(640)
  await page.screenshot({ path: testInfo.outputPath("multiselect-narrow.png") })
  await page.setViewportSize({ width: 1280, height: 720 })

  await entryButton(page, FILES[2]).click()
  await expect(page.getByText("已选 4 项", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "列表视图", exact: true }).click()
  await expect(checkbox(page, FILES[2])).not.toBeChecked()
  await expect(checkbox(page, FILES[0])).toBeChecked()
})

test("Command 点击切换、Shift 连选、Control 全选和 Escape 均限定当前目录", async ({ page }) => {
  await entryButton(page, FILES[0]).click({ modifiers: ["Meta"] })
  await expect(page.getByText("已选 1 项", { exact: true })).toBeVisible()
  await entryButton(page, FILES[3]).click({ modifiers: ["Shift"] })
  for (const name of FILES.slice(0, 4)) await expect(checkbox(page, name)).toBeChecked()
  await expect(checkbox(page, "资料")).not.toBeChecked()
  await entryButton(page, FILES[1]).click({ modifiers: ["Meta"] })
  await expect(checkbox(page, FILES[1])).not.toBeChecked()
  await expect(page.getByText("已选 3 项", { exact: true })).toBeVisible()
  await page.keyboard.press("Control+A")
  await expect(page.getByText("已选 8 项", { exact: true })).toBeVisible()
  await expect(page.getByRole("checkbox", { name: "全选当前目录", exact: true })).toBeChecked()
  await page.getByRole("button", { name: "取消全选", exact: true }).click()
  await expect(page.locator('[aria-label="文件批量操作"]')).toBeHidden()
  await expect(page.getByRole("button", { name: "多选文件", exact: true })).toHaveAttribute("aria-pressed", "false")
  await page.getByRole("region", { name: "notes 目录列表", exact: true }).focus()
  await page.keyboard.press("Control+A")
  await expect(page.getByText("已选 8 项", { exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "多选文件", exact: true })).toBeVisible()
  await expect(page.getByRole("checkbox", { name: /^选择 /u, checked: true })).toHaveCount(0)
})

for (const mode of ["列表", "宫格"] as const) {
  test(`${mode}取消最后一项或全部选择即退出多选并移除底部操作栏`, async ({ page }) => {
    await page.getByRole("button", { name: `${mode}视图`, exact: true }).click()
    const toolbar = page.locator('[aria-label="文件批量操作"]')
    const toggle = page.getByRole("button", { name: "多选文件", exact: true })
    const surface = mode === "列表"
      ? page.getByRole("region", { name: "notes 目录列表", exact: true })
      : page.getByRole("list", { name: "notes 目录宫格", exact: true })
    const expectCleared = async () => {
      await expect(toolbar).toBeHidden()
      await expect(toggle).toHaveAttribute("aria-pressed", "false")
      await expect(page.getByRole("checkbox", { name: /^选择 /u, checked: true })).toHaveCount(0)
    }

    // 显式多选保留空选择准备态，操作栏只服务已经选中的文件。
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-pressed", "true")
    await expect(toolbar).toBeHidden()
    await entryButton(page, FILES[0]).click()
    await expect(toolbar).toContainText("已选 1 项")
    await entryButton(page, FILES[0]).click()
    await expectCleared()

    await entryButton(page, FILES[0]).hover()
    await checkbox(page, FILES[0]).click()
    await expect(toolbar).toContainText("已选 1 项")
    await checkbox(page, FILES[0]).click()
    await expectCleared()

    await entryButton(page, FILES[0]).click({ modifiers: ["Meta"] })
    await expect(toolbar).toContainText("已选 1 项")
    await entryButton(page, FILES[0]).click({ modifiers: ["Meta"] })
    await expectCleared()

    await entryButton(page, FILES[0]).click({ modifiers: ["Meta"] })
    await toolbar.getByRole("button", { name: "全选", exact: true }).click()
    await expect(toolbar).toContainText("已选 8 项")
    await page.mouse.move(0, 0)
    await expectSelectionToolbarColors(toolbar, "取消全选")
    const scrollBeforeClear = await surface.evaluate(element => element.scrollTop)
    await toolbar.getByRole("button", { name: "取消全选", exact: true }).click()
    await expectCleared()
    await expect(surface).toBeFocused()
    expect(await surface.evaluate(element => element.scrollTop)).toBe(scrollBeforeClear)
    await page.keyboard.press("Control+A")
    await expect(toolbar).toContainText("已选 8 项")
    const scrollBeforeDone = await surface.evaluate(element => element.scrollTop)
    await toolbar.getByRole("button", { name: "完成", exact: true }).click()
    await expectCleared()
    await expect(surface).toBeFocused()
    expect(await surface.evaluate(element => element.scrollTop)).toBe(scrollBeforeDone)
    await page.keyboard.press("Control+A")
    await expect(toolbar).toContainText("已选 8 项")
    await page.keyboard.press("Escape")
    await expectCleared()
    if (mode === "列表") {
      const selectAll = page.getByRole("checkbox", { name: "全选当前目录", exact: true })
      await selectAll.check()
      await expect(toolbar).toContainText("已选 8 项")
      await selectAll.uncheck()
      await expectCleared()
    }

    // 最后一项取消后普通单击恢复打开文件，不能停留在隐形多选状态。
    await entryButton(page, FILES[0]).click()
    await expect(page.locator('[data-shard-editor="library:note-0"] .cm-content')).toBeVisible()
  })

  test(`${mode}底部批量操作栏显示隐藏不改变文件或操作按钮坐标`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole("button", { name: `${mode}视图`, exact: true }).click()
    const surface = mode === "列表"
      ? page.getByRole("region", { name: "notes 目录列表", exact: true })
      : page.getByRole("list", { name: "notes 目录宫格", exact: true })
    const item = page.locator(`${mode === "列表" ? "tr" : "li"}[data-path="notes/${FILES[0]}"]`)
    const fileActions = page.getByRole("button", { name: `${FILES[0]} 操作`, exact: true })
    const viewToggle = page.getByRole("button", { name: "宫格视图", exact: true })
    const elements = [surface, item, fileActions, viewToggle]
    const before = await Promise.all(elements.map(element => element.boundingBox()))
    const expectStable = async () => {
      for (const [index, element] of elements.entries()) {
        const actual = await element.boundingBox()
        for (const key of ["x", "y", "width", "height"] as const) {
          expect(actual![key], `${mode} ${index} ${key}`).toBeCloseTo(before[index]![key], 0)
        }
      }
    }
    await page.getByRole("button", { name: "多选文件", exact: true }).click()
    await expectStable()
    await entryButton(page, FILES[0]).click()
    await expect(page.locator('[aria-label="文件批量操作"]')).toBeVisible()
    await expectStable()
    await entryButton(page, FILES[0]).click()
    await expect(page.locator('[aria-label="文件批量操作"]')).toBeHidden()
    await expectStable()
  })

  test(`${mode}长目录滚到底仍可操作末项且批量操作栏固定在内容区底部`, async ({ page }) => {
    await installSelectionMock(page, 40)
    await page.reload()
    await page.getByRole("button", { name: "资料库", exact: true }).click()
    await page.getByRole("complementary", { name: "资料库目录" })
      .getByRole("button", { name: /^文件（/u }).click()
    await page.getByRole("button", { name: `${mode}视图`, exact: true }).click()
    const surface = mode === "列表"
      ? page.getByRole("region", { name: "notes 目录列表", exact: true })
      : page.getByRole("list", { name: "notes 目录宫格", exact: true })
    const toolbar = page.locator('[aria-label="文件批量操作"]')
    const viewer = page.getByRole("article", { name: "资料库查看器" })
    const lastName = "Z 附件 40.pdf"
    const last = page.locator(`${mode === "列表" ? "tr" : "li"}[data-path="notes/${lastName}"]`)
    for (const viewport of [{ width: 1280, height: 720 }, { width: 640, height: 560 }, { width: 390, height: 480 }]) {
      await page.setViewportSize(viewport)
      await surface.evaluate(element => { element.scrollTop = 0 })
      await entryButton(page, FILES[0]).click({ modifiers: ["Meta"] })
      await expect(toolbar).toBeVisible()
      const toolbarBefore = await toolbar.boundingBox()
      const viewerBox = await viewer.boundingBox()
      expect(toolbarBefore!.y).toBeGreaterThan(viewerBox!.y + viewerBox!.height / 2)
      expect(viewerBox!.y + viewerBox!.height - toolbarBefore!.y - toolbarBefore!.height).toBeGreaterThanOrEqual(-1)
      expect(viewerBox!.y + viewerBox!.height - toolbarBefore!.y - toolbarBefore!.height).toBeLessThanOrEqual(24)
      for (const button of await toolbar.getByRole("button").all()) {
        await expect(button).toBeInViewport()
        const bounds = await button.boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(toolbarBefore!.x)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(Math.min(viewport.width, toolbarBefore!.x + toolbarBefore!.width) + 1)
      }
      expect(await surface.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
      await surface.hover()
      await page.mouse.wheel(0, await surface.evaluate(element => element.scrollHeight))
      await expect.poll(() => surface.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      await expect(last).toBeInViewport()
      const lastBox = await last.boundingBox()
      const toolbarAfter = await toolbar.boundingBox()
      expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(toolbarAfter!.y + 1)
      expect(toolbarAfter!.y).toBeCloseTo(toolbarBefore!.y, 0)
      await entryButton(page, lastName).click()
      await expect(checkbox(page, lastName)).toBeChecked()
      await expect(toolbar).toContainText("已选 2 项")
      const selectedLastBox = await last.boundingBox()
      await toolbar.getByRole("button", { name: "完成", exact: true }).click()
      await expect(toolbar).toBeHidden()
      await expect(last).toBeInViewport()
      expect((await last.boundingBox())!.y).toBeCloseTo(selectedLastBox!.y, 0)
      expect(await page.evaluate(() => window.scrollY)).toBe(0)
    }
  })
}

test("390px矮窗批量操作部分失败的长错误局部滚动且保留操作与末项可达", async ({ page }) => {
  await installSelectionMock(page, 40)
  await page.reload()
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: /^文件（/u }).click()
  await page.getByRole("button", { name: "宫格视图", exact: true }).click()
  await page.setViewportSize({ width: 390, height: 480 })
  await page.evaluate(path => {
    const runtime = window as unknown as MockWindow & {
      __TAURI_INTERNALS__: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> }
    }
    runtime.__librarySelection.failPaths = [path]
    const original = runtime.__TAURI_INTERNALS__.invoke
    runtime.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      try { return await original(command, args) }
      catch (error) {
        if (command === "delete_library_entry" && args.path === path) {
          throw new Error("目录中的附件被其他程序占用，请关闭占用文件后重试。".repeat(16))
        }
        throw error
      }
    }
  }, `notes/${FILES[1]}`)
  await select(page, FILES.slice(0, 3))
  const toolbar = page.locator('[aria-label="文件批量操作"]')
  await toolbar.getByRole("button", { name: "批量删除", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "删除 3 项", exact: true }).click()
  await expect(toolbar).toContainText("已选 2 项")
  await expect(checkbox(page, FILES[1])).toBeChecked()
  await expect(checkbox(page, FILES[2])).toBeChecked()
  await expect(entryButton(page, FILES[0])).toHaveCount(0)
  const error = toolbar.getByRole("alert")
  await expect(error).toContainText("已完成 1/3 项")
  expect((await error.boundingBox())!.height).toBeLessThanOrEqual(96)
  expect(await error.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await expect(toolbar.getByRole("button", { name: "移动到…", exact: true })).toBeInViewport()
  await expect(toolbar.getByRole("button", { name: "完成", exact: true })).toBeInViewport()
  const surface = page.getByRole("list", { name: "notes 目录宫格", exact: true })
  await surface.hover()
  await page.mouse.wheel(0, await surface.evaluate(element => element.scrollHeight))
  const last = page.locator('li[data-path="notes/Z 附件 40.pdf"]')
  await expect(last).toBeInViewport()
  const lastBox = await last.boundingBox()
  const toolbarBox = await toolbar.boundingBox()
  expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(toolbarBox!.y + 1)
  await toolbar.getByRole("button", { name: "移动到…", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "归档", exact: true })).toBeInViewport()
  await page.keyboard.press("Escape")
  const scrollBeforeDone = await surface.evaluate(element => element.scrollTop)
  expect(scrollBeforeDone).toBeGreaterThan(0)
  await toolbar.getByRole("button", { name: "完成", exact: true }).click()
  await expect(toolbar).toBeHidden()
  await expect(surface).toBeFocused()
  expect(await surface.evaluate(element => element.scrollTop)).toBe(scrollBeforeDone)
  expect((await commandCalls(page, "delete_library_entry")).map(call => call.args.path)).toEqual(FILES.slice(0, 2).map(name => `notes/${name}`))
})

test("改名输入框保留全选文字快捷键，切换目录清空原目录选择", async ({ page }) => {
  await page.getByRole("button", { name: `${FILES[0]} 操作`, exact: true }).click()
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click()
  const rename = page.getByRole("textbox", { name: "重命名名称", exact: true })
  await rename.press("ArrowRight")
  await rename.press("ControlOrMeta+A")
  expect(await rename.evaluate((input: HTMLInputElement) => input.selectionEnd! - input.selectionStart!)).toBe((await rename.inputValue()).length)
  await expect(page.getByText(/^已选 \d+ 项$/u)).toBeHidden()
  await rename.press("Escape")
  await expect(rename).toHaveCount(0)
  await select(page, FILES.slice(0, 2))
  await page.getByRole("complementary", { name: "资料库目录" }).getByRole("button", { name: "资料", exact: true }).click()
  await expect(page.getByRole("region", { name: "notes/资料 目录列表", exact: true })).toBeVisible()
  await expect(page.getByText(/^已选 \d+ 项$/u)).toBeHidden()
  await expect(page.getByRole("button", { name: "多选文件", exact: true })).toBeVisible()
  await entryButton(page, "内页.md").click()
  await expect(page.locator('[data-shard-editor="library:note-1"] .cm-content')).toBeVisible()
})

test("混合文件与整目录可批量移动，目录后代跟随且源目录不残留选中项", async ({ page }) => {
  const names = [FILES[0], FILES[2], FILES[4], "资料"]
  await select(page, names)
  // 保持第一项请求待完成，观察真实忙碌状态，不依赖固定延迟。
  await page.evaluate(() => {
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> }
      __releaseLibraryMove?: () => void
    }
    const invoke = runtime.__TAURI_INTERNALS__.invoke
    let firstMove = true
    runtime.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === "move_library_entry" && firstMove) {
        firstMove = false
        await new Promise<void>(resolve => { runtime.__releaseLibraryMove = resolve })
      }
      return invoke(command, args)
    }
  })
  await page.getByRole("button", { name: "移动到…", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "资料", exact: true })).toHaveCount(0)
  await page.getByRole("menuitem", { name: "归档", exact: true }).click()
  const toolbar = page.locator('[aria-label="文件批量操作"]')
  await expect(toolbar).toHaveAttribute("aria-busy", "true")
  for (const button of await toolbar.getByRole("button").all()) await expect(button).toBeDisabled()
  expect(await commandCalls(page, "move_library_entry")).toHaveLength(0)
  for (const name of names) await expect(checkbox(page, name)).toBeChecked()
  await page.evaluate(() => {
    (window as unknown as { __releaseLibraryMove(): void }).__releaseLibraryMove()
  })
  await expect.poll(async () => (await commandCalls(page, "move_library_entry")).length).toBe(names.length)
  await expect(toolbar).toBeHidden()
  for (const name of names) await expect(entryButton(page, name)).toHaveCount(0)
  const calls = await commandCalls(page, "move_library_entry")
  expect(calls.map(call => call.args.path).sort()).toEqual(names.map(name => `notes/${name}`).sort())
  expect(calls.every(call => call.args.destinationDirectory === "notes/归档")).toBe(true)
  await page.getByRole("complementary", { name: "资料库目录" }).getByRole("button", { name: "归档", exact: true }).click()
  for (const name of names) await expect(entryButton(page, name)).toBeVisible()
  await entryButton(page, "资料").click()
  await expect(page.getByRole("region", { name: "notes/归档/资料 目录列表", exact: true })).toBeVisible()
  await expect(entryButton(page, "内页.md")).toBeVisible()
})

test("批量删除确认前不写入，取消保留选择，确认后只移入回收站", async ({ page }) => {
  const names = [FILES[0], FILES[1], FILES[3]]
  await select(page, names)
  await page.getByRole("button", { name: "批量删除", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  expect(await commandCalls(page, "delete_library_entry")).toHaveLength(0)
  await dialog.getByRole("button", { name: "取消", exact: true }).click()
  await expect(page.getByText("已选 3 项", { exact: true })).toBeVisible()
  for (const name of names) await expect(checkbox(page, name)).toBeChecked()
  expect(await commandCalls(page, "delete_library_entry")).toHaveLength(0)
  await page.getByRole("button", { name: "批量删除", exact: true }).click()
  await dialog.getByRole("button", { name: "删除 3 项", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  for (const name of names) await expect(entryButton(page, name)).toHaveCount(0)
  expect((await commandCalls(page, "delete_library_entry")).map(call => call.args.path).sort()).toEqual(names.map(name => `notes/${name}`).sort())
  const trash = await page.evaluate(() => (window as MockWindow).__librarySelection.snapshot().trashEntries.map(entry => entry.path))
  expect(trash.sort()).toEqual(names.map(name => `.trash/notes/${name}`).sort())
  expect(await commandCalls(page, "purge_from_trash")).toHaveLength(0)
})

for (const operation of ["move", "delete"] as const) {
  test(`批量${operation === "move" ? "移动" : "删除"}失败即停并保留待处理项，不自动重试`, async ({ page }) => {
    await page.evaluate(path => { (window as MockWindow).__librarySelection.failPaths = [path] }, `notes/${FILES[1]}`)
    await select(page, FILES.slice(0, 3))
    if (operation === "move") {
      await page.getByRole("button", { name: "移动到…", exact: true }).click()
      await page.getByRole("menuitem", { name: "归档", exact: true }).click()
    } else {
      await page.getByRole("button", { name: "批量删除", exact: true }).click()
      await page.getByRole("dialog").getByRole("button", { name: "删除 3 项", exact: true }).click()
    }
    await expect(page.getByText("已选 2 项", { exact: true })).toBeVisible()
    await expect(checkbox(page, FILES[1])).toBeChecked()
    await expect(entryButton(page, FILES[0])).toHaveCount(0)
    await expect(checkbox(page, FILES[2])).toBeChecked()
    await expect(page.getByRole("alert")).toContainText("模拟文件占用")
    await expect(page.getByRole("alert")).toContainText("已完成 1/3 项")
    const command = `${operation}_library_entry`
    expect((await commandCalls(page, command)).map(call => call.args.path)).toEqual(FILES.slice(0, 2).map(name => `notes/${name}`))
    await page.getByRole("button", { name: "宫格视图", exact: true }).click()
    await expect(checkbox(page, FILES[1])).toBeChecked()
    await page.getByRole("button", { name: "列表视图", exact: true }).click()
    await expect(page.getByText("已选 2 项", { exact: true })).toBeVisible()
    expect(await commandCalls(page, command)).toHaveLength(2)
  })
}

test("批量移动已经落盘但回包失败时刷新目录核对，只保留尚未执行的条目", async ({ page }) => {
  await page.evaluate(path => { (window as MockWindow).__librarySelection.failAfterPaths = [path] }, `notes/${FILES[1]}`)
  await select(page, FILES.slice(0, 3))
  await page.getByRole("button", { name: "移动到…", exact: true }).click()
  await page.getByRole("menuitem", { name: "归档", exact: true }).click()
  await expect(page.getByText("已选 1 项", { exact: true })).toBeVisible()
  await expect(checkbox(page, FILES[2])).toBeChecked()
  await expect(entryButton(page, FILES[0])).toHaveCount(0)
  await expect(entryButton(page, FILES[1])).toHaveCount(0)
  await expect(page.getByRole("alert")).toContainText("操作后目录回包失败")
  expect((await commandCalls(page, "move_library_entry")).map(call => call.args.path)).toEqual(FILES.slice(0, 2).map(name => `notes/${name}`))
  const moved = await page.evaluate(() => (window as MockWindow).__librarySelection.snapshot().entries.find(entry => entry.path === "notes/归档")?.children?.map(entry => entry.name))
  expect(moved?.sort()).toEqual(FILES.slice(0, 2).sort())
})

test("宫格卡片文件名单行省略且悬浮保留全名，移除第二行留白且窄窗不重叠", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "宫格视图", exact: true }).click()
  const card = page.locator(`li[data-path="notes/${FILES[5]}"]`)
  const header = card.locator('[data-slot="library-card-header"]')
  const preview = card.locator('[data-slot="library-card-preview"]')
  const name = card.locator('[data-slot="library-card-name"]')
  const type = card.locator('[data-slot="library-card-type"]')
  for (const width of [1280, 640]) {
    await page.setViewportSize({ width, height: 900 })
    await card.scrollIntoViewIfNeeded()
    await page.mouse.move(0, 0)
    await expect(header).toBeVisible()
    await expect(name).toHaveAttribute("title", FILES[5])
    const [cardBox, headBox, previewBox, nameBox, selectBox, typeBox, actionBox, sizeBox] = await Promise.all([
      card.boundingBox(), header.boundingBox(), preview.boundingBox(), name.boundingBox(),
      checkbox(page, FILES[5]).boundingBox(), type.boundingBox(),
      card.getByRole("button", { name: `${FILES[5]} 操作`, exact: true }).boundingBox(),
      card.getByText("128 B", { exact: true }).boundingBox(),
    ])
    expect(headBox!.y + headBox!.height).toBeLessThanOrEqual(previewBox!.y + 1)
    expect(previewBox!.y + previewBox!.height).toBeLessThanOrEqual(nameBox!.y + 1)
    expect(Math.abs(previewBox!.width / previewBox!.height - 4 / 3)).toBeLessThan(0.03)
    expect(selectBox!.x + selectBox!.width).toBeLessThanOrEqual(typeBox!.x + 1)
    expect(typeBox!.x + typeBox!.width).toBeLessThanOrEqual(actionBox!.x + 1)
    for (const control of [selectBox!, actionBox!]) {
      expect(control.y).toBeGreaterThanOrEqual(headBox!.y - 1)
      expect(control.y + control.height).toBeLessThanOrEqual(headBox!.y + headBox!.height + 1)
    }
    expect(nameBox!.x + nameBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1)
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(width + 1)
    const nameStyle = await name.evaluate(element => {
      const style = getComputedStyle(element)
      return {
        lineHeight: parseFloat(style.lineHeight),
        spacing: parseFloat(style.getPropertyValue("--space-1")),
        overflow: style.overflow,
        whiteSpace: style.whiteSpace,
        textOverflow: style.textOverflow,
        overflows: element.scrollWidth > element.clientWidth,
      }
    })
    expect(nameStyle.overflow).toBe("hidden")
    expect(nameStyle.whiteSpace).toBe("nowrap")
    expect(nameStyle.textOverflow).toBe("ellipsis")
    expect(nameStyle.overflows).toBe(true)
    expect(nameBox!.height / nameStyle.lineHeight).toBeGreaterThanOrEqual(0.9)
    expect(nameBox!.height / nameStyle.lineHeight).toBeLessThanOrEqual(1.1)
    expect(sizeBox!.y - nameBox!.y - nameBox!.height).toBeCloseTo(nameStyle.spacing, 0)
    await name.hover()
    await expect(name).toHaveAttribute("title", FILES[5])
    await page.screenshot({ path: testInfo.outputPath(`file-card-layout-${width}.png`) })
  }
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.getByRole("list", { name: "notes 目录宫格", exact: true }).evaluate(element => element.scrollTo({ top: 0 }))
  await page.screenshot({ path: testInfo.outputPath("file-card-layout-1920.png") })
})

for (const mode of ["列表", "宫格"] as const) {
  test(`${mode}右键单项按类型展示操作，关闭菜单不打开文件或留下选区`, async ({ page }, testInfo) => {
    await page.getByRole("button", { name: `${mode}视图`, exact: true }).click()
    const menu = page.locator('[data-slot="context-menu-content"]')
    for (const file of [FILES[0], FILES[2], "资料"]) {
      await entryButton(page, file).click({ button: "right" })
      await expect(menu).toBeVisible()
      await expect(menu.getByText(file, { exact: true })).toBeVisible()
      for (const action of ["打开", "重命名", "移动到…", "删除"]) {
        await expect(menu.getByRole("menuitem", { name: action, exact: true })).toBeVisible()
      }
      for (const action of ["转回碎片", "移入密匣"]) {
        await expect(menu.getByRole("menuitem", { name: action, exact: true })).toHaveCount(file === FILES[0] ? 1 : 0)
      }
      if (file === FILES[0]) await page.screenshot({ path: testInfo.outputPath(`context-menu-${mode}.png`) })
      await page.keyboard.press("Escape")
      await expect(menu).toHaveCount(0)
      await expect(page.getByText(/^已选 \d+ 项$/u)).toBeHidden()
      await expect(entryButton(page, file)).toBeVisible()
      await expect(page.locator('[data-shard-editor^="library:"]')).toHaveCount(0)
    }
    expect(await commandCalls(page, "delete_library_entry")).toHaveLength(0)
    expect(await commandCalls(page, "move_library_entry")).toHaveLength(0)
    expect(await commandCalls(page, "rename_library_entry")).toHaveLength(0)
  })

  test(`${mode}右键与省略号共享多选范围，右键未选项替换范围且批量删除只处理菜单中的项`, async ({ page }) => {
    await page.getByRole("button", { name: `${mode}视图`, exact: true }).click()
    await select(page, FILES.slice(0, 2))
    const context = page.locator('[data-slot="context-menu-content"]')
    const overflow = page.locator('[data-slot="dropdown-menu-content"]')
    await entryButton(page, FILES[1]).click({ button: "right" })
    await expect(context.getByText("已选 2 项", { exact: true })).toBeVisible()
    await expect(context.getByRole("menuitem", { name: "移动 2 项到…", exact: true })).toBeVisible()
    await expect(context.getByRole("menuitem", { name: "删除 2 项", exact: true })).toBeVisible()
    for (const action of ["打开", "重命名", "转回碎片", "移入密匣"]) {
      await expect(context.getByRole("menuitem", { name: action, exact: true })).toHaveCount(0)
    }
    await page.keyboard.press("Escape")
    await expect(context).toHaveCount(0)
    await page.getByRole("button", { name: `${FILES[1]} 操作`, exact: true }).click()
    await expect(overflow.getByText("已选 2 项", { exact: true })).toBeVisible()
    await expect(overflow.getByRole("menuitem", { name: "删除 2 项", exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(overflow).toHaveCount(0)

    await entryButton(page, FILES[2]).click({ button: "right" })
    await expect(context.getByText(FILES[2], { exact: true })).toBeVisible()
    await expect(context.getByRole("menuitem", { name: "删除", exact: true })).toBeVisible()
    await expect(context.getByRole("menuitem", { name: "重命名", exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(context).toHaveCount(0)
    await expect(checkbox(page, FILES[0])).not.toBeChecked()
    await expect(checkbox(page, FILES[1])).not.toBeChecked()
    await expect(checkbox(page, FILES[2])).toBeChecked()
    await expect(page.getByText("已选 1 项", { exact: true })).toBeVisible()
    expect(await commandCalls(page, "delete_library_entry")).toHaveLength(0)

    // Re-select A/B to execute the same group through the overflow entry point.
    await checkbox(page, FILES[2]).click()
    await expect(page.locator('[aria-label="文件批量操作"]')).toBeHidden()
    await page.getByRole("button", { name: "多选文件", exact: true }).click()
    await checkbox(page, FILES[0]).click()
    await checkbox(page, FILES[1]).click()
    await page.getByRole("button", { name: `${FILES[1]} 操作`, exact: true }).click()
    await overflow.getByRole("menuitem", { name: "删除 2 项", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "确认删除", exact: true })
    await expect(dialog.getByRole("list", { name: "待删除文件", exact: true }).getByRole("listitem")).toHaveText(FILES.slice(0, 2))
    await dialog.getByRole("button", { name: "删除 2 项", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect((await commandCalls(page, "delete_library_entry")).map(call => call.args.path).sort()).toEqual(FILES.slice(0, 2).map(file => `notes/${file}`).sort())
    await expect(entryButton(page, FILES[2])).toBeVisible()
  })
}

test("右键批量移动过滤所选目录及其后代，移动操作使用整组选区", async ({ page }, testInfo) => {
  await select(page, [FILES[0], "资料"])
  await entryButton(page, "资料").click({ button: "right" })
  const context = page.locator('[data-slot="context-menu-content"]')
  await expect(context.getByText("已选 2 项", { exact: true })).toBeVisible()
  await context.getByRole("menuitem", { name: "移动 2 项到…", exact: true }).hover()
  const destinations = page.locator('[data-slot="dropdown-menu-sub-content"]')
  await expect(destinations).toBeVisible()
  await expect(destinations.getByRole("menuitem")).toHaveText(["归档"])
  await destinations.evaluate(async element => { await Promise.allSettled(element.getAnimations().map(animation => animation.finished)) })
  await expect(destinations).toBeVisible()
  const parentBox = (await context.boundingBox())!
  const triggerBox = (await context.getByRole("menuitem", { name: "移动 2 项到…", exact: true }).boundingBox())!
  const childBox = (await destinations.boundingBox())!
  const opensRight = childBox.x >= parentBox.x + parentBox.width - 1
  const parentEdge = opensRight ? parentBox.x + parentBox.width : parentBox.x
  const childEdge = opensRight ? childBox.x : childBox.x + childBox.width
  expect(Math.abs(childEdge - parentEdge)).toBeLessThanOrEqual(8)
  const pointerY = Math.min(Math.max(triggerBox.y + triggerBox.height / 2, childBox.y + 8), childBox.y + childBox.height - 8)
  await page.mouse.move(parentEdge + (opensRight ? -1 : 1), pointerY, { steps: 3 })
  await page.mouse.move((parentEdge + childEdge) / 2, pointerY, { steps: 3 })
  await page.mouse.move(childEdge + (opensRight ? 8 : -8), pointerY, { steps: 3 })
  await expect(destinations).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("batch-move-submenu-gap.png") })
  await destinations.getByRole("menuitem", { name: "归档", exact: true }).click()
  await expect(entryButton(page, FILES[0])).toHaveCount(0)
  await expect(entryButton(page, "资料")).toHaveCount(0)
  expect((await commandCalls(page, "move_library_entry")).map(call => call.args.path).sort()).toEqual([`notes/${FILES[0]}`, "notes/资料"].sort())
})

test("键盘 Shift+F10 打开文件菜单，视口右下角菜单保持可见且 Escape 安全关闭", async ({ page }, testInfo) => {
  const context = page.locator('[data-slot="context-menu-content"]')
  await entryButton(page, FILES[0]).focus()
  await page.keyboard.press("Shift+F10")
  await expect(context.getByRole("menuitem", { name: "打开", exact: true })).toBeVisible()
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Escape")
  await expect(context).toHaveCount(0)
  await expect(page.getByText(/^已选 \d+ 项$/u)).toBeHidden()

  await page.getByRole("button", { name: "宫格视图", exact: true }).click()
  await page.setViewportSize({ width: 640, height: 600 })
  const card = page.locator(`li[data-path="notes/${FILES[5]}"]`)
  await card.scrollIntoViewIfNeeded()
  const cardBounds = await card.boundingBox()
  await card.click({ button: "right", position: { x: cardBounds!.width - 5, y: cardBounds!.height - 5 } })
  await expect(context).toBeVisible()
  await context.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)) })
  const bounds = await context.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(641)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(601)
  await page.screenshot({ path: testInfo.outputPath("context-menu-narrow-edge.png") })
  await page.keyboard.press("Escape")
  await expect(context).toHaveCount(0)
  expect(await commandCalls(page, "delete_library_entry")).toHaveLength(0)
})

test("列表和宫格空白区菜单提供新建与目录全选，退出多选不修改文件", async ({ page }) => {
  for (const mode of ["列表", "宫格"] as const) {
    await page.getByRole("button", { name: `${mode}视图`, exact: true }).click()
    const surface = mode === "列表"
      ? page.getByRole("region", { name: "notes 目录列表", exact: true })
      : page.getByRole("list", { name: "notes 目录宫格", exact: true })
    const context = page.locator('[data-slot="context-menu-content"]')
    await surface.click({ button: "right", position: { x: 3, y: 3 } })
    await expect(context.getByText("当前目录", { exact: true })).toHaveCount(0)
    await expect(context.getByRole("menuitem", { name: "新建文档", exact: true })).toBeVisible()
    await expect(context.getByRole("menuitem", { name: "新建目录", exact: true })).toBeVisible()
    await context.getByRole("menuitem", { name: "全选", exact: true }).click()
    await expect(context).toHaveCount(0)
    await expect(page.getByText("已选 8 项", { exact: true })).toBeVisible()
    await surface.click({ button: "right", position: { x: 3, y: 3 } })
    await context.getByRole("menuitem", { name: "退出多选", exact: true }).click()
    await expect(page.getByText(/^已选 \d+ 项$/u)).toBeHidden()
    await expect(checkbox(page, FILES[0])).not.toBeChecked()
  }
  expect(await commandCalls(page, "create_library_note")).toHaveLength(0)
  expect(await commandCalls(page, "create_library_directory")).toHaveLength(0)
  expect(await commandCalls(page, "delete_library_entry")).toHaveLength(0)
})

for (const mode of ["列表", "宫格"] as const) {
  test(`${mode}右键实际重命名和打开在菜单关闭后保留编辑焦点`, async ({ page }) => {
    await page.getByRole("button", { name: `${mode}视图`, exact: true }).click()
    const context = page.locator('[data-slot="context-menu-content"]')
    await entryButton(page, FILES[2]).click({ button: "right" })
    await context.getByRole("menuitem", { name: "重命名", exact: true }).click()
    await expect(context).toHaveCount(0)
    const rename = page.getByRole("textbox", { name: "重命名名称", exact: true })
    await expect(rename).toBeFocused()
    await expect(rename).toHaveValue("C 表格")
    await rename.fill("右键改名表格")
    await rename.press("Enter")
    await expect(rename).toHaveCount(0)
    await expect(entryButton(page, "右键改名表格.shardtable.json")).toBeVisible()
    expect(await commandCalls(page, "rename_library_entry")).toEqual([{
      command: "rename_library_entry", args: { path: `notes/${FILES[2]}`, newName: "右键改名表格" },
    }])
    await entryButton(page, FILES[0]).click({ button: "right" })
    await context.getByRole("menuitem", { name: "打开", exact: true }).click()
    await expect(context).toHaveCount(0)
    const editor = page.locator('[data-shard-editor="library:note-0"] .cm-content')
    await expect(editor).toBeVisible()
    await expect(editor).toBeFocused()
    await expect(editor).toContainText("A 笔记")
  })

  test(`${mode}菜单打开时可直接右键另一文件切换目标而无需先关闭菜单`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.getByRole("button", { name: `${mode}视图`, exact: true }).click()
    const surfaceTag = mode === "列表" ? "tr" : "li"
    const next = page.locator(`${surfaceTag}[data-path="notes/${FILES[2]}"]`)
    const nextBounds = await next.boundingBox()
    await entryButton(page, FILES[0]).click({ button: "right" })
    const context = page.locator('[data-slot="context-menu-content"]')
    await expect(context.getByText(FILES[0], { exact: true })).toBeVisible()
    // Use the user's physical click position: an overlay must not swallow it.
    await page.mouse.click(nextBounds!.x + nextBounds!.width - 12, nextBounds!.y + nextBounds!.height / 2, { button: "right" })
    await expect(context.getByText(FILES[2], { exact: true })).toBeVisible()
    await expect(context.getByText(FILES[0], { exact: true })).toHaveCount(0)
    await expect(context.getByRole("menuitem", { name: "移入密匣", exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`context-retarget-${mode}.png`) })
    await page.keyboard.press("Escape")
    await expect(context).toHaveCount(0)
    await expect(page.getByText(/^已选 \d+ 项$/u)).toBeHidden()
    expect(await commandCalls(page, "delete_library_entry")).toHaveLength(0)
    expect(await commandCalls(page, "rename_library_entry")).toHaveLength(0)
  })
}

test("空白菜单实际新建目录和笔记在关闭菜单后将焦点交给新建内容", async ({ page }) => {
  const surface = page.getByRole("region", { name: "notes 目录列表", exact: true })
  const context = page.locator('[data-slot="context-menu-content"]')
  const openBlankMenu = async () => {
    const bounds = await surface.boundingBox()
    await surface.click({ button: "right", position: { x: 3, y: bounds!.height - 3 } })
  }
  await openBlankMenu()
  await context.getByRole("menuitem", { name: "新建目录", exact: true }).click()
  await expect(context).toHaveCount(0)
  const directoryName = page.getByRole("textbox", { name: "新目录名称", exact: true })
  await expect(directoryName).toBeFocused()
  await directoryName.fill("右键新建目录")
  await directoryName.press("Enter")
  await expect(directoryName).toHaveCount(0)
  await expect(entryButton(page, "右键新建目录")).toBeVisible()
  expect(await commandCalls(page, "create_library_directory")).toEqual([{
    command: "create_library_directory", args: { parentPath: "notes", name: "右键新建目录" },
  }])
  await openBlankMenu()
  await context.getByRole("menuitem", { name: "新建文档", exact: true }).click()
  await expect(context).toHaveCount(0)
  const editor = page.locator('[data-shard-editor="library:note-created"] .cm-content')
  await expect(editor).toBeVisible()
  await expect(editor).toBeFocused()
  await expect(editor).toContainText("未命名")
  expect(await commandCalls(page, "create_library_note")).toEqual([{
    command: "create_library_note", args: { parentPath: "notes", title: "未命名" },
  }])
})

for (const mode of ["列表", "宫格"] as const) {
  test(`${mode}改名拒绝超过64字符并保留输入，Unicode字符和扩展名按名称上限处理`, async ({ page }) => {
    await page.getByRole("button", { name: `${mode}视图`, exact: true }).click()
    await entryButton(page, FILES[2]).click({ button: "right" })
    await page.locator('[data-slot="context-menu-content"]').getByRole("menuitem", { name: "重命名", exact: true }).click()
    const input = page.getByRole("textbox", { name: "重命名名称", exact: true })
    const overlong = "名".repeat(65)
    await input.fill(overlong)
    await expect(input).toHaveValue(overlong)
    await input.press("Enter")
    await expect(page.getByText("名称最多 64 个字符（不含扩展名）。", { exact: true })).toBeVisible()
    await expect(input).toHaveValue(overlong)
    expect(await commandCalls(page, "rename_library_entry")).toHaveLength(0)
    await input.press("Tab")
    await expect(input).toHaveValue(overlong)
    expect(await commandCalls(page, "rename_library_entry")).toHaveLength(0)

    // 64 Unicode code points but 65 UTF-16 code units: no maxlength truncation.
    const validBase = "名".repeat(63) + "😀"
    const validInput = validBase + (mode === "宫格" ? ".shardtable.json" : "")
    await input.fill(validInput)
    await expect(input).toHaveValue(validInput)
    await input.press("Enter")
    await expect(input).toHaveCount(0)
    await expect(entryButton(page, `${validBase}.shardtable.json`)).toBeVisible()
    expect(await commandCalls(page, "rename_library_entry")).toEqual([{
      command: "rename_library_entry", args: { path: `notes/${FILES[2]}`, newName: validInput },
    }])
  })
}

test("新建目录拒绝超过64字符且不截断，修正为含emoji的64字符后可提交", async ({ page }) => {
  await page.getByRole("button", { name: "新建", exact: true }).click()
  await page.getByRole("menuitem", { name: "新建目录", exact: true }).click()
  const input = page.getByRole("textbox", { name: "新目录名称", exact: true })
  const overlong = "📁".repeat(65)
  await input.fill(overlong)
  await expect(input).toHaveValue(overlong)
  await input.press("Enter")
  await expect(page.getByText("名称最多 64 个字符（不含扩展名）。", { exact: true })).toBeVisible()
  await expect(input).toHaveValue(overlong)
  expect(await commandCalls(page, "create_library_directory")).toHaveLength(0)
  await input.press("Tab")
  await expect(input).toHaveValue(overlong)
  expect(await commandCalls(page, "create_library_directory")).toHaveLength(0)
  const validName = "录".repeat(63) + "📁"
  await input.fill(validName)
  await expect(input).toHaveValue(validName)
  await input.press("Enter")
  await expect(input).toHaveCount(0)
  await expect(entryButton(page, validName)).toBeVisible()
  expect(await commandCalls(page, "create_library_directory")).toEqual([{
    command: "create_library_directory", args: { parentPath: "notes", name: validName },
  }])
})
