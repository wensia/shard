import { expect, test, type Page } from "@playwright/test"

import {
  fillEditor,
  focusEditor,
  readEditor,
  readEditorSnapshot,
  selectRange,
  typeEditor,
} from "./editor-helpers"

async function installTauriMock(
  page: Page,
  options: {
    imageSrc?: string
    relations?: Record<string, { targetId: string; note?: string }[]>
    walkResult?: string
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
      content: "已归档的回归片段",
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
            case "ai_agent_statuses":
              return [
                { agent: "codex", installed: true, version: "codex-cli 0.146.0", path: "/tmp/codex", error: null },
                { agent: "claude", installed: true, version: "2.1.221", path: "/tmp/claude", error: null },
                { agent: "kimi", installed: true, version: "0.32.0", path: "/tmp/kimi", error: null },
                { agent: "opencode", installed: true, version: "1.18.0", path: "/tmp/opencode", error: null },
              ]
            case "run_ai_review_task":
              return {
                text:
                  (args.request as { task?: string } | undefined)?.task === "walk" &&
                  injected.walkResult
                    ? injected.walkResult
                    : "测试洞察结果",
              }
            case "list_csv_files":
              return []
            case "list_library_tree":
              return {
                entries: [],
                fragmentStream: { totalCount: 0, years: [] },
              }
            case "migrate_legacy_notes":
              return {
                tree: {
                  entries: [],
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
            case "restore_window_frame":
            case "reveal_fragment_image_in_dir":
            case "save_recovery_key":
            case "save_exported_image":
            case "copy_exported_image":
              return null
            default:
              throw new Error(`Unhandled Tauri test command: ${command}`)
          }
        },
      },
    })
  }, options)
}

test.beforeEach(async ({ page }) => {
  await installTauriMock(page)
  await page.goto("/")
  await expect(
    page.locator('[data-shard-editor="composer"] .cm-content')
  ).toBeFocused()
  await expect(page.locator("[data-shard-fragment-id]")).toHaveCount(24)
})

test("editor toolbars expose visible labels through the shared icon button", async ({
  page,
}) => {
  const uploadButton = page.getByRole("button", { name: "上传图片" })

  await uploadButton.hover()
  await expect(page.getByRole("tooltip", { name: "上传图片" })).toBeVisible()

  await fillEditor(page, "composer", "禅模式工具栏提示回归")
  await focusEditor(page, "composer")
  await page.keyboard.press("Control+Shift+f")
  await expect(page.getByRole("button", { name: "退出编辑" })).toBeVisible()

  await page.getByRole("button", { name: "退出编辑" }).hover()
  await expect(page.getByRole("tooltip", { name: "退出编辑" })).toBeVisible()
})

test("inline 工具栏操作一步撤销，切换片段后 history 隔离", async ({
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
    await expect(editor.locator(".cm-content")).toBeFocused()
    return {
      article: page.locator("article").filter({ has: editor }),
      editor,
      editorId,
    }
  }

  const first = await openInlineEditor("fragment-1")
  const firstOriginal = await readEditor(page, first.editorId)
  await selectRange(page, first.editorId, 0, 2)
  await first.article.getByRole("button", { name: "粗体" }).click()
  const firstFormatted = `**${firstOriginal.slice(0, 2)}**${firstOriginal.slice(2)}`
  await expect.poll(() => readEditor(page, first.editorId)).toBe(firstFormatted)

  await focusEditor(page, first.editorId)
  await page.keyboard.press("Meta+z")
  await expect.poll(() => readEditor(page, first.editorId)).toBe(firstOriginal)

  await selectRange(page, first.editorId, 0, 2)
  await first.article.getByRole("button", { name: "粗体" }).click()
  await expect.poll(() => readEditor(page, first.editorId)).toBe(firstFormatted)
  await first.article.getByRole("button", { name: "取消" }).click()
  await expect(first.editor).toBeHidden()

  const second = await openInlineEditor("fragment-2")
  const secondOriginal = await readEditor(page, second.editorId)
  await focusEditor(page, second.editorId)
  await page.keyboard.press("Meta+z")
  await expect.poll(() => readEditor(page, second.editorId)).toBe(secondOriginal)
})

