import { expect, test, type Page } from "@playwright/test"
import type { IOSBridgeMessage } from "../../src/lib/ios-native"

test.use({ viewport: { width: 390, height: 844 }, locale: "zh-CN" })

async function installNativeHost(page: Page, authenticated: boolean, options: { listFailures?: number; delayLists?: boolean } = {}) {
  await page.addInitScript(({ authenticated, options }) => {
    let pending = authenticated ? 2 : 0
    let offline = authenticated
    let sessionValid = false
    let listFailures = options.listFailures ?? 0
    const deferredLists: Array<() => void> = []
    const calls: IOSBridgeMessage[] = []
    const state = () => ({
      serverURL: "https://shard.example.test", email: authenticated ? "me@example.test" : null, authenticated,
      sync: { state: offline ? "offline" : "online", pending }, legacyAvailable: true,
    })
    const reply = (body: unknown, status = 200) => ({
      status, headers: { "content-type": "application/json" },
      bodyBase64: btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(body)))),
    })
    const handlers: Record<string, () => unknown> = {
      list_markdown_dialect_migration: () => ({ dialect: 2, sources: [] }),
      list_fragments: () => ({
        vaultPath: "native-fixture", fragments: [],
        git: { branch: "main", shortCommit: "no git", hasRemote: false, status: "no_git", error: null, ahead: 0, behind: 0 },
        lockbox: { configured: false, unlocked: false, expiresAt: null, ttlSeconds: 900 },
      }),
      lockbox_snapshot: () => ({ configured: false, webUnlock: true, items: [], lockboxSeq: 0 }),
      list_library_tree: () => ({ entries: [], assets: [], trashEntries: [], fragmentTrashEntries: [], fragmentStream: { totalCount: 0, years: [] } }),
      list_mind_maps: () => [],
      list_csv_files: () => [],
      list_diagram_documents: () => [],
      list_deleted_entries: () => ({ entries: [], retentionDays: 30 }),
      read_property_registry: () => ({ registry: { version: 1, properties: {} }, sha: "empty" }),
    }
    Object.assign(window, {
      __IOS_NATIVE_CALLS__: calls,
      __IOS_RELEASE_LISTS__: () => deferredLists.splice(0).forEach((release) => release()),
      webkit: { messageHandlers: { shardApp: { postMessage: async (message: IOSBridgeMessage) => {
        calls.push(message)
        if (message.type === "bootstrap") return reply(state())
        if (message.type === "appearance" || message.type === "cancel") return reply({ ok: true })
        if (message.type === "sync") {
          offline = false
          pending = 0
          window.dispatchEvent(new CustomEvent("shard:ios-event", { detail: { type: "state-changed" } }))
          return reply(state())
        }
        if (message.type === "stream") return { ...reply({}), headers: { "content-type": "text/event-stream" }, bodyBase64: "" }
        if (message.path === "/api/auth/state") return reply({ authenticated, setupRequired: false, stepUpValid: sessionValid, vaultId: "native-fixture", email: authenticated ? "me@example.test" : null })
        if (message.path === "/api/auth/stepup") { sessionValid = true; return reply({ ok: true }) }
        if (message.path === "/api/auth/sessions" || message.path === "/api/devices") {
          if (!sessionValid) return reply({ code: "SESSION_REQUIRED", message: "需要验证登录密码。" }, 403)
          if (options.delayLists) {
            await new Promise<void>((resolve) => deferredLists.push(resolve))
            return reply({ code: "NETWORK", message: "测试连接失败。" }, 503)
          }
          if (listFailures > 0) {
            listFailures -= 1
            return reply({ code: "NETWORK", message: "测试连接失败。" }, 503)
          }
          return message.path === "/api/auth/sessions" ? reply({ sessions: [{
            id: "session-fixture", current: false, createdAt: "2026-10-31T00:00:00Z", lastSeenAt: "2026-10-31T01:00:00Z", userAgent: "iPhone Safari/1", ip: null,
          }] }) : reply({ devices: [{
            id: "device-fixture", name: "iPhone fixture", kind: "desktop", createdAt: "2026-10-31T00:00:00Z", lastSeenAt: "2026-10-31T01:00:00Z", lastIp: null,
          }] })
        }
        if (message.path?.startsWith("/api/rpc/")) {
          const result = handlers[decodeURIComponent(message.path.slice("/api/rpc/".length))]
          return result ? reply(result()) : reply({ code: "UNKNOWN", message: "Unknown fixture command" }, 400)
        }
        return reply({ code: "NOT_FOUND" }, 404)
      } } } },
    })
  }, { authenticated, options })
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "更多操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "设置", exact: true }).click()
  return page.getByRole("dialog", { name: "设置", exact: true })
}

async function confirmManagement(page: Page) {
  await page.getByRole("button", { name: "管理设备与会话", exact: true }).click()
  const prompt = page.getByRole("dialog", { name: "确认登录密码", exact: true })
  await prompt.getByLabel("登录密码", { exact: true }).fill("fixture-password")
  await prompt.getByRole("button", { name: "确认", exact: true }).click()
  await expect(prompt).toHaveCount(0)
}

test("原生登录表单通过可访问名称关联服务器地址", async ({ page }) => {
  await installNativeHost(page, false)
  await page.goto("/")
  const server = page.getByRole("textbox", { name: "服务器地址", exact: true })
  await expect(server).toHaveValue("https://shard.example.test")
  await page.locator("label").filter({ hasText: /^服务器地址$/ }).click()
  await expect(server).toBeFocused()
  await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible()
})

