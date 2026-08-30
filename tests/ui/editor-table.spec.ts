import { expect, test, type Page } from "@playwright/test"

import {
  fillEditor,
  focusEditor,
  readEditor,
  selectRange,
} from "./editor-helpers"

/**
 * 编辑态表格：工具栏插入 + 单元格直接改。
 *
 * 断言都落在 CM 测试桥读出的值上——可视化表格只是外壳，正文里存的必须始终是
 * 一张能被 GFM 解析回来的表，否则保存下去的 Markdown 就坏了。
 */

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

    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_TEST_COMMANDS__: [],
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          switch (command) {
            case "list_mind_maps":
              return []
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
            case "github_cli_status":
              return {
                installed: true,
                authenticated: true,
                login: "shard-test",
                protocol: "https",
                error: null,
              }
            case "ai_agent_statuses":
              return []
            case "plugin:dialog|open":
              return "/tmp/shard-test/采单安排.xlsx"
            case "convert_table_document_to_markdown":
              // 记下后端拿到的路径，断言选中的文件确实传下去了
              ;(globalThis as Record<string, unknown>).__SHARD_IMPORT_PATH__ =
                args.path
              // anydoc 的真实输出形状：每个 sheet 一个二级标题 + 一张 GFM 表
              return [
                "## 采单安排",
                "",
                "| 日期 | 学校 |",
                "| --- | --- |",
                "| 2026-08-24 | 行知中学 |",
                "",
                "## 费用",
                "",
                "| 项目 | 金额 |",
                "| --- | --- |",
                "| 交通 | 1250.5 |",
              ].join("\n")
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

/** 网格是 6×6，aria-label 形如「3 列 2 行」。 */
async function insertTable(page: Page, columns: number, rows: number) {
  await page.getByRole("button", { name: "插入表格" }).click()
  await page
    .getByRole("button", { name: `${columns} 列 ${rows} 行`, exact: true })
    .click()
}

test.beforeEach(async ({ page }) => {
  await installTauriMock(page)
  await page.goto("/")
  await expect(
    page.locator('[data-shard-editor="composer"] .cm-content')
  ).toBeFocused()
})

test("工具栏网格插入表格，光标直接落进第一个表头格", async ({ page }) => {
  await insertTable(page, 3, 2)

  await expect.poll(() => readEditor(page, "composer")).toBe(
    "|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n\n"
  )
  await expect(page.locator(".shard-editor-table")).toHaveCount(1)
  await expect(page.locator('[data-cell="-1:0"]')).toBeFocused()
})

test("单元格里打字直接改写正文里的表格", async ({ page }) => {
  await insertTable(page, 2, 2)
  await page.locator('[data-cell="-1:0"]').fill("名称")
  await page.locator('[data-cell="0:1"]').fill("完成")

  // 列宽跟着最宽的单元格走，第二列因为「完成」也变成 4 宽
  await expect.poll(() => readEditor(page, "composer")).toBe(
    "| 名称 |      |\n| ---- | ---- |\n|      | 完成 |\n\n"
  )
})

test("Tab 在单元格间走，最后一格 Tab 补一行", async ({ page }) => {
  await insertTable(page, 2, 2)
  await page.locator('[data-cell="-1:0"]').press("Tab")
  await expect(page.locator('[data-cell="-1:1"]')).toBeFocused()

  await page.locator('[data-cell="-1:1"]').press("Tab")
  await expect(page.locator('[data-cell="0:0"]')).toBeFocused()

  // 最后一格：补出新的一行并停在行首
  await page.locator('[data-cell="0:0"]').press("Tab")
  await page.locator('[data-cell="0:1"]').press("Tab")
  await expect(page.locator('[data-cell="1:0"]')).toBeFocused()
  await expect.poll(() => readEditor(page, "composer")).toBe(
    "|     |     |\n| --- | --- |\n|     |     |\n|     |     |\n\n"
  )
})

test("行列操作条能加列、删行", async ({ page }) => {
  await insertTable(page, 2, 3)
  await page.locator('[data-cell="0:0"]').click()

  await page.locator('.shard-editor-table-action[title="在右侧插入一列"]').click()
  await expect(page.locator('[data-cell="0:2"]')).toHaveCount(1)
  await expect.poll(() => readEditor(page, "composer")).toBe(
    "|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n\n"
  )

  await page.locator('.shard-editor-table-action[title="删除光标所在行"]').click()
  await expect.poll(() => readEditor(page, "composer")).toBe(
    "|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n\n"
  )
})

test("光标回到表格源文本时让位给源码编辑", async ({ page }) => {
  const block = page.locator(".shard-editor-table-block")

  await insertTable(page, 2, 2)
  await expect(block).toHaveCount(1)

  await selectRange(page, "composer", 2, 2)
  await focusEditor(page, "composer")
  await expect(block).toHaveCount(0)
  await expect(
    page.locator('[data-shard-editor="composer"] .cm-content')
  ).toContainText("|")

  const value = await readEditor(page, "composer")
  await selectRange(page, "composer", value.length, value.length)
  await expect(block).toHaveCount(1)
})

test("保存后的片段用只读表格渲染", async ({ page }) => {
  await insertTable(page, 2, 2)
  await focusEditor(page, "composer")
  await page.keyboard.press("Meta+Enter")

  await expect(page.locator(".shard-markdown-table")).toHaveCount(1)
})

test("连续输入与竖线都不会写坏这张表", async ({ page }) => {
  await insertTable(page, 2, 2)
  const firstCell = page.locator('[data-cell="-1:0"]')
  await firstCell.evaluate((input) => {
    ;(input as HTMLInputElement & { __shardIdentity?: boolean }).__shardIdentity =
      true
  })
  await firstCell.pressSequentially("市场采单", {
    delay: 30,
  })
  await expect(firstCell).toBeFocused()
  expect(
    await firstCell.evaluate(
      (input) =>
        (input as HTMLInputElement & { __shardIdentity?: boolean })
          .__shardIdentity === true
    )
  ).toBe(true)

  // 单元格里的裸竖线会把列切开，写回正文时必须转义
  await page.locator('[data-cell="0:0"]').fill("A|B")

  await expect.poll(() => readEditor(page, "composer")).toBe(
    "| 市场采单 |     |\n| -------- | --- |\n| A\\|B     |     |\n\n"
  )

  // 而且转义后的内容要能原样解析回单元格里
  await expect(page.locator('[data-cell="0:0"]')).toHaveValue("A|B")
})

test("网格面板始终留在窗口内，顶部装不下就朝下展开", async ({ page }) => {
  const panel = page.getByRole("dialog", { name: "选择表格大小" })

  // 速记框贴着窗口顶部，工具栏上方放不下这块面板
  await page.getByRole("button", { name: "插入表格" }).click()
  await expect(panel).toHaveAttribute("data-side", "bottom")

  const box = await panel.boundingBox()
  const viewport = page.viewportSize()
  expect(box).not.toBeNull()
  expect(viewport).not.toBeNull()
  if (!box || !viewport) return

  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
})

test("从 Excel 导入：转成 Markdown 表格插进正文，且立刻可编辑", async ({
  page,
}) => {
  await page.getByRole("button", { name: "插入表格" }).click()
  await page.getByRole("button", { name: "从 Excel 导入…" }).click()

  // 表格数据落在正文里——搜索、标签、git diff 才都还能用上
  await expect.poll(() => readEditor(page, "composer")).toBe(
    "## 采单安排\n\n| 日期 | 学校 |\n| --- | --- |\n| 2026-08-24 | 行知中学 |\n\n" +
      "## 费用\n\n| 项目 | 金额 |\n| --- | --- |\n| 交通 | 1250.5 |\n\n"
  )

  // 两个 sheet → 两张表，且都是可编辑的编辑态表格
  await expect(page.locator(".shard-editor-table")).toHaveCount(2)
  await expect(page.locator('[data-cell="0:1"]').first()).toHaveValue("行知中学")
  await expect(page.locator('[data-cell="-1:0"]').first()).toBeFocused()

  const importedPath = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__SHARD_IMPORT_PATH__
  )
  expect(importedPath).toBe("/tmp/shard-test/采单安排.xlsx")
})

