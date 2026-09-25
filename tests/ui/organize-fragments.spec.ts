import { expect, test, type Page } from "@playwright/test"

import { fillEditor, readEditor } from "./editor-helpers"
import { installSearchIpcMock } from "./search-ipc-mock"

interface OrganizeCall {
  args: Record<string, unknown>
  command: string
}

type OrganizeMockMode = "deferred-success" | "fail-once" | "save-failure" | "deferred-save-failure"

async function installOrganizeMock(page: Page, mode: OrganizeMockMode) {
  await installSearchIpcMock(page)
  await page.addInitScript((mockMode: OrganizeMockMode) => {
    const now = "2026-08-30T12:00:00.000Z"
    const fragments = [
      {
        id: "fragment-first",
        content: "第一条公开碎片：产品访谈里的核心问题。",
        createdAt: now,
        updatedAt: now,
        tags: ["inbox", "research"],
        category: null,
        path: "fragments/2026/08/fragment-first.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
      {
        id: "fragment-second",
        content: "第二条公开碎片：后续需要整理为行动建议。",
        createdAt: "2026-08-30T11:00:00.000Z",
        updatedAt: "2026-08-30T11:00:00.000Z",
        tags: ["inbox", "planning"],
        category: null,
        path: "fragments/2026/08/fragment-second.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
      {
        id: "lockbox-fragment",
        content: "密匣内容不得进入整理多选。",
        createdAt: "2026-08-30T10:00:00.000Z",
        updatedAt: "2026-08-30T10:00:00.000Z",
        tags: ["lockbox"],
        category: null,
        path: "lockbox/lockbox-fragment.md.age",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: true,
        pinned: false,
        related: [],
      },
    ]
    const calls: OrganizeCall[] = []
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    let organizeAttempts = 0
    let resolveDeferred: (() => void) | null = null
    let resolveDeferredSave: (() => void) | null = null

    const generatedNote = () => {
      const note = {
        id: "note-organized",
        content: [
          "# 访谈问题与行动建议",
          "",
          "整理后的笔记正文。",
          "",
          "## 来源",
          "",
          "- [[fragment-first]]",
          "- [[fragment-second]]",
        ].join("\n"),
        createdAt: now,
        updatedAt: now,
        tags: ["note"],
        category: null,
        path: "notes/访谈问题与行动建议.md",
        gitStatus: "untracked",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [
          { targetId: "fragment-first", origin: "wikilink", createdAt: now },
          { targetId: "fragment-second", origin: "wikilink", createdAt: now },
        ],
      }
      fragments.unshift(note)
      return clone(note)
    }

    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_ORGANIZE_CALLS__: calls,
      __SHARD_RESOLVE_ORGANIZE__: () => resolveDeferred?.(),
      __SHARD_RESOLVE_FRAGMENT_SAVE__: () => resolveDeferredSave?.(),
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args: clone(args) })

          if (command === "list_fragments") {
            return clone({
              vaultPath: "/tmp/shard-organize-test",
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
                configured: true,
                unlocked: false,
                expiresAt: null,
                ttlSeconds: 900,
              },
            })
          }
          if (command === "list_mind_maps") return []
          if (command === "sync_vault") {
            return {
              branch: "main",
              shortCommit: "abc1234",
              hasRemote: false,
              status: "ready",
              error: null,
              ahead: 0,
              behind: 0,
            }
          }
          if (command === "organize_fragments") {
            organizeAttempts += 1
            if (mockMode === "fail-once" && organizeAttempts === 1) {
              throw new Error("Codex CLI 暂时不可用")
            }
            if (mockMode === "deferred-success") {
              await new Promise<void>((resolve) => {
                resolveDeferred = resolve
              })
            }
            return generatedNote()
          }
          if (command === "update_fragment") {
            if (mockMode === "deferred-save-failure") {
              await new Promise<void>((resolve) => {
                resolveDeferredSave = resolve
              })
            }
            if (mockMode === "save-failure" || mockMode === "deferred-save-failure") {
              throw new Error("模拟碎片正文写入失败")
            }
            const fragment = fragments.find((item) => item.id === args.id)
            if (!fragment) throw new Error("片段不存在")
            fragment.content = String(args.content)
            fragment.tags = args.tags as string[]
            return clone(fragment)
          }

          if (command === "list_csv_files") return []
          if (command === "list_library_tree") {
            return {
              entries: fragments
                .filter((fragment) => fragment.tags.includes("note"))
                .map((fragment) => ({
                  name: "访谈问题与行动建议.md",
                  path: fragment.path,
                  kind: "markdown",
                  size: 0,
                  modifiedAt: "",
                })),
              assets: [],
              trashEntries: [],
              fragmentTrashEntries: [],
              fragmentStream: { totalCount: 0, years: [] },
            }
          }
          if (command === "migrate_legacy_notes") {
            return {
              tree: {
                entries: fragments
                  .filter((fragment) => fragment.tags.includes("note"))
                  .map((fragment) => ({
                    name: "访谈问题与行动建议.md",
                    path: fragment.path,
                    kind: "markdown",
                    size: 0,
                    modifiedAt: "",
                  })),
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
  }, mode)
}

async function enterOrganizeModeAndSelectTwo(page: Page) {
  await page.getByRole("button", { name: "碎片", exact: true }).click()
  await expect(page.getByRole("button", { name: "多选", exact: true })).toHaveCount(0)
  await page.locator('[data-shard-fragment-id="fragment-first"]')
    .getByRole("button", { name: "片段操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "多选", exact: true }).click()

  await expect(page.getByRole("checkbox", { name: /选择片段：第一条公开碎片/u })).toBeChecked()
  await expect(page.getByRole("checkbox", { name: /选择片段：第二条公开碎片/u })).not.toBeChecked()
  await expect(page.getByText("已选 1 条", { exact: true })).toBeVisible()
  await page
    .getByRole("checkbox", { name: /选择片段：第二条公开碎片/u })
    .check()

  await expect(page.getByText("已选 2 条", { exact: true })).toBeVisible()
}

async function openOrganizeDialog(page: Page) {
  await page.getByRole("button", { name: "整理成新文档…", exact: true }).click()
  return page.getByRole("dialog", { name: "整理成新文档" })
}

test("多选公开碎片并以模板生成笔记，生成中保持局部进度态，完成后在资料库打开", async ({
  page,
}) => {
  await installOrganizeMock(page, "deferred-success")
  await page.goto("/")

  await enterOrganizeModeAndSelectTwo(page)
  await expect(
    page.getByRole("checkbox", { name: /选择片段：密匣内容不得进入整理多选/u })
  ).toHaveCount(0)

  const dialog = await openOrganizeDialog(page)
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("目标描述").fill("提炼访谈问题并给出行动建议")
  await expect(dialog.getByRole("radio", { name: /摘要/u })).toHaveAttribute(
    "aria-checked",
    "true"
  )
  await expect(dialog.getByRole("radio", { name: /周报/u })).toBeVisible()
  const articleTemplate = dialog.getByRole("radio", { name: /文章/u })
  await articleTemplate.click()
  await expect(articleTemplate).toHaveAttribute("aria-checked", "true")
  await dialog.getByRole("button", { name: "整理并保存文档" }).click()

  await expect(dialog).toHaveAttribute("aria-busy", "true")
  await expect(dialog.getByRole("button", { name: "正在整理…" })).toBeDisabled()
  await expect(dialog.getByLabel("目标描述")).toBeDisabled()
  await expect(articleTemplate).toBeDisabled()

  const request = await page.evaluate(() =>
    (
      globalThis as typeof globalThis & {
        __SHARD_ORGANIZE_CALLS__?: OrganizeCall[]
      }
    ).__SHARD_ORGANIZE_CALLS__?.find(
      (call) => call.command === "organize_fragments"
    )
  )
  expect(request?.args).toEqual({
    request: {
      fragmentPaths: [
        "fragments/2026/08/fragment-first.md",
        "fragments/2026/08/fragment-second.md",
      ],
      target: "提炼访谈问题并给出行动建议",
      template: "article",
    },
  })

  await page.evaluate(() =>
    (
      globalThis as typeof globalThis & {
        __SHARD_RESOLVE_ORGANIZE__?: () => void
      }
    ).__SHARD_RESOLVE_ORGANIZE__?.()
  )

  await expect(
    page
      .getByRole("complementary", { name: "资料库目录" })
      .getByRole("button", { name: /^文件（/ })
  ).toBeVisible()
  await expect(
    page
      .getByRole("complementary", { name: "资料库目录" })
      .getByRole("button", {
        name: "访谈问题与行动建议.md",
        exact: true,
      })
  ).toHaveCount(0)
  await expect(
    page.locator('[data-shard-editor="library:note-organized"]')
  ).toBeVisible()
  await expect.poll(() => readEditor(page, "library:note-organized")).toContain(
    "## 来源\n\n- [[fragment-first]]\n- [[fragment-second]]"
  )
  await page.getByRole("button", { name: "碎片", exact: true }).click()
  await expect(page.locator(".shard-timeline-item")).toHaveCount(2)
  await expect(page.locator('[data-shard-fragment-id="fragment-first"]')).toBeVisible()
  await expect(page.locator('[data-shard-fragment-id="fragment-second"]')).toBeVisible()
  await expect(page.locator('[data-shard-fragment-id="note-organized"]')).toHaveCount(0)
})

test("Codex CLI 失败后保留可重试错误条并能成功重试", async ({ page }) => {
  await installOrganizeMock(page, "fail-once")
  await page.goto("/")

  await enterOrganizeModeAndSelectTwo(page)
  const dialog = await openOrganizeDialog(page)
  await dialog.getByLabel("目标描述").fill("整理失败后重试")
  await dialog.getByRole("button", { name: "整理并保存文档" }).click()

  const error = page.getByRole("alert")
  await expect(error).toContainText("Codex CLI 暂时不可用")
  await expect(dialog.getByLabel("目标描述")).toHaveValue("整理失败后重试")
  await expect(error.getByRole("button", { name: "重试" })).toBeEnabled()
  await error.getByRole("button", { name: "重试" }).click()

  await expect(page.locator('[data-shard-editor="library:note-organized"]')).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            __SHARD_ORGANIZE_CALLS__?: OrganizeCall[]
          }
        ).__SHARD_ORGANIZE_CALLS__?.filter(
          (call) => call.command === "organize_fragments"
        ).length ?? 0
      )
    )
    .toBe(2)
})

