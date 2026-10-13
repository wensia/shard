import { expect, test, type Locator, type Page } from "@playwright/test"

import { installContentTypesMock } from "./content-types-mock"

const navigation = (page: Page) => page.getByRole("navigation", { name: "工作台导航" })
const primary = (page: Page, name: string) =>
  navigation(page).getByRole("button", { name, exact: true })
const secondary = (page: Page, name: string) =>
  navigation(page).getByRole("button", { name: new RegExp(`^${name} \\d+$`, "u") })

async function box(locator: Locator) {
  const value = await locator.boundingBox()
  expect(value).not.toBeNull()
  return value!
}

async function cssColor(page: Page, token: string) {
  return page.evaluate((value) => {
    const probe = document.createElement("div")
    probe.style.backgroundColor = `var(${value})`
    document.body.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  }, token)
}

test.beforeEach(async ({ page }) => {
  await installContentTypesMock(page)
  await page.goto("/")
  await expect(navigation(page)).toBeVisible()
})

test("标题、搜索、导航与概览按 token 排列", async ({ page }) => {
  const title = await box(page.locator("[data-sidebar-titlebar]"))
  const search = await box(page.getByRole("button", { name: "搜索内容" }))
  const fragments = await box(primary(page, "碎片"))
  const calendar = await box(primary(page, "日历"))
  const library = await box(primary(page, "资料库"))
  const stats = await box(page.locator('[aria-label="碎片统计"]'))
  const heatmap = await box(page.getByRole("img", { name: "碎片热力图" }))
  const space3 = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-3")))

  expect(search.y - (title.y + title.height)).toBeCloseTo(space3, 1)
  expect(search.x).toBeCloseTo(fragments.x, 1)
  expect(search.x + search.width).toBeCloseTo(fragments.x + fragments.width, 1)
  expect(fragments.y - (search.y + search.height)).toBeCloseTo(space3, 1)
  const space6 = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-6")))
  expect(stats.y - (library.y + library.height)).toBeCloseTo(space6, 1)
  const searchIcon = await box(page.getByRole("button", { name: "搜索内容" }).locator("svg"))
  const navIcon = await box(primary(page, "碎片").locator("svg"))
  expect(searchIcon.x).toBeCloseTo(navIcon.x, 1)
  expect(calendar.y).toBeGreaterThan(fragments.y)
  expect(stats.y).toBeGreaterThan(calendar.y)
  expect(heatmap.y).toBeGreaterThan(stats.y)
})

test("三个视图的一级行位置稳定，只有当前叶子被标记", async ({ page }) => {
  const firstY = await Promise.all(["碎片", "日历", "资料库"].map(async name =>
    (await box(primary(page, name))).y))
  const cases = [
    { click: () => secondary(page, "全部碎片"), leaf: "全部碎片" },
    { click: () => primary(page, "日历"), leaf: "日历" },
    { click: () => primary(page, "资料库"), leaf: "资料库" },
  ]

  for (const item of cases) {
    await item.click().click()
    const current = navigation(page).locator('[aria-current="page"]')
    await expect(current).toHaveCount(1)
    await expect(current).toContainText(item.leaf)
    await expect(primary(page, "碎片")).not.toHaveAttribute("aria-current", "page")
    await expect(secondary(page, "全部碎片")).toBeVisible()
    await expect(secondary(page, "回收站")).toHaveCount(0)
    const positions = await Promise.all(["碎片", "日历", "资料库"].map(async name =>
      (await box(primary(page, name))).y))
    positions.forEach((y, index) => expect(y).toBeCloseTo(firstY[index], 1))
  }

  const ancestor = primary(page, "碎片")
  await secondary(page, "全部碎片").click()
  expect(await ancestor.evaluate(element => getComputedStyle(element).backgroundColor))
    .not.toBe(await cssColor(page, "--primary-subtle"))
})

