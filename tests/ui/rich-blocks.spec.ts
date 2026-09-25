import { expect, test, type Locator, type Page } from "@playwright/test"

import {
  fillEditor,
  focusEditor,
  readEditor,
  typeEditor,
} from "./editor-helpers"
import { installSearchIpcMock } from "./search-ipc-mock"

interface TestCall {
  command: string
  args: Record<string, unknown>
}

const COMPOSER = '[data-shard-editor="composer"]'
const FENCE = "```"

const INLINE_DATATABLE = [
  `${FENCE}datatable`,
  "{",
  '  "title": "季度",',
  '  "columns": [',
  '    { "key": "name", "label": "名称", "type": "text" },',
  '    { "key": "amount", "label": "金额", "type": "currency" }',
  "  ],",
  '  "rows": [',
  '    { "name": "乙项目", "amount": 1200 },',
  '    { "name": "甲项目", "amount": 300 }',
  "  ]",
  "}",
  FENCE,
].join("\n")

const CSV_DATATABLE = [
  `${FENCE}datatable`,
  '{ "title": "来自 CSV", "src": "data/small.csv" }',
  FENCE,
].join("\n")

const HTML_BLOCK_FRAGMENT = [
  "前面的段落",
  "",
  '<div class="note">',
  "  <span>原样保留</span>",
  "</div>",
  "",
  "后面的段落",
].join("\n")

const PASTED_MARKDOWN = [
  "- 列表一",
  "- 列表二",
  "",
  `${FENCE}mindmap`,
  "- 粘贴中心",
  "  - 粘贴分支",
  FENCE,
].join("\n")

// 跑真实工作台路由 + 内存 vault；不写用户的任何文件。
async function installRichBlocksMock(page: Page) {
  await installSearchIpcMock(page)
  await page.addInitScript(
    ({ csvFence, inlineFence }: { csvFence: string; inlineFence: string }) => {
      const now = "2026-09-10T08:00:00.000Z"
      const fragments = [
        { id: "card-datatable", path: "fragments/card-datatable.md", content: inlineFence },
        { id: "card-datatable-csv", path: "fragments/card-datatable-csv.md", content: csvFence },
      ].map((fragment) => ({
        ...fragment, tags: ["inbox"], createdAt: now, updatedAt: now, category: null,
        gitStatus: "committed", error: null, archived: false, lockbox: false,
        pinned: false, related: [],
      }))
      const git = {
        branch: "main", shortCommit: "abc1234", hasRemote: false,
        status: "ready", error: null, ahead: 0, behind: 0,
      }
      const state = {
        vaultPath: "/tmp/shard-rich-blocks-mock-vault", fragments, git,
        lockbox: { configured: false, unlocked: false, expiresAt: null, ttlSeconds: 900 },
      }
      const tree = {
        entries: [], assets: [], trashEntries: [], fragmentTrashEntries: [],
        fragmentStream: { totalCount: fragments.length, years: [] },
      }
      const csvFiles = [{ name: "small.csv", path: "data/small.csv" }]
      const smallCsv = "姓名,城市\r\n张三,北京\r\n李四,上海"
      const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
      const calls: TestCall[] = []
      let callbackId = 0
      let createdCount = 0
      Object.assign(globalThis, {
        isTauri: true,
        __SHARD_RICH_CALLS__: calls,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
          transformCallback: () => ++callbackId,
          invoke: async (command: string, args: Record<string, unknown> = {}) => {
            calls.push({ command, args: clone(args) })
            switch (command) {
              case "plugin:event|listen": return ++callbackId
              case "plugin:event|unlisten":
              case "unhide_pointer":
              case "set_window_controls_hidden": return null
              case "plugin:app|version": return "0.1.3"
              case "list_fragments": return clone(state)
              case "list_mind_maps": return []
              case "list_csv_files": return clone(csvFiles)
              // 数据表的 src 形态走与 CsvPreview 同一条读取链路。
              case "read_csv_file": {
                const path = String(args.path ?? "")
                if (path === "data/small.csv") {
                  return Array.from(new TextEncoder().encode(smallCsv))
                }
                throw new Error(`找不到 CSV 文件 ${path}`)
              }
              case "open_csv_file": return null
              case "list_library_tree": return clone(tree)
              case "migrate_legacy_notes": return { tree: clone(tree), migratedCount: 0 }
              case "sync_vault": return clone(git)
              case "checkpoint_vault":
                return { status: "no_changes", changes: 0, reason: null, git: clone(git) }
              case "github_cli_status":
                return { installed: true, authenticated: true, login: "shard-test", protocol: "https", error: null }
              case "create_fragment": {
                const id = `rich-block-created-${++createdCount}`
                const created = {
                  id, path: `fragments/2026/09/${id}.md`, content: String(args.content ?? ""),
                  tags: (args.tags as string[]) ?? [], createdAt: now, updatedAt: now,
                  category: null, gitStatus: "saved", error: null,
                  archived: false, lockbox: false, pinned: false, related: [],
                }
                fragments.unshift(created)
                return clone(created)
              }
              case "update_fragment": {
                const fragment = fragments.find((item) => item.id === args.id)
                if (!fragment) throw new Error("Fragment not found")
                fragment.content = String(args.content ?? fragment.content)
                return clone(fragment)
              }
              default: throw new Error(`Unhandled Tauri test command: ${command}`)
            }
          },
        },
      })
    },
    { csvFence: CSV_DATATABLE, inlineFence: INLINE_DATATABLE }
  )
}