test("超大表格退回纯文本，不把编辑器打字拖垮", async ({ page }) => {
  // 6 列 × 1200 行 ≈ 7200 格，越过 MAX_EDITABLE_TABLE_CELLS(6000)
  const lines = [
    "| 日期 | 学校 | 事项 | 负责人 | 数量 | 备注 |",
    "| --- | --- | --- | --- | --- | --- |",
  ]
  for (let index = 0; index < 1200; index += 1) {
    lines.push(`| 2026-08-01 | 第${index}中学 | 采单 | 张${index} | ${index} | — |`)
  }
  const content = lines.join("\n")
  await fillEditor(page, "composer", content)

  // 不渲染成可交互表格：一格一个受控 input，这个量级会把每次按键拖到几百毫秒
  await expect(page.locator(".shard-editor-table")).toHaveCount(0)
  await expect(page.locator(".shard-editor-table-input")).toHaveCount(0)

  // 但正文没丢，源码照样能编辑
  await expect.poll(() => readEditor(page, "composer")).toBe(content)
})

test("阈值以内的表格仍然是可视化表格", async ({ page }) => {
  // 2 列 × 100 行 ≈ 202 格，远在阈值内
  const lines = ["| 学校 | 事项 |", "| --- | --- |"]
  for (let index = 0; index < 100; index += 1) {
    lines.push(`| 第${index}中学 | 采单 |`)
  }
  await fillEditor(page, "composer", `${lines.join("\n")}\n\n`)

  await expect(page.locator(".shard-editor-table")).toHaveCount(1)
  await expect(page.locator('[data-cell="99:0"]')).toHaveValue("第99中学")
})

