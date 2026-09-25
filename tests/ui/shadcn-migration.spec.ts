import { expect, test, type Page } from "@playwright/test"

import {
  fillEditor,
  focusEditor,
  readEditor,
  readEditorSnapshot,
  selectEditorText,
  selectionToolbar,
  typeEditor,
} from "./editor-helpers"

async function installTauriMock(
  page: Page,
  options: {
    imageSrc?: string
    relations?: Record<string, { targetId: string; note?: string }[]>
  } = {}
) {
  await page.addInitScript((injected: typeof options) => {
    const now = "2026-08-03T10:00:00.000Z"
    const fragments = Array.from({ length: 24 }, (_, index) => ({
      id: `fragment-${index + 1}`,
      content:
        index === 0
          ? "迁移回归片段\n- [ ] 验证菜单、编辑器和分享图片"
          : `第 ${index + 1} 条回归片段，保持时间线滚动和纸张布局。`,
      createdAt: new Date(Date.parse(now) - index * 60_000).toISOString(),
      updatedAt: new Date(Date.parse(now) - index * 60_000).toISOString(),
      tags: ["inbox", index % 2 === 0 ? "work" : "notes"],
      category: null,
      path: `fragments/2026/08/fragment-${index + 1}.md`,
      gitStatus: "committed",
      error: null,
      archived: false,
      lockbox: false,
      pinned: index === 1,
    }))

    for (const fragment of fragments) {
      const relations = injected.relations?.[fragment.id]
      if (relations) {
        ;(fragment as Record<string, unknown>).related = relations.map(
          (relation) => ({
            targetId: relation.targetId,
            origin: "manual",
            createdAt: now,
            ...(relation.note ? { note: relation.note } : {}),
          })
        )
      }
    }

    fragments.push({
      id: "archived-1",
      content: "已删除的回归片段",
      createdAt: "2026-07-31T10:00:00.000Z",
      updatedAt: "2026-07-31T10:00:00.000Z",
      tags: ["inbox", "archive"],
      category: null,
      path: "fragments/2026/07/archived-1.md",
      gitStatus: "committed",
      error: null,
      archived: true,
      lockbox: false,
      pinned: false,
    })

    fragments.push({
      id: "lockbox-1",
      content: "密匣中的回归片段",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
      tags: ["inbox", "密匣"],
      category: null,
      path: "lockbox/lockbox-1.md",
      gitStatus: "committed",
      error: null,
      archived: false,
      lockbox: true,
      pinned: false,
    })

    const git = {
      branch: "main",
      shortCommit: "abc1234",
      hasRemote: true,
      status: "ready",
      error: null,
      ahead: 0,
      behind: 0,
    }
    const lockbox = {
      configured: true,
      unlocked: false,
      expiresAt: null,
      ttlSeconds: 180,
    }
    const state = {
      vaultPath: "/tmp/shard-ui-test-vault",
      fragments,
      git,
      lockbox,
    }
    const mapSummary = {
      id: "map-1",
      title: "测试导图",
      createdAt: now,
      updatedAt: now,
      nodeCount: 3,
      path: "maps/map-1.shardmap",
    }
    const mapFile = {
      kind: "shard.map",
      schemaVersion: 1,
      id: "map-1",
      title: "测试导图",
      createdAt: now,
      updatedAt: now,
      savedWithAppVersion: "0.1.3",
      revision: 1,
      rootId: "root",
      hasProtectedLinks: false,
      nodes: {
        root: {
          id: "root",
          parentId: null,
          sortKey: "a",
          text: "测试导图",
          createdAt: now,
          updatedAt: now,
        },
        child: {
          id: "child",
          parentId: "root",
          sortKey: "a",
          text: "迁移回归节点",
          width: 96,
          createdAt: now,
          updatedAt: now,
        },
        grandchild: {
          id: "grandchild",
          parentId: "child",
          sortKey: "a",
          text: "后续节点",
          width: 560,
          createdAt: now,
          updatedAt: now,
        },
      },
    }

    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const commands: string[] = []
    const calls: Array<{ args: Record<string, unknown>; command: string }> = []

    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_TEST_COMMANDS__: commands,
      __SHARD_TEST_CALLS__: calls,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          commands.push(command)
          calls.push({ command, args: clone(args) })

          switch (command) {
            case "list_fragments":
            case "set_vault_path":
            case "initialize_vault_git":
            case "set_vault_remote":
            case "create_github_vault_repo":
            case "lock_lockbox":
              return clone(state)
            case "list_mind_maps":
              return clone([mapSummary])
            case "read_mind_map":
              return {
                file: clone(mapFile),
                path: mapSummary.path,
                lastSavedHash: "map-hash",
              }
            case "write_mind_map":
              return {
                file: clone(args.file ?? mapFile),
                path: mapSummary.path,
                lastSavedHash: "map-hash-next",
              }
            case "create_mind_map":
              return {
                file: clone(mapFile),
                path: mapSummary.path,
                lastSavedHash: "map-hash",
              }
            case "create_fragment": {
              const created = {
                id: `fragment-created-${fragments.length + 1}`,
                content: String(args.content ?? ""),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                tags: Array.isArray(args.tags) ? args.tags : ["inbox"],
                category: null,
                path: "fragments/2026/08/created.md",
                gitStatus: "committed",
                error: null,
                archived: false,
                lockbox: false,
                pinned: false,
              }
              fragments.unshift(created)
              return clone(created)
            }
            case "update_fragment": {
              const fragment = fragments.find((item) => item.id === args.id)
              if (!fragment) throw new Error("Fragment not found")
              fragment.content = String(args.content ?? fragment.content)
              fragment.tags = Array.isArray(args.tags)
                ? (args.tags as string[])
                : fragment.tags
              fragment.updatedAt = new Date().toISOString()
              return clone(fragment)
            }
            case "update_fragment_tags": {
              const fragment = fragments.find((item) => item.id === args.id)
              if (!fragment) throw new Error("Fragment not found")
              fragment.tags = Array.isArray(args.tags)
                ? (args.tags as string[])
                : fragment.tags
              return clone(fragment)
            }
            case "set_fragment_archived": {
              const fragment = fragments.find((item) => item.id === args.id)
              if (!fragment) throw new Error("Fragment not found")
              fragment.archived = Boolean(args.archived)
              return clone(fragment)
            }
            case "set_fragment_pinned": {
              const fragment = fragments.find((item) => item.id === args.id)
              if (!fragment) throw new Error("Fragment not found")
              fragment.pinned = Boolean(args.pinned)
              return clone(fragment)
            }
            case "link_fragments": {
              const fragment = fragments.find((item) => item.id === args.sourceId)
              if (!fragment) throw new Error("Fragment not found")
              const related =
                ((fragment as Record<string, unknown>).related as
                  | Array<Record<string, unknown>>
                  | undefined) ?? []
              if (!related.some((relation) => relation.targetId === args.targetId)) {
                related.push({
                  targetId: args.targetId,
                  origin: args.origin,
                  createdAt: new Date().toISOString(),
                  ...(args.note ? { note: args.note } : {}),
                })
              }
              ;(fragment as Record<string, unknown>).related = related
              return clone(fragment)
            }
            case "unlink_fragments": {
              const fragment = fragments.find((item) => item.id === args.sourceId)
              if (!fragment) throw new Error("Fragment not found")
              const related =
                ((fragment as Record<string, unknown>).related as
                  | Array<Record<string, unknown>>
                  | undefined) ?? []
              ;(fragment as Record<string, unknown>).related = related.filter(
                (relation) => relation.targetId !== args.targetId
              )
              return clone(fragment)
            }
            case "move_fragment_to_lockbox":
              return clone(state)
            case "unlock_lockbox":
              lockbox.unlocked = true
              return clone(state)
            case "setup_lockbox":
            case "reset_lockbox_password":
              return { recoveryKey: "recovery-key", vault: clone(state) }
            case "change_lockbox_password":
              return clone(state)
            case "sync_vault":
              return clone(git)
            case "github_cli_status":
              return {
                installed: true,
                authenticated: true,
                login: "shard-test",
                protocol: "https",
                error: null,
              }
            case "list_csv_files":
              return []
            case "list_library_tree":
              return {
                entries: [],
                assets: [],
                trashEntries: [],
                fragmentTrashEntries: [],
                fragmentStream: { totalCount: 0, years: [] },
              }
            case "migrate_legacy_notes":
              return {
                tree: {
                  entries: [],
                  assets: [],
                  trashEntries: [],
                  fragmentTrashEntries: [],
                  fragmentStream: { totalCount: 0, years: [] },
                },
                migratedCount: 0,
              }
            case "create_library_note":
            case "create_library_directory":
            case "rename_library_entry":
            case "move_library_entry":
            case "delete_library_entry":
            case "convert_fragment_to_note":
            case "convert_note_to_fragment":
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
            case "plugin:app|version":
              return "0.1.3"
            case "save_fragment_image":
              return "assets/test.png"
            case "read_fragment_image":
              return injected.imageSrc ?? ""
            case "fragment_image_file_path":
              return "/tmp/shard-ui-test-vault/assets/test.png"
            case "unhide_pointer":
            case "set_window_controls_hidden":
            case "reveal_fragment_image_in_dir":
            case "save_recovery_key":
            case "save_exported_image":
            case "copy_exported_image":
              return null
            case "checkpoint_vault":
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
            default:
              throw new Error(`Unhandled Tauri test command: ${command}`)
          }
        },
      },
    })
  }, options)
}

async function openMindMaps(page: Page) {
  await page.locator("[data-shard-utility-menu-trigger]:visible").click()
  await page.getByRole("menuitem", { name: "思维导图", exact: true }).click()
}

test.beforeEach(async ({ page }) => {
  await installTauriMock(page)
  await page.goto("/")
  await expect(
    page.locator('[data-shard-editor="composer"] .ProseMirror')
  ).toBeFocused()
  await expect(page.locator("[data-shard-fragment-id]")).toHaveCount(24)
})

