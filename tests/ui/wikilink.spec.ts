import { expect, test, type Page } from "@playwright/test"

import { applyFragmentTag } from "./fragment-filter-helpers"

import { fillEditor, readEditor } from "./editor-helpers"

interface WikilinkCall {
  args: Record<string, unknown>
  command: string
}

interface WikilinkMockOptions {
  linkedFragments?: boolean
  inlineSave?: "failure" | "deferred-success" | "deferred-failure"
  trashTarget?: boolean
}

async function installWikilinkMock(page: Page, options: WikilinkMockOptions = {}) {
  await page.addInitScript((options: WikilinkMockOptions) => {
    const now = "2026-08-30T12:00:00.000Z"
    const fragments = [
      {
        id: "fragment-target",
        content: "可定位的碎片摘要",
        createdAt: now,
        updatedAt: now,
        tags: ["inbox"],
        category: null,
        path: "fragments/fragment-target.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
      {
        id: "note-source",
        content: "# 来源笔记\n正文 [[目标笔记]]",
        createdAt: now,
        updatedAt: now,
        tags: ["inbox", "note"],
        category: null,
        path: "notes/来源笔记.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [
          {
            targetId: "note-target",
            origin: "wikilink",
            createdAt: now,
          },
        ],
      },
      {
        id: "note-target",
        content: "# 目标笔记\n目标正文",
        createdAt: now,
        updatedAt: "2026-08-30T11:00:00.000Z",
        tags: ["inbox", "note"],
        category: null,
        path: "notes/目标笔记.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
    ]
    if (options.linkedFragments) {
      fragments[0].tags.push("shared")
      fragments.push({
        ...fragments[0],
        id: "fragment-source",
        path: "fragments/fragment-source.md",
        content: "同主题来源碎片 #shared [[fragment-target]]",
        related: [{ targetId: "fragment-target", origin: "wikilink", createdAt: now }],
      })
    }
    if (options.trashTarget) {
      for (let index = 0; index < 45; index += 1) {
        fragments.push({
          ...fragments[0], id: `active-${index}`, path: `fragments/active-${index}.md`,
          content: `恢复验收的活跃碎片 ${index}`,
          createdAt: new Date(Date.parse(now) - (index + 1) * 60_000).toISOString(),
        })
      }
      for (let index = 0; index < 25; index += 1) {
        fragments.push({
          ...fragments[0], id: `deleted-${index}`, path: `.trash/fragments/deleted-${index}.md`,
          content: index === 24 ? "待恢复定位目标：保留原记录日期。" : `已删除的历史碎片 ${index}`,
          createdAt: new Date(Date.UTC(2026, 6, 1, 12, 0, -index)).toISOString(),
          archived: true,
        })
      }
    }
    const calls: WikilinkCall[] = []
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    let completeInlineSave: (() => void) | null = null
    const saveEvents: string[] = []
    let holdRestoreRefresh = false
    const restoreRefreshResolvers: Array<() => void> = []
    const trashTree = () => ({
      entries: fragments.filter(item => item.tags.includes("note")).map(item => ({
        name: item.path.split("/").at(-1), path: item.path, kind: "markdown", size: 0, modifiedAt: "",
      })),
      assets: [], trashEntries: [],
      fragmentTrashEntries: fragments.filter(item => item.archived).map(item => ({
        name: item.path.split("/").at(-1), path: item.path, kind: "markdown", size: 0, modifiedAt: item.createdAt,
      })),
      fragmentStream: { totalCount: 0, years: [] },
    })

    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_WIKILINK_CALLS__: calls,
      __SHARD_INLINE_SAVE_EVENTS__: saveEvents,
      __SHARD_COMPLETE_INLINE_SAVE__: () => completeInlineSave?.(),
      __SHARD_RELEASE_RESTORE_REFRESH__: () => {
        holdRestoreRefresh = false
        for (const resolve of restoreRefreshResolvers.splice(0)) resolve()
      },
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args: clone(args) })
          if (command === "list_fragments") {
            if (holdRestoreRefresh) await new Promise<void>(resolve => restoreRefreshResolvers.push(resolve))
            return clone({
              vaultPath: "/tmp/shard-wikilink-test",
              fragments,
              git: {
                branch: "main",
                shortCommit: "abc1234",
                hasRemote: false,
                status: "ready",
                error: null,
                ahead: 0,
                behind: 0,
              },
              lockbox: {
                configured: false,
                unlocked: false,
                expiresAt: null,
                ttlSeconds: 900,
              },
            })
          }
          if (command === "plugin:app|version") return "0.0.0"
          if (command === "list_csv_files") return []
          if (command === "list_mind_maps") return []
          if (command === "restore_from_trash" && options.trashTarget) {
            const fragment = fragments.find(item => item.path === args.path)
            if (!fragment) throw new Error("Trash fragment not found")
            fragment.path = fragment.path.replace(/^\.trash\//u, "")
            fragment.archived = false
            holdRestoreRefresh = true
            return clone({ tree: trashTree(), fragment: null, updatedLinks: 0 })
          }
          if (command === "update_fragment") {
            const fragment = fragments.find((item) => item.id === args.id)
            if (!fragment) throw new Error("Fragment not found")
            if (args.id === "fragment-source" && options.inlineSave) {
              saveEvents.push("saving")
              if (options.inlineSave.startsWith("deferred-")) {
                await new Promise<void>(resolve => { completeInlineSave = resolve })
              }
              if (options.inlineSave !== "deferred-success") {
                saveEvents.push("failed")
                throw new Error("模拟碎片正文写入失败")
              }
              saveEvents.push("saved")
            }
            fragment.content = String(args.content)
            fragment.tags = args.tags as string[]
            fragment.updatedAt = now
            return clone(fragment)
          }
          if (command === "link_fragments") {
            const source = fragments.find((item) => item.id === args.sourceId)
            if (!source) throw new Error("Fragment not found")
            if (!source.related.some((item) => item.targetId === args.targetId)) {
              source.related.push({
                targetId: String(args.targetId),
                origin: String(args.origin),
                createdAt: now,
              })
            }
            return clone(source)
          }
          if (command === "unlink_fragments") {
            const source = fragments.find((item) => item.id === args.sourceId)
            if (!source) throw new Error("Fragment not found")
            source.related = source.related.filter(
              (item) => item.targetId !== args.targetId
            )
            return clone(source)
          }
          if (command === "convert_fragment_to_note" && options.inlineSave) {
            const fragment = fragments.find(item => item.id === args.id)
            if (!fragment) throw new Error("Fragment not found")
            saveEvents.push("convert")
            fragment.tags = [...fragment.tags, "note"]
            fragment.path = `notes/${String(args.title ?? "转换文档")}.md`
            return clone({
              tree: {
                entries: fragments.filter(item => item.tags.includes("note")).map(item => ({
                  name: item.path.split("/").at(-1), path: item.path, kind: "markdown", size: 0, modifiedAt: "",
                })),
                assets: [], trashEntries: [], fragmentTrashEntries: [],
                fragmentStream: { totalCount: 1, years: [] },
              },
              fragment,
              updatedLinks: 0,
            })
          }
          if (command === "list_library_tree") {
            if (options.trashTarget) return clone(trashTree())
            return {
              entries: [
                {
                  name: "来源笔记.md",
                  path: "notes/来源笔记.md",
                  kind: "markdown",
                  size: 0,
                  modifiedAt: "",
                },
                {
                  name: "目标笔记.md",
                  path: "notes/目标笔记.md",
                  kind: "markdown",
                  size: 0,
                  modifiedAt: "",
                },
              ],
              assets: [],
              trashEntries: [],
              fragmentTrashEntries: [],
              fragmentStream: { totalCount: 0, years: [] },
            }
          }
          if (command === "migrate_legacy_notes") {
            if (options.trashTarget) return clone({ tree: trashTree(), migratedCount: 0 })
            return {
              tree: {
                entries: [
                  {
                    name: "来源笔记.md",
                    path: "notes/来源笔记.md",
                    kind: "markdown",
                    size: 0,
                    modifiedAt: "",
                  },
                  {
                    name: "目标笔记.md",
                    path: "notes/目标笔记.md",
                    kind: "markdown",
                    size: 0,
                    modifiedAt: "",
                  },
                ],
                assets: [],
                trashEntries: [],
                fragmentTrashEntries: [],
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
                fragmentTrashEntries: [],
                fragmentStream: { totalCount: 0, years: [] },
              },
              fragment: null,
              updatedLinks: 0,
            }
          }
          throw new Error(`Unhandled Tauri test command: ${command}`)
        },
      },
    })
  }, options)
}

