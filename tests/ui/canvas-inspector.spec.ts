import { selectOption } from "./select-helpers"
import { expect, test, type Page } from "@playwright/test"
import type { MindMapReadResult, ShardDocumentLink } from "../../src/types"
test.use({ browserName: "webkit" })
type Harness = Window & {
  __mindMapDocumentMock: { disk: MindMapReadResult; hold: boolean; failSave: boolean; writes: number; release(): void }
  __mindMapDocumentHarness: { save(): Promise<boolean>; opened: ShardDocumentLink[]; block(value: boolean): void; dirty(): boolean }
  __pendingMapSave?: Promise<boolean>
}
const topic = (page: Page, text: string) => page.getByRole("button", { name: `导图节点：${text}`, exact: true })
async function saved(page: Page) { expect(await page.evaluate(() => (window as Harness).__mindMapDocumentHarness.save())).toBe(true); return page.evaluate(() => (window as Harness).__mindMapDocumentMock.disk.file) }

test("独立导图属性、宽度与颜色保存重开一致，收起检查器保留草稿", async ({ page }) => {
  await page.goto("/mind-map-document-test.html?mock=1")
  await page.getByRole("button", { name: "显示检查器", exact: true }).click()
  await topic(page, "主题甲").click()
  await page.getByLabel("主题文字", { exact: true }).fill("属性编辑后的主题")
  await page.getByRole("button", { name: "主题颜色：青绿", exact: true }).click()
  await selectOption(page.getByLabel("主题宽度", { exact: true }), "240")
  await expect(topic(page, "属性编辑后的主题")).toHaveAttribute("data-tone", "success")
  expect(Number(await topic(page, "属性编辑后的主题").locator('rect[class]').getAttribute("width"))).toBe(240)
  await page.getByRole("button", { name: "关闭检查器", exact: true }).click()
  await expect(page.getByRole("complementary", { name: "思维导图检查器" })).toHaveCount(0)
  await page.getByRole("button", { name: "显示检查器", exact: true }).click()
  await expect(page.getByLabel("主题文字", { exact: true })).toHaveValue("属性编辑后的主题")
  const file = await saved(page)
  expect(file.nodes["branch-1"].style?.tone).toBe("success")
  expect(file.nodes["branch-1"].width).toBe(240)
  await page.getByRole("button", { name: "重新打开", exact: true }).click()
  await expect(topic(page, "属性编辑后的主题")).toHaveAttribute("data-tone", "success")
})

test("导图引用流程图和其他导图仅保存稳定 ID，跳转先保存且失败保留现场", async ({ page }) => {
  await page.goto("/mind-map-document-test.html?mock=1")
  await page.getByRole("button", { name: "显示检查器", exact: true }).click()
  await topic(page, "主题甲").click()
  await page.getByRole("button", { name: "添加引用", exact: true }).click()
  await page.getByRole("button", { name: "审批流程 流程图", exact: true }).click()
  await page.getByRole("button", { name: "添加引用", exact: true }).click()
  await page.getByRole("button", { name: "资料结构 思维导图", exact: true }).click()
  await page.evaluate(() => { (window as Harness).__mindMapDocumentMock.failSave = true })
  await page.getByRole("button", { name: "审批流程", exact: true }).click()
  expect(await page.evaluate(() => (window as Harness).__mindMapDocumentHarness.opened)).toEqual([])
  expect(await page.evaluate(() => (window as Harness).__mindMapDocumentHarness.dirty())).toBe(true)
  await page.evaluate(() => { (window as Harness).__mindMapDocumentMock.failSave = false })
  await page.getByRole("button", { name: "审批流程", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as Harness).__mindMapDocumentHarness.opened.length)).toBe(1)
  const file = await saved(page)
  expect(file.nodes["branch-1"].links).toEqual([
    expect.objectContaining({ targetType: "flow", targetId: "reference-flow" }),
    expect.objectContaining({ targetType: "map", targetId: "reference-map" }),
  ])
  expect(Object.keys(file.nodes)).toHaveLength(4)
  await page.getByRole("button", { name: "移除引用 审批流程", exact: true }).click()
  expect((await saved(page)).nodes["branch-1"].links).toHaveLength(1)
})

