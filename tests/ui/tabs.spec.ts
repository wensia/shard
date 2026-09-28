import { expect, test } from "@playwright/test"

import { installContentTypesMock } from "./content-types-mock"

// Shard 页签合同（src/components/ui/tabs.css，墨迹）：没有底板和外框；
// 选中 = 正文色 + 标签宽度的 2px 品牌色下划线；选中加粗不改变宽度；
// 可访问名称只有一份文字（TabLabel 的占位副本不进无障碍树）。

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ height: 720, width: 820 })
  await installContentTypesMock(page)
  await page.goto("/")
  await expect(page.getByRole("navigation", { name: "工作台" })).toBeVisible()
})

test("页签没有底板与外框，选中项有 2px 品牌色下划线", async ({ page }) => {
  const nav = page.getByRole("navigation", { name: "工作台" })
  const active = nav.locator('.shard-tab[aria-current="page"]')
  const idle = nav.locator(".shard-tab:not([aria-current])").first()

  for (const tab of [active, idle]) {
    const style = await tab.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { background: cs.backgroundColor, border: cs.borderTopWidth, radius: cs.borderTopLeftRadius }
    })
    expect(style).toEqual({ background: "rgba(0, 0, 0, 0)", border: "0px", radius: "0px" })
  }

  const underline = await active.evaluate((el) => {
    const after = getComputedStyle(el, "::after")
    const probe = document.createElement("i")
    probe.style.color = "var(--primary-text)"
    document.body.append(probe)
    const brand = getComputedStyle(probe).color
    probe.remove()
    return { height: after.height, color: after.backgroundColor, brand }
  })
  expect(underline.height).toBe("2px")
  expect(underline.color).toBe(underline.brand)
  expect(await idle.evaluate((el) => getComputedStyle(el, "::after").content)).toBe("none")
})

test("切换选中页签不改变页签宽度，可访问名称不重复", async ({ page }) => {
  const views = page.getByRole("navigation", { name: "碎片视图" })
  const all = views.getByRole("button", { name: /^全部 \d+$/u })
  const trash = views.getByRole("button", { name: /^回收站 \d+$/u })
  await expect(all).toHaveAttribute("aria-current", "page")

  const widths = () => Promise.all([all, trash].map((tab) => tab.evaluate((el) => el.getBoundingClientRect().width)))
  const before = await widths()
  await trash.click()
  await expect(trash).toHaveAttribute("aria-current", "page")
  expect(await widths()).toEqual(before)
})
