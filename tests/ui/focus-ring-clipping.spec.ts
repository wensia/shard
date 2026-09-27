import { expect, test, type Page } from "@playwright/test"

import { installContentTypesMock } from "./content-types-mock"

// 键盘焦点环（index.css 的 managed-navigation 焦点块）外扩 --shard-focus-offset。
// 贴着 overflow 边缘的容器必须把它设为负值，否则焦点环会被裁掉一半甚至全部。
// 这里逐个聚焦页面上的可聚焦控件，断言：非编辑器控件都画出焦点环，且没有被祖先裁切。

interface ProbeResult {
  total: number
  drawn: number
  missing: string[]
  clipped: string[]
}

async function probe(page: Page, scope = "body"): Promise<ProbeResult> {
  // 先按一次键，让浏览器进入键盘模态，程序化聚焦才匹配 :focus-visible。
  await page.keyboard.press("Shift")
  return page.evaluate((scopeSelector) => {
    document.documentElement.dataset.focusMode = "keyboard"
    const root = document.querySelector(scopeSelector) ?? document.body
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const editor = '[contenteditable]:not([contenteditable="false"]), [data-focus-editor], [data-mind-map-outline] textarea'
    const result = { total: 0, drawn: 0, missing: [] as string[], clipped: [] as string[] }
    const name = (el: Element) => (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 24)

    for (const el of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
      if (el.getClientRects().length === 0 || el.closest('[inert], [aria-hidden="true"]')) continue
      if (el.tagName === "CANVAS" || el.matches(editor)) continue
      el.focus({ preventScroll: true })
      if (document.activeElement !== el) continue
      result.total += 1
      const style = getComputedStyle(el)
      if (style.outlineStyle === "none") {
        result.missing.push(name(el))
        continue
      }
      result.drawn += 1
      const grow = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)
      const rect = el.getBoundingClientRect()
      for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor)
        const clipX = ancestorStyle.overflowX !== "visible"
        const clipY = ancestorStyle.overflowY !== "visible"
        if (!clipX && !clipY) continue
        const bounds = ancestor.getBoundingClientRect()
        // 控件本身已滚出可视区时本来就看不全，不算焦点环裁切。
        if (rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5 || rect.top < bounds.top - 0.5 || rect.bottom > bounds.bottom + 0.5) break
        const cut = (clipX && (rect.left - grow < bounds.left - 0.5 || rect.right + grow > bounds.right + 0.5))
          || (clipY && (rect.top - grow < bounds.top - 0.5 || rect.bottom + grow > bounds.bottom + 0.5))
        if (cut) {
          result.clipped.push(name(el))
          break
        }
      }
    }
    return result
  }, scope)
}

function expectClean(result: ProbeResult) {
  expect(result.total).toBeGreaterThan(0)
  expect(result.missing).toEqual([])
  expect(result.clipped).toEqual([])
}

test.beforeEach(async ({ page }) => {
  await installContentTypesMock(page)
  await page.goto("/")
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeVisible()
})

test("首页控件的键盘焦点环完整可见", async ({ page }) => {
  expectClean(await probe(page))
})

test("资料库的面包屑与目录列表焦点环内收，不被裁切", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await expect(page.getByRole("complementary", { name: "资料库目录" })).toBeVisible()
  expectClean(await probe(page))
})

test("日历方向键轮转的日期格也画焦点环，事件条不被日期格裁切", async ({ page }) => {
  await page.getByRole("button", { name: "日历", exact: true }).click()
  await expect(page.getByRole("gridcell").first()).toBeVisible()
  const result = await probe(page)
  expectClean(result)
  // 日期格用 tabindex=-1 表示非当前项，仍是可达控件，必须有焦点环。
  expect(result.drawn).toBeGreaterThan(30)
})

test("设置对话框控件的焦点环完整可见", async ({ page }) => {
  await page.locator("[data-shard-utility-menu-trigger]:visible").click()
  await page.getByRole("menuitem", { name: "设置", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  expectClean(await probe(page, '[role="dialog"]'))
})
