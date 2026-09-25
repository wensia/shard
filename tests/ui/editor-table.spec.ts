import { expect, test, type Page } from "@playwright/test"

import {
  fillEditor,
  focusEditor,
  readEditor,
  selectEditorText,
  selectionToolbar,
  typeEditor,
} from "./editor-helpers"

/** 多维表格是唯一的表格导入入口；正文里的 GFM 表格在富文本里是表格节点，逐格编辑、只读渲染都不丢内容。 */
const LEGACY_TABLE = "| 名称 | 状态 |\n| :--- | ---: |\n| A\\|B | 完成 |"
/**
 * 富文本载入即按方言规范化（技术方案 §3「非规范输入首次保存后被规范化」）：
 * 对齐标记统一写成 `:--` / `--:`，转义竖线与单元格内容原样保留。
 */
const LEGACY_TABLE_SAVED = "| 名称 | 状态 |\n| :-- | --: |\n| A\\|B | 完成 |"

async function installTauriMock(page: Page) {
  await page.addInitScript(() => {
    const now = "2026-08-27T10:00:00.000Z"
    const state = {
      vaultPath: "/tmp/shard-ui-test-vault",
      fragments: [
        {
          id: "fragment-1",
          content: "表格回归片段",
          createdAt: now,
          updatedAt: now,
          tags: ["inbox"],
          category: null,
          path: "fragments/2026/08/fragment-1.md",
          gitStatus: "committed",
          error: null,
          archived: false,
          lockbox: false,
          pinned: false,
        },
      ],
      git: {
        branch: "main",
        shortCommit: "abc1234",
        hasRemote: true,
        status: "ready",
        error: null,
        ahead: 0,
        behind: 0,
      },
      lockbox: {
        configured: true,
        unlocked: false,
        expiresAt: null,
        ttlSeconds: 180,
      },
    }

    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const callbacks = new Map<number, (event: unknown) => void>()
    const listeners = new Map<number, { event: string; handler: number }>()
    const commands: string[] = []
    let nextId = 0

    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_TEST_COMMANDS__: commands,
      __SHARD_EMIT_TEST_EVENT__: (name: string, payload: unknown) => {
        for (const [id, entry] of listeners) {
          if (entry.event === name) callbacks.get(entry.handler)?.({ event: name, id, payload })
        }
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback(callback: (event: unknown) => void) {
          callbacks.set(++nextId, callback)
          return nextId
        },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          commands.push(command)
          switch (command) {
            case "plugin:event|listen":
              listeners.set(++nextId, args as { event: string; handler: number })
              return nextId
            case "plugin:event|unlisten":
              listeners.delete(args.eventId as number)
              return

            case "list_mind_maps":
              return []
            case "list_csv_files":
              return []
            case "list_library_tree":
              return {
                entries: [],
                assets: [],
                trashEntries: [],
                fragmentStream: { totalCount: 0, years: [] },
              }
            case "migrate_legacy_notes":
              return {
                tree: {
                  entries: [],
                  assets: [],
                  trashEntries: [],
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
                  fragmentStream: { totalCount: 0, years: [] },
                },
                fragment: null,
                updatedLinks: 0,
              }
            case "plugin:app|version":
              return "0.1.3"
            case "github_cli_status":
              return {
                installed: true,
                authenticated: true,
                login: "shard-test",
                protocol: "https",
                error: null,
              }
            case "convert_table_document_to_markdown":
              throw new Error("正文不应再调用表格转换")
            case "create_fragment": {
              const created = {
                ...clone(state.fragments[0]),
                id: "fragment-created",
                content: String(args.content ?? ""),
              }
              state.fragments.unshift(created)
              return clone(created)
            }
            case "update_fragment": {
              const fragment = state.fragments[0]
              fragment.content = String(args.content ?? fragment.content)
              return clone(fragment)
            }
            default:
              return clone(state)
          }
        },
      },
    })
  })
}

async function openFragmentEditor(page: Page, variant: "inline" | "zen") {
  await page.locator('[data-shard-fragment-id="fragment-1"]')
    .getByRole("button", { name: "片段操作", exact: true }).click()
  await page.getByRole("menuitem", { name: variant === "inline" ? "编辑" : "禅模式", exact: true }).click()
  const editorId = `${variant === "inline" ? "fragment" : "zen"}:fragment-1`
  await expect(page.locator(`[data-shard-editor="${editorId}"] .ProseMirror`)).toBeVisible()
  return editorId
}

async function emitDrag(page: Page, editorId: string, phase: "enter" | "over" | "drop" | "leave", paths: string[]) {
  await page.evaluate(({ editorId, phase, paths }) => {
    const content = document.querySelector(`[data-shard-editor="${editorId}"] .ProseMirror`)!
    const bounds = content.getBoundingClientRect()
    const runtime = window as unknown as {
      __SHARD_EMIT_TEST_EVENT__(name: string, payload: unknown): void
    }
    runtime.__SHARD_EMIT_TEST_EVENT__(`tauri://drag-${phase}`, {
      paths,
      position: { x: (bounds.x + 12) * devicePixelRatio, y: (bounds.y + 12) * devicePixelRatio },
    })
  }, { editorId, phase, paths })
}