test.beforeEach(async ({ page }) => {
  await installWikilinkMock(page)
  await page.goto("/")
})

// 「输入双左括号展示笔记标题与碎片摘要候选并写回 wikilink」已由富文本用例覆盖：
// tests/ui/rich-inline.spec.ts「双左括号弹出双链建议，选中后写成芯片并提交为 [[目标]]」
// 与 tests/ui/rich-library.spec.ts「[[ 建议按类别给出候选，选中写成芯片并落盘为 [[目标]]」。

test("链接点击复用资料库与时间线导航且不滚动 document", async ({ page }) => {
  await fillEditor(page, "composer", "[[目标笔记]]")
  await page.locator('[data-shard-editor="composer"] .shard-rich-wikilink').click()
  await expect(page.locator('[data-shard-editor="library:note-target"]')).toBeVisible()

  await page.getByRole("button", { name: "碎片", exact: true }).click()
  // 切回碎片空间后速记框重新挂载，等编辑区出现再写入。
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeVisible()
  await fillEditor(page, "composer", "[[fragment-target]]")
  const documentScrollBefore = await page.evaluate(() => window.scrollY)
  await page.locator('[data-shard-editor="composer"] .shard-rich-wikilink').click()
  await expect(page.getByRole("button", { name: "碎片", exact: true })).toHaveAttribute("aria-current", "page")
  await expect(page.getByRole("complementary", { name: "资料库目录" })).toHaveCount(0)
  await expect(page.locator('[data-shard-fragment-id="fragment-target"]')).toHaveClass(/shard-fragment-card-highlight/u)
  expect(await page.evaluate(() => window.scrollY)).toBe(documentScrollBefore)
})