test("CM 编辑器按行盒自绘选区、正文保持 Kiln 选区", async ({
  page,
}) => {
  const content = "第一行选中文字\n第二行继续选中"
  await fillEditor(page, "composer", content)
  await selectRange(page, "composer", 0, content.length)

  const selectionColors = await page
    .locator('[data-shard-editor="composer"] .cm-line')
    .first()
    .evaluate((element) => {
      return {
        editor: getComputedStyle(element, "::selection").backgroundColor,
        global: getComputedStyle(document.body, "::selection").backgroundColor,
      }
    })

  // 编辑器里：原生选区背景透明，由 .shard-cm-selection 按行盒绘制；
  // 编辑器外：正文仍是 Kiln 的原生选区
  await expect(page.locator(".shard-cm-selection")).toHaveCount(2)
  expect(selectionColors.editor).toBe("rgba(0, 0, 0, 0)")
  expect(selectionColors.global).not.toBe("rgba(0, 0, 0, 0)")
})

test("荧光标记在节点外隐藏，左移进入后揭示并按默认 Backspace 删除", async ({
  page,
}) => {
  const content = "==荧光=="
  const editor = page.locator('[data-shard-editor="composer"]')
  await fillEditor(page, "composer", content)
  await selectRange(page, "composer", content.length, content.length)

  await expect(editor.locator(".shard-cm-highlight")).toHaveText("荧光")
  await expect(editor.locator(".cm-content")).not.toContainText("==")

  await page.keyboard.press("ArrowLeft")
  await expect(editor.locator(".cm-content")).toContainText("==荧光==")

  await page.keyboard.press("Backspace")
  await expect.poll(() => readEditor(page, "composer")).toBe("==荧光=")
})

test("任务 checkbox widget 不影响 Enter 续行与任务标记删除", async ({
  page,
}) => {
  const editor = page.locator('[data-shard-editor="composer"]')

  await fillEditor(page, "composer", "- [ ] 任务")
  await expect(editor.locator(".shard-cm-task-checkbox")).toBeVisible()
  await selectRange(page, "composer", 8, 8)
  await page.keyboard.press("Enter")
  await expect.poll(() => readEditor(page, "composer")).toBe(
    "- [ ] 任务\n- [ ] ",
  )
  await expect(editor.locator(".shard-cm-task-checkbox")).toHaveCount(2)

  await fillEditor(page, "composer", "- [ ] 任务")
  await selectRange(page, "composer", 5, 5)
  await page.keyboard.press("Backspace")
  await expect.poll(() => readEditor(page, "composer")).toBe("任务")

  await fillEditor(page, "composer", "- [ ] 任务")
  await selectRange(page, "composer", 0, 0)
  await page.keyboard.press("Delete")
  await expect.poll(() => readEditor(page, "composer")).toBe("任务")
})

test("#tag 永不隐藏且不参与 caret reveal", async ({ page }) => {
  await fillEditor(page, "composer", "#tag ==荧光==")
  await selectRange(page, "composer", 11, 11)
  const editor = page.locator('[data-shard-editor="composer"]')
  await expect(editor.locator(".shard-cm-tag")).toHaveText("#tag")
  await expect(editor.locator(".cm-content")).toContainText("#tag")
  await expect(editor.locator(".cm-content")).not.toContainText("==")

  await selectRange(page, "composer", 2, 2)
  await expect(editor.locator(".shard-cm-tag")).toHaveText("#tag")
  await expect(editor.locator(".cm-content")).toContainText("#tag")
})

test("任务 checkbox 点击写回完成状态", async ({ page }) => {
  await fillEditor(page, "composer", "- [ ] 完成")
  await page
    .locator('[data-shard-editor="composer"]')
    .getByRole("checkbox", { name: "标记为完成" })
    .click()
  await expect.poll(() => readEditor(page, "composer")).toBe("- [x] 完成")
})

test("分割线 widget 在光标进入该行时揭示源码", async ({ page }) => {
  const editor = page.locator('[data-shard-editor="composer"]')
  await fillEditor(page, "composer", "---\n后文")
  await selectRange(page, "composer", 6, 6)
  await expect(editor.locator(".shard-fragment-divider")).toBeVisible()

  await selectRange(page, "composer", 1, 1)
  await expect(editor.locator(".shard-fragment-divider")).toHaveCount(0)
  await expect(editor.locator(".cm-content")).toContainText("---")
})

