import { expect, test, type Page } from "@playwright/test"

import {
  card,
  createdFragments,
  createdGraphFragments,
  failNextGraphCreate,
  installContentTypesMock,
  readTypeCalls,
  revealCard,
} from "./content-types-mock"
import {
  fillEditor,
  focusEditor,
  readEditor,
  typeEditor,
} from "./editor-helpers"
import { openFragmentFilters } from "./fragment-filter-helpers"
import { selectOption } from "./select-helpers"

const COMPOSER = '[data-shard-editor="composer"]'
const OUTLINE = '[data-capture-outline="editor"]'
const OUTLINE_ROOT =
  '[data-outline-node][data-root="true"] textarea[data-outline-field="text"]'

function commandMenu(page: Page) {
  return page.getByRole("listbox", { name: "命令菜单" })
}

function outlineComposer(page: Page) {
  return page.locator(OUTLINE)
}

function submitButton(page: Page) {
  return page.getByRole("button", { name: "保存片段", exact: true })
}

function zenSurface(page: Page) {
  return page.locator('section[aria-label="禅模式"]')
}

async function openFromCardMenu(page: Page, id: string, entry: "编辑" | "禅模式") {
  const target = card(page, id)
  await revealCard(target)
  await target.getByRole("button", { name: "片段操作", exact: true }).click()
  await page.getByRole("menuitem", { name: entry, exact: true }).click()
}

async function commandCount(page: Page, command: string) {
  return (await readTypeCalls(page)).filter((call) => call.command === command).length
}

async function addEmptyOutlineNodes(page: Page, count: number) {
  await page.evaluate(async (nodeCount) => {
    for (let index = 0; index < nodeCount; index += 1) {
      const inputs = document.querySelectorAll<HTMLTextAreaElement>(
        '[data-capture-outline="editor"] [data-outline-node] textarea[data-outline-field="text"]'
      )
      const target = document.activeElement instanceof HTMLTextAreaElement
        ? document.activeElement
        : inputs.item(inputs.length - 1)
      if (!(target instanceof HTMLTextAreaElement)) {
        throw new Error(`第 ${index + 1} 个节点前没有活动的大纲输入框`)
      }
      target.focus()
      target.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Enter",
        key: "Enter",
      }))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }, count)
}

/**
 * 围栏块改名「导图块」之后，`/大纲` 只剩内容类型这一条候选（产品框架 §11 末条）。
 * 候选唯一，直接回车即可。
 */
async function runOutlineCommand(page: Page, editorId: string) {
  await focusEditor(page, editorId)
  await typeEditor(page, editorId, "/大纲")

  const menu = commandMenu(page)
  await expect(menu.getByRole("option")).toHaveCount(1)
  await expect(menu.getByRole("option")).toContainText("大纲")
  await page.keyboard.press("Enter")
  await expect(menu).toHaveCount(0)
}

async function runDocumentCommand(page: Page, editorId: string) {
  await focusEditor(page, editorId)
  await typeEditor(page, editorId, "/文档")

  const menu = commandMenu(page)
  await expect(menu.getByRole("option")).toHaveCount(1)
  await page.keyboard.press("Enter")
  await expect(menu).toHaveCount(0)
}

async function runFlowchartCommand(page: Page, editorId: string) {
  await focusEditor(page, editorId)
  await typeEditor(page, editorId, "/流程图")
  const menu = commandMenu(page)
  await expect(menu.getByRole("option")).toHaveCount(1)
  await page.keyboard.press("Enter")
  await expect(menu).toHaveCount(0)
}