// 「断链使用待建样式，点击仅提示且编辑器可继续输入」已由富文本用例覆盖：
// tests/ui/rich-inline.spec.ts「断链芯片用待建样式，点击只提示且正文不动」
// 与 tests/ui/rich-library.spec.ts「芯片导航：CSV 交给系统打开，待建链接只提示」。

test("资料库保存通过现有 relation 命令同步 wikilink diff", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const tree = page.getByRole("complementary", { name: "资料库目录" })
  await tree.getByRole("button", { name: /^文件（/ }).click()
  await page.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 目标笔记.md", exact: true }).click()
  await fillEditor(page, "library:note-target", "# 目标笔记\n[[fragment-target]]")
  await tree.getByRole("button", { name: /^文件（/ }).click()
  await page.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 来源笔记.md", exact: true }).click()

  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            __SHARD_WIKILINK_CALLS__?: WikilinkCall[]
          }
        ).__SHARD_WIKILINK_CALLS__?.filter(
          (call) => call.command === "link_fragments"
        ) ?? []
      )
    )
    .toContainEqual({
      command: "link_fragments",
      args: {
        sourceId: "note-target",
        targetId: "fragment-target",
        origin: "wikilink",
        note: null,
      },
    })
})

test("资料库第三栏展示 wikilink 反向链接分组", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: /^文件（/ }).click()
  await page.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 目标笔记.md", exact: true }).click()

  const inspector = page.locator("[data-library-inspector-slot]")
  await expect(inspector.getByRole("region", { name: "反向链接" })).toBeVisible()
  await expect(inspector.getByText("来源笔记", { exact: false })).toBeVisible()
})

test("文档里的碎片引用保存草稿后进入碎片，返回时保留文档正文", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: /^文件（/ }).click()
  await page.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 目标笔记.md", exact: true }).click()
  const content = "# 目标笔记\n\n最新正文 [[fragment-target]]"
  await fillEditor(page, "library:note-target", content)
  await page.locator('[data-shard-editor="library:note-target"] .shard-rich-wikilink').click()
  await expect(page.getByRole("button", { name: "碎片", exact: true })).toHaveAttribute("aria-current", "page")
  await expect(page.locator('[data-shard-fragment-id="fragment-target"]')).toHaveClass(/shard-fragment-card-highlight/u)
  await expect(page.getByRole("complementary", { name: "资料库目录" })).toHaveCount(0)
  await page.getByRole("button", { name: "返回资料库", exact: true }).click()
  await expect(page.locator('[data-shard-editor="library:note-target"]')).toBeVisible()
  await expect.poll(() => readEditor(page, "library:note-target")).toBe(content)
})

