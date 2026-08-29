import { expect, test, type Page } from "@playwright/test"

/**
 * 编辑态表格：工具栏插入 + 单元格直接改。
 *
 * 断言都落在 textarea 的值上——可视化表格只是外壳，正文里存的必须始终是
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
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          switch (command) {
            case "list_mind_maps":
              return []
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
  await expect(page.getByPlaceholder("想到什么，写什么...")).toBeFocused()
})

test("工具栏网格插入表格，光标直接落进第一个表头格", async ({ page }) => {
  const textarea = page.getByPlaceholder("想到什么，写什么...")

  await insertTable(page, 3, 2)

  await expect(textarea).toHaveValue(
    "|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n\n"
  )
  await expect(page.locator(".shard-editor-table")).toHaveCount(1)
  await expect(page.locator('[data-cell="-1:0"]')).toBeFocused()
})

test("单元格里打字直接改写正文里的表格", async ({ page }) => {
  const textarea = page.getByPlaceholder("想到什么，写什么...")

  await insertTable(page, 2, 2)
  await page.locator('[data-cell="-1:0"]').fill("名称")
  await page.locator('[data-cell="0:1"]').fill("完成")

  // 列宽跟着最宽的单元格走，第二列因为「完成」也变成 4 宽
  await expect(textarea).toHaveValue(
    "| 名称 |      |\n| ---- | ---- |\n|      | 完成 |\n\n"
  )
})

test("Tab 在单元格间走，最后一格 Tab 补一行", async ({ page }) => {
  const textarea = page.getByPlaceholder("想到什么，写什么...")

  await insertTable(page, 2, 2)
  await page.locator('[data-cell="-1:0"]').press("Tab")
  await expect(page.locator('[data-cell="-1:1"]')).toBeFocused()

  await page.locator('[data-cell="-1:1"]').press("Tab")
  await expect(page.locator('[data-cell="0:0"]')).toBeFocused()

  // 最后一格：补出新的一行并停在行首
  await page.locator('[data-cell="0:0"]').press("Tab")
  await page.locator('[data-cell="0:1"]').press("Tab")
  await expect(page.locator('[data-cell="1:0"]')).toBeFocused()
  await expect(textarea).toHaveValue(
    "|     |     |\n| --- | --- |\n|     |     |\n|     |     |\n\n"
  )
})

test("行列操作条能加列、删行", async ({ page }) => {
  const textarea = page.getByPlaceholder("想到什么，写什么...")

  await insertTable(page, 2, 3)
  await page.locator('[data-cell="0:0"]').click()

  await page.locator('.shard-editor-table-action[title="在右侧插入一列"]').click()
  await expect(page.locator('[data-cell="0:2"]')).toHaveCount(1)
  await expect(textarea).toHaveValue(
    "|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n\n"
  )

  await page.locator('.shard-editor-table-action[title="删除光标所在行"]').click()
  await expect(textarea).toHaveValue(
    "|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n\n"
  )
})

test("光标回到表格源文本时让位给源码编辑", async ({ page }) => {
  const textarea = page.getByPlaceholder("想到什么，写什么...")
  const block = page.locator(".shard-editor-table-block")

  await insertTable(page, 2, 2)
  await expect(block).not.toHaveAttribute("data-source-active", /.*/)

  await textarea.focus()
  await textarea.evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(2, 2)
    element.dispatchEvent(new Event("select", { bubbles: true }))
  })

  await expect(block).toHaveAttribute("data-source-active", "")
})

test("保存后的片段用只读表格渲染", async ({ page }) => {
  const textarea = page.getByPlaceholder("想到什么，写什么...")

  await insertTable(page, 2, 2)
  await page.locator('[data-cell="-1:0"]').fill("名称")
  await textarea.focus()
  await textarea.press("Meta+Enter")

  await expect(page.locator(".shard-markdown-table")).toHaveCount(1)
})

test("连续输入与竖线都不会写坏这张表", async ({ page }) => {
  const textarea = page.getByPlaceholder("想到什么，写什么...")

  await insertTable(page, 2, 2)
  await page.locator('[data-cell="-1:0"]').pressSequentially("市场采单", {
    delay: 30,
  })
  await expect(page.locator('[data-cell="-1:0"]')).toBeFocused()

  // 单元格里的裸竖线会把列切开，写回正文时必须转义
  await page.locator('[data-cell="0:0"]').fill("A|B")

  await expect(textarea).toHaveValue(
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
  const textarea = page.getByPlaceholder("想到什么，写什么...")

  await page.getByRole("button", { name: "插入表格" }).click()
  await page.getByRole("button", { name: "从 Excel 导入…" }).click()

  // 表格数据落在正文里——搜索、标签、git diff 才都还能用上
  await expect(textarea).toHaveValue(
    "## 采单安排\n\n| 日期 | 学校 |\n| --- | --- |\n| 2026-08-24 | 行知中学 |\n\n" +
      "## 费用\n\n| 项目 | 金额 |\n| --- | --- |\n| 交通 | 1250.5 |\n\n"
  )

  // 两个 sheet → 两张表，且都是可编辑的编辑态表格
  await expect(page.locator(".shard-editor-table")).toHaveCount(2)
  await expect(page.locator('[data-cell="0:1"]').first()).toHaveValue("行知中学")

  const importedPath = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__SHARD_IMPORT_PATH__
  )
  expect(importedPath).toBe("/tmp/shard-test/采单安排.xlsx")
})

test("超大表格退回纯文本，不把编辑器打字拖垮", async ({ page }) => {
  const textarea = page.getByPlaceholder("想到什么，写什么...")

  // 6 列 × 1200 行 ≈ 7200 格，越过 MAX_EDITABLE_TABLE_CELLS(6000)
  const lines = [
    "| 日期 | 学校 | 事项 | 负责人 | 数量 | 备注 |",
    "| --- | --- | --- | --- | --- | --- |",
  ]
  for (let index = 0; index < 1200; index += 1) {
    lines.push(`| 2026-08-01 | 第${index}中学 | 采单 | 张${index} | ${index} | — |`)
  }
  await textarea.fill(lines.join("\n"))

  // 不渲染成可交互表格：一格一个受控 input，这个量级会把每次按键拖到几百毫秒
  await expect(page.locator(".shard-editor-table")).toHaveCount(0)
  await expect(page.locator(".shard-editor-table-input")).toHaveCount(0)

  // 但正文没丢，源码照样能编辑
  await expect(textarea).toHaveValue(lines.join("\n"))
  await expect(page.locator(".shard-editor-highlight-layer")).toContainText(
    "第1199中学"
  )
})

test("阈值以内的表格仍然是可视化表格", async ({ page }) => {
  const textarea = page.getByPlaceholder("想到什么，写什么...")

  // 2 列 × 100 行 ≈ 202 格，远在阈值内
  const lines = ["| 学校 | 事项 |", "| --- | --- |"]
  for (let index = 0; index < 100; index += 1) {
    lines.push(`| 第${index}中学 | 采单 |`)
  }
  await textarea.fill(lines.join("\n"))

  await expect(page.locator(".shard-editor-table")).toHaveCount(1)
  await expect(page.locator('[data-cell="99:0"]')).toHaveValue("第99中学")
})