test("单元格改动在 CM 内 Cmd+Z 一步撤回且 widget 保留", async ({ page }) => {
  const initial = "|     |     |\n| --- | --- |\n|     |     |\n\n"
  await insertTable(page, 2, 2)
  await page.locator('[data-cell="-1:0"]').fill("名称")
  await expect.poll(() => readEditor(page, "composer")).toBe(
    "| 名称 |     |\n| ---- | --- |\n|      |     |\n\n"
  )

  const edited = await readEditor(page, "composer")
  await selectRange(page, "composer", edited.length, edited.length)
  await page.keyboard.press("Meta+z")

  await expect.poll(() => readEditor(page, "composer")).toBe(initial)
  await expect(page.locator(".shard-editor-table")).toHaveCount(1)
})

test("同一文档中的两张表可独立编辑", async ({ page }) => {
  const first = "| A | B |\n| --- | --- |\n| 1 | 2 |"
  const second = "| C | D |\n| --- | --- |\n| 3 | 4 |"
  await fillEditor(page, "composer", `${first}\n\n${second}\n\n`)

  const tables = page.locator(".shard-editor-table")
  await expect(tables).toHaveCount(2)
  await tables.nth(0).locator('[data-cell="-1:0"]').fill("第一")
  await expect(tables.nth(1).locator('[data-cell="-1:0"]')).toHaveValue("C")

  await tables.nth(1).locator('[data-cell="-1:0"]').fill("第二")
  await expect(tables.nth(0).locator('[data-cell="-1:0"]')).toHaveValue("第一")
  await expect.poll(() => readEditor(page, "composer")).toBe(
    "| 第一 | B   |\n| ---- | --- |\n| 1    | 2   |\n\n" +
      "| 第二 | D   |\n| ---- | --- |\n| 3    | 4   |\n\n"
  )
})

test("CDP IME 在单元格内上屏中文时不重建 input", async ({ page }) => {
  await insertTable(page, 2, 2)
  const cell = page.locator('[data-cell="-1:0"]')
  await cell.evaluate((input) => {
    ;(input as HTMLInputElement & { __shardImeIdentity?: boolean }).__shardImeIdentity =
      true
  })

  const session = await page.context().newCDPSession(page)
  try {
    await session.send("Input.imeSetComposition", {
      text: "zhongwen",
      selectionStart: 8,
      selectionEnd: 8,
    })
    await expect(cell).toBeFocused()
    expect(
      await cell.evaluate(
        (input) =>
          (input as HTMLInputElement & { __shardImeIdentity?: boolean })
            .__shardImeIdentity === true
      )
    ).toBe(true)
    await expect(page.locator(".shard-editor-table")).toHaveCount(1)

    await session.send("Input.insertText", { text: "中文" })
    await expect(cell).toHaveValue("中文")
    await expect.poll(() => readEditor(page, "composer")).toBe(
      "| 中文 |     |\n| ---- | --- |\n|      |     |\n\n"
    )
    await expect(page.locator(".shard-editor-table")).toHaveCount(1)
    expect(
      await cell.evaluate(
        (input) =>
          (input as HTMLInputElement & { __shardImeIdentity?: boolean })
            .__shardImeIdentity === true
      )
    ).toBe(true)
  } finally {
    await session.detach()
  }
})

test("文档超过 50000 字符时整篇不创建表格 widget", async ({ page }) => {
  const table = "| A | B |\n| --- | --- |\n| 1 | 2 |"
  const content = `${table}\n\n${"x".repeat(50_001)}`
  await fillEditor(page, "composer", content)

  await expect.poll(() => readEditor(page, "composer")).toBe(content)
  await expect(page.locator(".shard-editor-table")).toHaveCount(0)
  await expect(page.locator(".shard-editor-table-input")).toHaveCount(0)
})
