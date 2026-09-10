import { resolve } from "node:path"
import { chromium, expect, test, webkit, type Page } from "@playwright/test"

const longTopic = "这是用于检查自动换行后整个文字组仍然垂直居中的长主题名称"
const editor = (page: Page) => page.getByRole("textbox", { name: "主题文字", exact: true })

// Inspect the real screenshot ink, not SVG getBBox or the implementation's baseline formula.
async function assertCentered(page: Page, selector = "[data-mind-map-node]") {
  const geometry = await page.locator(selector).evaluateAll(elements => elements.map(element => {
    const rect = element.querySelector("rect[class]")!.getBoundingClientRect()
    return { label: element.getAttribute("aria-label"), x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }))
  // Whole-page capture avoids fractional clip rounding shifting the crop origin.
  const screenshot = (await page.screenshot({ animations: "disabled" })).toString("base64")
  const results = await page.evaluate(async ({ geometry, screenshot }) => {
    const image = new Image()
    image.src = `data:image/png;base64,${screenshot}`
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext("2d")!
    context.drawImage(image, 0, 0)
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    const dpr = devicePixelRatio
    return geometry.map(rect => {
      let top = Infinity, bottom = -Infinity
      for (let y = Math.ceil(rect.y * dpr) + 4; y < Math.floor((rect.y + rect.height) * dpr) - 4; y++) {
        for (let x = Math.ceil(rect.x * dpr) + 4; x < Math.floor((rect.x + rect.width) * dpr) - 4; x++) {
          const index = (y * canvas.width + x) * 4
          if (data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722 < 145) {
            top = Math.min(top, y); bottom = Math.max(bottom, y)
          }
        }
      }
      return { label: rect.label, visible: Number.isFinite(top),
        withinViewport: rect.y > 0 && (rect.y + rect.height) * dpr < canvas.height,
        offset: (top + bottom + 1) / (2 * dpr) - (rect.y + rect.height / 2) }
    })
  }, { geometry, screenshot })
  for (const result of results) {
    expect(result.withinViewport, `${result.label}: whole node visible`).toBe(true)
    expect(result.visible, `${result.label}: visible text ink`).toBe(true)
    expect(Math.abs(result.offset), `${result.label}: raster ink center`).toBeLessThanOrEqual(1)
  }
}

async function prepare(page: Page) {
  for (const [name, text] of [["主题甲", "Alpha gyp"], ["主题乙", "中文 Alpha"], ["主题丙", longTopic]]) {
    await page.getByRole("button", { name: `导图节点：${name}`, exact: true }).click()
    await editor(page).fill(text)
  }
  await page.getByRole("button", { name: "关闭检查器", exact: true }).click()
  await page.getByRole("button", { name: "适应屏幕", exact: true }).click()
  await expect.poll(() => page.getByRole("button", { name: `导图节点：${longTopic}`, exact: true }).locator("tspan").count()).toBeGreaterThan(1)
}

for (const browserName of ["webkit", "chromium"] as const) {
  const engineTest = test.extend({
    page: async ({}, use) => {
      const browser = await ({ webkit, chromium })[browserName].launch()
      try {
        const page = await browser.newPage({ baseURL: "http://127.0.0.1:1420", viewport: { width: 1800, height: 1600 }, deviceScaleFactor: 2 })
        await use(page)
      } finally { await browser.close() }
    },
  })
  engineTest.describe(`${browserName} 独立导图文字居中`, () => {
    engineTest("中文、中英混合及自动换行在缩放后墨盒保持居中", async ({ page }) => {
      await page.goto("/mind-map-document-test.html?mock=1")
      await page.getByRole("button", { name: "显示检查器", exact: true }).click()
      await prepare(page)
      await page.evaluate(() => document.fonts.ready)
      await assertCentered(page)
      const viewport = page.getByLabel("思维导图编辑器", { exact: true })
      await viewport.dispatchEvent("wheel", { deltaY: 250, ctrlKey: true, clientX: 900, clientY: 800, bubbles: true })
      await assertCentered(page)
      await viewport.dispatchEvent("wheel", { deltaY: -500, ctrlKey: true, clientX: 900, clientY: 800, bubbles: true })
      await assertCentered(page)
    })

    engineTest("延迟字体加载在字体族字符串不变时重新定位文字", async ({ page }) => {
      let release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      await page.route("**/canvas-center-font.woff2", async route => {
        await held
        await route.fulfill({ path: resolve("node_modules/@fontsource/noto-sans-sc/files/noto-sans-sc-latin-400-normal.woff2"), contentType: "font/woff2" })
      })
      await page.goto("/mind-map-document-test.html?mock=1")
      await page.getByRole("button", { name: "显示检查器", exact: true }).click()
      await page.getByRole("button", { name: "导图节点：主题甲", exact: true }).click()
      await editor(page).fill("Alpha gyp")
      await page.addStyleTag({ content: '@font-face { font-family: "CanvasCenterLate"; src: url("/canvas-center-font.woff2"); font-display: swap; } [aria-label="思维导图画布"] { font-family: "CanvasCenterLate", serif; }' })
      await page.getByRole("button", { name: "重新打开", exact: true }).click()
      const root = page.getByRole("button", { name: "导图节点：Alpha gyp", exact: true })
      const before = await root.locator("tspan").evaluate(element => ({ y: element.getAttribute("y"), family: getComputedStyle(element).fontFamily }))
      release()
      await page.evaluate(() => document.fonts.ready)
      await expect.poll(() => root.locator("tspan").getAttribute("y")).not.toBe(before.y)
      expect(await root.locator("tspan").evaluate(element => getComputedStyle(element).fontFamily)).toBe(before.family)
      await assertCentered(page, '[data-mind-map-node="branch-1"]')
    })
  })
}
