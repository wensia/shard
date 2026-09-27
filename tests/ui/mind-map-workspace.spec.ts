import { writeFileSync } from "node:fs"
import { chromium, expect, test, webkit, type Locator, type Page } from "@playwright/test"
import type { MindMapReadResult } from "../../src/types"

type Harness = Window & {
  __mindMapDocumentMock: { disk: MindMapReadResult; writes: number }
  __mindMapDocumentHarness: { save(): Promise<boolean>; reopen(): Promise<void>; dirty(): boolean }
}

const canvas = (page: Page) => page.getByRole("application", { name: "思维导图编辑器", exact: true })
const outline = (page: Page) => page.locator("[data-mind-map-outline]:visible")
const branch = (page: Page, id = "branch-1") => outline(page).locator(`[data-outline-node="${id}"] textarea`)
const mapTab = (page: Page) => page.getByRole("tab", { name: "思维导图", exact: true })
const outlineTab = (page: Page) => page.getByRole("tab", { name: "大纲", exact: true })
const inspector = (page: Page) => page.getByRole("complementary", { name: "思维导图检查器", exact: true })
const help = (page: Page) => page.getByRole("complementary", { name: "思维导图快捷键", exact: true })
const topic = (page: Page, id = "branch-1") => page.locator(`[data-mind-map-node="${id}"]:visible`)

async function openWorkspace(page: Page) {
  await page.goto("/mind-map-document-test.html?mock=1")
  await expect(canvas(page)).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}

async function save(page: Page) {
  expect(await page.evaluate(() => (window as Harness).__mindMapDocumentHarness.save())).toBe(true)
  return page.evaluate(() => structuredClone((window as Harness).__mindMapDocumentMock.disk.file))
}

async function storageState(page: Page) {
  return page.evaluate(() => {
    const w = window as Harness
    return { dirty: w.__mindMapDocumentHarness.dirty(), writes: w.__mindMapDocumentMock.writes,
      file: structuredClone(w.__mindMapDocumentMock.disk.file) }
  })
}

async function caret(input: Locator) {
  return input.evaluate(element => {
    const input = element as HTMLTextAreaElement
    return { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection }
  })
}

async function setCaret(input: Locator, start: number, end = start) {
  await input.focus()
  await input.evaluate((element, range) => {
    const input = element as HTMLTextAreaElement
    input.setSelectionRange(range.start, range.end)
    input.dispatchEvent(new Event("select", { bubbles: true }))
  }, { start, end })
}

async function seedLongOutline(page: Page) {
  // Seed only the isolated storage double, then open through the real workspace reader.
  await page.evaluate(async () => {
    const w = window as Harness
    const file = w.__mindMapDocumentMock.disk.file
    for (let index = 4; index <= 46; index++) {
      const id = `branch-${index}`
      file.nodes[id] = { ...file.nodes["branch-1"], id, text: `长大纲主题 ${String(index).padStart(2, "0")} 保留编辑光标`,
        sortKey: String(index).padStart(3, "0") }
    }
    for (let index = 1; index <= 3; index++) file.nodes[`branch-${index}`].sortKey = String(index).padStart(3, "0")
    await w.__mindMapDocumentHarness.reopen()
  })
  await expect(canvas(page).locator("[data-mind-map-node]")).toHaveCount(47)
  await outlineTab(page).click()
  await expect(outline(page).locator("textarea")).toHaveCount(47)
}

async function zoomAndPan(page: Page) {
  const svg = canvas(page)
  const bounds = (await svg.boundingBox())!
  const initial = await svg.getAttribute("viewBox")
  await svg.dispatchEvent("wheel", { deltaY: -120, ctrlKey: true, clientX: bounds.x + bounds.width / 2,
    clientY: bounds.y + bounds.height / 2, bubbles: true })
  await expect(svg).not.toHaveAttribute("viewBox", initial!)
  const zoomed = await svg.getAttribute("viewBox")
  await svg.dispatchEvent("wheel", { deltaX: 35, deltaY: 22, clientX: bounds.x + bounds.width / 2,
    clientY: bounds.y + bounds.height / 2, bubbles: true })
  await expect(svg).not.toHaveAttribute("viewBox", zoomed!)
  return svg.getAttribute("viewBox")
}

