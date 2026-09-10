import { expect, type Page } from "@playwright/test"

import { selectOption } from "./select-helpers"

export async function openFragmentFilters(page: Page) {
  const sidebarSearch = page.getByRole("button", { name: "搜索内容", exact: true })
  if (await sidebarSearch.isVisible()) await sidebarSearch.click()
  else await page.keyboard.press("Control+k")
  await page.getByRole("button", { name: "筛选碎片", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "筛选碎片", exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

export async function applyFragmentTag(page: Page, tag: string) {
  const dialog = await openFragmentFilters(page)
  await selectOption(dialog.getByRole("combobox", { name: "标签", exact: true }), tag)
  await dialog.getByRole("button", { name: "查看碎片", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole("button", { name: "清除筛选", exact: true })).toBeVisible()
}