test("图片行使用 read_fragment_image 结果渲染并在进光标时揭示", async ({
  page,
}) => {
  const imageSrc =
    "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="
  await installTauriMock(page, { imageSrc })
  await page.reload()
  await expect(page.locator("[data-shard-fragment-id]")).toHaveCount(24)

  const content = "![测试图](assets/test.png)\n正文"
  const editor = page.locator('[data-shard-editor="composer"]')
  await fillEditor(page, "composer", content)
  await selectRange(page, "composer", content.length, content.length)
  const image = editor.locator('.shard-cm-image-widget img[alt="测试图"]')
  await expect(image).toHaveAttribute("src", imageSrc)

  await selectRange(page, "composer", 2, 2)
  await expect(editor.locator(".shard-cm-image-widget")).toHaveCount(0)
  await expect(editor.locator(".cm-content")).toContainText("![测试图]")
})

test("code span 内的 == 不高亮", async ({ page }) => {
  await fillEditor(page, "composer", "`==代码==` ==荧光==")
  await selectRange(page, "composer", 15, 15)
  const editor = page.locator('[data-shard-editor="composer"]')
  await expect(editor.locator(".shard-cm-highlight")).toHaveCount(1)
  await expect(editor.locator(".shard-cm-highlight")).toHaveText("荧光")
  await expect(editor.locator(".cm-content")).toContainText("`==代码==`")
})

test("跨 #tag 与荧光笔的原生选区 rect 连续", async ({ page }) => {
  const content = "前 #tag ==荧光== 后"
  await fillEditor(page, "composer", content)
  await selectRange(page, "composer", 0, content.length)

  const metrics = await page
    .locator('[data-shard-editor="composer"] .cm-content')
    .evaluate((element) => {
      const selection = window.getSelection()
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null
      const rects = range
        ? Array.from(range.getClientRects()).sort(
            (left, right) => left.top - right.top || left.left - right.left,
          )
        : []
      let maxGap = 0
      for (let index = 1; index < rects.length; index += 1) {
        if (Math.abs(rects[index].top - rects[index - 1].top) < 1) {
          maxGap = Math.max(maxGap, rects[index].left - rects[index - 1].right)
        }
      }
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
      return {
        heights: rects.map((rect) => rect.height),
        lineHeight,
        maxGap,
        rectCount: rects.length,
      }
    })

  expect(metrics.rectCount).toBeGreaterThan(0)
  // 同一行内相邻 rect 必须相接：#tag / 荧光笔的 mark 把文本拆成多个 span，
  // 选区不能因此碎成有缝的块。
  expect(metrics.maxGap).toBeLessThan(1)

  // 实际绘制由自绘选区层负责：跨 mark 的一行只画一块，且高度是整个行盒
  const drawn = await page
    .locator('[data-shard-editor="composer"]')
    .evaluate((editor) => {
      const lineHeight = Number.parseFloat(
        getComputedStyle(editor.querySelector(".cm-content") ?? editor).lineHeight,
      )
      const blocks = Array.from(
        editor.querySelectorAll<HTMLElement>(".shard-cm-selection"),
      ).map((block) => block.getBoundingClientRect().height)
      return { blocks, lineHeight }
    })
  expect(drawn.blocks).toHaveLength(1)
  expect(Math.abs(drawn.blocks[0] - drawn.lineHeight)).toBeLessThan(1)
})