test("慢保存期间继续输入会 drain 最新草稿，导航门禁阻止编辑", async ({ page }) => {
  await page.goto("/mind-map-document-test.html?mock=1")
  await page.getByRole("button", { name: "显示检查器", exact: true }).click()
  await topic(page, "主题甲").click()
  await page.getByLabel("主题文字", { exact: true }).fill("第一批修改")
  await page.evaluate(() => { const w = window as Harness; w.__mindMapDocumentMock.hold = true; w.__pendingMapSave = w.__mindMapDocumentHarness.save() })
  await expect.poll(() => page.evaluate(() => (window as Harness).__mindMapDocumentMock.writes)).toBe(1)
  await page.getByLabel("主题文字", { exact: true }).fill("保存期间继续修改")
  await page.evaluate(() => (window as Harness).__mindMapDocumentMock.release())
  expect(await page.evaluate(() => (window as Harness).__pendingMapSave)).toBe(true)
  expect((await saved(page)).nodes["branch-1"].text).toBe("保存期间继续修改")
  expect(await page.evaluate(() => (window as Harness).__mindMapDocumentMock.writes)).toBe(2)
  await page.evaluate(() => (window as Harness).__mindMapDocumentHarness.block(true))
  await expect(page.getByLabel("思维导图画布", { exact: true })).toHaveAttribute("aria-busy", "true")
  await page.keyboard.press("Enter")
  expect(Object.keys((await saved(page)).nodes)).toHaveLength(4)
  await page.evaluate(() => (window as Harness).__mindMapDocumentHarness.block(false))
  await expect(page.getByLabel("主题文字", { exact: true })).toBeEditable()
})

test("窄窗口检查器保持内部滚动且控件使用 Kiln 几何", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 550 })
  await page.goto("/mind-map-document-test.html?mock=1")
  await page.getByRole("button", { name: "显示检查器", exact: true }).click()
  await page.getByRole("tab", { name: "主题导航", exact: true }).click()
  await page.getByLabel("导图主题导航").getByRole("button", { name: "主题甲", exact: true }).click()
  await page.getByRole("tab", { name: "属性", exact: true }).click()
  const styles = await page.getByLabel("主题文字", { exact: true }).evaluate(element => ({ radius: getComputedStyle(element).borderRadius, font: getComputedStyle(element).fontSize }))
  expect(styles).toEqual({ radius: "4px", font: "13px" })
  const panel = await page.getByRole("complementary", { name: "思维导图检查器" }).boundingBox()
  expect(panel!.width).toBe(288)
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(640)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(640)
})

test("读取失败可离开，组合输入期间保存门禁保留当前编辑", async ({ page }) => {
  await page.goto("/mind-map-document-test.html?mock=1&missing=1")
  await expect(page.getByText("思维导图文件不存在", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as Harness).__mindMapDocumentHarness.save())).toBe(true)
  await page.goto("/mind-map-document-test.html?mock=1")
  await page.getByRole("button", { name: "显示检查器", exact: true }).click()
  await topic(page, "主题甲").click()
  const text = page.getByLabel("主题文字", { exact: true })
  await text.fill("组合输入中的草稿")
  await text.dispatchEvent("compositionstart", { data: "拼" })
  expect(await page.evaluate(() => (window as Harness).__mindMapDocumentHarness.save())).toBe(false)
  expect(await page.evaluate(() => (window as Harness).__mindMapDocumentMock.writes)).toBe(0)
  await text.dispatchEvent("compositionend", { data: "拼音" })
  expect((await saved(page)).nodes["branch-1"].text).toBe("组合输入中的草稿")
})

for (const viewportWidth of [1180, 680]) {
  test(`内容区 ${viewportWidth === 1180 ? 684 : 680} 像素：连续新建与文字扩宽后所选主题避开检查器`, async ({ page }) => {
    await page.setViewportSize({ width: viewportWidth, height: 760 })
    await page.goto("/mind-map-document-test.html?mock=1")
    await page.getByRole("button", { name: "显示检查器", exact: true }).click()
    if (viewportWidth === 1180) await page.addStyleTag({ content: 'body > #root > main { margin-left: 496px; width: calc(100% - 496px); }' })
    await page.getByRole("tab", { name: "主题导航", exact: true }).click()
    await page.getByLabel("导图主题导航").getByRole("button", { name: "主题甲", exact: true }).click()
    for (const label of ["独立导图验收", "连续新建后扩展宽度仍然可见的主题文字"]) {
      await page.keyboard.press("Enter")
      const inline = page.getByRole("textbox", { name: "导图节点", exact: true })
      await expect(inline).toBeFocused()
      await inline.fill(label)
      const panel = await page.getByRole("complementary", { name: "思维导图检查器" }).boundingBox()
      const bounds = await inline.boundingBox()
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(panel!.x + 1)
      expect(bounds!.x).toBeGreaterThanOrEqual(viewportWidth === 1180 ? 496 : 0)
      await inline.press("Escape")
      const node = await topic(page, label).boundingBox()
      expect(node!.x + node!.width).toBeLessThanOrEqual(panel!.x + 3)
    }
  })
}