test.describe("速记框内容类型", () => {
  test.beforeEach(async ({ page }) => {
    await installContentTypesMock(page)
    await page.goto("/")
    await expect(page.locator(`${COMPOSER} .ProseMirror`)).toBeFocused()
  })

  test("/大纲 提交会话树与标签到 create_graph_fragment，不调用 create_fragment", async ({ page }) => {
    await runOutlineCommand(page, "composer")

    // 编辑区整块换成幕布式大纲，富文本正文让位。
    await expect(outlineComposer(page)).toHaveCount(1)
    await expect(page.locator(`${COMPOSER} .ProseMirror`)).toHaveCount(0)
    await expect(outlineComposer(page).locator(OUTLINE_ROOT)).toBeFocused()
    await expect(page.locator('[data-capture-type-badge="outline"]')).toBeVisible()
    await expect(page.getByRole("button", { name: "退出大纲", exact: true })).toBeVisible()

    await page.keyboard.type("项目大纲 #计划")
    await page.keyboard.press("Enter")
    await page.keyboard.type("第一步")
    await page.keyboard.press("ControlOrMeta+Enter")

    await expect.poll(() => createdGraphFragments(page)).toHaveLength(1)
    const [created] = await createdGraphFragments(page)
    expect(created.kind).toBe("outline")
    expect(created.operationId).toMatch(/^[0-9a-f-]{20,}$/u)
    expect(created.tags).toEqual(["inbox", "计划", "outline"])
    expect(created.graph.nodes[created.graph.rootId].text).toBe("项目大纲 #计划")
    expect(Object.values(created.graph.nodes).map((node) => node.text)).toContain("第一步")
    expect(await createdFragments(page)).toEqual([])
    await expect(card(page, "typed-graph-created-1")).toHaveCount(1)
    // 提交后退出大纲态，回到普通速记。
    await expect(outlineComposer(page)).toHaveCount(0)
    await expect(page.locator(`${COMPOSER} .ProseMirror`)).toHaveCount(1)
  })

  test("/流程图 立即创建空图、保留原草稿并打开流程图宿主", async ({ page }) => {
    await fillEditor(page, "composer", "原有草稿")
    await page.keyboard.press("Enter")
    await runFlowchartCommand(page, "composer")

    await expect.poll(() => createdGraphFragments(page)).toHaveLength(1)
    const [created] = await createdGraphFragments(page)
    expect(created).toMatchObject({ kind: "flowchart", graph: null, tags: ["inbox"] })
    expect(created.operationId).toMatch(/^[0-9a-f-]{20,}$/u)
    await expect(page.locator('section[aria-label="流程图工作区"]')).toHaveCount(1)

    await page.keyboard.press("Escape")
    await expect(page.locator('section[aria-label="流程图工作区"]')).toHaveCount(0)
    await expect.poll(async () => (await readEditor(page, "composer")).trim()).toBe("原有草稿")
    await expect(card(page, "typed-graph-created-1")).toHaveCount(1)
  })

  test("/流程图 创建失败时保留草稿并显示错误", async ({ page }) => {
    await fillEditor(page, "composer", "失败也要保留")
    await page.keyboard.press("Enter")
    await failNextGraphCreate(page)
    await runFlowchartCommand(page, "composer")

    await expect(page.getByText("创建流程图失败：模拟流程图创建失败", { exact: true })).toBeVisible()
    await expect.poll(async () => (await readEditor(page, "composer")).trim()).toBe("失败也要保留")
    await expect(page.locator('section[aria-label="流程图工作区"]')).toHaveCount(0)
  })

  test("201 节点大纲完整提交，不沿用旧的 200 节点截断", async ({ page }) => {
    test.setTimeout(60_000)
    await runOutlineCommand(page, "composer")
    await page.keyboard.type("二百零一节点")
    await addEmptyOutlineNodes(page, 200)
    await expect(outlineComposer(page).locator("[data-outline-node]")).toHaveCount(201)

    await page.keyboard.press("ControlOrMeta+Enter")

    await expect.poll(() => createdGraphFragments(page)).toHaveLength(1)
    const [created] = await createdGraphFragments(page)
    expect(Object.keys(created.graph.nodes)).toHaveLength(201)
  })

  test("超过 400 节点时拦截提交、提示并保留完整草稿", async ({ page }) => {
    test.slow()
    await runOutlineCommand(page, "composer")
    await page.keyboard.type("超限大纲")
    await addEmptyOutlineNodes(page, 400)
    await expect(outlineComposer(page).locator("[data-outline-node]")).toHaveCount(401)

    await page.keyboard.press("ControlOrMeta+Enter")

    await expect(page.getByText("大纲最多 400 个节点", { exact: true })).toBeVisible()
    expect(await createdGraphFragments(page)).toEqual([])
    await expect(outlineComposer(page)).toHaveCount(1)
    await expect(outlineComposer(page).locator("[data-outline-node]")).toHaveCount(401)
  })

  test("根节点为空时不能提交，写下中心主题后才放行", async ({ page }) => {
    await runOutlineCommand(page, "composer")
    await expect(submitButton(page)).toBeDisabled()

    await page.keyboard.type("中心主题")
    await expect(submitButton(page)).toBeEnabled()

    // 清空根节点又回到禁用：空大纲没有中心主题，不该落盘。
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.press("Backspace")
    await expect(submitButton(page)).toBeDisabled()
  })

  test("大纲含密匣标签时保留草稿并提示，不创建内容", async ({ page }) => {
    await runOutlineCommand(page, "composer")
    await page.keyboard.type("私密大纲 #密匣")
    await page.keyboard.press("ControlOrMeta+Enter")

    await expect(page.getByText("大纲不能放入密匣", { exact: true })).toBeVisible()
    await expect.poll(() => createdFragments(page)).toEqual([])
    await expect(outlineComposer(page)).toHaveCount(1)
    await expect(outlineComposer(page).locator(OUTLINE_ROOT)).toHaveValue("私密大纲 #密匣")
  })

  test("退出大纲恢复进入前的草稿，两边互不转换", async ({ page }) => {
    await fillEditor(page, "composer", "原有草稿")
    await focusEditor(page, "composer")
    // `/` 只在行首或空白之后才算命令触发点，另起一段再打命令。
    await page.keyboard.press("Enter")
    await runOutlineCommand(page, "composer")
    await page.keyboard.type("临时大纲")

    await page.getByRole("button", { name: "退出大纲", exact: true }).click()

    await expect(outlineComposer(page)).toHaveCount(0)
    await expect
      .poll(async () => (await readEditor(page, "composer")).trim())
      .toBe("原有草稿")
    await expect(page.locator(`${COMPOSER} .ProseMirror`)).not.toContainText("临时大纲")
  })

  test("Esc 在根节点为空时也退出大纲态", async ({ page }) => {
    await runOutlineCommand(page, "composer")
    await expect(outlineComposer(page).locator(OUTLINE_ROOT)).toHaveValue("")

    await page.keyboard.press("Escape")
    await expect(outlineComposer(page)).toHaveCount(0)
    await expect(page.locator(`${COMPOSER} .ProseMirror`)).toHaveCount(1)
  })

  test("/文档 打下类型徽标，提交带文档 type；取消徽标后提交不带", async ({ page }) => {
    await runDocumentCommand(page, "composer")

    const badge = page.getByRole("button", { name: "取消文档类型", exact: true })
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText("文档")

    await focusEditor(page, "composer")
    await typeEditor(page, "composer", "第一篇文档")
    await page.keyboard.press("ControlOrMeta+Enter")
    await expect.poll(() => createdFragments(page)).toEqual([
      { content: "第一篇文档", tags: ["inbox", "document"] },
    ])
    // `/文档` 提交后直接进禅模式接着写（产品框架 §2）；关掉才回到速记框。
    await expect(zenSurface(page)).toHaveCount(1)
    await page.keyboard.press("Escape")
    await expect(zenSurface(page)).toHaveCount(0)
    // 提交后类型标记归零，下一条默认还是碎片。
    await expect(badge).toHaveCount(0)

    await runDocumentCommand(page, "composer")
    await expect(badge).toBeVisible()
    await badge.click()
    await expect(badge).toHaveCount(0)

    await focusEditor(page, "composer")
    await typeEditor(page, "composer", "普通碎片")
    await page.keyboard.press("ControlOrMeta+Enter")
    await expect.poll(() => createdFragments(page)).toEqual([
      { content: "第一篇文档", tags: ["inbox", "document"] },
      { content: "普通碎片", tags: ["inbox"] },
    ])
  })

  test("空草稿上的 /文档 只打标记，不报错也不创建内容", async ({ page }) => {
    await runDocumentCommand(page, "composer")

    await expect(page.getByRole("button", { name: "取消文档类型", exact: true })).toBeVisible()
    await expect.poll(() => readEditor(page, "composer")).toBe("")
    await expect(submitButton(page)).toBeDisabled()
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
  })
})