test("editor toolbars expose visible labels through the shared icon button", async ({
  page,
}) => {
  // 行内格式在选区浮动条上，同样走共享图标按钮的 label → tooltip 契约。
  await fillEditor(page, "composer", "浮动条提示回归")
  await selectEditorText(page, "composer", "浮动条")
  await selectionToolbar(page).getByRole("button", { name: "粗体" }).hover()
  await expect(page.getByRole("tooltip", { name: "粗体" })).toBeVisible()

  await fillEditor(page, "composer", "禅模式工具栏提示回归")
  await focusEditor(page, "composer")
  await page.keyboard.press("Control+Shift+f")
  await expect(page.getByRole("button", { name: "退出编辑" })).toBeVisible()

  await page.getByRole("button", { name: "退出编辑" }).hover()
  await expect(page.getByRole("tooltip", { name: "退出编辑" })).toBeVisible()
})

test("inline 浮动条操作一步撤销，切换片段后 history 隔离", async ({
  page,
}) => {
  async function openInlineEditor(fragmentId: string) {
    const card = page.locator(
      `[data-shard-fragment-id="${fragmentId}"]`
    )
    await card.getByRole("button", { name: "片段操作" }).click()
    await page.getByRole("menuitem", { name: "编辑" }).click()

    const editorId = `fragment:${fragmentId}`
    const editor = page.locator(`[data-shard-editor="${editorId}"]`)
    await expect(editor.locator(".ProseMirror")).toBeFocused()
    return {
      article: page.locator("article").filter({ has: editor }),
      editor,
      editorId,
    }
  }

  const first = await openInlineEditor("fragment-1")
  const firstOriginal = await readEditor(page, first.editorId)
  const firstHead = firstOriginal.slice(0, 2)
  await selectEditorText(page, first.editorId, firstHead)
  await selectionToolbar(page).getByRole("button", { name: "粗体" }).click()
  const firstFormatted = `**${firstHead}**${firstOriginal.slice(2)}`
  await expect.poll(() => readEditor(page, first.editorId)).toBe(firstFormatted)

  await focusEditor(page, first.editorId)
  await page.keyboard.press("Meta+z")
  await expect.poll(() => readEditor(page, first.editorId)).toBe(firstOriginal)

  await selectEditorText(page, first.editorId, firstHead)
  await selectionToolbar(page).getByRole("button", { name: "粗体" }).click()
  await expect.poll(() => readEditor(page, first.editorId)).toBe(firstFormatted)
  await first.article.getByRole("button", { name: "取消" }).click()
  await expect(first.editor).toBeHidden()

  const second = await openInlineEditor("fragment-2")
  const secondOriginal = await readEditor(page, second.editorId)
  await focusEditor(page, second.editorId)
  await page.keyboard.press("Meta+z")
  await expect.poll(() => readEditor(page, second.editorId)).toBe(secondOriginal)
})

test("荧光笔渲染为行内高亮，编辑区看不到 == 且写回原样", async ({
  page,
}) => {
  const content = "==荧光=="
  const editor = page.locator('[data-shard-editor="composer"]')
  await fillEditor(page, "composer", content)

  await expect(editor.locator(".ProseMirror mark")).toHaveText("荧光")
  await expect(editor.locator(".ProseMirror")).not.toContainText("==")
  await expect.poll(() => readEditor(page, "composer")).toBe(content)

  // 光标在高亮末尾删一个字，删的是正文，不是看不见的标记
  await selectEditorText(page, "composer", "荧光", { collapse: "end" })
  await page.keyboard.press("Backspace")
  await expect.poll(() => readEditor(page, "composer")).toBe("==荧==")
})

test("任务复选框不影响 Enter 续行，行首 Backspace 去掉任务标记", async ({
  page,
}) => {
  const editor = page.locator('[data-shard-editor="composer"]')

  await fillEditor(page, "composer", "- [ ] 任务")
  await expect(
    editor.getByRole("checkbox", { name: "标记为完成" })
  ).toBeVisible()
  await selectEditorText(page, "composer", "任务", { collapse: "end" })
  await page.keyboard.press("Enter")
  await expect.poll(() => readEditor(page, "composer")).toBe(
    "- [ ] 任务\n- [ ]",
  )
  await expect(editor.getByRole("checkbox")).toHaveCount(2)

  await fillEditor(page, "composer", "- [ ] 任务")
  await selectEditorText(page, "composer", "任务", { collapse: "start" })
  await page.keyboard.press("Backspace")
  await expect.poll(() => readEditor(page, "composer")).toBe("任务")
  await expect(editor.getByRole("checkbox")).toHaveCount(0)
})

test("#tag 与荧光笔并存时标签始终可见", async ({ page }) => {
  await fillEditor(page, "composer", "#tag ==荧光==")
  const editor = page.locator('[data-shard-editor="composer"]')
  await expect(editor.locator(".shard-rich-tag")).toHaveText("#tag")
  await expect(editor.locator(".ProseMirror mark")).toHaveText("荧光")
  await expect(editor.locator(".ProseMirror")).not.toContainText("==")

  // 光标移动到哪里标签都保持原样，不会被隐藏或换成源码
  await selectEditorText(page, "composer", "荧光", { collapse: "end" })
  await expect(editor.locator(".shard-rich-tag")).toHaveText("#tag")
  await focusEditor(page, "composer")
  await page.keyboard.press("ControlOrMeta+Home")
  await expect(editor.locator(".shard-rich-tag")).toHaveText("#tag")
  await expect(editor.locator(".ProseMirror")).toContainText("#tag")
  await expect.poll(() => readEditor(page, "composer")).toBe("#tag ==荧光==")
})

test("任务 checkbox 点击写回完成状态", async ({ page }) => {
  await fillEditor(page, "composer", "- [ ] 完成")
  await page
    .locator('[data-shard-editor="composer"]')
    .getByRole("checkbox", { name: "标记为完成" })
    .click()
  await expect.poll(() => readEditor(page, "composer")).toBe("- [x] 完成")
})

test("分割线在编辑区渲染为分隔线，编辑区看不到源码", async ({ page }) => {
  const editor = page.locator('[data-shard-editor="composer"]')
  await fillEditor(page, "composer", "---\n\n后文")
  await expect(editor.locator(".ProseMirror hr")).toHaveCount(1)
  await expect(editor.locator(".ProseMirror")).not.toContainText("---")

  await selectEditorText(page, "composer", "后文", { collapse: "start" })
  await expect(editor.locator(".ProseMirror hr")).toHaveCount(1)
  await expect.poll(() => readEditor(page, "composer")).toBe("---\n\n后文")
})

test("图片附件使用 read_fragment_image 结果渲染", async ({ page }) => {
  const imageSrc =
    "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="
  await installTauriMock(page, { imageSrc })
  await page.reload()
  await expect(page.locator("[data-shard-fragment-id]")).toHaveCount(24)

  const content = "![测试图](assets/test.png)\n正文"
  const editor = page.locator('[data-shard-editor="composer"]')
  await fillEditor(page, "composer", content)
  const image = editor.locator(
    '[data-shard-rich-inline="image"] img[data-source-path="assets/test.png"]'
  )
  await expect(image).toHaveAttribute("src", imageSrc)
  await expect(editor.locator(".ProseMirror")).not.toContainText("![测试图]")

  // 光标进入同一段不再揭示源码：附件节点一直在
  await selectEditorText(page, "composer", "正文", { collapse: "end" })
  await expect(image).toHaveAttribute("src", imageSrc)
})

test("code span 内的 == 不高亮", async ({ page }) => {
  const content = "`==代码==` ==荧光=="
  await fillEditor(page, "composer", content)
  const editor = page.locator('[data-shard-editor="composer"]')
  await expect(editor.locator(".ProseMirror mark")).toHaveCount(1)
  await expect(editor.locator(".ProseMirror mark")).toHaveText("荧光")
  await expect(editor.locator(".ProseMirror code")).toHaveText("==代码==")
  await expect.poll(() => readEditor(page, "composer")).toBe(content)
})

test("跨 #tag 与荧光笔的原生选区 rect 连续", async ({ page }) => {
  const content = "前 #tag ==荧光== 后"
  await fillEditor(page, "composer", content)
  await focusEditor(page, "composer")
  await page.keyboard.press("ControlOrMeta+a")

  const metrics = await page
    .locator('[data-shard-editor="composer"] .ProseMirror')
    .evaluate(() => {
      const selection = window.getSelection()
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null
      const rects = range
        ? Array.from(range.getClientRects())
            .filter((rect) => rect.width > 0)
            .sort(
              (left, right) => left.top - right.top || left.left - right.left,
            )
        : []
      let maxGap = 0
      for (let index = 1; index < rects.length; index += 1) {
        if (Math.abs(rects[index].top - rects[index - 1].top) < 1) {
          maxGap = Math.max(maxGap, rects[index].left - rects[index - 1].right)
        }
      }
      return { maxGap, rectCount: rects.length }
    })

  expect(metrics.rectCount).toBeGreaterThan(0)
  // 同一行内相邻 rect 必须相接：标签节点与荧光笔 mark 把文本拆成多个元素，
  // 选区不能因此碎成有缝的块。
  expect(metrics.maxGap).toBeLessThan(1)
})

test("荧光笔高亮块铺满行盒", async ({ page }) => {
  await fillEditor(page, "composer", "前面 ==荧光笔== 后面")
  const highlight = page.locator(
    '[data-shard-editor="composer"] .ProseMirror mark'
  )
  await expect(highlight).toHaveText("荧光笔")

  const metrics = await highlight.evaluate((element) => {
    const highlightRect = element.getBoundingClientRect()
    const lineHeight = Number.parseFloat(
      getComputedStyle(element.closest(".ProseMirror") ?? element).lineHeight,
    )
    return { highlightHeight: highlightRect.height, lineHeight }
  })

  // --shard-editor-highlight-pad-y 让荧光笔的行内背景块撑到整个行盒高
  expect(Math.abs(metrics.highlightHeight - metrics.lineHeight)).toBeLessThan(1)
})

test("zen editor renders highlight markup with hidden markers", async ({ page }) => {
  await fillEditor(page, "composer", "禅模式荧光笔")
  await focusEditor(page, "composer")
  await page.keyboard.press("Control+Shift+f")

  const zenEditorId = await page.evaluate(() => {
    const bridge = (window as typeof window & {
      __shardEditorTest?: { list(): string[] }
    }).__shardEditorTest
    return bridge?.list().find((id) => id.startsWith("zen:")) ?? ""
  })
  expect(zenEditorId).not.toBe("")
  const zenContent = "==禅模式荧光笔=="
  await fillEditor(page, zenEditorId, zenContent)

  const editor = page.locator(`[data-shard-editor="${zenEditorId}"]`)
  await expect(editor.locator(".ProseMirror mark")).toHaveText("禅模式荧光笔")
  await expect(editor.locator(".ProseMirror")).not.toContainText("==")
  await expect.poll(() => readEditor(page, zenEditorId)).toBe(zenContent)
})