test("组合态文本变更只映射旧 decoration，结束后再重算", async ({ page }) => {
  const editor = page.locator('[data-shard-editor="composer"]')
  await fillEditor(page, "composer", "==a==")
  await selectRange(page, "composer", 1, 1)
  await expect(editor.locator(".shard-cm-highlight")).toHaveCount(1)

  // 合成的 CompositionEvent 不会让 CM 进入 composing（它要看到真实的 DOM 变更），
  // 所以走 CDP 的 IME 接口模拟一次真正的拼音组合。
  await focusEditor(page, "composer")
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Input.imeSetComposition", {
    selectionEnd: 1,
    selectionStart: 1,
    text: "x",
  })
  const composed = await editor.locator(".cm-content").evaluate(() => {
    type Bridge = { get(id: string): { composing: boolean; value: string } }
    const bridge = (window as typeof window & { __shardEditorTest?: Bridge })
      .__shardEditorTest
    return bridge?.get("composer") ?? { composing: false, value: "" }
  })
  expect(composed.composing).toBe(true)
  expect(composed.value).toBe("=x=a==")
  // 组合期间只映射旧 decoration：荧光笔块还在，没有因为 `=x=a==` 不再匹配而消失
  await expect(editor.locator(".shard-cm-highlight")).toHaveCount(1)

  // 上屏结束组合，此时才重算：`=x=a==` 不是荧光笔
  await cdp.send("Input.insertText", { text: "x" })
  await expect(editor.locator(".shard-cm-highlight")).toHaveCount(0)
  await cdp.detach()
})

test("选区高亮铺满行盒且跨行连成整片", async ({ page }) => {
  const content = "单独单独 abc 后文\n第二行继续选中 xyz"
  await fillEditor(page, "composer", content)
  await selectRange(page, "composer", 2, 20)

  const metrics = await page
    .locator('[data-shard-editor="composer"]')
    .evaluate((editor) => {
      const lineHeight = Number.parseFloat(
        getComputedStyle(editor.querySelector(".cm-content") ?? editor).lineHeight,
      )
      const blocks = Array.from(
        editor.querySelectorAll<HTMLElement>(".shard-cm-selection"),
      )
        .map((block) => block.getBoundingClientRect())
        .sort((left, right) => left.top - right.top)
      return {
        heights: blocks.map((block) => block.height),
        lineHeight,
        rowCount: blocks.length,
        seam: blocks.length > 1 ? blocks[1].top - blocks[0].bottom : null,
      }
    })

  // 自绘选区层每个视觉行画一块：块高 = 行盒高（同 flomo / 原生 contenteditable），
  // 相邻两行的块首尾相接，不再是断开的横条。
  expect(metrics.rowCount).toBe(2)
  for (const height of metrics.heights) {
    expect(Math.abs(height - metrics.lineHeight)).toBeLessThan(1)
  }
  expect(Math.abs(metrics.seam ?? 99)).toBeLessThan(1)
})

