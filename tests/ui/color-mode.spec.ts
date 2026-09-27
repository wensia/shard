import { expect, test, type Page } from "@playwright/test"

import { installContentTypesMock } from "./content-types-mock"

// 明暗模式合同：外观来自 kiln 暗色层（vendor/kiln/tokens/dark.css），
// Shard 只负责何时给 <html> 加 .dark，以及强调色的暗色变体。

async function boot(page: Page, mode?: "system" | "light" | "dark") {
  if (mode) {
    await page.addInitScript((m) => localStorage.setItem("shard.colorMode", m), mode)
  }
  await installContentTypesMock(page)
  await page.goto("/")
  await expect(page.locator('[data-shard-editor="composer"]')).toBeVisible()
}

function computed(page: Page, expression: string) {
  return page.evaluate((expr) => {
    const probe = document.createElement("div")
    probe.style.color = expr
    document.body.append(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  }, expression)
}

async function openAppearance(page: Page) {
  await page.locator("[data-shard-utility-menu-trigger]:visible").click()
  await page.getByRole("menuitem", { name: "设置", exact: true }).click()
  await page.getByRole("button", { name: "外观", exact: true }).click()
}

test("深色模式在首帧生效，页面与表面走 kiln 暖炭黑", async ({ page }) => {
  await boot(page, "dark")

  await expect(page.locator("html")).toHaveClass(/\bdark\b/)
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(22, 18, 15)")
  expect(await computed(page, "var(--card)")).toBe("rgb(29, 25, 21)")
  expect(await computed(page, "var(--popover)")).toBe("rgb(36, 32, 28)")
  expect(await computed(page, "var(--foreground)")).toBe("rgb(235, 229, 222)")
  // 默认孔雀蓝强调色换成提亮后的暗色釉，实心底上用深色字。
  expect(await computed(page, "var(--primary)")).toBe("rgb(110, 177, 189)")
  expect(await computed(page, "var(--primary-foreground)")).toBe("rgb(22, 18, 15)")
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
    .toBe("dark")
})

test("浅色模式的语义 token 与 kiln 亮色一致（暗色层不外溢）", async ({ page }) => {
  await boot(page, "light")

  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/)
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(251, 250, 248)")
  expect(await computed(page, "var(--card)")).toBe("rgb(255, 255, 255)")
  expect(await computed(page, "var(--primary)")).toBe("rgb(46, 110, 121)")
  expect(await computed(page, "var(--primary-foreground)")).toBe("rgb(255, 255, 255)")
  // Shard 的边框偏离项：线色 45% 混进主表面。
  expect(await computed(page, "var(--border)"))
    .toBe(await computed(page, "color-mix(in srgb, #d8d3cc 45%, #ffffff)"))
})

test("跟随系统时随 prefers-color-scheme 切换", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await boot(page)
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/)

  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveClass(/\bdark\b/)

  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/)
})

test("设置面板切换明暗并持久化，固定模式不再跟随系统", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await boot(page)
  await openAppearance(page)

  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: "深色" }).click()
  await expect(page.locator("html")).toHaveClass(/\bdark\b/)
  await expect(dialog.getByRole("button", { name: "深色" })).toHaveAttribute("aria-pressed", "true")
  expect(await page.evaluate(() => localStorage.getItem("shard.colorMode"))).toBe("dark")

  await dialog.getByRole("button", { name: "浅色" }).click()
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/)
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/)

  await dialog.getByRole("button", { name: "跟随系统" }).click()
  await expect(page.locator("html")).toHaveClass(/\bdark\b/)
})

test("强调色在深色下换成对应的暗色釉", async ({ page }) => {
  await boot(page, "dark")
  await openAppearance(page)
  await page.getByRole("dialog").getByRole("button", { name: "陶土红" }).click()

  expect(await computed(page, "var(--primary)")).toBe("rgb(222, 129, 107)")
  expect(await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--shard-primary-rgb").trim()
  )).toBe("222 129 107")
})

test("品牌入口成套解析：亮色窑青绿用深色前景与加深文字色", async ({ page }) => {
  await boot(page, "light")
  await openAppearance(page)
  await page.getByRole("dialog").getByRole("button", { name: "窑青绿" }).click()

  expect(await computed(page, "var(--primary)")).toBe("rgb(62, 140, 125)")
  expect(await computed(page, "var(--primary-foreground)")).toBe("rgb(22, 18, 15)")
  expect(await computed(page, "var(--primary-text)")).toBe("rgb(50, 108, 96)")
  expect(await computed(page, "var(--sidebar-primary)")).toBe("rgb(62, 140, 125)")
})

test("暗色普通实心按钮降为暖灰米，分段激活片带选中标记", async ({ page }) => {
  await boot(page, "dark")

  expect(await computed(page, "var(--solid)")).toBe("rgb(180, 172, 165)")
  expect(await computed(page, "var(--solid-foreground)")).toBe("rgb(22, 18, 15)")
  expect(await computed(page, "var(--segment-active-fg)")).toBe("rgb(235, 229, 222)")
  expect(await computed(page, "var(--segment-active-mark)")).toBe("rgb(110, 177, 189)")
  expect(await computed(page, "var(--control-boundary)")).toBe("rgb(125, 117, 109)")
})