test("main shell keeps geometry and local scrolling", async ({ page }) => {
  const geometry = await page.evaluate(() => {
    const save = document.querySelector<HTMLButtonElement>(
      'button[aria-label="保存片段"]'
    )
    const editor = document.querySelector<HTMLElement>(
      '[data-shard-editor="composer"]'
    )
    const editorViewport = editor?.closest(".shard-editor")?.parentElement
    const timeline = document.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    const saveRect = save?.getBoundingClientRect()
    const editorRect = editorViewport?.getBoundingClientRect()
    const timelineRect = timeline?.getBoundingClientRect()

    return {
      bodyOverflow: getComputedStyle(document.body).overflow,
      save: saveRect
        ? {
            height: saveRect.height,
            radius: getComputedStyle(save!).borderRadius,
            width: saveRect.width,
          }
        : null,
      editor: editorRect
        ? {
            radius: getComputedStyle(editorViewport!).borderRadius,
            width: editorRect.width,
          }
        : null,
      timeline: timelineRect
        ? {
            height: timelineRect.height,
            overflowY: getComputedStyle(timeline!).overflowY,
          }
        : null,
    }
  })

  expect(geometry.bodyOverflow).toBe("hidden")
  expect(geometry.save).toEqual({ height: 32, radius: "4px", width: 32 })
  expect(geometry.editor?.width).toBeGreaterThan(800)
  expect(geometry.editor?.radius).toBe("6px 6px 0px 0px")
  expect(geometry.timeline?.height).toBeGreaterThan(300)
  expect(["auto", "scroll"]).toContain(geometry.timeline?.overflowY)
})

test("capture, card menu, and share dialog remain functional", async ({
  page,
}) => {
  await fillEditor(page, "composer", "迁移后的新片段 #work")
  await focusEditor(page, "composer")
  await page.keyboard.press("Control+Enter")

  await expect(page.locator("[data-shard-fragment-id]")).toHaveCount(25)
  await expect(page.getByText("迁移后的新片段")).toBeVisible()
  await expect(page.getByText("#work").first()).toBeVisible()
  await expect(page.getByText("碎片已保存")).toBeVisible()

  const copiedCard = page
    .locator("[data-shard-fragment-id]")
    .filter({ hasText: "迁移后的新片段" })
  const firstCard = page.locator("[data-shard-fragment-id]").first()
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await copiedCard.getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "复制" }).click()
  await expect(page.getByText("已复制片段内容")).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "迁移后的新片段 #work"
  )

  await firstCard.getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "分享" }).last().click()

  const dialog = page.getByRole("dialog")
  await expect(
    dialog.getByRole("heading", { name: "导出分享图片" })
  ).toBeVisible()
  await expect(dialog.getByLabel("分享图片预览")).toBeVisible()

  const layout = await dialog.evaluate((element) => {
    const aside = element.querySelector<HTMLElement>("aside")
    const footerActions = element.querySelector<HTMLElement>("footer > div")

    return {
      dialog: { height: element.offsetHeight, width: element.offsetWidth },
      asideWidth: aside?.offsetWidth,
      footerGap: footerActions ? getComputedStyle(footerActions).gap : null,
    }
  })

  expect(layout.dialog.width).toBe(960)
  expect(layout.dialog.height).toBeLessThanOrEqual(760)
  expect(layout.asideWidth).toBe(240)
  expect(layout.footerGap).toBe("8px")

  await dialog.getByRole("button", { name: "取消" }).click()
  await expect(dialog).toBeHidden()
})

test("超宽表格导出时单元格文本不溢出内容区", async ({ page }) => {
  await fillEditor(
    page,
    "composer",
    [
      "超宽排期",
      "| 序号 | 日期 | 时间段 | 学校全称 | 负责人 | 事项说明 | 年级 | 备注信息 |",
      "| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |",
      "| 1 | 8月24日 | 8:30-11:00 | 行知中学高中部 | 张老师 | 市场采单与返校登记 | 高一 | 需带宣传物料 |",
    ].join("\n")
  )
  await focusEditor(page, "composer")
  await page.keyboard.press("Control+Enter")

  const card = page
    .locator("[data-shard-fragment-id]")
    .filter({ hasText: "超宽排期" })
  await card.getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "分享" }).last().click()

  const canvas = page.getByRole("dialog").getByLabel("分享图片预览")
  await expect(canvas).toBeVisible()

  // 中文没有空格，整串是一个 token；折行必须逐字切分，
  // 否则窄列里的单元格会原样画出去、越过内容区右边界互相重叠。
  const darkPixelsOutsideContent = await canvas.evaluate(
    (element: HTMLCanvasElement) => {
      const logicalWidth = Number(element.dataset.logicalWidth ?? 0)
      const ratio = element.width / logicalWidth
      const context = element.getContext("2d")
      if (!context || !logicalWidth) return -1

      // 右侧页边距区域：表格内容不该出现在这里
      const x = Math.round((logicalWidth - 20) * ratio)
      const width = Math.round(20 * ratio)
      const y = Math.round(90 * ratio)
      const height = Math.round(200 * ratio)
      const { data } = context.getImageData(x, y, width, height)

      let dark = 0
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
        if ((a ?? 0) > 10 && (r ?? 255) < 150 && (g ?? 255) < 150 && (b ?? 255) < 150) {
          dark += 1
        }
      }
      return dark
    }
  )

  expect(darkPixelsOutsideContent).toBe(0)
})

test("table fragment exports a non-empty PNG", async ({ page }) => {
  await fillEditor(
    page,
    "composer",
    [
      "学校安排",
      "| 日期 | 学校 | 活动 |",
      "| :--- | :---: | ---: |",
      "| 8 月 27 日 | 行知中学 | 返校 |",
      "| 8 月 28 日 | 卓群中学 | 市场采单 |",
    ].join("\n")
  )
  await focusEditor(page, "composer")
  await page.keyboard.press("Control+Enter")

  const tableCard = page
    .locator("[data-shard-fragment-id]")
    .filter({ hasText: "行知中学" })
  await expect(tableCard.locator("table")).toBeVisible()
  await tableCard.getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "分享" }).last().click()

  const dialog = page.getByRole("dialog")
  const canvas = dialog.getByLabel("分享图片预览")
  await expect(canvas).toBeVisible()
  await expect
    .poll(() =>
      canvas.evaluate((element: HTMLCanvasElement) =>
        Math.min(
          element.height,
          Number(element.dataset.logicalHeight ?? 0),
          element.width
        )
      )
    )
    .toBeGreaterThan(0)
  await expect(dialog.getByRole("button", { name: "复制图片" })).toBeEnabled()
  await dialog.getByRole("button", { name: "复制图片" }).click()
  await expect(page.getByText("分享图片已复制")).toBeVisible()

  const pngByteLength = await page.evaluate(() => {
    const calls = (
      globalThis as typeof globalThis & {
        __SHARD_TEST_CALLS__?: Array<{
          args: { bytes?: unknown }
          command: string
        }>
      }
    ).__SHARD_TEST_CALLS__
    const copyCall = calls
      ?.filter((call) => call.command === "copy_exported_image")
      .at(-1)
    return Array.isArray(copyCall?.args.bytes) ? copyCall.args.bytes.length : 0
  })
  expect(pngByteLength).toBeGreaterThan(0)
})