test("荧光笔高亮块铺满行盒", async ({ page }) => {
  await fillEditor(page, "composer", "前面 ==荧光笔== 后面")
  await selectRange(page, "composer", 0, 0)
  const highlight = page.locator('[data-shard-editor="composer"] .shard-cm-highlight')
  await expect(highlight).toHaveText("荧光笔")

  const metrics = await highlight.evaluate((element) => {
    const highlightRect = element.getBoundingClientRect()
    const lineHeight = Number.parseFloat(
      getComputedStyle(element.closest(".cm-content") ?? element).lineHeight,
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
  await selectRange(page, zenEditorId, zenContent.length, zenContent.length)

  const editor = page.locator(`[data-shard-editor="${zenEditorId}"]`)
  await expect(editor.locator(".shard-cm-highlight")).toHaveText("禅模式荧光笔")
  await expect(editor.locator(".cm-content")).not.toContainText("==")
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
  await expect(page.getByText("片段已保存")).toBeVisible()

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
  const composerContent = composer.locator(".cm-content")
  const composerBefore = await composer.boundingBox()
  const documentScrollBefore = await page.evaluate(
    () => document.scrollingElement?.scrollTop ?? -1
  )

  await page.keyboard.press("Control+k")
  const search = page.getByRole("combobox", { name: "搜索笔记" })
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
  expect(searchStyles.height).toBe("36px")
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

  await expect(
    page.getByRole("button", { name: "返回搜索结果" })
  ).toBeVisible()
  const locatedFragment = page.locator(
    '[data-shard-fragment-id="fragment-19"]'
  )
  await expect(locatedFragment).toBeVisible()
  await expect(locatedFragment).toBeInViewport()

  const scrollContract = await page.evaluate(() => {
    const composer = document.querySelector<HTMLElement>(
      '[data-shard-editor="composer"]'
    )
    const target = document.querySelector<HTMLElement>(
      '[data-shard-fragment-id="fragment-19"]'
    )
    const viewport = target?.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    return {
      composerTop: composer?.getBoundingClientRect().top,
      documentScroll: document.scrollingElement?.scrollTop ?? -1,
      targetBottom: target?.getBoundingClientRect().bottom,
      targetTop: target?.getBoundingClientRect().top,
      viewportBottom: viewport?.getBoundingClientRect().bottom,
      viewportScroll: viewport?.scrollTop,
      viewportTop: viewport?.getBoundingClientRect().top,
    }
  })
  expect(scrollContract.documentScroll).toBe(documentScrollBefore)
  expect(scrollContract.composerTop).toBe(composerBefore?.y)
  expect(scrollContract.viewportScroll).toBeGreaterThan(0)
  expect(scrollContract.targetTop).toBeGreaterThanOrEqual(
    scrollContract.viewportTop ?? 0
  )
  expect(scrollContract.targetBottom).toBeLessThanOrEqual(
    scrollContract.viewportBottom ?? Number.POSITIVE_INFINITY
  )

  await page.getByRole("button", { name: "返回搜索结果" }).click()
  await expect(search).toBeFocused()
  await expect(search).toHaveValue("work")
  await page.getByRole("button", { name: "退出搜索" }).click()
  await page.getByRole("button", { name: "结束搜索" }).click()

  await page.keyboard.press("Control+k")
  await search.fill("已归档")
  await expect(page.getByRole("option")).toHaveCount(1)
  await page.getByRole("button", { name: "未归档" }).click()
  await expect(page.getByText("没有找到“已归档”")).toBeVisible()
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
  await page.getByRole("button", { name: /^标签 \d+$/ }).click()
  await page.getByRole("button", { name: /密匣 已上锁/ }).click()
  await expect(
    page.getByRole("heading", { name: "解锁密匣" })
  ).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toBeHidden()

  await page.getByRole("button", { name: /思维导图 1/ }).click()
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()
  await page.setViewportSize({ height: 720, width: 900 })

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
    .toBeGreaterThan((initialBox?.height ?? 0) + 8)
  const longTextOverflow = await nodeEditor.evaluate((element) => ({
    horizontal: element.scrollWidth - element.clientWidth,
    vertical: element.scrollHeight - element.clientHeight,
  }))
  expect(longTextOverflow.horizontal).toBeLessThanOrEqual(1)
  expect(longTextOverflow.vertical).toBeLessThanOrEqual(1)
  const longNodeText = await nodeEditor.inputValue()
  await nodeEditor.press("Shift+Enter")
  await expect(nodeEditor).toHaveValue(longNodeText)

  await page.getByLabel("思维导图编辑器").click({
    position: { x: 12, y: 12 },
  })
  await expect(nodeEditor).toBeHidden()
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
  await page.getByRole("button", { name: /思维导图 1/ }).click()
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
  await page.getByRole("button", { name: /思维导图 1/ }).click()
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
  await page.getByRole("button", { name: /思维导图 1/ }).click()
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
  await page.getByRole("button", { name: /思维导图 1/ }).click()
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
  await page.getByRole("button", { name: /思维导图 1/ }).click()
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
  await page.getByRole("button", { name: /思维导图 1/ }).click()
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
  await page.getByRole("button", { name: /思维导图 1/ }).click()
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

  // 空格是抓手语义，不能触发 type-to-edit。
  await page.keyboard.press("Escape")
  await page.keyboard.press(" ")
  await expect(editor).toBeHidden()
})

test("mind map workspace keeps Tab focus out of global actions", async ({
  page,
}) => {
  await page.getByRole("button", { name: /思维导图 1/ }).click()
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  // 未选中任何节点时按 Tab：焦点不得迁移到底部全局操作区按钮。
  await page.keyboard.press("Tab")
  const focusedTag = await page.evaluate(
    () => document.activeElement?.tagName ?? ""
  )
  expect(focusedTag).not.toBe("BUTTON")

  // 选中再取消选中后同样成立。
  await page.locator('[data-mind-map-node="child"]').click()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Tab")
  const focusedTagAfter = await page.evaluate(
    () => document.activeElement?.tagName ?? ""
  )
  expect(focusedTagAfter).not.toBe("BUTTON")
})

test("insight workspace selects lenses and AI runners", async ({
  page,
}) => {
  await page.getByRole("button", { name: "回顾", exact: true }).click()
  await page.getByRole("button", { name: "洞察视角", exact: true }).click()

  // 设置面板：分组单选列表，默认选中"默认洞察"；结果区标题常显。
  const defaultLens = page.getByRole("radio", { name: "默认洞察" })
  await expect(defaultLens).toHaveAttribute("aria-checked", "true")
  await expect(
    page.getByRole("heading", { name: "分析设置" })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "洞察结果 · 默认洞察" })
  ).toBeVisible()
  await expect(page.getByText("尚未生成洞察")).toBeVisible()
  const runnerSelect = page.getByRole("combobox", { name: "AI 运行器" })
  await expect(runnerSelect).toHaveValue("codex")
  await expect(page.getByText("已识别 4/4")).toBeVisible()

  // 切换视角：摘要行跟随，已生成结果的来源标题不被牵连。
  const reverseLens = page.getByRole("radio", { name: "逆向思考" })
  await reverseLens.click()
  await expect(reverseLens).toHaveAttribute("aria-checked", "true")
  await expect(defaultLens).toHaveAttribute("aria-checked", "false")
  await expect(page.getByText(/反过来审视笔记中的默认假设/)).toBeVisible()
  await runnerSelect.selectOption("kimi")
  await expect(page.getByText("已就绪 · 0.32.0")).toBeVisible()

  // 运行洞察：结果区标题记录来源视角，文档渲染，保存入口在结果末尾。
  await page.getByRole("button", { name: "开始洞察" }).click()
  await expect(
    page.getByRole("heading", { name: "洞察结果 · 逆向思考 · Kimi Code" })
  ).toBeVisible()
  await expect(page.getByText("测试洞察结果")).toBeVisible()
  await expect(page.getByRole("button", { name: "保存为片段" })).toBeVisible()

  const request = await page.evaluate(() => {
    const calls = (globalThis as typeof globalThis & {
      __SHARD_TEST_CALLS__: Array<{ args: Record<string, unknown>; command: string }>
    }).__SHARD_TEST_CALLS__
    return calls.find((call) => call.command === "run_ai_review_task")
  })
  expect(request?.args).toMatchObject({
    request: { agent: "kimi", lens: "reverse", task: "insight" },
  })
})

test("small windows use bottom tabs without document scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ height: 720, width: 820 })

  await expect(page.getByRole("navigation", { name: "工作台" }))
    .toBeVisible()
  await expect(page.getByRole("navigation", { name: "碎片空间" }))
    .toBeVisible()
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
          { targetId: "fragment-3", note: "同一次漫步里被连起来" },
        ],
      },
      walkResult: [
        "## 漫步路径",
        "测试漫步正文。",
        "",
        "## 意外连接",
        "两条片段可以互相补充。",
        "",
        "```json",
        '{"edges":[{"from":1,"to":3,"reason":"共同指向同一个后续行动"}]}',
        "```",
      ].join("\n"),
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
    const linkedRow = card.locator('button[title="同一次漫步里被连起来"]')
    await expect(linkedRow).toBeVisible()
    await expect(linkedRow).toContainText("第 3 条回归片段")

    // 点击跳转后目标卡片进入高亮
    await linkedRow.click()
    await expect(
      page.locator('[data-shard-fragment-id="fragment-3"]')
    ).toHaveClass(/shard-fragment-card-highlight/)
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

  test("随机漫步建议边可逐条保留并持久化为 walk 关联", async ({ page }) => {
    await page.getByRole("button", { name: "回顾", exact: true }).click()
    await page.getByRole("button", { name: "随机漫步", exact: true }).click()
    await page.getByRole("button", { name: "生成连接理由" }).click()

    const suggestions = page.getByRole("region", { name: "建议的关联" })
    await expect(suggestions).toBeVisible()
    await expect(suggestions).toContainText("共同指向同一个后续行动")

    await suggestions.getByRole("button", { name: "保留" }).click()
    await expect(suggestions.getByText("已保留")).toBeVisible()

    const linkCall = await page.evaluate(() => {
      const calls = (globalThis as typeof globalThis & {
        __SHARD_TEST_CALLS__: Array<{
          args: Record<string, unknown>
          command: string
        }>
      }).__SHARD_TEST_CALLS__
      return calls.find(
        (call) =>
          call.command === "link_fragments" && call.args.origin === "walk"
      )
    })
    expect(linkCall?.args).toMatchObject({
      note: "共同指向同一个后续行动",
      origin: "walk",
    })
    expect(linkCall?.args.sourceId).toMatch(/^fragment-/)
    expect(linkCall?.args.targetId).toMatch(/^fragment-/)
  })
})