test("碎片多选底栏固定且不改变卡片位置，最后取消即退出", async ({ page }) => {
  await installOrganizeMock(page, "fail-once")
  await page.goto("/")
  const card = page.locator('[data-shard-fragment-id="fragment-first"]')
  await expect(card).toBeVisible()
  const before = await card.boundingBox()
  await enterOrganizeModeAndSelectTwo(page)
  const dock = page.getByRole("toolbar", { name: "碎片批量操作" })
  await expect(dock).toBeVisible()
  expect((await card.boundingBox())!.y).toBe(before!.y)
  const viewport = card.locator('xpath=ancestor::*[@data-slot="scroll-area-viewport"]')
  const viewportBox = (await viewport.boundingBox())!
  const dockBox = (await dock.boundingBox())!
  expect(Math.abs(dockBox.y + dockBox.height - viewportBox.y - viewportBox.height)).toBeLessThanOrEqual(1)
  const primaryStyles = await dock.getByRole("button", { name: "整理成新文档…" }).evaluate(element => {
    const style = getComputedStyle(element)
    const probe = document.createElement("div")
    probe.style.background = "var(--primary)"
    element.append(probe)
    const expected = getComputedStyle(probe).backgroundColor
    probe.remove()
    return { actual: style.backgroundColor, expected }
  })
  expect(primaryStyles.actual).toBe(primaryStyles.expected)
  await page.getByRole("checkbox", { name: /选择片段：第一条公开碎片/u }).uncheck()
  await expect(dock.getByText("已选 1 条", { exact: true })).toBeVisible()
  await page.getByRole("checkbox", { name: /选择片段：第二条公开碎片/u }).click()
  await expect(dock).toBeHidden()
  await expect(card.getByRole("button", { name: "片段操作", exact: true })).toBeVisible()
  await expect(card).not.toHaveAttribute("aria-selected")
  await expect(page.getByRole("checkbox", { name: /选择片段：/u })).toHaveCount(0)
  expect((await card.boundingBox())!.y).toBe(before!.y)
})