test("search recall mode preserves context, focus, and timeline scrolling", async ({
  page,
}) => {
  const composer = page.locator('[data-shard-editor="composer"]')
  const composerContent = composer.locator(".ProseMirror")
  const documentScrollBefore = await page.evaluate(
    () => document.scrollingElement?.scrollTop ?? -1
  )

  await page.keyboard.press("Control+k")
  const search = page.getByRole("combobox", { name: "搜索内容" })
  await expect(search).toBeFocused()
  await search.fill("密匣中的")
  await expect(page.getByText("没有找到“密匣中的”")).toBeVisible()
  await expect(page.getByRole("option")).toHaveCount(0)
  await search.fill("work")
  await expect(page.getByRole("option")).toHaveCount(12)
  await expect(page.getByText(/fragments\/2026/)).toHaveCount(0)

  await search.fill("不存在的快速查询")
  await search.press("Enter")
  await expect(page.getByRole("search")).toBeVisible()
  await expect(page.getByRole("button", { name: "返回搜索结果" })).toHaveCount(0)
  await expect(page.getByText("没有找到“不存在的快速查询”")).toBeVisible()
  await search.fill("work")
  await expect(page.getByRole("option")).toHaveCount(12)

  await page.waitForTimeout(200)
  const searchStyles = await search.evaluate((element) => {
    const style = getComputedStyle(element)
    const focusProbe = document.createElement("div")
    focusProbe.style.cssText = [
      "all: initial",
      "position: absolute",
      "border: 1px solid color-mix(in oklab, var(--primary) 70%, transparent)",
      "box-shadow: var(--shadow-primary-focus)",
    ].join(";")
    element.parentElement?.append(focusProbe)
    const focusProbeStyle = getComputedStyle(focusProbe)
    const expectedBorderColor = focusProbeStyle.borderColor
    const expectedBoxShadow = focusProbeStyle.boxShadow
    focusProbe.remove()
    return {
      borderRadius: style.borderRadius,
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
      expectedBorderColor,
      expectedBoxShadow,
      fontFamily: style.fontFamily,
      height: style.height,
    }
  })
  // 32px = compact 档的 --control-height（kiln standard 档是 36px）。
  // 密度档由 index.html 的 data-density 决定，见 vendor/kiln/SKILL.md → Density Ladder。
  // 圆角不随密度档变，仍是 4px。
  expect(searchStyles.height).toBe("32px")
  expect(searchStyles.borderRadius).toBe("4px")
  expect(searchStyles.borderColor).toBe(searchStyles.expectedBorderColor)
  expect(searchStyles.boxShadow.endsWith(searchStyles.expectedBoxShadow)).toBe(
    true
  )
  expect(searchStyles.boxShadow).not.toContain("0px 0px 0px 3px")
  expect(searchStyles.fontFamily).toContain("Noto Sans SC")

  await page.keyboard.press("Escape")
  await expect(page.getByRole("search")).toBeHidden()
  await expect(composerContent).toBeFocused()

  await page.keyboard.press("Control+k")
  await search.fill("work")
  await expect(page.getByRole("option")).toHaveCount(12)
  for (let index = 0; index < 9; index += 1) {
    await search.press("ArrowDown")
  }
  const selectedOption = page.getByRole("option").nth(9)
  await expect(selectedOption).toHaveAttribute("aria-selected", "true")
  await search.press("Enter")

  await expect(page.getByRole("button", { name: "碎片", exact: true })).toHaveAttribute("aria-current", "page")
  await expect(page.getByRole("complementary", { name: "资料库目录" })).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "返回搜索结果" })
  ).toBeVisible()
  const locatedFragment = page.locator(
    '[data-shard-fragment-id="fragment-19"]'
  )
  await expect(locatedFragment).toBeVisible()
  await expect(locatedFragment).toBeInViewport()

  // 定位滚动是 behavior:"smooth"。toBeInViewport() 只要求部分可见，滚到一半就
  // 满足，此时取 rect 会量到动画中途的位置（实测全量跑比单独跑少滚 199px，
  // 机器负载越高越明显）。先等目标完全落入视口，再测量。
  await page.waitForFunction(() => {
    const target = document.querySelector<HTMLElement>(
      '[data-shard-fragment-id="fragment-19"]'
    )
    const viewport = target?.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    if (!target || !viewport) return false

    const targetRect = target.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    return (
      targetRect.top >= viewportRect.top &&
      targetRect.bottom <= viewportRect.bottom
    )
  })

  const scrollContract = await page.evaluate(() => {
    const target = document.querySelector<HTMLElement>(
      '[data-shard-fragment-id="fragment-19"]'
    )
    const viewport = target?.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    return {
      documentScroll: document.scrollingElement?.scrollTop ?? -1,
      targetBottom: target?.getBoundingClientRect().bottom,
      targetTop: target?.getBoundingClientRect().top,
      viewportBottom: viewport?.getBoundingClientRect().bottom,
      viewportScroll: viewport?.scrollTop,
      viewportTop: viewport?.getBoundingClientRect().top,
    }
  })
  expect(scrollContract.documentScroll).toBe(documentScrollBefore)
  expect(scrollContract.viewportScroll).toBeGreaterThan(0)
  expect(scrollContract.targetTop).toBeGreaterThanOrEqual(
    scrollContract.viewportTop ?? 0
  )
  expect(scrollContract.targetBottom).toBeLessThanOrEqual(
    scrollContract.viewportBottom ?? Number.POSITIVE_INFINITY
  )

  await page.getByRole("button", { name: "返回搜索结果" }).click()
  await expect(composer).toBeVisible()
  await expect(search).toBeFocused()
  await expect(search).toHaveValue("work")
  await page.getByRole("button", { name: "退出搜索" }).click()
  await page.getByRole("button", { name: "结束搜索" }).click()

  await page.keyboard.press("Control+k")
  await search.fill("已删除")
  await expect(page.getByRole("option")).toHaveCount(1)
  await page.getByRole("button", { name: "未删除" }).click()
  await expect(page.getByText("没有找到“已删除”")).toBeVisible()
  await page.getByRole("button", { name: "退出搜索" }).click()

  await page.setViewportSize({ height: 640, width: 720 })
  await page.keyboard.press("Control+k")
  await search.fill("work")
  await expect(page.getByRole("option")).toHaveCount(12)
  const compactGeometry = await page.getByRole("search").evaluate((element) => {
    const input = element.querySelector<HTMLInputElement>(
      '[role="combobox"]'
    )
    const inputRect = input?.getBoundingClientRect()
    const inputStyle = input ? getComputedStyle(input) : null
    return {
      clientWidth: element.clientWidth,
      inputBottom: inputRect?.bottom,
      inputLeft: inputRect?.left,
      inputRight: inputRect?.right,
      inputShadow: inputStyle?.boxShadow,
      scrollWidth: element.scrollWidth,
    }
  })
  expect(compactGeometry.scrollWidth).toBe(compactGeometry.clientWidth)
  expect(compactGeometry.inputLeft).toBeGreaterThan(0)
  expect(compactGeometry.inputRight).toBeLessThan(720)
  expect(compactGeometry.inputBottom).toBeLessThan(640)
  expect(compactGeometry.inputShadow).toContain("rgb")
  await page.getByRole("button", { name: "退出搜索" }).click()
  await page.setViewportSize({ height: 720, width: 1280 })

  const utilityTrigger = page.locator(
    "[data-shard-utility-menu-trigger]:visible"
  )
  await utilityTrigger.click()
  await page.getByRole("menuitem", { name: "设置" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(utilityTrigger).toBeFocused()
})

test("lockbox and mind map editing preserve adaptive node geometry", async ({
  page,
}) => {
  // 密匣入口已移到资料库树的上锁挂载点（传送门模型），侧栏不再有密匣项
  await expect(
    page
      .getByRole("navigation", { name: "工作台导航" })
      .getByRole("button", { name: /^密匣/ })
  ).toHaveCount(0)
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page
    .getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: "密匣（上锁空间）", exact: true })
    .click()
  // 推门先落进上锁的一级空间：整页只有主体解锁面板，不弹窗、无标题条
  await expect(
    page.getByRole("heading", { name: "密匣已上锁", exact: true })
  ).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)

  await openMindMaps(page)
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()
  await page.setViewportSize({ height: 720, width: 900 })
  // Workspace resize preserves the chosen zoom; explicitly zoom out to exercise scaled editing.
  await page.getByLabel("思维导图编辑器").dispatchEvent("wheel", {
    deltaY: 160, ctrlKey: true, clientX: 450, clientY: 360, bubbles: true,
  })

  const childNode = page.locator('[data-mind-map-node="child"]')
  await childNode.dblclick()
  let nodeEditor = page.getByRole("textbox", { name: "导图节点" })
  await expect(nodeEditor).toBeFocused()
  await expect(nodeEditor).toHaveJSProperty("tagName", "TEXTAREA")

  await nodeEditor.press("Escape")
  await expect(nodeEditor).toBeHidden()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  await childNode.dblclick()
  nodeEditor = page.getByRole("textbox", { name: "导图节点" })
  await expect(nodeEditor).toBeFocused()

  const initialBox = await nodeEditor.boundingBox()
  expect(initialBox).not.toBeNull()
  const canvasScale = await page.getByLabel("思维导图编辑器").evaluate(element => {
    const svg = element as SVGSVGElement
    return svg.getBoundingClientRect().width / svg.viewBox.baseVal.width
  })
  const moveHandle = page.getByRole("button", { name: "拖拽移动节点" })
  const initialTypography = await nodeEditor.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      clientHeight: element.clientHeight,
      fontSize: Number.parseFloat(style.fontSize),
      lineHeight: Number.parseFloat(style.lineHeight),
      paddingBottom: Number.parseFloat(style.paddingBottom),
      paddingTop: Number.parseFloat(style.paddingTop),
      scrollHeight: element.scrollHeight,
    }
  })
  const moveHandleBox = await moveHandle.boundingBox()
  expect(initialTypography.fontSize).toBeLessThan(13)
  expect(initialTypography.lineHeight).toBeLessThan(18)
  expect(initialTypography.scrollHeight).toBeLessThanOrEqual(
    initialTypography.clientHeight + 1
  )
  expect(
    Math.abs(initialTypography.paddingTop - initialTypography.paddingBottom)
  ).toBeLessThanOrEqual(0.1)
  const initialContentHeight =
    initialTypography.clientHeight -
    initialTypography.paddingTop -
    initialTypography.paddingBottom
  expect(
    Math.abs(initialContentHeight - initialTypography.lineHeight)
  ).toBeLessThanOrEqual(1)
  expect(moveHandleBox?.height ?? 32).toBeLessThan(32)

  await nodeEditor.fill("节点会随着文字数量持续增加而自动扩展")
  await expect
    .poll(async () => (await nodeEditor.boundingBox())?.width ?? 0)
    .toBeGreaterThan((initialBox?.width ?? 0) + 40)

  await nodeEditor.fill("自动扩展节点".repeat(12))
  await expect
    .poll(async () => (await nodeEditor.boundingBox())?.height ?? 0)
    .toBeGreaterThan((initialBox?.height ?? 0) + 8 * canvasScale)
  const longTextOverflow = await nodeEditor.evaluate((element) => ({
    horizontal: element.scrollWidth - element.clientWidth,
    vertical: element.scrollHeight - element.clientHeight,
  }))
  expect(longTextOverflow.horizontal).toBeLessThanOrEqual(1)
  expect(longTextOverflow.vertical).toBeLessThanOrEqual(1)
  const longNodeText = await nodeEditor.inputValue()
  await nodeEditor.press("End")
  await nodeEditor.press("Shift+Enter")
  await page.keyboard.insertText("手动换行")
  await expect(nodeEditor).toHaveValue(`${longNodeText}\n手动换行`)

  await page.getByLabel("思维导图编辑器").click({
    position: { x: 12, y: 12 },
  })
  await expect(nodeEditor).toBeHidden()
  expect(await page.getByRole("region", { name: "思维导图画布", exact: true })
    .evaluate(element => element.contains(document.activeElement))).toBe(true)
  expect(await childNode.locator("tspan").count()).toBeGreaterThan(1)
  const childRect = childNode.locator("rect").last()
  const grandchildRect = page
    .locator('[data-mind-map-node="grandchild"] rect')
    .last()
  const grandchildText = page.locator(
    '[data-mind-map-node="grandchild"] text'
  )
  // 基线由实测字形偏移的显式 y 给出，不再依赖 dominant-baseline / dy hack。
  await expect(grandchildText.locator("tspan").first()).not.toHaveAttribute(
    "dy",
    /.+/
  )
  const grandchildVerticalDelta = await grandchildText.evaluate((text) => {
    const node = text.closest("[data-mind-map-node]")
    const rect = node?.querySelector("rect")
    if (!rect) return Number.POSITIVE_INFINITY

    const textBox = text.getBoundingClientRect()
    const rectBox = rect.getBoundingClientRect()
    return Math.abs(
      textBox.top +
        textBox.height / 2 -
        (rectBox.top + rectBox.height / 2)
    )
  })
  expect(grandchildVerticalDelta).toBeLessThanOrEqual(2)
  const childRight =
    Number(await childRect.getAttribute("x")) +
    Number(await childRect.getAttribute("width"))
  const grandchildLeft = Number(await grandchildRect.getAttribute("x"))
  expect(grandchildLeft - childRight).toBeGreaterThanOrEqual(96)

  await page.keyboard.press("Control+Enter")
  await expect(page.getByLabel("打开思维导图：测试导图")).toBeVisible()
  expect(
    await page.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          __SHARD_TEST_COMMANDS__?: string[]
        }
      ).__SHARD_TEST_COMMANDS__?.includes("write_mind_map")
    )
  ).toBe(true)
})

