import { expect, test, type Page } from "@playwright/test"

import { installContentTypesMock } from "./content-types-mock"
import { fillEditor, readEditor } from "./editor-helpers"

// managed-navigation 合同（src/lib/focus-navigation.ts）：Tab 归编辑器，
// F6 / Shift+F6 在工作区域间循环，<html data-focus-mode> 决定焦点装饰。

async function boot(page: Page) {
  await installContentTypesMock(page)
  await page.goto("/")
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeVisible()
}

function focusMode(page: Page) {
  return page.evaluate(() => document.documentElement.dataset.focusMode)
}

function activeRegion(page: Page) {
  return page.evaluate(() =>
    document.activeElement?.closest<HTMLElement>("[data-focus-region]")?.dataset.focusRegion ?? null)
}

/** 当前可作为 F6 停靠点的外壳区域，按 DOM 顺序。 */
function visibleRegions(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-focus-region]"))
      .filter(region => region.getClientRects().length > 0 && region.querySelector("button, a[href], [contenteditable='true'], input, textarea, [tabindex='0']"))
      .map(region => region.dataset.focusRegion))
}

function activeFocusStyle(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement
    const style = getComputedStyle(element)
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      ring: getComputedStyle(document.documentElement).getPropertyValue("--ring").trim(),
    }
  })
}

test.beforeEach(async ({ page }) => {
  await boot(page)
})

test("默认 pointer 模式；F6 在区域间循环，Shift+F6 反向", async ({ page }) => {
  expect(await focusMode(page)).toBe("pointer")
  const regions = await visibleRegions(page)
  expect(regions).toEqual(["sidebar", "content", "status-bar"])

  // 启动后速记框自动聚焦，起点在正文区域。
  expect(await activeRegion(page)).toBe("content")
  await page.keyboard.press("F6")
  expect(await activeRegion(page)).toBe("status-bar")
  expect(await focusMode(page)).toBe("keyboard")
  await page.keyboard.press("F6")
  expect(await activeRegion(page)).toBe("sidebar")
  await page.keyboard.press("F6")
  expect(await activeRegion(page)).toBe("content")

  await page.keyboard.press("Shift+F6")
  expect(await activeRegion(page)).toBe("sidebar")
  await page.keyboard.press("Shift+F6")
  expect(await activeRegion(page)).toBe("status-bar")
  await page.keyboard.press("Shift+F6")
  expect(await activeRegion(page)).toBe("content")
})

test("进入区域时恢复该区域上次的焦点，正文编辑器保留选区", async ({ page }) => {
  const composer = page.locator('[data-shard-editor="composer"] .ProseMirror')
  await composer.click()
  await page.keyboard.insertText("区域焦点恢复")
  await page.keyboard.press("ArrowLeft")
  await page.keyboard.press("ArrowLeft")
  const caret = () => page.evaluate(() => {
    const selection = window.getSelection()
    return selection ? `${selection.anchorNode?.textContent}:${selection.anchorOffset}` : ""
  })
  const before = await caret()

  await page.keyboard.press("F6")
  expect(await activeRegion(page)).toBe("status-bar")
  await page.keyboard.press("Shift+F6")
  await expect(composer).toBeFocused()
  expect(await caret()).toBe(before)
})

test("正文编辑器里的 Tab 仍由编辑器处理，焦点不逃出编辑器", async ({ page }) => {
  await fillEditor(page, "composer", "- 甲\n- 乙")
  const composer = page.locator('[data-shard-editor="composer"] .ProseMirror')
  await composer.getByText("乙", { exact: true }).click()
  await page.keyboard.press("End")

  await page.keyboard.press("Tab")
  await expect.poll(() => readEditor(page, "composer")).toBe("- 甲\n  - 乙")
  await expect(composer).toBeFocused()

  await page.keyboard.press("Shift+Tab")
  await expect.poll(() => readEditor(page, "composer")).toBe("- 甲\n- 乙")
  await expect(composer).toBeFocused()

  // 列表以外编辑器不处理 Tab：边界兜底，焦点仍留在编辑器，也不切到 keyboard 模式。
  await fillEditor(page, "composer", "普通段落")
  await composer.click()
  await page.keyboard.press("Tab")
  await page.keyboard.press("Shift+Tab")
  await expect(composer).toBeFocused()
  expect(await focusMode(page)).toBe("pointer")
})

