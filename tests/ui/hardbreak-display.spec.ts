import { expect, test } from "@playwright/test"

import { card, installContentTypesMock, lastSavedFragment, revealCard } from "./content-types-mock"
import { readEditor, selectEditorText, typeEditor } from "./editor-helpers"

const slash = "\\"
const initial = `开头${slash}\n${slash}\n呼吸也不顺畅`

test("公开卡片、编辑器和保存后的卡片保持硬换行与空行", async ({ page }) => {
  await installContentTypesMock(page, { fragmentBody: initial })
  await page.goto("/")
  const target = card(page, "card-fragment")
  await revealCard(target)
  const body = target.locator(".shard-fragment-card-content")
  await expect(body).toHaveText("开头\n\n呼吸也不顺畅")
  await target.getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click()
  const editorId = "fragment:card-fragment"
  const editor = page.locator(`[data-shard-editor="${editorId}"] .ProseMirror`)
  await expect(editor).toBeVisible()
  await expect(editor).not.toContainText(slash)
  expect(await readEditor(page, editorId)).toBe(initial)
  await selectEditorText(page, editorId, "顺畅", { collapse: "end" })
  await typeEditor(page, editorId, "！")
  await page.locator('[data-shard-editor="composer"] .ProseMirror').click()
  await expect.poll(() => lastSavedFragment(page, "card-fragment")).toMatchObject({
    content: `开头${slash}\n${slash}\n呼吸也不顺畅！`,
  })
  await expect(body).toHaveText("开头\n\n呼吸也不顺畅！")
})