test("mind map canvas deletes nodes from selected state", async ({ page }) => {
  await openMindMaps(page)
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  const childNode = page.locator('[data-mind-map-node="child"]')
  const grandchildNode = page.locator('[data-mind-map-node="grandchild"]')

  // 单击只是选中节点，不进入文本编辑，节点文字保持可见。
  await childNode.click()
  await expect(page.getByRole("textbox", { name: "导图节点" })).toBeHidden()
  await expect(childNode.locator("text")).toBeVisible()

  // Ctrl/⌘+Delete：只删节点本身，子节点上提到祖父节点下。
  await page.keyboard.press("Control+Delete")
  await expect(childNode).toBeHidden()
  await expect(grandchildNode).toBeVisible()

  // Delete：连子树删除。
  await grandchildNode.click()
  await page.keyboard.press("Delete")
  await expect(grandchildNode).toBeHidden()
})

test("mind map canvas context menu acts on nodes and multi-selection", async ({
  page,
}) => {
  await openMindMaps(page)
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  const childNode = page.locator('[data-mind-map-node="child"]')
  const grandchildNode = page.locator('[data-mind-map-node="grandchild"]')

  // 右键空白画布不打开菜单。
  await page
    .getByLabel("思维导图编辑器")
    .click({ button: "right", position: { x: 12, y: 12 } })
  await expect(page.getByRole("menu")).toBeHidden()

  // 多选后右键集合内节点：保留多选，菜单按数量展示。
  await childNode.click()
  await grandchildNode.click({ modifiers: ["Meta"] })
  await grandchildNode.click({ button: "right" })
  await expect(
    page.getByRole("menuitem", { name: /删除 2 个节点及子节点/ })
  ).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("menu")).toBeHidden()

  // 右键单选节点：仅删除节点本身，子节点上提。
  await childNode.click()
  await childNode.click({ button: "right" })
  await page
    .getByRole("menuitem", { name: /仅删除节点（子节点上提）/ })
    .click()
  await expect(childNode).toBeHidden()
  await expect(grandchildNode).toBeVisible()

  // 右键菜单连子树删除，destructive 项 hover 时有可见底色。
  await grandchildNode.click({ button: "right" })
  const destructiveItem = page.getByRole("menuitem", {
    name: /删除节点及子节点/,
  })
  await destructiveItem.hover()
  const destructiveHoverBg = await destructiveItem.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  )
  expect(destructiveHoverBg).not.toBe("rgba(0, 0, 0, 0)")
  expect(destructiveHoverBg).not.toBe("transparent")
  await destructiveItem.click()
  await expect(grandchildNode).toBeHidden()
})

test("mind map canvas marquee selects nodes and space-drag pans", async ({
  page,
}) => {
  await openMindMaps(page)
  await page.getByLabel("打开思维导图：测试导图").click()
  const svg = page.getByLabel("思维导图编辑器")
  await expect(svg).toBeVisible()

  const childNode = page.locator('[data-mind-map-node="child"]')
  const grandchildNode = page.locator('[data-mind-map-node="grandchild"]')

  // 默认光标是箭头（选择工具），不是抓手。
  await expect(svg).toHaveCSS("cursor", "default")

  // 空白处拖出包围 child + grandchild 的选框，松开后两个节点都被选中。
  const childBox = (await childNode.boundingBox())!
  const grandchildBox = (await grandchildNode.boundingBox())!
  const left = Math.min(childBox.x, grandchildBox.x) - 30
  const top = Math.min(childBox.y, grandchildBox.y) - 30
  const right =
    Math.max(
      childBox.x + childBox.width,
      grandchildBox.x + grandchildBox.width
    ) + 30
  const bottom =
    Math.max(
      childBox.y + childBox.height,
      grandchildBox.y + grandchildBox.height
    ) + 30
  await page.mouse.move(left, top)
  await page.mouse.down()
  await page.mouse.move(right, bottom, { steps: 5 })
  await expect(page.locator('[data-mind-map-marquee="true"]')).toBeVisible()
  await page.mouse.up()

  // 框选只选中节点，不能带出原生文本选区（节点文字在非编辑态不可选）。
  const nativeSelection = await page.evaluate(
    () => window.getSelection()?.toString() ?? ""
  )
  expect(nativeSelection).toBe("")

  // 右键集合内节点：多选保留，菜单按 2 个节点展示。
  await grandchildNode.click({ button: "right" })
  await expect(
    page.getByRole("menuitem", { name: /删除 2 个节点及子节点/ })
  ).toBeVisible()
  await page.keyboard.press("Escape")

  // 按住空格 = 抓手工具，拖拽平移画布。
  const beforeViewBox = await svg.getAttribute("viewBox")
  await page.keyboard.down(" ")
  await expect(svg).toHaveCSS("cursor", "grab")
  await page.mouse.move(childBox.x + childBox.width / 2, bottom + 40)
  await page.mouse.down()
  await page.mouse.move(childBox.x + childBox.width / 2 + 120, bottom + 130, {
    steps: 5,
  })
  await page.mouse.up()
  await page.keyboard.up(" ")
  expect(await svg.getAttribute("viewBox")).not.toBe(beforeViewBox)

  // T0：适应屏幕按钮出现，点击后回到全图自适应视图。
  const fitButton = page.getByRole("button", { name: "适应屏幕" })
  await expect(fitButton).toBeVisible()
  await fitButton.click()
  expect(await svg.getAttribute("viewBox")).toBe(beforeViewBox)
})

test("mind map canvas collapses and expands subtrees", async ({ page }) => {
  await openMindMaps(page)
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  const childNode = page.locator('[data-mind-map-node="child"]')
  const grandchildNode = page.locator('[data-mind-map-node="grandchild"]')
  const toggle = page.locator('[data-mind-map-collapse-toggle="child"]')

  // 有子节点的节点显示折叠钮；点击后子树收拢并显示计数。
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(grandchildNode).toBeHidden()
  await expect(toggle.locator("text")).toHaveText("1")

  // 折叠态下 Tab 新增子节点：自动展开，新节点进入编辑。
  await childNode.click()
  await page.keyboard.press("Tab")
  await expect(grandchildNode).toBeVisible()
  await expect(page.getByRole("textbox", { name: "导图节点" })).toBeFocused()
  await expect(toggle.locator("text")).toHaveCount(0)

  // ⌘/ 快捷键折叠/展开。
  await page.keyboard.press("Escape")
  await childNode.click()
  await page.keyboard.press("Meta+/")
  await expect(grandchildNode).toBeHidden()
  await page.keyboard.press("Meta+/")
  await expect(grandchildNode).toBeVisible()
})

test("mind map workspace undo/redo restores deletions and merges typing", async ({
  page,
}) => {
  await openMindMaps(page)
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  const childNode = page.locator('[data-mind-map-node="child"]')
  const grandchildNode = page.locator('[data-mind-map-node="grandchild"]')

  // 结构操作：删除子树 → ⌘Z 恢复 → ⇧⌘Z 再删。
  await childNode.click()
  await page.keyboard.press("Delete")
  await expect(childNode).toBeHidden()
  await expect(grandchildNode).toBeHidden()
  await page.keyboard.press("Meta+z")
  await expect(childNode).toBeVisible()
  await expect(grandchildNode).toBeVisible()
  await page.keyboard.press("Meta+Shift+z")
  await expect(childNode).toBeHidden()

  // 恢复后进入文本编辑。
  await page.keyboard.press("Meta+z")
  await expect(childNode).toBeVisible()
  const editor = page.getByRole("textbox", { name: "导图节点" })
  await childNode.dblclick()
  await expect(editor).toBeFocused()

  // 连续输入合并为一条历史；等自动保存落盘。
  const writeCount = () =>
    page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __SHARD_TEST_COMMANDS__?: string[]
          }
        ).__SHARD_TEST_COMMANDS__?.filter((command) => command === "write_mind_map")
          .length ?? 0
    )
  await editor.fill("第一阶段")
  await expect.poll(writeCount, { timeout: 5000 }).toBeGreaterThan(0)

  // 保存后继续编辑是新的一步；⌘Z 回到刚保存的内容，不再触发写盘。
  await editor.fill("第一阶段改")
  const writesBeforeUndo = await writeCount()
  await page.keyboard.press("Meta+z")
  await expect(editor).toHaveValue("第一阶段")
  await page.waitForTimeout(1600)
  expect(await writeCount()).toBe(writesBeforeUndo)

  // 连续打字合并：一次 ⌘Z 直接回到编辑前文本。
  await editor.fill("迁移回归节点替换")
  await page.keyboard.press("Meta+z")
  await expect(editor).toHaveValue("第一阶段")
})