async function expectNoLegacyTableControls(page: Page) {
  await expect(page.getByRole("button", { name: "插入表格", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "从 Excel 导入…", exact: true })).toHaveCount(0)
  await expect(page.locator(".shard-editor-table, .shard-editor-table-input, .shard-editor-table-actions")).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  await installTauriMock(page)
  await page.goto("/")
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeFocused()
})

test("速记工具栏不再提供简单表格和 Excel 转正文入口，行内格式由选区浮动条提供", async ({ page }) => {
  await expectNoLegacyTableControls(page)
  await fillEditor(page, "composer", "正文")
  await selectEditorText(page, "composer", "正文")
  await selectionToolbar(page).getByRole("button", { name: "粗体", exact: true }).click()
  await expect.poll(() => readEditor(page, "composer")).toBe("**正文**")
})

for (const variant of ["inline", "zen"] as const) {
  test(`${variant} 编辑器不再提供简单表格入口，旧表格内容保留并可逐格修改`, async ({ page }) => {
    const editorId = await openFragmentEditor(page, variant)
    await fillEditor(page, editorId, LEGACY_TABLE)
    await expectNoLegacyTableControls(page)
    await expect.poll(() => readEditor(page, editorId)).toBe(LEGACY_TABLE_SAVED)
    await selectEditorText(page, editorId, "完成")
    await typeEditor(page, editorId, "待办")
    await expect.poll(() => readEditor(page, editorId)).toBe(LEGACY_TABLE_SAVED.replace("完成", "待办"))
  })
}