test.describe("时间线与瀑布流的类型卡片", () => {
  test.beforeEach(async ({ page }) => {
    await installContentTypesMock(page)
    await page.goto("/")
    await expect(page.locator(".shard-timeline-item")).toHaveCount(6)
  })

  test("大纲卡片渲染导图缩略加根节点标题，不铺原始列表", async ({ page }) => {
    const target = card(page, "card-outline")
    await revealCard(target)

    await expect(target.locator('[data-fragment-type-badge="outline"]')).toHaveText("大纲")
    const body = target.locator('[data-fragment-card-kind="outline"]')
    await expect(body).toHaveCount(1)
    await expect(body.locator("p").first()).toHaveText("项目大纲")
    await expect(body.getByRole("img", { name: "思维导图预览" })).toBeVisible()
    // 卡片上看不到缩进列表的原文。
    await expect(target).not.toContainText("- 第一步")
  })

  test("存在旧格式大纲时显示升级提示，暂不后按当前库隐藏", async ({ page }) => {
    const context = page.getByRole("region", { name: "旧格式大纲升级提示", exact: true })
    await expect(context).toContainText("有 1 篇旧格式大纲，升级后可用导图编辑")

    await context.getByRole("button", { name: "暂不", exact: true }).click()
    await expect(context).toHaveCount(0)
  })

  test("旧格式大纲升级提示与筛选状态条同时显示", async ({ page }) => {
    const dialog = await openFragmentFilters(page)
    await selectOption(dialog.getByRole("combobox", { name: "类型", exact: true }), "flowchart")
    await dialog.getByRole("button", { name: "查看碎片", exact: true }).click()

    await expect(page.getByRole("region", { name: "旧格式大纲升级提示", exact: true })).toBeVisible()
    await expect(page.getByRole("region", { name: "当前碎片筛选", exact: true })).toContainText("流程图")
  })

  test("升级对话框分三组展示，只有明确勾选后才包含有损项", async ({ page }) => {
    await page.getByRole("button", { name: "查看并升级", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "升级旧格式大纲", exact: true })
    await expect(dialog).toHaveAttribute("aria-busy", "false")

    await expect(dialog.getByRole("region", { name: "可无损升级", exact: true })).toContainText("项目大纲")
    const lossy = dialog.getByRole("region", { name: "有损", exact: true })
    await expect(lossy).toContainText("带备注的大纲")
    await expect(lossy).toContainText("丢弃非列表行 1 处")
    await expect(dialog.getByRole("region", { name: "无法升级", exact: true })).toContainText("没有任何有效行")

    const lossyItem = dialog.getByRole("checkbox", { name: /^选择 带备注的大纲/u })
    await expect(lossyItem).toBeDisabled()
    await expect(dialog.getByRole("button", { name: "升级 1 篇", exact: true })).toBeEnabled()

    await dialog.getByRole("checkbox", { name: "包含有损项", exact: true }).click()
    await expect(lossyItem).toBeEnabled()
    await expect(lossyItem).toBeChecked()
    await expect(dialog.getByRole("button", { name: "升级 2 篇", exact: true })).toBeEnabled()
  })

  test("升级完成后显示结果、刷新列表并按 JSON 大纲重新打开", async ({ page }) => {
    const listCallsBefore = await commandCount(page, "list_fragments")
    await page.getByRole("button", { name: "查看并升级", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "升级旧格式大纲", exact: true })
    await dialog.getByRole("button", { name: "升级 1 篇", exact: true }).click()

    const result = dialog.getByLabel("升级结果", { exact: true })
    await expect(result).toContainText("成功 1 篇，跳过 0 篇，失败 0 篇。")
    await expect(result).toContainText("已先保存 Git 检查点")
    await expect.poll(() => commandCount(page, "list_fragments")).toBeGreaterThan(listCallsBefore)
    await expect(page.getByRole("region", { name: "旧格式大纲升级提示", exact: true })).toHaveCount(0)

    await dialog.locator('[data-slot="dialog-footer"]').getByRole("button", { name: "关闭", exact: true }).click()
    await openFromCardMenu(page, "card-outline", "编辑")
    await expect(page.locator('section[aria-label="思维导图工作区"]')).toHaveCount(1)
  })

  test("旧格式大纲行内编辑提供升级入口，成功后关闭旧编辑器", async ({ page }) => {
    await openFromCardMenu(page, "card-outline", "编辑")
    const editorCard = card(page, "card-outline")
    const legacyEditor = editorCard.locator(OUTLINE)
    await expect(legacyEditor).toHaveCount(1)
    await expect(editorCard.getByText("旧格式大纲，升级后可用导图编辑", { exact: true })).toBeVisible()

    await editorCard.getByRole("button", { name: "升级", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "升级旧格式大纲", exact: true })
    await dialog.getByRole("button", { name: "升级 1 篇", exact: true }).click()
    await expect(dialog.getByLabel("升级结果", { exact: true })).toContainText("成功 1 篇")
    await expect(legacyEditor).toHaveCount(0)
  })

  test("旧格式大纲禅模式提供升级入口，成功后关闭旧编辑器", async ({ page }) => {
    await openFromCardMenu(page, "card-outline", "禅模式")
    const zen = zenSurface(page)
    await expect(zen).toHaveCount(1)
    await expect(zen.getByText("旧格式大纲，升级后可用导图编辑", { exact: true })).toBeVisible()

    await zen.getByRole("button", { name: "升级", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "升级旧格式大纲", exact: true })
    await dialog.getByRole("button", { name: "升级 1 篇", exact: true }).click()
    await expect(dialog.getByLabel("升级结果", { exact: true })).toContainText("成功 1 篇")
    await expect(zen).toHaveCount(0)
  })

  test("JSON 大纲卡片从受管区域显示根节点标题与缩略导图", async ({ page }) => {
    const target = card(page, "card-json-outline")
    await revealCard(target)

    await expect(target.locator('[data-fragment-type-badge="outline"]')).toHaveText("大纲")
    const body = target.locator('[data-fragment-card-kind="outline"]')
    await expect(body.locator("p").first()).toHaveText("JSON 项目大纲")
    await expect(body.getByRole("img", { name: "思维导图预览" })).toBeVisible()
    await expect(target).not.toContainText("```shardmap")
  })

  test("流程图卡片显示 JSON 标题与节点连线计数，解析失败回退原正文", async ({ page }) => {
    const valid = card(page, "card-json-flowchart")
    await revealCard(valid)
    await expect(valid.locator('[data-fragment-type-badge="flowchart"]')).toHaveText("流程图")
    const body = valid.locator('[data-fragment-card-kind="flowchart"]')
    await expect(body.locator("p").first()).toHaveText("发布流程")
    await expect(body.locator("p").nth(1)).toHaveText("2 个节点 · 1 条连线")
    await expect(valid).not.toContainText("```shardflow")

    const invalid = card(page, "card-invalid-flowchart")
    await revealCard(invalid)
    await expect(invalid).toContainText("流程图原始正文")
    await expect(invalid.locator('[data-fragment-card-kind="flowchart"]')).toHaveCount(0)
  })

  test("搜索与快速打开使用流程图 JSON 标题并进入碎片宿主", async ({ page }) => {
    await page.keyboard.press("Control+o")
    let dialog = page.getByRole("dialog", { name: "搜索", exact: true })
    await expect(dialog).toHaveAttribute("data-search-mode", "open")
    await dialog.getByRole("combobox", { name: "搜索内容" }).fill("发布流程")
    await expect(dialog.getByRole("option")).toContainText("发布流程")
    await dialog.getByRole("option").click()
    await expect(page.locator('section[aria-label="流程图工作区"]')).toHaveCount(1)
    await page.keyboard.press("Escape")

    await page.keyboard.press("Control+k")
    dialog = page.getByRole("dialog", { name: "搜索", exact: true })
    await dialog.getByRole("combobox", { name: "搜索内容" }).fill("发布流程")
    await expect(dialog.getByRole("option")).toContainText("发布流程")
    await dialog.getByRole("option").click()
    await expect(page.locator('section[aria-label="流程图工作区"]')).toHaveCount(1)
  })

  test("时间线按类型筛选流程图，清除后恢复全部卡片", async ({ page }) => {
    const dialog = await openFragmentFilters(page)
    await selectOption(dialog.getByRole("combobox", { name: "类型", exact: true }), "flowchart")
    await dialog.getByRole("button", { name: "查看碎片", exact: true }).click()

    const summary = page.getByRole("region", { name: "当前碎片筛选", exact: true })
    await expect(summary).toContainText("流程图")
    await expect(page.locator(".shard-timeline-item")).toHaveCount(2)
    await expect(card(page, "card-json-flowchart")).toBeVisible()
    await expect(card(page, "card-invalid-flowchart")).toBeVisible()
    await expect(card(page, "card-fragment")).toHaveCount(0)

    await summary.getByRole("button", { name: "清除筛选", exact: true }).click()
    await expect(summary).toHaveCount(0)
    await expect(page.locator(".shard-timeline-item")).toHaveCount(6)
  })

  test("搜索 mock 为 JSON 大纲提取根节点标题", async ({ page }) => {
    await page.keyboard.press("Control+k")
    const search = page.getByRole("dialog", { name: "搜索", exact: true })
    await search.getByRole("combobox", { name: "搜索内容" }).fill("JSON 项目大纲")
    await expect(search).toContainText("JSON 项目大纲")
    await search.getByRole("option").click()
    await expect(page.locator('section[aria-label="思维导图工作区"]')).toHaveCount(1)
    await expect(
      page.getByRole("tab", { name: "大纲", exact: true })
    ).toHaveAttribute("aria-selected", "true")
  })

  test("大纲卡片操作菜单不提供移入密匣", async ({ page }) => {
    const target = card(page, "card-outline")
    await revealCard(target)
    await target.getByRole("button", { name: "片段操作" }).click()

    await expect(page.getByRole("menuitem", { name: "移入密匣", exact: true })).toHaveCount(0)
  })

  test("文档卡片只给标题、摘要与徽标，不渲染全文", async ({ page }) => {
    const target = card(page, "card-document")
    await revealCard(target)

    await expect(target.locator('[data-fragment-type-badge="document"]')).toHaveText("文档")
    const body = target.locator('[data-fragment-card-kind="document"]')
    await expect(body.locator("p").first()).toHaveText("季度复盘")
    await expect(body.locator("p").nth(1)).toHaveText(
      "本季度完成了三件事。 第一件是把速记框换成富文本 第二件是补齐围栏块"
    )
    // 标题的井号与列表标记都不上卡片。
    await expect(target).not.toContainText("# 季度复盘")
    await expect(target).not.toContainText("- 第一件")
  })

  test("瀑布流两列下两种卡片形态不变", async ({ page }) => {
    await page.setViewportSize({ height: 900, width: 1800 })
    await expect(page.locator(".shard-timeline-layout")).toHaveAttribute("data-columns", "2")

    const outline = card(page, "card-outline")
    await revealCard(outline)
    await expect(outline.getByRole("img", { name: "思维导图预览" })).toBeVisible()
    await expect(outline.locator('[data-fragment-type-badge="outline"]')).toBeVisible()

    const document = card(page, "card-document")
    await revealCard(document)
    await expect(document.locator('[data-fragment-card-kind="document"]')).toHaveCount(1)
    await expect(document).not.toContainText("- 第一件")
  })
})