test("mind map canvas arrow keys navigate the tree", async ({ page }) => {
  await openMindMaps(page)
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  const rootNode = page.locator('[data-mind-map-node="root"]')
  const childNode = page.locator('[data-mind-map-node="child"]')
  const grandchildNode = page.locator('[data-mind-map-node="grandchild"]')
  // 选中态的节点会比未选中多一个选框 rect。
  const selectedRects = (node: typeof childNode) => node.locator("rect")

  await childNode.click()
  await expect(selectedRects(childNode)).toHaveCount(2)

  // → 第一个子节点；← 父节点。
  await page.keyboard.press("ArrowRight")
  await expect(selectedRects(grandchildNode)).toHaveCount(2)
  await expect(selectedRects(childNode)).toHaveCount(1)
  await page.keyboard.press("ArrowLeft")
  await expect(selectedRects(childNode)).toHaveCount(2)
  await page.keyboard.press("ArrowLeft")
  await expect(selectedRects(rootNode)).toHaveCount(2)

  // 根节点无同级，↑ 落空不报错；→ 回到 child。
  await page.keyboard.press("ArrowUp")
  await expect(selectedRects(rootNode)).toHaveCount(2)
  await page.keyboard.press("ArrowRight")
  await expect(selectedRects(childNode)).toHaveCount(2)

  // Enter 建同级节点后，↑ 回到 child。
  await page.keyboard.press("Enter")
  const editor = page.getByRole("textbox", { name: "导图节点" })
  await expect(editor).toBeFocused()
  await page.keyboard.press("Escape")
  await page.keyboard.press("ArrowUp")
  await expect(selectedRects(childNode)).toHaveCount(2)

  // 折叠节点上 → = 展开。
  await page.keyboard.press("Meta+/")
  await expect(grandchildNode).toBeHidden()
  await page.keyboard.press("ArrowRight")
  await expect(grandchildNode).toBeVisible()
})

test("mind map canvas type-to-edit replaces node text", async ({ page }) => {
  await openMindMaps(page)
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  const childNode = page.locator('[data-mind-map-node="child"]')
  const editor = page.getByRole("textbox", { name: "导图节点" })

  // 选中态敲可打印字符：覆盖原文本并进入编辑，光标在末尾可继续追加。
  await childNode.click()
  await page.keyboard.press("a")
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue("a")
  await page.keyboard.type("bc")
  await expect(editor).toHaveValue("abc")

  // 单选主题时空格保留原文进入编辑；空白画布才使用空格抓手。
  await page.keyboard.press("Escape")
  await page.keyboard.press(" ")
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue("abc")
})

test("mind map workspace suppresses default Tab traversal without creating topics", async ({
  page,
}) => {
  await openMindMaps(page)
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  const initialCount = await page.locator("[data-mind-map-node]").count()
  // 无节点选择时不再通过 Tab 轮转全局工作区控件。
  const exitButton = page.getByRole("button", { name: "退出思维导图", exact: true })
  await exitButton.focus()
  await page.keyboard.press("Tab")
  await expect(exitButton).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  await expect(exitButton).toBeFocused()
  await expect(page.locator("[data-mind-map-node]")).toHaveCount(initialCount)

  // 选中再取消后 Tab 保持画布焦点，不新建主题。
  await page.locator('[data-mind-map-node="child"]').click()
  await page.keyboard.press("Escape")
  const canvasFocus = await page.evaluateHandle(() => document.activeElement)
  expect(await page.getByRole("region", { name: "思维导图画布", exact: true })
    .evaluate(element => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press("Tab")
  expect(await canvasFocus.evaluate(element => element === document.activeElement)).toBe(true)
  await canvasFocus.dispose()
  await expect(page.locator("[data-mind-map-node]")).toHaveCount(initialCount)
})

test("fragment navigation only exposes all fragments and trash", async ({ page }) => {
  const navigation = page.getByRole("navigation", { name: "工作台导航" })
  await expect(navigation.getByRole("button", { name: /^全部碎片 24$/u })).toBeVisible()
  await expect(navigation.getByRole("button", { name: /^回收站 1$/u })).toBeVisible()
  await expect(page.getByRole("button", { name: /每日回顾|洞察视角|随机漫步/u })).toHaveCount(0)

  await navigation.getByRole("button", { name: /^回收站 1$/u }).click()
  await expect(page.getByRole("region", { name: "碎片回收站", exact: true })).toBeVisible()
  await navigation.getByRole("button", { name: /^全部碎片 24$/u }).click()
  await expect(page.locator("[data-shard-fragment-id]")).toHaveCount(24)
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeVisible()
})

for (const mode of ["dailyReview", "insight", "walk"]) {
  for (const route of [
    { space: "review", params: { mode } },
    { space: "fragments", params: { view: mode } },
  ]) {
    test(`removed ${route.space} ${mode} route restores the fragment stream`, async ({ page }) => {
      await page.evaluate((savedRoute) => {
        localStorage.setItem("shard.workspace-route", JSON.stringify(savedRoute))
      }, route)
      await page.reload()
      await expect(page.locator("[data-shard-fragment-id]")).toHaveCount(24)
      await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeVisible()
      await expect(page.getByRole("button", { name: /^全部碎片 24$/u })).toHaveAttribute("aria-current", "page")
      await expect(page.getByRole("button", { name: /每日回顾|洞察视角|随机漫步/u })).toHaveCount(0)
    })
  }
}

test("small windows use bottom tabs without document scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ height: 720, width: 820 })

  await expect(page.getByRole("navigation", { name: "工作台" }))
    .toBeVisible()
  const views = page.getByRole("navigation", { name: "碎片视图" })
  await expect(views).toBeVisible()
  await expect(views.getByRole("button")).toHaveCount(2)
  await expect(views.getByRole("button", { name: /^全部 24$/u })).toBeVisible()
  await expect(views.getByRole("button", { name: /^回收站 1$/u })).toBeVisible()
  await expect(page.getByRole("button", { name: /每日回顾|洞察|漫步/u })).toHaveCount(0)
  await expect(page.locator("aside").first()).toBeHidden()

  const overflow = await page.evaluate(() => ({
    body: getComputedStyle(document.body).overflow,
    root: getComputedStyle(document.querySelector("#root")!).overflow,
  }))
  expect(overflow).toEqual({ body: "hidden", root: "hidden" })
})

test.describe("片段关系层", () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMock(page, {
      relations: {
        "fragment-1": [
          { targetId: "fragment-3", note: "同一主题的补充资料" },
        ],
      },
    })
    await page.goto("/")
    await expect(page.locator("[data-shard-fragment-id]")).toHaveCount(24)
  })

  test("有关联的卡片显示折叠入口，展开后可跳转到目标片段", async ({
    page,
  }) => {
    const card = page.locator('[data-shard-fragment-id="fragment-1"]')
    const toggle = card.getByRole("button", { name: "1 条关联" })

    // 折叠态：只有一行入口，不展开内容
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute("aria-expanded", "false")

    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-expanded", "true")

    // 已确认的边排在最前，并带上建边理由
    const linkedRow = card.locator('button[title="同一主题的补充资料"]')
    await expect(linkedRow).toBeVisible()
    await expect(linkedRow).toContainText("第 3 条回归片段")

    // 点击跳转后目标卡片进入高亮
    await linkedRow.click()
    await expect(page.getByRole("button", { name: "碎片", exact: true })).toHaveAttribute("aria-current", "page")
    await expect(page.getByRole("complementary", { name: "资料库目录" })).toHaveCount(0)
    await expect(page.locator('[data-shard-fragment-id="fragment-3"]')).toHaveClass(/shard-fragment-card-highlight/)
  })

  test("没有关联的卡片不占用垂直空间，可从菜单显式打开", async ({ page }) => {
    const card = page.locator('[data-shard-fragment-id="fragment-5"]')

    // 默认时间线密度不变：无边的卡片没有任何关系入口
    await expect(card.getByRole("button", { name: /条关联/ })).toHaveCount(0)
    await expect(card.getByRole("button", { name: "相关片段" })).toHaveCount(0)

    await card.getByRole("button", { name: "片段操作" }).click()
    await page.getByRole("menuitem", { name: "相关片段" }).click()

    // 展开后按标签共现给出候选
    await expect(card.getByRole("button", { name: "相关片段" })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    await expect(card.locator('span[aria-label="同标签"]').first()).toBeVisible()
  })

  test("可从卡片菜单搜索目标并建立手动关联", async ({ page }) => {
    const card = page.locator('[data-shard-fragment-id="fragment-5"]')
    await card.getByRole("button", { name: "片段操作" }).click()
    await page.getByRole("menuitem", { name: "关联到片段…" }).click()

    const dialog = page.getByRole("dialog", { name: "关联到片段" })
    await expect(dialog).toBeVisible()
    await dialog.getByRole("textbox", { name: "搜索片段" }).fill("第 8 条")
    await dialog.getByRole("option", { name: /第 8 条回归片段/ }).click()

    await expect(dialog).toBeHidden()
    await expect(card.getByRole("button", { name: "1 条关联" })).toBeVisible()

    const linkCall = await page.evaluate(() => {
      const calls = (globalThis as typeof globalThis & {
        __SHARD_TEST_CALLS__: Array<{
          args: Record<string, unknown>
          command: string
        }>
      }).__SHARD_TEST_CALLS__
      return calls.find(
        (call) =>
          call.command === "link_fragments" && call.args.origin === "manual"
      )
    })
    expect(linkCall?.args).toMatchObject({
      origin: "manual",
      sourceId: "fragment-5",
      targetId: "fragment-8",
    })
  })

  test("关闭的关联弹窗不计算候选，按需打开后保留搜索与焦点恢复", async ({ page }) => {
    await page.addInitScript(() => {
      const work = { indexNormalizations: 0, candidateDates: 0 }
      Object.assign(globalThis, { __SHARD_LINK_DIALOG_WORK__: work })
      // Count the actual normalization/formatting work without a production test hook.
      const fromLinkDialog = () => new Error().stack?.includes("/fragment-link-dialog.tsx")
      const normalize = String.prototype.toLocaleLowerCase
      String.prototype.toLocaleLowerCase = function (...args) {
        if (fromLinkDialog()) work.indexNormalizations += 1
        return normalize.apply(this, args)
      }
      const formatDate = Date.prototype.toLocaleString
      Date.prototype.toLocaleString = function (...args) {
        if (fromLinkDialog()) work.candidateDates += 1
        return formatDate.apply(this, args)
      }
    })
    await page.reload()
    await expect(page.locator("[data-shard-fragment-id]")).toHaveCount(24)
    const readWork = () => page.evaluate(() => (
      globalThis as typeof globalThis & {
        __SHARD_LINK_DIALOG_WORK__: { indexNormalizations: number; candidateDates: number }
      }
    ).__SHARD_LINK_DIALOG_WORK__)
    expect(await readWork()).toEqual({ indexNormalizations: 0, candidateDates: 0 })

    const card = page.locator('[data-shard-fragment-id="fragment-5"]')
    const trigger = card.getByRole("button", { name: "片段操作" })
    const openLinkDialog = async () => {
      await trigger.click()
      await page.getByRole("menuitem", { name: "关联到片段…" }).click()
    }
    await openLinkDialog()
    const dialog = page.getByRole("dialog", { name: "关联到片段" })
    const search = dialog.getByRole("textbox", { name: "搜索片段" })
    await expect(search).toBeFocused()
    await expect(dialog.getByRole("option")).toHaveCount(20)
    const openedWork = await readWork()
    expect(openedWork.indexNormalizations).toBeGreaterThan(0)
    expect(openedWork.candidateDates).toBeGreaterThan(0)
    await search.fill("第 24 条")
    await expect(dialog.getByRole("option")).toHaveCount(1)
    await search.press("Escape")
    await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0)
    await expect(trigger).toBeFocused()

    const afterClose = await readWork()
    // A later card render must not retain the closed dialog's expensive body.
    await trigger.click()
    await page.getByRole("menuitem", { name: "编辑", exact: true }).press("Escape")
    await expect(trigger).toBeFocused()
    expect(await readWork()).toEqual(afterClose)

    await openLinkDialog()
    await expect(search).toBeFocused()
    await expect(search).toHaveValue("")
    await expect(dialog.getByRole("option")).toHaveCount(20)
    await search.fill("第 24 条")
    await expect(dialog.getByRole("option")).toHaveCount(1)
    await search.press("Enter")
    await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(card.getByRole("button", { name: "1 条关联" })).toBeVisible()
  })

  test("移除反向关联使用真实边 owner，且不会触发卡片跳转", async ({ page }) => {
    const card = page.locator('[data-shard-fragment-id="fragment-3"]')
    await card.getByRole("button", { name: "片段操作" }).click()
    await page.getByRole("menuitem", { name: "相关片段" }).click()

    const removeButton = card.getByRole("button", { name: "移除关联" })
    await expect(removeButton).toBeVisible()
    await removeButton.click()

    await expect(removeButton).toBeHidden()
    await expect(
      page.locator('[data-shard-fragment-id="fragment-1"]')
    ).not.toHaveClass(/shard-fragment-card-highlight/)

    const unlinkCall = await page.evaluate(() => {
      const calls = (globalThis as typeof globalThis & {
        __SHARD_TEST_CALLS__: Array<{
          args: Record<string, unknown>
          command: string
        }>
      }).__SHARD_TEST_CALLS__
      return calls.find((call) => call.command === "unlink_fragments")
    })
    expect(unlinkCall?.args).toMatchObject({
      sourceId: "fragment-1",
      targetId: "fragment-3",
    })
  })


})