test("原生离线与待发数量可见，重试使用native sync", async ({ page }) => {
  await installNativeHost(page, true)
  await page.goto("/")
  const navigation = page.getByRole("navigation", { name: "页面导航" })
  await expect(navigation.getByRole("button", { name: "离线", exact: true })).toBeVisible()
  await expect(navigation.getByText("待上传 2 条", { exact: true })).toBeVisible()
  await navigation.getByRole("button", { name: "离线", exact: true }).click()
  await expect(navigation.getByRole("button", { name: "已连接服务器", exact: true })).toBeVisible()
  await expect(navigation.locator("[data-shard-sync-pending]")).toHaveCount(0)
  const types = await page.evaluate(() => (window as typeof window & { __IOS_NATIVE_CALLS__: IOSBridgeMessage[] }).__IOS_NATIVE_CALLS__.map((call) => call.type))
  expect(types.filter((type) => type === "sync")).toHaveLength(1)
})

test("网页主题通知原生外观，并保留跟随系统语义", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await installNativeHost(page, true)
  await page.goto("/")
  await page.getByRole("button", { name: "更多操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "设置", exact: true }).click()
  const settings = page.getByRole("dialog")
  await settings.getByRole("button", { name: "外观", exact: true }).click()
  await settings.getByRole("button", { name: "深色", exact: true }).click()
  await expect(page.locator("html")).toHaveClass(/\bdark\b/)
  const lastAppearance = () => page.evaluate(() => {
    const calls = (window as typeof window & { __IOS_NATIVE_CALLS__: IOSBridgeMessage[] }).__IOS_NATIVE_CALLS__.filter((call) => call.type === "appearance")
    return calls.length ? JSON.parse(atob(calls[calls.length - 1].bodyBase64!)).mode as string : null
  })
  await expect.poll(lastAppearance).toBe("dark")
  await settings.getByRole("button", { name: "跟随系统", exact: true }).click()
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/)
  await expect.poll(lastAppearance).toBe("system")
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveClass(/\bdark\b/)
  await expect.poll(lastAppearance).toBe("system")
})

test("打开各设置段不触发认证，取消设备管理后保留账号且可重试", async ({ page }) => {
  await installNativeHost(page, true)
  await page.goto("/")
  const settings = await openSettings(page)
  await settings.getByRole("button", { name: "外观", exact: true }).click()
  await settings.getByRole("button", { name: "账号与安全", exact: true }).click()
  await expect(settings.getByText("me@example.test", { exact: true })).toBeVisible()
  await expect(settings.getByRole("button", { name: "退出登录", exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as typeof window & { __IOS_NATIVE_CALLS__: IOSBridgeMessage[] }).__IOS_NATIVE_CALLS__.filter((call) => call.path === "/api/auth/sessions" || call.path === "/api/devices"))).toHaveLength(0)
  await expect(page.getByRole("dialog", { name: "确认登录密码", exact: true })).toHaveCount(0)
  await settings.getByRole("button", { name: "管理设备与会话", exact: true }).click()
  await page.getByRole("dialog", { name: "确认登录密码", exact: true }).getByRole("button", { name: "取消", exact: true }).click()
  await expect(settings.getByRole("button", { name: "管理设备与会话", exact: true })).toBeEnabled()
  await expect(settings.getByRole("button", { name: "退出登录", exact: true })).toBeEnabled()
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0)
  await expect(settings.getByText("iPhone fixture", { exact: true })).toHaveCount(0)
  await confirmManagement(page)
  await expect(settings.getByText("iPhone fixture", { exact: true })).toBeVisible()
  await expect(settings.getByRole("button", { name: "退出这个会话", exact: true })).toBeVisible()
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0)
})

test("设备列表网络失败不伪装为空，保留真实错误和重试入口", async ({ page }) => {
  await installNativeHost(page, true, { listFailures: 1 })
  await page.goto("/")
  const settings = await openSettings(page)
  await confirmManagement(page)
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "读取设备与会话失败" })).toBeVisible()
  await expect(settings.getByText("还没有连接的桌面应用或命令行。", { exact: false })).toHaveCount(0)
  await expect(settings.getByRole("button", { name: "管理设备与会话", exact: true })).toBeEnabled()
  await confirmManagement(page)
  await expect(settings.getByText("iPhone fixture", { exact: true })).toBeVisible()
})

test("关闭设置返回资料库后，迟到的列表失败不再弹toast", async ({ page }) => {
  await installNativeHost(page, true, { delayLists: true })
  await page.goto("/")
  const settings = await openSettings(page)
  await confirmManagement(page)
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __IOS_NATIVE_CALLS__: IOSBridgeMessage[] }).__IOS_NATIVE_CALLS__.filter((call) => call.path === "/api/auth/sessions" || call.path === "/api/devices").length)).toBe(2)
  await settings.getByRole("button", { name: "关闭", exact: true }).click()
  await page.getByRole("navigation", { name: "工作台", exact: true }).getByRole("button", { name: "资料库", exact: true }).click()
  await page.evaluate(() => (window as typeof window & { __IOS_RELEASE_LISTS__: () => void }).__IOS_RELEASE_LISTS__())
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(page.getByRole("dialog", { name: "设置", exact: true })).toHaveCount(0)
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0)
})
