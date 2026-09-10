import { chromium, expect, test, webkit, type Locator, type Page } from "@playwright/test"
import type { MindMapReadResult } from "../../src/types"

type Harness = Window & {
  __mindMapDocumentMock: { disk: MindMapReadResult }
  __mindMapDocumentHarness: { save(): Promise<boolean> }
}

const inlineEditor = (page: Page) => page.getByRole("textbox", { name: "导图节点", exact: true })
const selectedNode = (page: Page) => page.locator('[data-mind-map-node="branch-1"]')
const longChinese = "这是不断输入的中文内容，需要自动换行并且完整显示，不能让最后几行被截断。".repeat(3)

async function metrics(editor: Locator) {
  return editor.evaluate(element => {
    const input = element as HTMLTextAreaElement
    const rect = input.getBoundingClientRect()
    const style = getComputedStyle(input)
    return {
      height: rect.height, width: rect.width, x: rect.x, y: rect.y,
      bottom: rect.bottom, right: rect.right,
      clientHeight: input.clientHeight, scrollHeight: input.scrollHeight,
      scrollTop: input.scrollTop, lineHeight: parseFloat(style.lineHeight),
      fontSize: parseFloat(style.fontSize),
    }
  })
}

async function expectUnclipped(editor: Locator) {
  await expect.poll(async () => {
    const value = await metrics(editor)
    return value.scrollHeight - value.clientHeight
  }, { message: "编辑框应随所有实际文本行增高，不能隐藏溢出文字" }).toBeLessThanOrEqual(1)
  await expect.poll(async () => Math.abs((await metrics(editor)).scrollTop),
    { message: "可完整容纳的文字不应在编辑框内部滚动（允许亚像素取整误差）" }).toBeLessThanOrEqual(1)
}

async function openEditor(page: Page) {
  await page.goto("/mind-map-document-test.html?mock=1")
  await page.evaluate(() => document.fonts.ready)
  await page.getByRole("button", { name: "导图节点：主题甲", exact: true }).dblclick()
  await expect(inlineEditor(page)).toBeFocused()
}

async function expectLayoutFollowsEditor(page: Page) {
  const input = await metrics(inlineEditor(page))
  const nextTopic = await page.locator('[data-mind-map-node="branch-2"] rect[class]').boundingBox()
  expect(nextTopic!.y, "相邻主题应随编辑框增高向下避让").toBeGreaterThan(input.bottom)
  const endpoint = await page.getByRole("application", { name: "思维导图编辑器", exact: true })
    .locator('g[fill="none"] > path').first().evaluate(element => {
      const path = element as SVGPathElement
      const point = path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM()!)
      return { x: point.x, y: point.y }
    })
  expect(Math.abs(endpoint.x - input.x), "分支连线应连接增长后的节点左边缘").toBeLessThanOrEqual(1)
  expect(Math.abs(endpoint.y - input.y - input.height / 2), "分支连线应连接增长后的节点纵向中心").toBeLessThanOrEqual(1)
}