test("同标签范围内打开关联碎片保留筛选与结果集合", async ({ page }) => {
  await installWikilinkMock(page, { linkedFragments: true })
  await page.reload()
  await applyFragmentTag(page, "shared")
  await expect(page.locator(".shard-timeline-item")).toHaveCount(2)
  const source = page.locator('[data-shard-fragment-id="fragment-source"]')
  await source.getByRole("button", { name: "1 条关联", exact: true }).click()
  await source.getByRole("button", { name: /可定位的碎片摘要/u }).click()
  await expect(page.locator('[data-shard-fragment-id="fragment-target"]')).toHaveClass(/shard-fragment-card-highlight/u)
  await expect(page.getByRole("region", { name: "当前碎片筛选", exact: true })).toContainText("#shared")
  await expect(page.getByRole("button", { name: "清除筛选", exact: true })).toBeVisible()
  await expect(page.locator(".shard-timeline-item")).toHaveCount(2)
  await expect(page.getByRole("button", { name: "返回碎片", exact: true })).toHaveCount(0)
  await page.screenshot({ path: "tests/evidence/fragments-separation/fragments.png" })
})

async function inlineSaveCalls(page: Page) {
  return page.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __SHARD_WIKILINK_CALLS__: WikilinkCall[]
      __SHARD_INLINE_SAVE_EVENTS__: string[]
    }
    return { calls: state.__SHARD_WIKILINK_CALLS__, events: state.__SHARD_INLINE_SAVE_EVENTS__ }
  })
}

