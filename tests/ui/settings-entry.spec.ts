import { expect, test, type Page } from "@playwright/test"

import { installContentTypesMock } from "./content-types-mock"
import { installLocalVoiceMock } from "./voice-local-mock"

// 设置的入口与「AI」分区（本机资料库模式的桌面）。网页端的同类用例在 web-auth.spec.ts。
// 桌面真机上 ⌘, 由 macOS 应用菜单「设置…」接走（Tauri 事件），这里没有原生菜单，走页面里的同一个处理。

async function setup(page: Page) {
  await installContentTypesMock(page)
  await page.goto("/")
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeVisible()
  await installLocalVoiceMock(page)
}

const settingsDialog = (page: Page) => page.getByRole("dialog", { name: "设置", exact: true })

test("侧栏底部常驻「设置」，⌘, 也能打开", async ({ page }) => {
  await setup(page)
  const sidebar = page.getByRole("complementary", { name: "Shard 侧边栏" })
  const entry = sidebar.getByRole("button", { name: "设置", exact: true })
  await expect(entry).toBeVisible()
  await expect(entry).toContainText("⌘,")
  // 钉在侧栏最底部：在导航（含热力图）之下。
  const entryBox = (await entry.boundingBox())!
  const navBox = (await sidebar.getByRole("navigation").boundingBox())!
  expect(entryBox.y).toBeGreaterThanOrEqual(navBox.y + navBox.height - 0.5)

  await entry.click()
  await expect(settingsDialog(page)).toBeVisible()
  await settingsDialog(page).getByRole("button", { name: "关闭", exact: true }).click()
  await expect(settingsDialog(page)).toHaveCount(0)

  await page.keyboard.press("Meta+Comma")
  await expect(settingsDialog(page)).toBeVisible()
  // 快捷键列表里也写明了 ⌘,
  const shortcuts = settingsDialog(page).locator('[data-settings-section="shortcuts"]')
  await expect(shortcuts.getByText("设置", { exact: true })).toBeAttached()
})

test("AI 分区把自动标签、语音和助手接入放在一处，并能跳到相关分区", async ({ page }) => {
  await setup(page)
  await page.keyboard.press("Meta+Comma")
  const dialog = settingsDialog(page)
  const nav = dialog.getByRole("navigation")
  await expect(nav.getByRole("button")).toHaveText(["Vault", "Git 同步", "服务器", "外观", "AI", "终端命令", "快捷键"])
  await nav.getByRole("button", { name: "AI", exact: true }).click()
  await expect(nav.getByRole("button", { name: "AI", exact: true })).toHaveAttribute("aria-current", "true")

  const ai = dialog.locator('[data-settings-section="ai"]')
  await expect(ai.getByRole("heading", { level: 4 })).toHaveText(["自动标签", "语音输入与朗读", "AI 助手接入"])
  // 本机资料库：自动标签在服务器上运行，这里只说明并给出去处，不请求服务器。
  const autoTagging = ai.locator('[data-settings-group="auto-tagging"]')
  await expect(autoTagging).toContainText("需要连接服务器")
  const calls = await page.evaluate(() =>
    ((window as any).__SHARD_TYPE_CALLS__ as Array<{ command: string }>).map((call) => call.command)
  )
  expect(calls.filter((command) => command.startsWith("ai_settings"))).toEqual([])

  await autoTagging.getByRole("button", { name: "前往服务器设置", exact: true }).click()
  await expect(nav.getByRole("button", { name: "服务器", exact: true })).toHaveAttribute("aria-current", "true")
  await expect(dialog.locator('[data-settings-section="server"]')).toBeInViewport()

  await nav.getByRole("button", { name: "AI", exact: true }).click()
  await ai.locator('[data-settings-group="assistant"]').getByRole("button", { name: "前往终端命令", exact: true }).click()
  await expect(nav.getByRole("button", { name: "终端命令", exact: true })).toHaveAttribute("aria-current", "true")
  await expect(dialog.locator('[data-settings-section="cli"]')).toBeInViewport()
})