/** 清空编辑器后像用户一样逐字输入，输入规则与标签建议都会照常触发。 */
async function typeFresh(page: Page, id: string, text: string) {
  await fillEditor(page, id, "")
  await focusEditor(page, id)
  await typeEditor(page, id, text)
}

/**
 * 编辑区可见正文（含空白）。序列化会裁掉段尾空白，
 * 断言「标签后补出的空格」「未收敛的手打井号」时看编辑区本身。
 */
async function editorText(page: Page, id: string) {
  return page
    .locator(`[data-shard-editor="${id}"] .ProseMirror`)
    .evaluate((element) => element.textContent ?? "")
}

test("/标签 插入井号：空白后不重复补空格", async ({ page }) => {
  // `/` 只在行首或空白后触发，删掉命令文本后光标前一定是空白或行首，
  // 井号直接落下，不会补出第二个空格。汉字后补空格的规则由
  // `getTagMarker` 单测覆盖，手打 `#` 的路径见下面的补全用例。
  await typeFresh(page, "composer", "密匣 /标签")
  await page.keyboard.press("Enter")
  await expect.poll(() => editorText(page, "composer")).toBe("密匣 #")

  await typeFresh(page, "composer", "/标签")
  await page.keyboard.press("Enter")
  await expect.poll(() => editorText(page, "composer")).toBe("#")
})

test("从建议里选中标签后自动补空格", async ({ page }) => {
  await typeFresh(page, "composer", "#wo")
  const suggestion = page
    .getByRole("listbox", { name: "标签建议" })
    .getByRole("option", { name: /work/ })
  await suggestion.click()

  // 补全后必须留出分隔空格，否则接着写下一个标签会粘连
  await expect.poll(() => editorText(page, "composer")).toBe("#work ")
  await expect(
    page.locator('[data-shard-editor="composer"] .ProseMirror')
  ).toBeFocused()
  // 光标落在补出的空格之后：接着打字不会粘在标签上
  await typeEditor(page, "composer", "续写")
  await expect.poll(() => readEditor(page, "composer")).toBe("#work 续写")
})

test("编辑模式选中标签后留出输入边距", async ({ page }) => {
  const card = page.locator('[data-shard-fragment-id="fragment-1"]')
  await card.getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "编辑" }).click()

  const editor = page.locator(
    '[data-shard-editor="fragment:fragment-1"] .ProseMirror'
  )
  await expect(editor).toBeFocused()
  await typeFresh(page, "fragment:fragment-1", "#wo")
  await page
    .getByRole("listbox", { name: "标签建议" })
    .getByRole("option", { name: /work/ })
    .click()

  await expect.poll(() => editorText(page, "fragment:fragment-1")).toBe("#work ")
  await expect(editor).toBeFocused()
  const caretGap = await page.evaluate(() => {
    const selection = window.getSelection()
    const caret = selection?.rangeCount
      ? selection.getRangeAt(0).getClientRects()[0]
      : undefined
    const tag = document
      .querySelector(
        '[data-shard-editor="fragment:fragment-1"] .shard-rich-tag'
      )
      ?.getBoundingClientRect()
    return caret && tag ? caret.left - tag.right : null
  })
  expect(caretGap).not.toBeNull()
  expect(caretGap ?? 0).toBeGreaterThanOrEqual(3)
})