function proseMirror(page: Page) {
  return page.locator(`${COMPOSER} .ProseMirror`)
}

function commandMenu(page: Page) {
  return page.getByRole("listbox", { name: "命令菜单" })
}

function composerBlock(page: Page, lang: string) {
  return page.locator(`${COMPOSER} [data-shard-rich-block="${lang}"]`)
}

function card(page: Page, id: string) {
  return page.locator(`[data-shard-fragment-id="${id}"]`)
}

/** 只滚动碎片流 viewport；content-visibility:auto 的卡片必须先进视口才有布局。 */
async function revealCard(target: Locator) {
  await expect(target).toHaveCount(1)
  await target.evaluate((element) => {
    const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (!viewport) return
    viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  })
}

async function runSlashCommand(page: Page, query: string) {
  await fillEditor(page, "composer", "")
  await focusEditor(page, "composer")
  await typeEditor(page, "composer", `/${query}`)
  await expect(commandMenu(page).getByRole("option")).toHaveCount(1)
  await page.keyboard.press("Enter")
  await expect(commandMenu(page)).toHaveCount(0)
}

async function createdContents(page: Page) {
  return page.evaluate(() => {
    const calls = (globalThis as typeof globalThis & { __SHARD_RICH_CALLS__: TestCall[] })
      .__SHARD_RICH_CALLS__
    return calls
      .filter((call) => call.command === "create_fragment")
      .map((call) => String(call.args.content ?? ""))
  })
}

/** 提交前先把选区交回 ProseMirror：块内组件把所有事件都拦下了。 */
async function submitComposer(page: Page) {
  await page.locator(`${COMPOSER} .ProseMirror > p`).last().click()
  await page.keyboard.press("ControlOrMeta+Enter")
}