for (const browserName of ["webkit", "chromium"] as const) {
  const engineTest = test.extend({
    page: async ({ baseURL }, use) => {
      const browser = await ({ webkit, chromium })[browserName].launch()
      try {
        await use(await browser.newPage({ baseURL: baseURL!, viewport: { width: 1280, height: 760 } }))
      } finally { await browser.close() }
    },
  })

  engineTest.describe(`${browserName} 思维导图工作区`, () => {
    engineTest("顶部文字视图明确当前态，切换保留缩放、平移及选中主题而不写盘", async ({ page }) => {
      await openWorkspace(page)
      await expect(page.getByRole("tablist", { name: "思维导图视图", exact: true })).toBeVisible()
      await expect(mapTab(page)).toHaveAttribute("aria-selected", "true")
      await expect(inspector(page)).toHaveCount(0)
      await expect(page.getByRole("button", { name: "显示检查器", exact: true })).toHaveText("主题属性")
      const before = await storageState(page)
      await topic(page).click()
      const viewBox = await zoomAndPan(page)
      const nodeBefore = await topic(page).boundingBox()
      await outlineTab(page).click()
      await expect(outlineTab(page)).toHaveAttribute("aria-selected", "true")
      await expect(branch(page)).toHaveValue("主题甲")
      await mapTab(page).click()
      await expect(topic(page)).toHaveAttribute("aria-pressed", "true")
      await expect(canvas(page)).toHaveAttribute("viewBox", viewBox!)
      const nodeAfter = await topic(page).boundingBox()
      expect(nodeAfter!.x).toBeCloseTo(nodeBefore!.x, 1)
      expect(nodeAfter!.y).toBeCloseTo(nodeBefore!.y, 1)
      expect(nodeAfter!.width).toBeCloseTo(nodeBefore!.width, 1)
      await page.getByRole("button", { name: "快捷键", exact: true }).click()
      await expect.poll(async () => (await topic(page).boundingBox())!.width).toBeCloseTo(nodeAfter!.width, 1)
      await page.getByRole("button", { name: "关闭快捷键", exact: true }).click()
      await expect.poll(async () => (await topic(page).boundingBox())!.width).toBeCloseTo(nodeAfter!.width, 1)
      await save(page)
      expect(await storageState(page)).toEqual(before)
    })

    engineTest("长大纲切换往返保留局部滚动、文字光标和同一主题", async ({ page }) => {
      await openWorkspace(page)
      await seedLongOutline(page)
      const input = branch(page, "branch-29")
      await input.click()
      await setCaret(input, 5, 9)
      const originalCaret = await caret(input)
      const scrollBefore = await outline(page).evaluate(element => element.scrollTop)
      expect(scrollBefore).toBeGreaterThan(500)
      const before = await storageState(page)
      await mapTab(page).click()
      await expect(topic(page, "branch-29")).toHaveAttribute("aria-pressed", "true")
      await outlineTab(page).click()
      await expect(outlineTab(page)).toBeFocused()
      await input.focus()
      expect(await caret(input)).toEqual(originalCaret)
      expect(await outline(page).evaluate(element => element.scrollTop)).toBeCloseTo(scrollBefore, 0)
      expect(await page.evaluate(() => ({ window: scrollY, document: document.documentElement.scrollTop }))).toEqual({ window: 0, document: 0 })
      expect(await storageState(page)).toEqual(before)
      await page.keyboard.insertText("选区替换")
      await expect(input).toHaveValue("长大纲主题选区替换保留编辑光标")
      const file = await save(page)
      expect(file.nodes["branch-29"].text).toBe("长大纲主题选区替换保留编辑光标")
      expect(Object.keys(file.nodes)).toHaveLength(47)
    })

    engineTest("属性与快捷键互斥，关闭和 Escape 恢复原编辑光标", async ({ page }) => {
      await openWorkspace(page)
      await outlineTab(page).click()
      const input = branch(page)
      await setCaret(input, 1, 2)
      const before = await storageState(page)
      await page.getByRole("button", { name: "快捷键", exact: true }).click()
      await expect(help(page)).toBeVisible()
      await expect(inspector(page)).toHaveCount(0)
      await page.getByRole("button", { name: "显示检查器", exact: true }).click()
      await expect(inspector(page)).toBeVisible()
      await expect(help(page)).toHaveCount(0)
      await expect(page.getByRole("tab", { name: "主题导航", exact: true })).toBeVisible()
      await page.getByRole("button", { name: "关闭检查器", exact: true }).click()
      await expect(input).toBeFocused()
      expect(await caret(input)).toMatchObject({ start: 1, end: 2 })
      await page.getByRole("button", { name: "快捷键", exact: true }).click()
      await page.getByRole("button", { name: "关闭快捷键", exact: true }).focus()
      await page.keyboard.press("Escape")
      await expect(help(page)).toHaveCount(0)
      await expect(input).toBeFocused()
      expect(await caret(input)).toMatchObject({ start: 1, end: 2 })
      expect(await storageState(page)).toEqual(before)
      await page.keyboard.insertText("正文")
      await expect(input).toHaveValue("主正文甲")
    })

    engineTest("帮助打开时导图内联 Escape 只结束文字编辑，帮助仍保留", async ({ page }) => {
      await openWorkspace(page)
      await topic(page).click()
      await page.getByRole("button", { name: "快捷键", exact: true }).click()
      await expect(help(page)).toBeVisible()
      const before = await storageState(page)
      await topic(page).dblclick()
      const input = page.getByRole("textbox", { name: "导图节点", exact: true })
      await expect(input).toBeFocused()
      await expect(input).toHaveValue("主题甲")
      await input.press("Escape")
      await expect(input).toHaveCount(0)
      await expect(topic(page)).toHaveAttribute("aria-pressed", "true")
      await expect(help(page)).toBeVisible()
      expect(await storageState(page)).toEqual(before)
    })

    engineTest("工具栏和右栏 Tab 按焦点导航，不误触新建主题或文字修改", async ({ page }) => {
      await openWorkspace(page)
      await topic(page).click()
      const before = await storageState(page)
      await mapTab(page).focus()
      await page.keyboard.press("ArrowLeft")
      await expect(outlineTab(page)).toBeFocused()
      await expect(outlineTab(page)).toHaveAttribute("aria-selected", "true")
      await page.keyboard.press("ArrowRight")
      await expect(mapTab(page)).toBeFocused()
      await expect(mapTab(page)).toHaveAttribute("aria-selected", "true")
      await page.getByRole("button", { name: "显示检查器", exact: true }).focus()
      await page.keyboard.press("Tab")
      await expect(page.getByRole("button", { name: "快捷键", exact: true })).toBeFocused()
      await page.keyboard.press("Enter")
      await expect(help(page)).toBeVisible()
      await page.getByRole("button", { name: "关闭快捷键", exact: true }).focus()
      await page.keyboard.press("Tab")
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).not.toBe("导图节点")
      await page.getByRole("button", { name: "显示检查器", exact: true }).click()
      const property = page.getByRole("textbox", { name: "主题文字", exact: true })
      await property.focus()
      await page.keyboard.press("Tab")
      await expect(property).not.toBeFocused()
      expect(await inspector(page).evaluate(element => element.contains(document.activeElement))).toBe(true)
      await page.keyboard.press("Shift+Tab")
      await expect(property).toBeFocused()
      await save(page)
      expect(await storageState(page)).toEqual(before)
      await expect(canvas(page).locator("[data-mind-map-node]")).toHaveCount(4)
    })

    engineTest("视图与面板操作不清空内容撤销栈，撤销回原文不产生额外写入", async ({ page }) => {
      await openWorkspace(page)
      await outlineTab(page).click()
      const input = branch(page)
      await input.fill("本轮新正文")
      await save(page)
      const writes = (await storageState(page)).writes
      await mapTab(page).click()
      await page.getByRole("button", { name: "快捷键", exact: true }).click()
      await page.getByRole("button", { name: "关闭快捷键", exact: true }).click()
      await outlineTab(page).click()
      expect((await storageState(page)).writes).toBe(writes)
      await input.focus()
      await page.keyboard.press("ControlOrMeta+z")
      await expect(input).toHaveValue("主题甲")
      expect((await storageState(page)).dirty).toBe(true)
      await page.keyboard.press("ControlOrMeta+Shift+z")
      await expect(input).toHaveValue("本轮新正文")
      expect((await storageState(page)).dirty).toBe(false)
      await save(page)
      expect((await storageState(page)).writes).toBe(writes)
    })

    engineTest("组合输入期间视图和面板保持禁用，确认后全文与光标仍可恢复", async ({ page }) => {
      await openWorkspace(page)
      await outlineTab(page).click()
      const input = branch(page)
      await input.fill("组合输入中的完整正文")
      // Synthetic composition boundaries are a handler regression, not a physical IME acceptance.
      await input.dispatchEvent("compositionstart", { data: "拼" })
      await expect(mapTab(page)).toBeDisabled()
      await expect(outlineTab(page)).toBeDisabled()
      await expect(page.getByRole("button", { name: "显示检查器", exact: true })).toBeDisabled()
      await expect(page.getByRole("button", { name: "快捷键", exact: true })).toBeDisabled()
      await expect(page.getByRole("button", { name: "保存思维导图", exact: true })).toBeDisabled()
      expect(await page.evaluate(() => (window as Harness).__mindMapDocumentHarness.save())).toBe(false)
      await expect(input).toBeFocused()
      await input.dispatchEvent("compositionend", { data: "拼音" })
      await expect(mapTab(page)).toBeEnabled()
      await setCaret(input, 4)
      await page.getByRole("button", { name: "快捷键", exact: true }).click()
      await page.getByRole("button", { name: "关闭快捷键", exact: true }).click()
      await expect(input).toBeFocused()
      expect(await caret(input)).toMatchObject({ start: 4, end: 4 })
      const file = await save(page)
      expect(file.nodes["branch-1"].text).toBe("组合输入中的完整正文")
      expect(Object.keys(file.nodes)).toHaveLength(4)
    })

    for (const width of [1280, 640]) {
      engineTest(`${width}px 窗口面板与正文不重叠，长大纲只滚动自身`, async ({ page }) => {
        await page.setViewportSize({ width, height: 700 })
        await openWorkspace(page)
        await seedLongOutline(page)
        await branch(page, "branch-23").click()
        await page.getByRole("button", { name: "快捷键", exact: true }).click()
        const geometry = await page.evaluate(() => {
          const viewport = document.querySelector<HTMLElement>("[data-mind-map-outline]")!
          const panel = document.querySelector<HTMLElement>('[aria-label="思维导图快捷键"]')!
          const tabs = document.querySelector<HTMLElement>('[aria-label="思维导图视图"]')!
          const input = viewport.querySelector<HTMLTextAreaElement>('[data-outline-node="branch-23"] textarea')!
          const rect = (element: HTMLElement) => {
            const r = element.getBoundingClientRect()
            return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
          }
          return { viewport: rect(viewport), panel: rect(panel), tabs: rect(tabs), input: rect(input),
            pageOverflow: document.documentElement.scrollWidth - innerWidth,
            windowScroll: scrollY, documentScroll: document.documentElement.scrollTop,
            panelOverflowY: getComputedStyle(panel).overflowY, fontFamily: getComputedStyle(input).fontFamily,
            inputFontSize: getComputedStyle(input).fontSize, panelFontSize: getComputedStyle(panel).fontSize }
        })
        expect(geometry.pageOverflow).toBeLessThanOrEqual(1)
        expect(geometry.viewport.right).toBeLessThanOrEqual(geometry.panel.x + 1)
        expect(geometry.input.width).toBeGreaterThan(180)
        expect(geometry.input.right).toBeLessThanOrEqual(geometry.panel.x + 1)
        expect(geometry.panel.right).toBeLessThanOrEqual(width + 1)
        expect(geometry.input.bottom).toBeLessThanOrEqual(geometry.viewport.bottom + 1)
        expect(geometry.windowScroll).toBe(0)
        expect(geometry.documentScroll).toBe(0)
        expect(geometry.fontFamily).toContain("Noto Sans SC")
        const toolbarY = geometry.tabs.y
        const viewportBounds = (await outline(page).boundingBox())!
        await page.mouse.move(viewportBounds.x + viewportBounds.width / 2, viewportBounds.y + viewportBounds.height / 2)
        await page.mouse.wheel(0, 400)
        await expect.poll(() => outline(page).evaluate(element => element.scrollTop)).toBeGreaterThan(0)
        expect((await page.getByRole("tablist", { name: "思维导图视图", exact: true }).boundingBox())!.y).toBe(toolbarY)
        expect(await page.evaluate(() => scrollY)).toBe(0)
        writeFileSync(`tests/evidence/mind-map-workspace-${browserName}-${width}.json`, JSON.stringify(geometry, null, 2) + "\n")
        await page.screenshot({ path: `tests/evidence/mind-map-workspace-${browserName}-${width}.png` })
        const outlineScroll = await outline(page).evaluate(element => element.scrollTop)
        await page.mouse.move(geometry.panel.x + geometry.panel.width / 2, geometry.panel.y + geometry.panel.height / 2)
        await page.mouse.wheel(0, 5000)
        const common = help(page).getByRole("heading", { name: "通用", exact: true })
        await expect.poll(async () => (await common.boundingBox())!.y).toBeLessThan(geometry.panel.bottom - 30)
        expect((await common.boundingBox())!.y).toBeGreaterThan(geometry.panel.y)
        expect(await outline(page).evaluate(element => element.scrollTop)).toBeCloseTo(outlineScroll, 0)
        expect(await page.evaluate(() => scrollY)).toBe(0)
        await expect(page.getByRole("button", { name: "关闭快捷键", exact: true })).toBeInViewport()
      })
    }
  })
}