test("标签补全用 ArrowDown 与 Enter 选择第二项", async ({ page }) => {
  await typeFresh(page, "composer", "#")
  const listbox = page.getByRole("listbox", { name: "标签建议" })
  await expect(listbox).toBeVisible()
  // 空 query 时候选顺序由标签索引决定，不假设第二项是谁：读出来再比对
  const second = (
    await listbox
      .getByRole("option")
      .nth(1)
      .locator(".shard-rich-suggestion-label")
      .innerText()
  ).trim()
  expect(second.length).toBeGreaterThan(0)
  await expect(listbox.getByRole("option").nth(0)).toHaveAttribute("aria-selected", "true")

  await page.keyboard.press("ArrowDown")
  await expect(listbox.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Enter")

  await expect.poll(() => editorText(page, "composer")).toBe(`#${second} `)
  await expect.poll(() => readEditor(page, "composer")).toBe(`#${second}`)
})

test("Escape 关闭标签补全且不改文本", async ({ page }) => {
  await typeFresh(page, "composer", "#wo")
  const listbox = page.getByRole("listbox", { name: "标签建议" })
  await expect(listbox).toBeVisible()

  await page.keyboard.press("Escape")

  await expect(listbox).toBeHidden()
  await expect.poll(() => readEditor(page, "composer")).toBe("#wo")
})

test("刚输入井号就展示已知标签且不展示新建项", async ({ page }) => {
  await typeFresh(page, "composer", "#")
  const listbox = page.getByRole("listbox", { name: "标签建议" })

  await expect(listbox).toBeVisible()
  await expect(listbox.getByRole("option", { name: /work/ })).toBeVisible()
  await expect(listbox.getByText("新建")).toHaveCount(0)
})

test("未知标签显示新建并由 Enter 应用", async ({ page }) => {
  await typeFresh(page, "composer", "#新标签")
  const listbox = page.getByRole("listbox", { name: "标签建议" })

  await expect(
    listbox.getByRole("option", { name: /新标签.*新建/ })
  ).toBeVisible()
  await page.keyboard.press("Enter")

  await expect.poll(() => editorText(page, "composer")).toBe("#新标签 ")
  await expect(
    page.locator('[data-shard-editor="composer"] .shard-rich-tag')
  ).toHaveText("#新标签")
})

test("/标签 插入井号后立即打开补全", async ({ page }) => {
  await typeFresh(page, "composer", "密匣 /标签")
  await page.keyboard.press("Enter")

  await expect.poll(() => readEditor(page, "composer")).toBe("密匣 #")
  await expect(
    page.getByRole("listbox", { name: "标签建议" })
  ).toBeVisible()
})

test("IME 组合期间不弹补全，上屏后才出现", async ({ page }) => {
  const session = await page.context().newCDPSession(page)
  await typeFresh(page, "composer", "#")
  await expect(
    page.getByRole("listbox", { name: "标签建议" })
  ).toBeVisible()

  await session.send("Input.imeSetComposition", {
    text: "wo",
    selectionStart: 2,
    selectionEnd: 2,
  })
  await page.waitForTimeout(200)
  await expect(
    page.getByRole("listbox", { name: "标签建议" })
  ).toHaveCount(0)
  expect((await readEditorSnapshot(page, "composer")).composing).toBe(true)

  await session.send("Input.insertText", { text: "wo" })

  // 建议开着时手打的 `#wo` 还是文本、尚未收敛成标签节点，看编辑区原文
  await expect.poll(() => editorText(page, "composer")).toBe("#wo")
  await expect(
    page.getByRole("listbox", { name: "标签建议" })
  ).toBeVisible()
  expect((await readEditorSnapshot(page, "composer")).composing).toBe(false)
  await session.detach()
})

test("补全打开时 Cmd+Enter 仍提交而不接受候选", async ({ page }) => {
  await typeFresh(page, "composer", "#wo")
  await expect(
    page.getByRole("listbox", { name: "标签建议" })
  ).toBeVisible()

  await page.keyboard.press("Meta+Enter")

  await expect.poll(() => readEditor(page, "composer")).toBe("")
  const createCall = await page.evaluate(() => {
    const calls = (globalThis as typeof globalThis & {
      __SHARD_TEST_CALLS__: Array<{
        args: Record<string, unknown>
        command: string
      }>
    }).__SHARD_TEST_CALLS__
    return calls.find((call) => call.command === "create_fragment")
  })
  expect(createCall?.args.content).toBe("#wo")
})

test("连续标签高亮保留可见空格", async ({ page }) => {
  await fillEditor(page, "composer", "#work #notes ")

  const tags = page.locator('[data-shard-editor="composer"] .shard-rich-tag')
  await expect(tags).toHaveCount(2)
  const tagGap = await tags.evaluateAll((elements) => {
    const first = elements[0]?.getBoundingClientRect()
    const second = elements[1]?.getBoundingClientRect()
    return first && second ? second.left - first.right : null
  })
  expect(tagGap).not.toBeNull()
  // 两个标签之间的空格必须完整可见，不能只是「没重叠」
  expect(tagGap ?? 0).toBeGreaterThanOrEqual(3)
})

test("输入框达到窗口上限时上下留白对称", async ({ page }) => {
  const composer = page.locator('[data-shard-editor="composer"]')
  await fillEditor(
    page,
    "composer",
    Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 行`).join("\n")
  )

  async function readGeometry() {
    return composer.evaluate((element) => {
      const frame = element.closest<HTMLElement>(".shard-content-measure")
      const column = element.closest<HTMLElement>("section")
      const frameRect = frame?.getBoundingClientRect()
      const columnRect = column?.getBoundingClientRect()
      return {
        bottomGap:
          frameRect && columnRect ? columnRect.bottom - frameRect.bottom : null,
        capped: frame?.dataset.heightCapped,
        topGap:
          frameRect && columnRect ? frameRect.top - columnRect.top : null,
      }
    })
  }

  await expect
    .poll(async () => {
      const geometry = await readGeometry()
      return Math.abs(
        (geometry.topGap ?? 0) - (geometry.bottomGap ?? 0)
      )
    })
    .toBeLessThanOrEqual(1)
  const geometry = await readGeometry()

  expect(geometry.capped).toBe("true")
  expect(geometry.topGap).not.toBeNull()
  expect(geometry.bottomGap).not.toBeNull()
  expect(
    Math.abs((geometry.topGap ?? 0) - (geometry.bottomGap ?? 0))
  ).toBeLessThanOrEqual(1)

  const overflow = await composer.evaluate((element) => ({
    clientHeight:
      element.closest(".shard-editor")?.parentElement?.clientHeight ?? 0,
    documentScrollTop: document.scrollingElement?.scrollTop ?? -1,
    overflowY: getComputedStyle(
      element.closest(".shard-editor")?.parentElement ?? element
    ).overflowY,
    scrollHeight:
      element.closest(".shard-editor")?.parentElement?.scrollHeight ?? 0,
  }))
  expect(overflow.overflowY).toBe("auto")
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight)
  expect(overflow.documentScrollTop).toBe(0)

  await fillEditor(page, "composer", "恢复短内容")
  await expect
    .poll(async () => {
      const restored = await readGeometry()
      return restored.topGap
    })
    .toBe(32)
  expect((await readGeometry()).capped).toBeUndefined()

  await page.setViewportSize({ height: 640, width: 720 })
  await fillEditor(
    page,
    "composer",
    Array.from({ length: 80 }, (_, index) => `窄窗口第 ${index + 1} 行`).join(
      "\n"
    )
  )
  await expect
    .poll(async () => {
      const narrow = await readGeometry()
      return narrow.topGap
    })
    .toBe(32)
  expect((await readGeometry()).capped).toBeUndefined()
})

test("自动同步失败通知可关闭且不堆叠", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "shard.app-settings.v1",
      JSON.stringify({
        autoSyncEnabled: true,
        autoSyncIntervalMinutes: 5,
        customTags: [],
      })
    )

    const runtime = globalThis as typeof globalThis & {
      __SHARD_RUN_AUTO_SYNC__?: () => void
      __SHARD_SYNC_ATTEMPTS__?: number
      __TAURI_INTERNALS__: {
        invoke: (
          command: string,
          args?: Record<string, unknown>
        ) => Promise<unknown>
      }
    }
    const originalInvoke = runtime.__TAURI_INTERNALS__.invoke
    const results = ["failure", "success", "failure", "failure"]
    runtime.__SHARD_SYNC_ATTEMPTS__ = 0
    runtime.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command !== "sync_vault") return originalInvoke(command, args)

      const attempt = runtime.__SHARD_SYNC_ATTEMPTS__ ?? 0
      runtime.__SHARD_SYNC_ATTEMPTS__ = attempt + 1
      if (results[attempt] === "success") return originalInvoke(command, args)
      throw new Error("TLS 连接失败")
    }

    const originalSetInterval = window.setInterval.bind(window)
    window.setInterval = ((handler: TimerHandler, timeout?: number) => {
      if (timeout === 5 * 60_000) {
        runtime.__SHARD_RUN_AUTO_SYNC__ = () => {
          if (typeof handler === "function") handler()
        }
      }
      return originalSetInterval(handler, timeout)
    }) as typeof window.setInterval
  })
  await page.reload()

  async function runAutoSync(attempt: number) {
    await page.evaluate(() => {
      const runtime = globalThis as typeof globalThis & {
        __SHARD_RUN_AUTO_SYNC__?: () => void
      }
      runtime.__SHARD_RUN_AUTO_SYNC__?.()
    })
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                __SHARD_SYNC_ATTEMPTS__?: number
              }
            ).__SHARD_SYNC_ATTEMPTS__ ?? 0
        )
      )
      .toBe(attempt)
  }

  const failureToast = page.getByText(/\u81ea\u52a8\u540c\u6b65\u5931\u8d25：TLS 连接失败/)
  const errorToast = page.locator('[data-sonner-toast][data-type="error"]')
  await runAutoSync(1)
  await expect(failureToast).toBeVisible()
  await expect(errorToast).toHaveCount(1)

  const toastPresentation = await errorToast.evaluate((toast) => {
    const closeButton = toast.querySelector<HTMLElement>("[data-close-button]")
    if (!closeButton) throw new Error("缺少通知关闭按钮")

    const colorAlpha = (color: string) => {
      const canvas = document.createElement("canvas")
      canvas.width = 1
      canvas.height = 1
      const context = canvas.getContext("2d")
      if (!context) throw new Error("无法读取通知颜色")
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return context.getImageData(0, 0, 1, 1).data[3]
    }

    const toastRect = toast.getBoundingClientRect()
    const closeRect = closeButton.getBoundingClientRect()
    return {
      closeButtonContained:
        closeRect.top >= toastRect.top &&
        closeRect.right <= toastRect.right &&
        closeRect.bottom <= toastRect.bottom &&
        closeRect.left >= toastRect.left,
      closeButtonBackgroundAlpha: colorAlpha(
        getComputedStyle(closeButton).backgroundColor
      ),
      toastBackgroundAlpha: colorAlpha(getComputedStyle(toast).backgroundColor),
    }
  })
  expect(toastPresentation).toEqual({
    closeButtonContained: true,
    closeButtonBackgroundAlpha: 255,
    toastBackgroundAlpha: 255,
  })

  await runAutoSync(2)
  await expect(failureToast).toBeHidden()

  await runAutoSync(3)
  await expect(failureToast).toBeVisible()
  await expect(errorToast).toHaveCount(1)
  await page.getByRole("button", { name: "关闭通知" }).click()
  await expect(failureToast).toBeHidden()

  await runAutoSync(4)
  await expect(failureToast).toBeHidden()
})

test.describe("正文表格", () => {
  const TABLE = [
    "|   日期  |      时间     |   学校  |   事项   | 年级/备注 |",
    "| :---: | :---------: | :---: | :----: | :---: |",
    "| 8月24日 |  8:30-11:00 |  行知中学 |  市场采单  |   —   |",
    "| 8月27日 |     8:30    | 四十二中学 | 返校+可采单 |   —   |",
  ].join("\n")

  test("GFM 表格渲染成真正的表格并保留列对齐", async ({ page }) => {
    await fillEditor(page, "composer", `本周安排\n${TABLE}`)
    await focusEditor(page, "composer")
    await page.keyboard.press("Meta+Enter")

    const card = page
      .locator("[data-shard-fragment-id]")
      .filter({ hasText: "本周安排" })
      .first()
    const table = card.locator("table.shard-markdown-table")
    await expect(table).toBeVisible()

    // 表头与数据行按分隔行的列数解析
    await expect(table.locator("thead th")).toHaveCount(5)
    await expect(table.locator("tbody tr")).toHaveCount(2)
    await expect(table.locator("thead th").first()).toHaveText("日期")
    await expect(table.locator("tbody tr").first().locator("td").nth(2)).toHaveText("行知中学")

    // :---: 落成居中对齐
    await expect(table.locator("thead th").first()).toHaveCSS(
      "text-align",
      "center"
    )

    // 表格上方的普通段落仍走内联流
    await expect(card).toContainText("本周安排")
  })

  test("完整真实表格：8 行数据、破折号与含连字符时间都正常", async ({
    page,
  }) => {
    const REAL = [
      "|   日期  |      时间     |   学校  |   事项   | 年级/备注 |",
      "| :---: | :---------: | :---: | :----: | :---: |",
      "| 8月24日 |  8:30-11:00 |  行知中学 |  市场采单  |   —   |",
      "| 8月25日 |  8:30-11:00 |  行知中学 |  市场采单  |   —   |",
      "| 8月26日 |  8:30-11:00 |  行知中学 |  市场采单  |   —   |",
      "| 8月26日 |   上午 8:30   |  卓群中学 |  市场采单  | 2024年 |",
      "| 8月27日 |  8:30-11:00 |  觉民中学 |  初一返校  |   —   |",
      "| 8月27日 |     8:30    | 四十二中学 | 返校+可采单 |   —   |",
      "| 8月27日 | 14:00-16:00 |  觉民中学 |  高一返校  |   —   |",
      "| 8月28日 |      —      |  觉民中学 |  市场采单  |   —   |",
    ].join("\n")

    await fillEditor(page, "composer", `超宽排期\n${REAL}`)
    await focusEditor(page, "composer")
    await page.keyboard.press("Meta+Enter")

    const card = page
      .locator("[data-shard-fragment-id]")
      .filter({ hasText: "超宽排期" })
      .first()
    const table = card.locator("table.shard-markdown-table")

    await expect(table).toBeVisible()
    await expect(table.locator("tbody tr")).toHaveCount(8)
    // 含连字符的时间不能被误判成分隔行
    await expect(
      table.locator("tbody tr").first().locator("td").nth(1)
    ).toHaveText("8:30-11:00")
    // 破折号单元格保留
    await expect(
      table.locator("tbody tr").last().locator("td").nth(1)
    ).toHaveText("—")
  })
})