test("外壳控件间恢复原生 Tab 轮转，并切到 keyboard 模式", async ({ page }) => {
  const first = page.locator('[data-focus-region="sidebar"] button:visible').first()
  await first.focus()
  expect(await focusMode(page)).toBe("pointer")
  await page.keyboard.press("Tab")
  expect(await focusMode(page)).toBe("keyboard")
  await expect(first).not.toBeFocused()
  expect(await activeRegion(page)).toBe("sidebar")
  await page.keyboard.press("Shift+Tab")
  await expect(first).toBeFocused()
})

test("鼠标点击后没有焦点环；F6 之后当前控件有可见 outline", async ({ page }) => {
  const settings = page.locator("[data-shard-utility-menu-trigger]:visible")
  await settings.click()
  await page.keyboard.press("Escape")
  await settings.focus()
  expect(await focusMode(page)).toBe("pointer")
  let style = await activeFocusStyle(page)
  expect(style.outlineStyle).toBe("none")
  expect(style.ring).toBe("transparent")

  await page.keyboard.press("F6")
  expect(await focusMode(page)).toBe("keyboard")
  style = await activeFocusStyle(page)
  expect(style.outlineStyle).toBe("solid")
  expect(style.outlineWidth).toBe("2px")
  expect(style.ring).not.toBe("transparent")

  // 正文编辑器在键盘模式下也不画整块焦点框。
  while (await activeRegion(page) !== "content") await page.keyboard.press("F6")
  await page.locator('[data-shard-editor="composer"] .ProseMirror').focus()
  expect((await activeFocusStyle(page)).outlineStyle).toBe("none")

  await page.mouse.click(640, 400)
  expect(await focusMode(page)).toBe("pointer")
})

test("打开设置对话框后，F6 只在对话框内循环", async ({ page }) => {
  await page.locator("[data-shard-utility-menu-trigger]:visible").click()
  await page.getByRole("menuitem", { name: "设置", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()

  const seen = new Set<string>()
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("F6")
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
    seen.add(await page.evaluate(() => document.activeElement?.outerHTML ?? ""))
  }
  expect(seen.size).toBeGreaterThan(1)
  await page.keyboard.press("Shift+F6")
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
  expect(await focusMode(page)).toBe("keyboard")
})

test("输入法组合期间 F6 不切换区域", async ({ page }) => {
  const composer = page.locator('[data-shard-editor="composer"] .ProseMirror')
  await composer.click()
  await composer.dispatchEvent("keydown", { key: "F6", isComposing: true, bubbles: true })
  await expect(composer).toBeFocused()
  expect(await focusMode(page)).toBe("pointer")
})

test("资料库的目录栏与查看器是独立的 F6 停靠区域", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await expect(page.getByRole("complementary", { name: "资料库目录" })).toBeVisible()

  const visited: string[] = []
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press("F6")
    visited.push((await activeRegion(page)) ?? "")
  }
  expect(visited.slice(0, 4).sort()).toEqual(["library-tree", "library-viewer", "sidebar", "status-bar"])
  // 四个停靠点循环：第五次回到第一次的位置。
  expect(visited[4]).toBe(visited[0])
})

test("禅模式覆盖外壳时，F6 只在禅模式内移动", async ({ page }) => {
  await page.locator('[data-shard-editor="composer"] .ProseMirror').click()
  await page.keyboard.press("ControlOrMeta+Shift+F")
  const zen = page.getByRole("region", { name: "禅模式", exact: true })
  await expect(zen).toBeVisible()

  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press(index % 2 ? "Shift+F6" : "F6")
    expect(await zen.evaluate(element => element.contains(document.activeElement))).toBe(true)
  }
})