test("筛选变化清空多选，恢复全部结果不会带回隐藏选择", async ({ page }) => {
  await installOrganizeMock(page, "fail-once")
  await page.goto("/")
  await enterOrganizeModeAndSelectTwo(page)
  await page.getByRole("button", { name: "搜索内容", exact: true }).click()
  await page.getByRole("button", { name: "筛选碎片", exact: true }).click()
  const filters = page.getByRole("dialog", { name: "筛选碎片", exact: true })
  await filters.getByRole("combobox", { name: "标签", exact: true }).click()
  await page.getByRole("option", { name: "#research", exact: true }).click()
  await filters.getByRole("button", { name: "查看碎片", exact: true }).click()
  await expect(page.locator(".shard-timeline-item")).toHaveCount(1)
  await expect(page.getByRole("toolbar", { name: "碎片批量操作" })).toBeHidden()
  await expect(page.getByRole("checkbox", { name: /选择片段：/u })).toHaveCount(0)
  await page.getByRole("button", { name: "清除筛选", exact: true }).click()
  await expect(page.locator(".shard-timeline-item")).toHaveCount(2)
  await page.locator('[data-shard-fragment-id="fragment-first"]')
    .getByRole("button", { name: "片段操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "多选", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: /选择片段：第一条公开碎片/u })).toBeChecked()
  await expect(page.getByRole("checkbox", { name: /选择片段：第二条公开碎片/u })).not.toBeChecked()
  await expect(page.getByText("已选 1 条", { exact: true })).toBeVisible()
})

for (const mode of ["save-failure", "deferred-save-failure"] as const) {
  test(`A 碎片 ${mode} 时从 B 菜单进入多选须保留 A 草稿`, async ({ page }) => {
    await installOrganizeMock(page, mode)
    await page.goto("/")
    await page.locator('[data-shard-fragment-id="fragment-first"]')
      .getByRole("button", { name: "片段操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "编辑", exact: true }).click()
    const draft = "第一条尚未保存的修改，进入多选前必须保留。"
    await fillEditor(page, "fragment:fragment-first", draft)
    await page.locator('[data-shard-fragment-id="fragment-second"]')
      .getByRole("button", { name: "片段操作", exact: true }).click()
    const readCalls = () => page.evaluate(() => (
      globalThis as typeof globalThis & { __SHARD_ORGANIZE_CALLS__: OrganizeCall[] }
    ).__SHARD_ORGANIZE_CALLS__)
    await expect.poll(async () => (await readCalls()).filter(call => call.command === "update_fragment").length).toBe(1)
    await page.getByRole("menuitem", { name: "多选", exact: true }).click()
    if (mode === "deferred-save-failure") {
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await expect(page.getByRole("toolbar", { name: "碎片批量操作" })).toBeHidden()
      expect(await readEditor(page, "fragment:fragment-first")).toBe(draft)
      expect((await readCalls()).filter(call => call.command === "update_fragment")).toHaveLength(1)
      await page.evaluate(() => (
        globalThis as typeof globalThis & { __SHARD_RESOLVE_FRAGMENT_SAVE__: () => void }
      ).__SHARD_RESOLVE_FRAGMENT_SAVE__())
    }
    await expect(page.getByText(/自动保存失败：.*模拟碎片正文写入失败/u).first()).toBeVisible()
    await expect(page.getByRole("toolbar", { name: "碎片批量操作" })).toBeHidden()
    await expect(page.getByRole("checkbox", { name: /选择片段：/u })).toHaveCount(0)
    await expect(page.locator('[data-shard-editor="fragment:fragment-first"]')).toBeVisible()
    expect(await readEditor(page, "fragment:fragment-first")).toBe(draft)
    expect((await readCalls()).filter(call => call.command === "organize_fragments")).toEqual([])
  })
}
