import { expect, test, type Page } from "@playwright/test"

import {
  card,
  createdFragments,
  installContentTypesMock,
  revealCard,
} from "./content-types-mock"
import {
  fillEditor,
  focusEditor,
  readEditor,
  typeEditor,
} from "./editor-helpers"

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

test.describe("速记框内容类型", () => {
  test.beforeEach(async ({ page }) => {
    await installContentTypesMock(page)
    await page.goto("/")
    await expect(page.locator(`${COMPOSER} .ProseMirror`)).toBeFocused()
  })

  test("/大纲 把速记框切成幕布态，两级节点提交为纯缩进列表与大纲 type", async ({ page }) => {
    await runOutlineCommand(page, "composer")

    // 编辑区整块换成幕布式大纲，富文本正文让位。
    await expect(outlineComposer(page)).toHaveCount(1)
    await expect(page.locator(`${COMPOSER} .ProseMirror`)).toHaveCount(0)
    await expect(outlineComposer(page).locator(OUTLINE_ROOT)).toBeFocused()
    await expect(page.locator('[data-capture-type-badge="outline"]')).toBeVisible()
    await expect(page.getByRole("button", { name: "退出大纲", exact: true })).toBeVisible()

    await page.keyboard.type("项目大纲")
    await page.keyboard.press("Enter")
    await page.keyboard.type("第一步")
    await page.keyboard.press("ControlOrMeta+Enter")

    await expect.poll(() => createdFragments(page)).toEqual([
      { content: "- 项目大纲\n  - 第一步", tags: ["inbox", "outline"] },
    ])
    // 提交后退出大纲态，回到普通速记。
    await expect(outlineComposer(page)).toHaveCount(0)
    await expect(page.locator(`${COMPOSER} .ProseMirror`)).toHaveCount(1)
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
    await expect(page.locator(".shard-timeline-item")).toHaveCount(3)
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