test("搜索 hover 边框、导航选中与计数均不改变盒子尺寸", async ({ page }) => {
  const search = page.getByRole("button", { name: "搜索内容" })
  const leaf = secondary(page, "全部碎片")
  const beforeSearch = await box(search)
  const beforeLeaf = await box(leaf)
  await search.hover()
  const visibleBorder = await cssColor(page, "--border-visible")
  // 边框颜色有 150ms 过渡，等过渡结束再比较，否则读到的是插值中间色
  await expect.poll(() => search.evaluate(element => getComputedStyle(element).borderColor)).toBe(visibleBorder)
  expect(visibleBorder).not.toContain(", 0)")
  expect(await box(search)).toEqual(beforeSearch)
  await leaf.hover()
  expect(await box(leaf)).toEqual(beforeLeaf)

  const count = leaf.locator("span").last()
  expect(await count.evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
  await expect(count).toHaveText(/\d+/u)
  await expect(secondary(page, "回收站")).toHaveCount(0)
})

test("快捷键提示可见但不进入一级按钮的可访问名称", async ({ page }) => {
  for (const [name, key] of [["碎片", "1"], ["日历", "2"], ["资料库", "3"]]) {
    const button = primary(page, name)
    await expect(button).toHaveAttribute("aria-keyshortcuts", `Meta+${key}`)
    await expect(button.getByText(`⌘${key}`, { exact: true })).toBeVisible()
    await expect(button.getByText(`⌘${key}`, { exact: true })).toHaveAttribute("aria-hidden", "true")
    await expect(navigation(page).getByRole("button", { name: `${name}⌘${key}`, exact: true })).toHaveCount(0)
  }
})

test("四种强调色在明暗模式都使用浅底与可读文字", async ({ page }) => {
  const luminance = async (color: string) => {
    const channels = await page.evaluate(value => {
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 1
      const context = canvas.getContext("2d")!
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3)
    }, color)
    const [r, g, b] = channels.map(channel => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  for (const mode of ["light", "dark"]) {
    for (const theme of ["clay", "teal", "peacock", "amber"]) {
      await page.evaluate(({ mode, theme }) => {
        localStorage.setItem("shard.colorMode", mode)
        localStorage.setItem("shard.accentTheme", theme)
      }, { mode, theme })
      await page.reload()
      const leaf = secondary(page, "全部碎片")
      const [foreground, background] = await leaf.evaluate(element => {
        const style = getComputedStyle(element)
        return [style.color, style.backgroundColor]
      })
      const primaryText = await cssColor(page, "--primary-text")
      const primarySubtle = await cssColor(page, "--primary-subtle")
      expect(foreground, `${mode}/${theme} text`).toBe(primaryText)
      expect(background, `${mode}/${theme} background`).toBe(primarySubtle)
      const values = [await luminance(foreground), await luminance(background)]
        .sort((a, b) => b - a)
      expect((values[0] + 0.05) / (values[1] + 0.05), `${mode}/${theme} contrast`)
        .toBeGreaterThanOrEqual(4.5)
    }
  }
})

test("短窗口中导航完整可见，概览在侧栏内可滚动到", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 480 })
  const nav = navigation(page)
  for (const name of ["碎片", "全部碎片", "日历", "资料库"]) {
    const button = name === "全部碎片"
      ? secondary(page, name) : primary(page, name)
    await expect(button).toBeInViewport()
  }
  const heatmap = page.getByRole("img", { name: "碎片热力图" })
  await expect(nav).toHaveCSS("overscroll-behavior-y", "none")
  const overflow = await nav.evaluate(element => element.scrollHeight > element.clientHeight)
  // 热力图是否一开始就在侧栏滚动区的可视范围内（Locator 没有 isInViewport，自己比矩形）
  const heatmapInitiallyVisible = await heatmap.evaluate((element) => {
    const scroller = element.closest("nav")!.getBoundingClientRect()
    const rect = element.getBoundingClientRect()
    return rect.top >= scroller.top && rect.bottom <= scroller.bottom
  })
  await heatmap.scrollIntoViewIfNeeded()
  await expect(heatmap).toBeInViewport()
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(0)
  expect(await page.evaluate(() => document.scrollingElement?.scrollHeight <= innerHeight)).toBe(true)
  if (overflow && !heatmapInitiallyVisible) {
    expect(await nav.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  }
})
