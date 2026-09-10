import { chromium, expect, test, webkit, type Locator, type Page } from "@playwright/test"
import type { MindMapReadResult, ShardMapFile } from "../../src/types"

type Harness = Window & {
  __mindMapDocumentMock: { disk: MindMapReadResult }
  __mindMapDocumentHarness: { save(): Promise<boolean> }
}

const branches = (page: Page) => page.getByRole("textbox", { name: "导图节点", exact: true })
const focusedEditor = (page: Page) => page.locator('textarea[aria-label="导图节点"]:focus, input[aria-label="导图节点"]:focus')
const nodeNamed = (file: ShardMapFile, text: string) => Object.values(file.nodes).find(node => node.text === text)!

async function openOutline(page: Page) {
  await page.goto("/mind-map-document-test.html?mock=1")
  await page.getByRole("tab", { name: "大纲", exact: true }).click()
  await expect(branches(page)).toHaveCount(3)
  await page.evaluate(() => document.fonts.ready)
}

async function saved(page: Page) {
  expect(await page.evaluate(() => (window as Harness).__mindMapDocumentHarness.save())).toBe(true)
  return page.evaluate(() => (window as Harness).__mindMapDocumentMock.disk.file)
}

async function settleFocus(page: Page) {
  // A focus request used to re-select the text on the following animation frame.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function expectUnclipped(editor: Locator) {
  await expect.poll(() => editor.evaluate(element => {
    const input = element as HTMLTextAreaElement
    return input.scrollHeight - input.clientHeight
  }), { message: "大纲正文应完整换行显示，不能依赖输入框内部滚动" }).toBeLessThanOrEqual(1)
}