for (const browserName of ["webkit", "chromium"] as const) {
  const engineTest = test.extend({
    page: async ({}, use) => {
      const browser = await ({ webkit, chromium })[browserName].launch()
      try {
        await use(await browser.newPage({ baseURL: "http://127.0.0.1:1420", viewport: { width: 1280, height: 900 } }))
      } finally { await browser.close() }
    },
  })
  engineTest.describe(`${browserName} 独立导图内联编辑自适应`, () => {

    engineTest("长中文自动换行后编辑框长高，删除文字后缩回并保持缩放", async ({ page }) => {
      await openEditor(page)
      const editor = inlineEditor(page)
      const before = await metrics(editor)
      await editor.fill(longChinese)
      await expectUnclipped(editor)
      await expectLayoutFollowsEditor(page)
      const expanded = await metrics(editor)
      expect(expanded.height).toBeGreaterThan(before.height + before.lineHeight * 3)
      expect(expanded.fontSize).toBeCloseTo(before.fontSize, 2)
      expect(expanded.y).toBeGreaterThanOrEqual(0)
      expect(expanded.bottom).toBeLessThanOrEqual(900)
      await editor.fill("短文字")
      await expectUnclipped(editor)
      expect((await metrics(editor)).height).toBeLessThan(expanded.height)
      expect((await metrics(editor)).fontSize).toBeCloseTo(before.fontSize, 2)
    })

    engineTest("连续 Shift+Enter 的空行及尾随换行可见，保存重开保留原始内容", async ({ page }) => {
      await openEditor(page)
      const editor = inlineEditor(page)
      await editor.fill("第一行")
      const before = await metrics(editor)
      await editor.press("End")
      for (let index = 0; index < 7; index++) {
        await editor.press("Shift+Enter")
        await expect(editor).toHaveValue(`第一行${"\n".repeat(index + 1)}`)
        await expectUnclipped(editor)
      }
      const trailing = await metrics(editor)
      expect(trailing.height).toBeGreaterThan(before.height + before.lineHeight * 5)
      await page.keyboard.insertText("末行完整可见")
      await editor.press("Shift+Enter")
      const content = `第一行${"\n".repeat(7)}末行完整可见\n`
      await expect(editor).toHaveValue(content)
      await expectUnclipped(editor)
      await editor.press("Escape")
      expect(await page.evaluate(() => (window as Harness).__mindMapDocumentHarness.save())).toBe(true)
      expect(await page.evaluate(() => (window as Harness).__mindMapDocumentMock.disk.file.nodes["branch-1"].text)).toBe(content)
      await page.getByRole("button", { name: "重新打开", exact: true }).click()
      await selectedNode(page).dblclick()
      await expect(inlineEditor(page)).toHaveValue(content)
      await expectUnclipped(inlineEditor(page))
    })

    engineTest("实际字体的宽英文字符、单词换行和组合表情均完整显示", async ({ page }) => {
      await openEditor(page)
      const editor = inlineEditor(page)
      for (const value of [
        "WWWWWWWWWWWWWWWWWWWW".repeat(4),
        "Word wrapping of long English content and paragraphs. ".repeat(5),
        "😀👩🏻‍💻👨‍👩‍👧‍👧🌈🚀😀👩🏻‍💻👨‍👩‍👧‍👧🌈🚀".repeat(3),
        "第一行     中间五个空格     最后内容".repeat(6),
      ]) {
        await editor.fill(value)
        await expect(editor).toHaveValue(value)
        await expectUnclipped(editor)
        await expectLayoutFollowsEditor(page)
        await editor.fill("缩回")
        await expectUnclipped(editor)
      }
      await editor.fill("WWWWWWWWWWWWWWWWWWWW".repeat(4))
      const beforeZoom = await metrics(editor)
      await page.getByRole("application", { name: "思维导图编辑器", exact: true }).dispatchEvent("wheel", {
        deltaY: 180, ctrlKey: true, clientX: 600, clientY: 450, bubbles: true,
      })
      await expect.poll(async () => (await metrics(editor)).fontSize).toBeLessThan(beforeZoom.fontSize)
      await expectUnclipped(editor)
    })

    engineTest("缩放和窄画布检查器打开时，增长中的完整编辑框仍在可见区域", async ({ page }) => {
      await page.setViewportSize({ width: 1180, height: 900 })
      await page.goto("/mind-map-document-test.html?mock=1")
      // Reproduce the real Library columns leaving 684px for the diagram workspace.
      await page.addStyleTag({ content: "body > #root > main { margin-left: 496px; width: calc(100% - 496px); }" })
      await page.getByRole("button", { name: "显示检查器", exact: true }).click()
      await page.getByRole("tab", { name: "主题导航", exact: true }).click()
      await page.getByLabel("导图主题导航").getByRole("button", { name: "主题甲", exact: true }).click()
      const canvas = page.getByRole("application", { name: "思维导图编辑器", exact: true })
      await canvas.dispatchEvent("wheel", { deltaY: -80, ctrlKey: true, clientX: 690, clientY: 450, bubbles: true })
      await page.keyboard.press("F2")
      const editor = inlineEditor(page)
      await expect(editor).toBeFocused()
      const before = await metrics(editor)
      await editor.fill("物品收纳和整理\n大口喝咖啡后再开始\n卡夫卡\n\n末行不能遮挡\n\n")
      await expectUnclipped(editor)
      const panel = await page.getByRole("complementary", { name: "思维导图检查器", exact: true }).boundingBox()
      await expect.poll(async () => (await metrics(editor)).right).toBeLessThanOrEqual(panel!.x + 1)
      const expanded = await metrics(editor)
      expect(expanded.x).toBeGreaterThanOrEqual(496)
      expect(expanded.y).toBeGreaterThanOrEqual(0)
      expect(expanded.bottom).toBeLessThanOrEqual(900)
      expect(expanded.fontSize).toBeCloseTo(before.fontSize, 2)
    })
  })
}