test("插入标签按需补空格，汉字后不粘连", async ({ page }) => {
  const insertTag = page.getByRole("button", { name: "插入标签" })

  // 汉字后面必须补空格：isTagBoundary 把汉字当边界是为了识别，
  // 插入时沿用会得到 `#密匣#高菲` 这种粘连。
  await fillEditor(page, "composer", "密匣")
  await selectRange(page, "composer", 2, 2)
  await insertTag.click()
  await expect.poll(() => readEditor(page, "composer")).toBe("密匣 #")

  // 已经有空白分隔时不重复补
  await fillEditor(page, "composer", "密匣 ")
  await selectRange(page, "composer", 3, 3)
  await insertTag.click()
  await expect.poll(() => readEditor(page, "composer")).toBe("密匣 #")

  // 中文标点后同样不补，保持 `你好，#标签` 的自然写法
  await fillEditor(page, "composer", "你好，")
  await selectRange(page, "composer", 3, 3)
  await insertTag.click()
  await expect.poll(() => readEditor(page, "composer")).toBe("你好，#")
})

test("从建议里选中标签后自动补空格", async ({ page }) => {
  await fillEditor(page, "composer", "#w")
  await selectRange(page, "composer", 2, 2)
  await typeEditor(page, "composer", "o")
  const suggestion = page
    .getByRole("listbox", { name: "标签建议" })
    .getByRole("option", { name: /work/ })
  await suggestion.click()

  // 补全后必须留出分隔空格，否则接着写下一个标签会粘连
  await expect.poll(() => readEditor(page, "composer")).toBe("#work ")
  await expect
    .poll(async () => (await readEditorSnapshot(page, "composer")).selectionStart)
    .toBe(6)
  await expect(
    page.locator('[data-shard-editor="composer"] .cm-content')
  ).toBeFocused()
})