for (const browserName of ["webkit", "chromium"] as const) {
  const engineTest = test.extend({
    page: async ({}, use) => {
      const browser = await ({ webkit, chromium })[browserName].launch()
      try {
        await use(await browser.newPage({ baseURL: "http://127.0.0.1:1420", viewport: { width: 1280, height: 720 } }))
      } finally { await browser.close() }
    },
  })

  engineTest.describe(`${browserName} 主编辑区大纲模式`, () => {
    engineTest("普通点击保留鼠标光标，输入不会覆盖已有主题", async ({ page }) => {
      await openOutline(page)
      const first = branches(page).first()
      await first.click()
      await settleFocus(page)
      const selection = await first.evaluate(element => {
        const input = element as HTMLTextAreaElement
        return { start: input.selectionStart, end: input.selectionEnd }
      })
      expect(selection.end).toBe(selection.start)
      await first.press("End")
      await page.keyboard.insertText("补充")
      await expect(first).toHaveValue("主题甲补充")
      await branches(page).nth(1).click()
      await first.click()
      await settleFocus(page)
      await first.press("End")
      await page.keyboard.insertText("继续")
      await expect(first).toHaveValue("主题甲补充继续")
      expect((await saved(page)).nodes["branch-1"].text).toBe("主题甲补充继续")
    })

    engineTest("Enter 连续新同级、Tab 缩进当前主题和 Shift+Tab 提升后持续输入", async ({ page }) => {
      await openOutline(page)
      await branches(page).first().click()
      await branches(page).first().evaluate(element => {
        const input = element as HTMLTextAreaElement
        input.setSelectionRange(input.value.length, input.value.length)
      })
      await page.keyboard.press("Enter")
      await expect(focusedEditor(page)).toHaveValue("")
      await page.keyboard.insertText("同级乙")
      await page.keyboard.press("Enter")
      await expect(focusedEditor(page)).toHaveValue("")
      await page.keyboard.insertText("同级丙")
      await page.keyboard.press("Tab")
      await expect(focusedEditor(page)).toHaveValue("同级丙")
      await page.keyboard.press("Enter")
      await expect(focusedEditor(page)).toHaveValue("")
      await page.keyboard.insertText("子主题")
      let file = await saved(page)
      expect(nodeNamed(file, "同级丙").parentId).toBe(nodeNamed(file, "同级乙").id)
      expect(nodeNamed(file, "子主题").parentId).toBe(nodeNamed(file, "同级乙").id)
      expect(nodeNamed(file, "同级乙").parentId).toBe(file.rootId)
      await page.keyboard.press("Shift+Tab")
      await expect(focusedEditor(page)).toHaveValue("子主题")
      await page.keyboard.press("End")
      await page.keyboard.insertText("已提升")
      file = await saved(page)
      expect(nodeNamed(file, "子主题已提升").parentId).toBe(file.rootId)
      expect(Object.keys(file.nodes)).toHaveLength(7)
    })

    engineTest("空主题 Backspace 删除后返回父主题光标，根主题不被删除", async ({ page }) => {
      await openOutline(page)
      await page.getByRole("button", { name: "主题操作：主题甲", exact: true }).click()
      await page.getByRole("menuitem", { name: "添加子节点", exact: true }).click()
      await expect(focusedEditor(page)).toHaveValue("")
      await page.keyboard.press("Backspace")
      await expect(branches(page)).toHaveCount(3)
      await expect(focusedEditor(page)).toHaveValue("主题甲")
      await page.keyboard.press("End")
      await page.keyboard.insertText("继续输入")
      await expect(focusedEditor(page)).toHaveValue("主题甲继续输入")
      const root = page.getByRole("textbox", { name: "根节点", exact: true })
      await root.fill("")
      await root.press("Backspace")
      await expect(root).toBeFocused()
      expect(Object.keys((await saved(page)).nodes)).toHaveLength(4)
    })

    engineTest("已有多行主题和空行在保存重开及视图切换后保持全文", async ({ page }) => {
      await openOutline(page)
      const first = branches(page).first()
      const text = "第一行\n第二行\n\n末行"
      // The outline now uses Shift+Enter for notes; existing/pasted multiline titles remain lossless.
      await first.fill(text)
      await expect(first).toHaveValue(text)
      await expect(branches(page)).toHaveCount(3)
      await expectUnclipped(first)
      expect((await saved(page)).nodes["branch-1"].text).toBe(text)
      await page.getByRole("tab", { name: "思维导图", exact: true }).click()
      await expect(page.locator('[data-mind-map-node="branch-1"]')).toContainText("末行")
      await page.getByRole("tab", { name: "大纲", exact: true }).click()
      await expect(branches(page).first()).toHaveValue(text)
      await page.getByRole("button", { name: "重新打开", exact: true }).click()
      await page.getByRole("tab", { name: "大纲", exact: true }).click()
      await expect(branches(page).first()).toHaveValue(text)
      await expectUnclipped(branches(page).first())
    })

    engineTest("中文输入法确认键和兼容键码不触发增删节点", async ({ page }) => {
      await openOutline(page)
      const first = branches(page).first()
      await first.fill("")
      // Synthetic composition boundaries verify handlers; this is not a physical IME acceptance.
      for (const event of [
        { key: "Enter", isComposing: true, keyCode: 13 },
        { key: "Tab", isComposing: true, keyCode: 9 },
        { key: "Backspace", isComposing: true, keyCode: 8 },
        { key: "Enter", isComposing: false, keyCode: 229 },
        { key: "Tab", isComposing: false, keyCode: 229 },
        { key: "Backspace", isComposing: false, keyCode: 229 },
      ]) {
        await first.dispatchEvent("keydown", event)
        await expect(branches(page)).toHaveCount(3)
        await expect(first).toBeFocused()
      }
      await page.keyboard.insertText("输入法确认后的正文")
      expect((await saved(page)).nodes["branch-1"].text).toBe("输入法确认后的正文")
    })

    engineTest("窄幅长文可完整换行，正文不被隐藏操作按钮压缩", async ({ page }) => {
      await openOutline(page)
      await page.setViewportSize({ width: 760, height: 720 })
      const first = branches(page).first()
      const text = "这是应该完整显示的大纲主题，长中文需要换行，不能被隐藏按钮挤到只剩几个字。".repeat(4)
      await first.fill(text)
      await expectUnclipped(first)
      const geometry = await first.evaluate(element => {
        const input = element as HTMLTextAreaElement
        const bounds = input.getBoundingClientRect()
        return { width: bounds.width, height: bounds.height, lineHeight: parseFloat(getComputedStyle(input).lineHeight),
          horizontalOverflow: input.scrollWidth - input.clientWidth, pageOverflow: document.documentElement.scrollWidth - innerWidth }
      })
      expect(geometry.width, "760px 工作区正文应保留可用宽度").toBeGreaterThan(200)
      expect(geometry.height).toBeGreaterThan(geometry.lineHeight * 3)
      expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1)
      expect(geometry.pageOverflow).toBeLessThanOrEqual(1)
      await branches(page).nth(1).click()
      await expectUnclipped(first)
      await page.screenshot({ path: `tests/evidence/mind-map-outline-${browserName}.png` })
      await first.fill("短文")
      await expectUnclipped(first)
      expect((await first.boundingBox())!.height).toBeLessThan(geometry.height)
    })

    engineTest("主题操作菜单新增主题后保持新主题焦点", async ({ page }) => {
      await openOutline(page)
      await page.getByRole("button", { name: "主题操作：主题甲", exact: true }).click()
      await page.getByRole("menuitem", { name: "添加同级节点", exact: true }).click()
      await expect(focusedEditor(page)).toHaveValue("")
      await settleFocus(page)
      await page.keyboard.insertText("菜单创建同级")
      await expect(focusedEditor(page)).toHaveValue("菜单创建同级")
      const file = await saved(page)
      expect(nodeNamed(file, "菜单创建同级").parentId).toBe(file.rootId)
      expect(file.nodes["branch-1"].text).toBe("主题甲")
    })

    engineTest("折叠主题添加子节点自动展开并定位新节点", async ({ page }) => {
      await openOutline(page)
      await page.getByRole("button", { name: "主题操作：主题甲", exact: true }).click()
      await page.getByRole("menuitem", { name: "添加子节点", exact: true }).click()
      await page.keyboard.insertText("已有子主题")
      const parentRow = page.locator('[data-outline-node="branch-1"]')
      await parentRow.getByRole("button", { name: "折叠 主题甲", exact: true }).click()
      await expect(branches(page)).toHaveCount(3)
      await parentRow.getByRole("button", { name: "主题操作：主题甲", exact: true }).click()
      await page.getByRole("menuitem", { name: "添加子节点", exact: true }).click()
      await expect(branches(page)).toHaveCount(5)
      await expect(focusedEditor(page)).toHaveValue("")
      await settleFocus(page)
      await page.keyboard.insertText("折叠后新增")
      await expect(focusedEditor(page)).toHaveValue("折叠后新增")
      const file = await saved(page)
      expect(file.nodes["branch-1"].collapsed).not.toBe(true)
      expect(nodeNamed(file, "折叠后新增").parentId).toBe("branch-1")
      expect(nodeNamed(file, "已有子主题").parentId).toBe("branch-1")
    })

    engineTest("连续新建只滚动大纲内部并让当前输入框保持可见", async ({ page }) => {
      await openOutline(page)
      const toggle = page.getByRole("tab", { name: "思维导图", exact: true })
      const toolbarBefore = await toggle.boundingBox()
      await branches(page).nth(2).click()
      await branches(page).nth(2).evaluate(element => {
        const input = element as HTMLTextAreaElement
        input.setSelectionRange(input.value.length, input.value.length)
      })
      for (let index = 0; index < 24; index++) {
        await page.keyboard.press("Enter")
        await expect(focusedEditor(page)).toHaveValue("")
        await page.keyboard.insertText(`连续主题 ${index + 1}`)
      }
      const geometry = await page.locator("[data-mind-map-outline]").evaluate(viewport => {
        const input = document.activeElement as HTMLTextAreaElement
        const r = input.getBoundingClientRect()
        const v = viewport.getBoundingClientRect()
        return { scrollTop: viewport.scrollTop, inputTop: r.top, inputBottom: r.bottom, viewportTop: v.top, viewportBottom: v.bottom,
          windowScroll: window.scrollY, documentScroll: document.documentElement.scrollTop }
      })
      expect(geometry.scrollTop).toBeGreaterThan(0)
      expect(geometry.inputTop).toBeGreaterThanOrEqual(geometry.viewportTop)
      expect(geometry.inputBottom).toBeLessThanOrEqual(geometry.viewportBottom)
      expect(geometry.windowScroll).toBe(0)
      expect(geometry.documentScroll).toBe(0)
      expect((await toggle.boundingBox())!.y).toBe(toolbarBefore!.y)
      expect(Object.keys((await saved(page)).nodes)).toHaveLength(28)
    })

    engineTest("撤销新主题后焦点仍留在大纲，可以立即继续创建", async ({ page }) => {
      await openOutline(page)
      await branches(page).first().click()
      await branches(page).first().evaluate(element => {
        const input = element as HTMLTextAreaElement
        input.setSelectionRange(input.value.length, input.value.length)
      })
      await page.keyboard.press("Enter")
      await expect(branches(page)).toHaveCount(4)
      await expect(focusedEditor(page)).toHaveValue("")
      await page.keyboard.press("ControlOrMeta+z")
      await expect(branches(page)).toHaveCount(3)
      await expect.poll(() => page.locator("[data-mind-map-outline]").evaluate(viewport => viewport.contains(document.activeElement))).toBe(true)
      await page.keyboard.press("Enter")
      await expect(branches(page)).toHaveCount(4)
      await expect(focusedEditor(page)).toHaveValue("")
      await page.keyboard.insertText("撤销后继续录入")
      expect(nodeNamed(await saved(page), "撤销后继续录入")).toBeTruthy()
    })

    engineTest("检查器选中与主区光标同步，检查器编辑不会被大纲抢走焦点", async ({ page }) => {
      await openOutline(page)
      await branches(page).nth(1).click()
      await page.getByRole("button", { name: "显示检查器", exact: true }).click()
      const property = page.getByRole("textbox", { name: "主题文字", exact: true })
      await expect(property).toHaveValue("主题乙")
      await property.fill("从属性编辑主题乙")
      await expect(property).toBeFocused()
      await expect(branches(page).nth(1)).toHaveValue("从属性编辑主题乙")
      await page.getByRole("tab", { name: "主题导航", exact: true }).click()
      await page.getByLabel("导图主题导航").getByRole("button", { name: "主题丙", exact: true }).click()
      await expect(branches(page).nth(2)).toBeFocused()
      // macOS End scrolls to the document end; Cmd+Right moves the text caret.
      await page.keyboard.press(await page.evaluate(() => /Mac/.test(navigator.platform) ? "Meta+ArrowRight" : "End"))
      expect(await branches(page).nth(2).evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(3)
      await page.keyboard.insertText("继续")
      await expect(branches(page).nth(2)).toHaveValue("主题丙继续")
      expect((await saved(page)).nodes["branch-3"].text).toBe("主题丙继续")
    })
  })
}