test.describe("富文本块级组件", () => {
  test.beforeEach(async ({ page }) => {
    await installRichBlocksMock(page)
    await page.goto("/")
    await expect(proseMirror(page)).toBeFocused()
  })

  test("/导图块 插入幕布式大纲，根节点直接可输入，提交为规范围栏", async ({ page }) => {
    await runSlashCommand(page, "导图块")

    const outline = composerBlock(page, "mindmap")
    await expect(outline).toHaveCount(1)
    const root = outline.locator(
      '[data-outline-node][data-root="true"] textarea[data-outline-field="text"]'
    )
    await expect(root).toBeFocused()

    await page.keyboard.type("中心主题")
    // Enter 在根节点上建子节点，与旧 widget 的交互契约一致。
    await page.keyboard.press("Enter")
    await page.keyboard.type("分支一")

    await expect.poll(() => readEditor(page, "composer")).toContain(
      `${FENCE}mindmap\n- 中心主题\n  - 分支一\n${FENCE}`
    )
    // 编辑区里看不到围栏语法。
    await expect(proseMirror(page)).not.toContainText(FENCE)

    await page.keyboard.press("Escape")
    await expect(proseMirror(page)).toBeFocused()
    await page.keyboard.press("ControlOrMeta+Enter")

    await expect
      .poll(async () => (await createdContents(page)).map((content) => content.trimEnd()))
      .toEqual([`${FENCE}mindmap\n- 中心主题\n  - 分支一\n${FENCE}`])
  })

  test("外部替换围栏正文时大纲会话重建，自己的写回不重建", async ({ page }) => {
    await fillEditor(page, "composer", `${FENCE}mindmap\n- 原始中心\n${FENCE}`)

    const outline = composerBlock(page, "mindmap")
    await expect(outline).toHaveCount(1)
    const root = outline.locator(
      '[data-outline-node][data-root="true"] textarea[data-outline-field="text"]'
    )
    await expect(root).toHaveValue("原始中心")

    // 先在会话里写一笔：这一步的写回要原样绕宿主一圈回来，不能重建会话。
    await root.click()
    await page.keyboard.press("End")
    await page.keyboard.type("补充")
    await expect.poll(() => readEditor(page, "composer")).toContain("- 原始中心补充")
    await expect(root).toBeFocused()

    // 紧接着一次外部整体替换（撤销、外部写入都是这一路）：必须重建会话。
    await fillEditor(page, "composer", `${FENCE}mindmap\n- 外部替换\n${FENCE}`)
    await expect(root).toHaveValue("外部替换")
    await expect.poll(() => readEditor(page, "composer")).toBe(
      `${FENCE}mindmap\n- 外部替换\n${FENCE}`
    )
  })

  test("/数据表 插入模板，可编辑、排序与搜索，提交 JSON 不含视图状态", async ({ page }) => {
    await runSlashCommand(page, "数据表")

    const block = page.locator(`${COMPOSER} [data-datatable="block"]`)
    await expect(block).toHaveCount(1)
    await expect(block).toHaveAttribute("data-datatable-editable", "true")
    await expect(block.locator("thead th")).toHaveCount(2)
    await expect(block.locator("tbody tr")).toHaveCount(2)

    // 编辑两个单元格：失焦即提交，第二个用 Enter 提交。
    await block.getByRole("textbox", { name: "列 1 第 1 行" }).fill("乙")
    await block.getByRole("textbox", { name: "列 1 第 2 行" }).fill("甲")
    await page.keyboard.press("Enter")
    await expect.poll(() => readEditor(page, "composer")).toContain('"column1": "乙"')

    // 列头排序：甲 排到 乙 前面。
    const firstCell = () => block.locator("tbody tr").first().locator("input").first()
    await expect(firstCell()).toHaveValue("乙")
    await block.getByRole("button", { name: "按列 1排序" }).click()
    await expect(firstCell()).toHaveValue("甲")

    // 搜索只留命中行。
    await block.getByRole("textbox", { name: "搜索表格" }).fill("乙")
    await expect(block.locator("tbody tr")).toHaveCount(1)
    await expect(firstCell()).toHaveValue("乙")

    await submitComposer(page)
    const contents = await createdContents(page)
    expect(contents).toHaveLength(1)
    expect(contents[0]).toContain('"column1": "乙"')
    expect(contents[0]).toContain('"column1": "甲"')
    // 排序与搜索只是浏览动作，不写回文件。
    expect(contents[0]).not.toContain('"view"')
  })

  test("可编辑数据表可以加行、加列并命名、删列、删行，全部写回围栏 JSON", async ({ page }) => {
    await runSlashCommand(page, "数据表")
    const block = page.locator(`${COMPOSER} [data-datatable="block"]`)
    await expect(block.locator("tbody tr")).toHaveCount(2)

    // 加行：新行出现在末尾，焦点落进第一格，直接可以输入。
    await block.getByRole("button", { name: "新增行" }).click()
    await expect(block.locator("tbody tr")).toHaveCount(3)
    await expect(block.getByRole("textbox", { name: "列 1 第 3 行" })).toBeFocused()
    await page.keyboard.type("新行")
    await page.keyboard.press("Enter")
    await expect.poll(() => readEditor(page, "composer")).toContain('"column1": "新行"')

    // 加列：新列直接进入改名，Enter 提交。
    await block.getByRole("button", { name: "新增列" }).click()
    const nameInput = block.getByRole("textbox", { name: "列名" })
    await expect(nameInput).toBeFocused()
    await page.keyboard.type("金额")
    await page.keyboard.press("Enter")
    await expect(block.locator("thead th")).toHaveCount(3)
    await expect(block.locator("thead th").nth(2)).toContainText("金额")
    await expect.poll(() => readEditor(page, "composer")).toContain('"label": "金额"')
    await expect.poll(() => readEditor(page, "composer")).toContain('"column3": ""')

    // 删列：列操作菜单里删掉「列 2」，各行里的字段一起消失。
    await block.getByRole("button", { name: "列 2列操作" }).click()
    await page.getByRole("menuitem", { name: "删除列" }).click()
    await expect(block.locator("thead th")).toHaveCount(2)
    await expect.poll(() => readEditor(page, "composer")).not.toContain("column2")

    // 删行：删掉第 1 行。
    await block.locator("tbody tr").first().hover()
    await block.getByRole("button", { name: "删除第 1 行" }).click()
    await expect(block.locator("tbody tr")).toHaveCount(2)
    await expect(block.getByRole("textbox", { name: "列 1 第 2 行" })).toHaveValue("新行")
  })

  test("/表格 插入 3 列 2 行 GFM 表格，Tab 在单元格之间走格", async ({ page }) => {
    await runSlashCommand(page, "表格")

    const table = proseMirror(page).locator("table")
    await expect(table).toHaveCount(1)
    await expect(table.locator("th")).toHaveCount(3)
    await expect(table.locator("td")).toHaveCount(3)
    await expect(table.locator("tr")).toHaveCount(2)

    await page.keyboard.type("甲")
    await page.keyboard.press("Tab")
    await page.keyboard.type("乙")
    await expect(table.locator("th").nth(0)).toHaveText("甲")
    await expect(table.locator("th").nth(1)).toHaveText("乙")

    const markdown = await readEditor(page, "composer")
    expect(markdown).toContain("甲")
    expect(markdown).toContain("乙")
    expect(markdown).toMatch(/\|\s*---\s*\|\s*---\s*\|\s*---\s*\|/u)
  })

  test("粘贴 Markdown 文本解析成列表与大纲块，编辑区没有语法字符", async ({ page }) => {
    await fillEditor(page, "composer", "")
    await focusEditor(page, "composer")

    await proseMirror(page).evaluate((element, text) => {
      const data = new DataTransfer()
      data.setData("text/plain", text)
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })
      )
    }, PASTED_MARKDOWN)

    await expect(proseMirror(page).locator("ul > li")).toHaveCount(2)
    await expect(composerBlock(page, "mindmap")).toHaveCount(1)
    await expect(proseMirror(page)).not.toContainText(FENCE)
    await expect(proseMirror(page)).not.toContainText("- 列表一")
    await expect(proseMirror(page)).toContainText("列表一")

    await expect.poll(() => readEditor(page, "composer")).toBe(PASTED_MARKDOWN)
  })

  test("CSV 嵌入在编辑态是带说明的只读预览", async ({ page }) => {
    await fillEditor(page, "composer", "![[data/small.csv]]")

    const embed = composerBlock(page, "csv-embed")
    await expect(embed).toHaveCount(1)
    await expect(embed).toContainText("CSV 嵌入")
    await expect(embed.locator('[data-csv-path="data/small.csv"]')).toBeVisible()
    await expect(embed.locator("tbody tr")).toHaveCount(2)
    // 只读预览：编辑态不做 CSV ↔ 数据表的转换，正文仍是原写法。
    await expect.poll(() => readEditor(page, "composer")).toBe("![[data/small.csv]]")
  })

  test("块级 HTML 显示为不可编辑灰块，提交后原样保留", async ({ page }) => {
    await fillEditor(page, "composer", HTML_BLOCK_FRAGMENT)

    const raw = composerBlock(page, "raw")
    await expect(raw).toHaveCount(1)
    await expect(raw).toContainText("原始内容")
    await expect(raw).toContainText('<div class="note">')
    await expect(raw.locator("[contenteditable=true]")).toHaveCount(0)
    await expect(raw.getByRole("button", { name: "删除原始内容" })).toBeVisible()
    // 灰块的图标同样走 token：尺寸 md 档、基准描边（design.md）。
    const icon = await raw.locator('[data-slot="button"] svg').evaluate((svg) => {
      const style = getComputedStyle(svg)
      return { width: style.width, height: style.height, stroke: style.strokeWidth }
    })
    expect(icon).toEqual({ width: "16px", height: "16px", stroke: "1.5px" })

    await submitComposer(page)
    await expect.poll(() => createdContents(page)).toEqual([HTML_BLOCK_FRAGMENT])
  })

  test("灰块的删除按钮只移除这一块，其余正文不动", async ({ page }) => {
    await fillEditor(page, "composer", HTML_BLOCK_FRAGMENT)
    await composerBlock(page, "raw").getByRole("button", { name: "删除原始内容" }).click()

    await expect(composerBlock(page, "raw")).toHaveCount(0)
    await expect.poll(() => readEditor(page, "composer")).toBe("前面的段落\n\n后面的段落")
  })
})