test("全局 Tab 不轮转焦点，工具栏在明暗主题下没有焦点框且仍可点击编辑", async ({ page }) => {
  const button = page.getByRole("button", { name: "禅模式", exact: true })
  for (const dark of [false, true]) {
    await page.evaluate(value => document.documentElement.classList.toggle("dark", value), dark)
    await button.focus()
    await page.keyboard.press("Tab")
    await expect(button).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await expect(button).toBeFocused()
    await expect(button).toHaveCSS("outline-style", "none")
    await expect(button).toHaveCSS("--tw-ring-color", "transparent")
    const visibleShadows = await button.evaluate(element =>
      getComputedStyle(element).boxShadow.replace(/rgba\(0, 0, 0, 0\)/g, "transparent")
    )
    expect(visibleShadows === "none" || !/rgba?\(/.test(visibleShadows)).toBe(true)
  }
  await fillEditor(page, "composer", "焦点测试")
  await selectEditorText(page, "composer", "焦点测试")
  await selectionToolbar(page).getByRole("button", { name: "粗体", exact: true }).click()
  await expect.poll(() => readEditor(page, "composer")).toContain("**焦点测试**")
  await page.locator('[data-shard-editor="composer"] .ProseMirror').click()
  await page.keyboard.type("ok")
  await expect.poll(() => readEditor(page, "composer")).toContain("ok")
})

test("旧 Markdown 表格切换焦点与光标位置后内容不变，不自动迁移", async ({ page }) => {
  const saved = `正文\n\n${LEGACY_TABLE_SAVED}\n\n后记`
  await fillEditor(page, "composer", `正文\n\n${LEGACY_TABLE}\n\n后记`)
  await expect.poll(() => readEditor(page, "composer")).toBe(saved)
  await selectEditorText(page, "composer", "名称", { collapse: "start" })
  await page.getByRole("button", { name: "禅模式", exact: true }).focus()
  await selectEditorText(page, "composer", "后记", { collapse: "end" })
  await expectNoLegacyTableControls(page)
  await expect.poll(() => readEditor(page, "composer")).toBe(saved)
})

test("旧表格单元格修改支持撤销，对齐方向与转义竖线不丢", async ({ page }) => {
  await fillEditor(page, "composer", LEGACY_TABLE)
  await selectEditorText(page, "composer", "完成")
  await typeEditor(page, "composer", "待办")
  await expect.poll(() => readEditor(page, "composer")).toBe(LEGACY_TABLE_SAVED.replace("完成", "待办"))
  await page.keyboard.press("Meta+z")
  await expect.poll(() => readEditor(page, "composer")).toBe(LEGACY_TABLE_SAVED)
  await expectNoLegacyTableControls(page)
})

test("保存旧 Markdown 表格后仍使用只读表格渲染并保留内容", async ({ page }) => {
  await fillEditor(page, "composer", LEGACY_TABLE)
  await focusEditor(page, "composer")
  await page.keyboard.press("Meta+Enter")
  const card = page.locator('[data-shard-fragment-id="fragment-created"]')
  const table = card.locator(".shard-markdown-table")
  await expect(table).toHaveCount(1)
  await expect(table.locator("tbody td").first()).toHaveText("A|B")
  await expect(table.locator("thead th").last()).toHaveCSS("text-align", "right")
  await expect(table.locator("input, button")).toHaveCount(0)
  await card.getByRole("button", { name: "片段操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click()
  await expect.poll(() => readEditor(page, "fragment:fragment-created")).toBe(LEGACY_TABLE_SAVED)
})

test("同一文档的多张旧表格可独立修改", async ({ page }) => {
  const second = "| C | D |\n| --- | --- |\n| 3 | 4 |"
  await fillEditor(page, "composer", `${LEGACY_TABLE}\n\n${second}\n\n`)
  // 文末空行不是内容，规范化时去掉。
  const saved = `${LEGACY_TABLE_SAVED}\n\n${second}`
  await expect.poll(() => readEditor(page, "composer")).toBe(saved)
  await selectEditorText(page, "composer", "C")
  await typeEditor(page, "composer", "第二")
  await expect.poll(() => readEditor(page, "composer")).toBe(saved.replace("C", "第二"))
  await expectNoLegacyTableControls(page)
})

test("旧 Markdown 表格单元格中中文组词不创建旧表格控件或丢失内容", async ({ page }) => {
  await fillEditor(page, "composer", LEGACY_TABLE)
  await selectEditorText(page, "composer", "名称")
  const session = await page.context().newCDPSession(page)
  try {
    await session.send("Input.imeSetComposition", { text: "zhongwen", selectionStart: 8, selectionEnd: 8 })
    await session.send("Input.insertText", { text: "中文" })
    await expect.poll(() => readEditor(page, "composer")).toBe(LEGACY_TABLE_SAVED.replace("名称", "中文"))
    await expectNoLegacyTableControls(page)
  } finally { await session.detach() }
})

for (const count of [100, 1200]) {
  test(`${count} 行旧 Markdown 表格保留完整内容且不创建旧表格控件`, async ({ page }) => {
    const lines = ["| 学校 | 事项 |", "| --- | --- |"]
    for (let index = 0; index < count; index++) lines.push(`| 第${index}中学 | 采单 |`)
    const content = lines.join("\n")
    // 文末空行在规范化时去掉，行内容逐行保留。
    await fillEditor(page, "composer", `${content}\n\n`)
    await expectNoLegacyTableControls(page)
    await expect(page.locator('[data-shard-editor="composer"] .ProseMirror tr')).toHaveCount(count + 1)
    await expect.poll(() => readEditor(page, "composer")).toBe(content)
  })
}

for (const variant of ["composer", "inline", "zen"] as const) {
  test(`${variant} 拖入 CSV/XLSX 只提示导入多维表格，保持草稿和源文件不变`, async ({ page }) => {
    const editorId = variant === "composer" ? "composer" : await openFragmentEditor(page, variant)
    await fillEditor(page, editorId, LEGACY_TABLE)
    await emitDrag(page, editorId, "enter", ["/tmp/测试.csv", "/tmp/测试.xlsx"])
    await expect(page.getByText("请在资料库中导入为多维表格", { exact: true })).toBeVisible()
    await emitDrag(page, editorId, "drop", ["/tmp/测试.csv", "/tmp/测试.xlsx"])
    await expect(page.getByText("请在资料库的“多维表格”菜单中选择“从 CSV / Excel 导入…”，导入 CSV 或 XLSX 文件。", { exact: true })).toBeVisible()
    await expect.poll(() => readEditor(page, editorId)).toBe(LEGACY_TABLE_SAVED)
    const commands = await page.evaluate(() => (window as unknown as { __SHARD_TEST_COMMANDS__: string[] }).__SHARD_TEST_COMMANDS__)
    expect(commands).not.toContain("convert_table_document_to_markdown")
    expect(commands).not.toContain("read_table_exchange_file")
    expect(commands).not.toContain("create_table")
  })
}

test("旧 XLS 文件提示先另存 XLSX，不承诺支持直接导入", async ({ page }) => {
  await fillEditor(page, "composer", "尚未保存的正文")
  await emitDrag(page, "composer", "drop", ["/tmp/旧格式.xls"])
  await expect(page.getByText("请先将旧 Excel 文件另存为 XLSX，再到资料库的“多维表格”菜单中选择“从 CSV / Excel 导入…”。", { exact: true })).toBeVisible()
  await expect.poll(() => readEditor(page, "composer")).toBe("尚未保存的正文")
})

test("普通文档拖放不会出现多维表格提示或触发表格转换", async ({ page }) => {
  await fillEditor(page, "composer", "普通正文")
  await emitDrag(page, "composer", "enter", ["/tmp/普通.md", "/tmp/图片.png"])
  await emitDrag(page, "composer", "over", [])
  await expect(page.locator(".shard-editor-drop-hint")).toHaveCount(0)
  await emitDrag(page, "composer", "drop", ["/tmp/普通.md"])
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0)
  await expect.poll(() => readEditor(page, "composer")).toBe("普通正文")
})