async function beginOtherFragmentConversion(page: Page, mode: NonNullable<WikilinkMockOptions["inlineSave"]>) {
  await installWikilinkMock(page, { linkedFragments: true, inlineSave: mode })
  await page.reload()
  const source = page.locator('[data-shard-fragment-id="fragment-source"]')
  await source.getByRole("button", { name: "片段操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click()
  const draft = "#shared A 的未落盘修改，必须保留。"
  await fillEditor(page, "fragment:fragment-source", draft)
  await page.locator('[data-shard-fragment-id="fragment-target"]')
    .getByRole("button", { name: "片段操作", exact: true }).click()
  await expect.poll(async () => (await inlineSaveCalls(page)).calls.filter(call => call.command === "update_fragment").length).toBe(1)
  await page.getByRole("menuitem", { name: "转为文档…", exact: true }).click()
  return draft
}

test("A 碎片 blur 保存已失败时禁止 B 转文档并保留 A 草稿", async ({ page }) => {
  const draft = await beginOtherFragmentConversion(page, "failure")
  await expect(page.getByText(/自动保存失败：.*模拟碎片正文写入失败/u).first()).toBeVisible()
  await expect(page.getByRole("dialog", { name: "转为文档", exact: true })).toHaveCount(0)
  await expect(page.locator('[data-shard-editor="fragment:fragment-source"]')).toBeVisible()
  expect(await readEditor(page, "fragment:fragment-source")).toBe(draft)
  expect((await inlineSaveCalls(page)).calls.filter(call => call.command === "convert_fragment_to_note")).toEqual([])
  await expect(page.getByRole("button", { name: "碎片", exact: true })).toHaveAttribute("aria-current", "page")
})

for (const mode of ["deferred-success", "deferred-failure"] as const) {
  test(`A 碎片保存 ${mode} 时 B 转文档串行等待同一保存结果`, async ({ page }) => {
    const draft = await beginOtherFragmentConversion(page, mode)
    // Drain the click turn while the mock write remains explicitly unresolved.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.getByRole("dialog", { name: "转为文档", exact: true })).toHaveCount(0)
    expect(await readEditor(page, "fragment:fragment-source")).toBe(draft)
    const pending = await inlineSaveCalls(page)
    expect(pending.events).toEqual(["saving"])
    expect(pending.calls.filter(call => call.command === "update_fragment")).toHaveLength(1)
    expect(pending.calls.filter(call => call.command === "convert_fragment_to_note")).toEqual([])
    await page.evaluate(() => (globalThis as typeof globalThis & { __SHARD_COMPLETE_INLINE_SAVE__: () => void }).__SHARD_COMPLETE_INLINE_SAVE__())
    if (mode === "deferred-failure") {
      await expect(page.getByText(/自动保存失败：.*模拟碎片正文写入失败/u).first()).toBeVisible()
      await expect(page.getByRole("dialog", { name: "转为文档", exact: true })).toHaveCount(0)
      expect(await readEditor(page, "fragment:fragment-source")).toBe(draft)
      expect((await inlineSaveCalls(page)).events).toEqual(["saving", "failed"])
      expect((await inlineSaveCalls(page)).calls.filter(call => call.command === "convert_fragment_to_note")).toEqual([])
    } else {
      const dialog = page.getByRole("dialog", { name: "转为文档", exact: true })
      await expect(dialog).toBeVisible()
      await expect(page.locator('[data-shard-editor="fragment:fragment-source"]')).toHaveCount(0)
      await dialog.getByRole("button", { name: "转为文档", exact: true }).click()
      await expect.poll(async () => (await inlineSaveCalls(page)).events).toEqual(["saving", "saved", "convert"])
      const finished = await inlineSaveCalls(page)
      const saves = finished.calls.filter(call => call.command === "update_fragment")
      expect(saves).toHaveLength(1)
      expect(saves[0].args).toMatchObject({ id: "fragment-source", content: draft })
      expect(finished.calls.find(call => call.command === "convert_fragment_to_note")?.args.id).toBe("fragment-target")
    }
  })
}

test("搜索已删除碎片聚焦回收站目标，恢复后等待刷新再定位并结束滚动目标", async ({ page }) => {
  await installWikilinkMock(page, { trashTarget: true })
  await page.reload()
  await expect(page.locator(".shard-timeline-item")).toHaveCount(40)
  const documentScroll = await page.evaluate(() => document.scrollingElement?.scrollTop)
  await page.keyboard.press("Control+k")
  const search = page.getByRole("combobox", { name: "搜索内容" })
  await search.fill("待恢复定位目标")
  await expect(page.getByRole("option")).toHaveCount(1)
  await search.press("Enter")
  const trash = page.getByRole("region", { name: "碎片回收站", exact: true })
  const target = trash.locator('[data-trash-path=".trash/fragments/deleted-24.md"]')
  await expect(trash).toBeVisible()
  await expect(target).toBeFocused()
  await expect(target).toBeInViewport()
  await expect.poll(() => target.evaluate(element => element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!.scrollTop)).toBeGreaterThan(0)
  await expect(page.getByRole("button", { name: "碎片", exact: true })).toHaveAttribute("aria-current", "page")
  await expect(page.getByRole("complementary", { name: "资料库目录" })).toHaveCount(0)
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(documentScroll)

  await target.getByRole("button", { name: "恢复", exact: true }).click()
  await expect(trash).toHaveCount(0)
  await expect(page.getByText("碎片已恢复", { exact: true })).toBeVisible()
  const restored = page.locator('[data-shard-fragment-id="deleted-24"]')
  await expect(restored).toHaveCount(0)
  await page.evaluate(() => (globalThis as typeof globalThis & { __SHARD_RELEASE_RESTORE_REFRESH__: () => void }).__SHARD_RELEASE_RESTORE_REFRESH__())
  await expect(restored).toHaveClass(/shard-fragment-card-highlight/u)
  await expect(restored).toBeInViewport()
  await expect(restored.locator("time")).toContainText("2026/07/01")
  await expect(page.locator(".shard-timeline-item")).toHaveCount(47)

  // Once positioning completed, a later masonry resize must not steal user scroll.
  await expect(restored).not.toHaveClass(/shard-fragment-card-highlight/u)
  const readPositions = () => page.locator(".shard-timeline-layout").evaluate(element =>
    Array.from(element.children).map(child => `${(child as HTMLElement).style.left}:${(child as HTMLElement).style.top}`).join("|"))
  const positionsBeforeResize = await readPositions()
  await restored.evaluate(element => {
    element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!.scrollTop = 0
    const first = document.querySelector<HTMLElement>(".shard-timeline-item")!
    first.style.paddingBottom = "80px"
  })
  await expect.poll(readPositions).not.toBe(positionsBeforeResize)
  await expect.poll(() => restored.evaluate(element => element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!.scrollTop)).toBe(0)
  await expect(restored).not.toBeInViewport()
  const calls = (await inlineSaveCalls(page)).calls.filter(call => call.command === "restore_from_trash")
  expect(calls).toEqual([{ command: "restore_from_trash", args: { path: ".trash/fragments/deleted-24.md" } }])
})