test("编辑模式选中标签后留出输入边距", async ({ page }) => {
  const card = page.locator('[data-shard-fragment-id="fragment-1"]')
  await card.getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "编辑" }).click()

  const editor = page.locator(
    '[data-shard-editor="fragment:fragment-1"] .cm-content'
  )
  await expect(editor).toBeFocused()
  await fillEditor(page, "fragment:fragment-1", "#w")
  await selectRange(page, "fragment:fragment-1", 2, 2)
  await typeEditor(page, "fragment:fragment-1", "o")
  await page
    .getByRole("listbox", { name: "标签建议" })
    .getByRole("option", { name: /work/ })
    .click()

  await expect.poll(() => readEditor(page, "fragment:fragment-1")).toBe("#work ")
  await expect
    .poll(
      async () =>
        (await readEditorSnapshot(page, "fragment:fragment-1")).selectionStart
    )
    .toBe(6)
  await expect(editor).toBeFocused()
  const caretGap = await page.evaluate(() => {
    const selection = window.getSelection()
    const caret = selection?.rangeCount
      ? selection.getRangeAt(0).getClientRects()[0]
      : undefined
    const tag = document
      .querySelector(
        '[data-shard-editor="fragment:fragment-1"] .shard-cm-tag'
      )
      ?.getBoundingClientRect()
    return caret && tag ? caret.left - tag.right : null
  })
  expect(caretGap).not.toBeNull()
  expect(caretGap ?? 0).toBeGreaterThanOrEqual(3)
})