test.describe("碎片卡片上的围栏块", () => {
  test.beforeEach(async ({ page }) => {
    await installRichBlocksMock(page)
    await page.goto("/")
    await expect(page.locator(".shard-timeline-item")).toHaveCount(2)
  })

  test("datatable 围栏在卡片上渲染成表格并可排序", async ({ page }) => {
    const target = card(page, "card-datatable")
    await revealCard(target)

    const block = target.locator('[data-datatable="block"]')
    await expect(block).toBeVisible()
    // 卡片是只读预览：没有可编辑的单元格。
    await expect(block).toHaveAttribute("data-datatable-editable", "false")
    await expect(block.locator("input[type=text]")).toHaveCount(1) // 只有搜索框
    await expect(target).not.toContainText(`${FENCE}datatable`)

    // 货币列按 zh-CN 格式化。
    await expect(block.locator("tbody tr").first()).toContainText("乙项目")
    await expect(block.locator("tbody tr").first()).toContainText("¥1,200.00")

    await block.getByRole("button", { name: "按金额排序" }).click()
    await expect(block.locator("tbody tr").first()).toContainText("甲项目")
  })

  test("卡片上的数据表可以按列分组并折叠分组", async ({ page }) => {
    const target = card(page, "card-datatable")
    await revealCard(target)
    const block = target.locator('[data-datatable="block"]')
    await expect(block).toBeVisible()

    await block.getByRole("button", { name: "分组" }).click()
    await page.getByRole("menuitem", { name: "按名称分组" }).click()

    const groups = block.locator("[data-datatable-group]")
    await expect(groups).toHaveCount(2)
    await expect(block.locator("tbody tr")).toHaveCount(4) // 两个分组标题 + 两行

    await groups.first().click()
    await expect(groups.first()).toHaveAttribute("aria-expanded", "false")
    await expect(block.locator("tbody tr")).toHaveCount(3)
  })

  test("src 指向库内 CSV 的数据表只读展示 CSV 内容", async ({ page }) => {
    const target = card(page, "card-datatable-csv")
    await revealCard(target)

    const block = target.locator('[data-datatable="block"]')
    await expect(block).toBeVisible()
    await expect(block.locator("thead th")).toHaveCount(2)
    await expect(block.locator("thead th").nth(0)).toContainText("姓名")
    await expect(block.locator("tbody tr")).toHaveCount(2)
    await expect(block.locator("tbody tr").first()).toContainText("张三")
    await expect(block).toContainText("data/small.csv")
  })
})

// 迁自 tests/ui/mind-map-widget.spec.ts 与 tests/ui/slash-commands.spec.ts（旧 CodeMirror widget 用例）。
test.describe("大纲块的编辑交互", () => {
  const OUTLINE_DOC = ["前言", "", `${FENCE}mindmap`, "- 中心主题", "  - 分支一", FENCE, "", "结尾"].join("\n")
  const SINGLE_ROOT_DOC = [`${FENCE}mindmap`, "- 中心主题", FENCE, "", "结尾"].join("\n")

  function rootInput(target: Locator) {
    return target.locator('[data-outline-node][data-root="true"] textarea[data-outline-field="text"]')
  }

  function branchInputs(target: Locator) {
    return target.locator('[data-outline-node][data-root="false"] textarea[data-outline-field="text"]')
  }

  function composerViewportHeight(page: Page) {
    return page
      .locator(COMPOSER)
      .evaluate((element) => element.parentElement?.getBoundingClientRect().height ?? 0)
  }

  test.beforeEach(async ({ page }) => {
    await installRichBlocksMock(page)
    await page.goto("/")
    await expect(proseMirror(page)).toBeFocused()
  })

  for (const surface of ["inline", "zen"] as const) {
    test(`${surface} 编辑面把 mindmap 围栏渲染为幕布式大纲`, async ({ page }) => {
      await card(page, "card-datatable").getByRole("button", { name: "片段操作", exact: true }).click()
      await page
        .getByRole("menuitem", { name: surface === "inline" ? "编辑" : "禅模式", exact: true })
        .click()
      const id = `${surface === "inline" ? "fragment" : "zen"}:card-datatable`
      const editor = page.locator(`[data-shard-editor="${id}"]`)
      await expect(editor.locator(".ProseMirror")).toBeVisible()

      await fillEditor(page, id, OUTLINE_DOC)
      const outline = editor.locator('[data-shard-rich-block="mindmap"]')
      await expect(outline.locator("[data-mind-map-fence-widget]")).toHaveAttribute(
        "data-mind-map-fence-widget",
        "editor"
      )
      await expect(rootInput(outline)).toHaveValue("中心主题")
      await expect(branchInputs(outline)).toHaveValue("分支一")
      await expect(editor.locator(".ProseMirror")).not.toContainText(`${FENCE}mindmap`)
    })
  }

  test("空根大纲显示「中心主题」占位，Enter 建子节点、Tab 与 Shift-Tab 调层级并实时写回", async ({
    page,
  }) => {
    await runSlashCommand(page, "导图块")
    const root = rootInput(composerBlock(page, "mindmap"))
    await expect(root).toBeFocused()
    await expect(root).toHaveAttribute("placeholder", "中心主题")
    // 占位提示由组件渲染，正文里的根节点是空的。
    await expect.poll(() => readEditor(page, "composer")).toContain(`${FENCE}mindmap\n- \n${FENCE}`)

    await page.keyboard.type("主题")
    await page.keyboard.press("Enter")
    await page.keyboard.type("子节点")
    await page.keyboard.press("Enter")
    await expect.poll(() => readEditor(page, "composer")).toContain(
      `${FENCE}mindmap\n- 主题\n  - 子节点\n  - \n${FENCE}`
    )

    await page.keyboard.press("Tab")
    await expect.poll(() => readEditor(page, "composer")).toContain(
      `${FENCE}mindmap\n- 主题\n  - 子节点\n    - \n${FENCE}`
    )

    await page.keyboard.press("Shift+Tab")
    await expect.poll(() => readEditor(page, "composer")).toContain(
      `${FENCE}mindmap\n- 主题\n  - 子节点\n  - \n${FENCE}`
    )
  })

  test("大纲里新增节点是一步撤销，撤回后大纲块仍在", async ({ page }) => {
    await fillEditor(page, "composer", SINGLE_ROOT_DOC)
    const outline = composerBlock(page, "mindmap")
    await rootInput(outline).click()
    await page.keyboard.press("Enter")
    await expect.poll(() => readEditor(page, "composer")).toBe(
      [`${FENCE}mindmap`, "- 中心主题", "  - ", FENCE, "", "结尾"].join("\n")
    )

    await page.keyboard.press("Escape")
    await expect(proseMirror(page)).toBeFocused()
    await page.keyboard.press("ControlOrMeta+z")

    await expect.poll(() => readEditor(page, "composer")).toBe(SINGLE_ROOT_DOC)
    await expect(outline).toHaveCount(1)
    await expect(branchInputs(outline)).toHaveCount(0)
  })

  test("大纲块长高时速记框跟着长高", async ({ page }) => {
    await fillEditor(page, "composer", SINGLE_ROOT_DOC)
    const outline = composerBlock(page, "mindmap")
    await expect(outline).toHaveCount(1)
    const before = await composerViewportHeight(page)

    await rootInput(outline).click()
    for (let index = 1; index <= 5; index += 1) {
      await page.keyboard.press("Enter")
      await page.keyboard.type(`分支${index}`)
    }
    await expect(branchInputs(outline)).toHaveCount(5)

    await expect.poll(() => composerViewportHeight(page)).toBeGreaterThan(before)
  })

  test("组合输入期间根节点输入框不重建", async ({ page }) => {
    await runSlashCommand(page, "导图块")
    const root = rootInput(composerBlock(page, "mindmap"))
    await expect(root).toBeFocused()
    await root.evaluate((element) => {
      ;(element as HTMLTextAreaElement & { __shardImeMark?: string }).__shardImeMark = "kept"
    })

    const session = await page.context().newCDPSession(page)
    try {
      await session.send("Input.imeSetComposition", { selectionEnd: 2, selectionStart: 2, text: "zt" })
      await session.send("Input.insertText", { text: "主题" })

      await expect(root).toHaveValue("主题")
      expect(
        await root.evaluate(
          (element) => (element as HTMLTextAreaElement & { __shardImeMark?: string }).__shardImeMark
        )
      ).toBe("kept")
      await expect.poll(() => readEditor(page, "composer")).toContain(
        `${FENCE}mindmap\n- 主题\n${FENCE}`
      )
    } finally {
      await session.detach()
    }
  })
})