test("标签补全用 ArrowDown 与 Enter 选择第二项", async ({ page }) => {
  await fillEditor(page, "composer", "")
  await selectRange(page, "composer", 0, 0)
  await typeEditor(page, "composer", "#")
  const listbox = page.getByRole("listbox", { name: "标签建议" })
  await expect(listbox).toBeVisible()
  // 空 query 时候选顺序由标签索引决定，不假设第二项是谁：读出来再比对
  const second = (
    await listbox.getByRole("option").nth(1).locator(".cm-completionLabel").innerText()
  ).trim()
  expect(second.length).toBeGreaterThan(0)
  await expect(listbox.getByRole("option").nth(0)).toHaveAttribute("aria-selected", "true")

  await page.keyboard.press("ArrowDown")
  await expect(listbox.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Enter")

  await expect.poll(() => readEditor(page, "composer")).toBe(`#${second} `)
})

test("Escape 关闭标签补全且不改文本", async ({ page }) => {
  await fillEditor(page, "composer", "#w")
  await selectRange(page, "composer", 2, 2)
  await typeEditor(page, "composer", "o")
  const listbox = page.getByRole("listbox", { name: "标签建议" })
  await expect(listbox).toBeVisible()

  await page.keyboard.press("Escape")

  await expect(listbox).toBeHidden()
  await expect.poll(() => readEditor(page, "composer")).toBe("#wo")
})

test("刚输入井号就展示已知标签且不展示新建项", async ({ page }) => {
  await fillEditor(page, "composer", "")
  await selectRange(page, "composer", 0, 0)
  await typeEditor(page, "composer", "#")
  const listbox = page.getByRole("listbox", { name: "标签建议" })

  await expect(listbox).toBeVisible()
  await expect(listbox.getByRole("option", { name: /work/ })).toBeVisible()
  await expect(listbox.getByText("新建")).toHaveCount(0)
})

test("未知标签显示新建并由 Enter 应用", async ({ page }) => {
  await fillEditor(page, "composer", "")
  await selectRange(page, "composer", 0, 0)
  await typeEditor(page, "composer", "#新标签")
  const listbox = page.getByRole("listbox", { name: "标签建议" })

  await expect(
    listbox.getByRole("option", { name: /新标签.*新建/ })
  ).toBeVisible()
  await page.keyboard.press("Enter")

  await expect.poll(() => readEditor(page, "composer")).toBe("#新标签 ")
})

test("汉字后用工具栏插入标签会补空格并立即打开补全", async ({ page }) => {
  await fillEditor(page, "composer", "密匣")
  await selectRange(page, "composer", 2, 2)

  await page.getByRole("button", { name: "插入标签" }).click()

  await expect.poll(() => readEditor(page, "composer")).toBe("密匣 #")
  await expect(
    page.getByRole("listbox", { name: "标签建议" })
  ).toBeVisible()
})

test("IME 组合期间不弹补全，上屏后才出现", async ({ page }) => {
  const session = await page.context().newCDPSession(page)
  await fillEditor(page, "composer", "")
  await selectRange(page, "composer", 0, 0)
  await typeEditor(page, "composer", "#")
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

  await expect.poll(() => readEditor(page, "composer")).toBe("#wo")
  await expect(
    page.getByRole("listbox", { name: "标签建议" })
  ).toBeVisible()
  expect((await readEditorSnapshot(page, "composer")).composing).toBe(false)
  await session.detach()
})

test("补全打开时 Cmd+Enter 仍提交而不接受候选", async ({ page }) => {
  await fillEditor(page, "composer", "#w")
  await selectRange(page, "composer", 2, 2)
  await typeEditor(page, "composer", "o")
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

  const tagGap = await page
    .locator('[data-shard-editor="composer"] .shard-cm-tag')
    .evaluateAll((tags) => {
      const first = tags[0]?.getBoundingClientRect()
      const second = tags[1]?.getBoundingClientRect()
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

  test("编辑态给出可编辑表格，但源文本仍逐字符保留", async ({ page }) => {
    await fillEditor(page, "composer", TABLE)
    await page.getByRole("button", { name: "插入表格" }).focus()

    // 编辑态的表格是 EditorTable，不是只读的展示态表格
    await expect(page.locator("table.shard-markdown-table")).toHaveCount(0)
    await expect(page.locator("table.shard-editor-table")).toHaveCount(1)

    // widget 只替换渲染，不改 CM 文档；源文本必须逐字符保留。
    await expect.poll(() => readEditor(page, "composer")).toBe(TABLE)
  })
})
