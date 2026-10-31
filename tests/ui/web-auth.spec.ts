import { expect, test, type Page } from "@playwright/test"

import { fillEditor } from "./editor-helpers"

// 网页端的邮箱 + 密码登录、一次性链接设置 / 重置密码、敏感操作前的密码确认框、设置里的「修改邮箱或密码」。
// 与 web-history.spec.ts 一样在页面里改写 fetch，把 /api/* 接到内存里的假服务端，走真实的网页代码路径。

test.use({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" })

const RIDE = "20261026-073012-a1b2c3d4-0a0b0c"
const EMAIL = "me@example.com"
const PASSWORD = "correct horse battery"

interface MockOptions {
  authenticated?: boolean
  setupRequired?: boolean
  /** 10 分钟内输过密码（登录本身算一次）；false 表示敏感操作会被要求再输一次。 */
  stepUpValid?: boolean
  /** 有效的一次性链接。 */
  setupToken?: { token: string; purpose: "setup" | "reset" }
}

interface ApiCall {
  method: string
  path: string
  body: Record<string, unknown> | null
}

async function installAuthServerMock(page: Page, options: MockOptions) {
  await page.addInitScript(
    ({ options, ride, email, password }) => {
      const auth = {
        authenticated: (options.authenticated ?? false) && sessionStorage.getItem("__AUTH_SIGNED_OUT__") !== "1",
        setupRequired: options.setupRequired ?? false,
        stepUpValid: options.stepUpValid ?? true,
        email: options.setupToken?.purpose === "setup" ? null : email,
        password,
      }
      const now = "2026-10-26T12:00:00.000Z"
      let sessions = [
        { id: "s-current", current: true, createdAt: now, lastSeenAt: now, userAgent: navigator.userAgent, ip: "203.0.113.5" },
        {
          id: "s-phone",
          current: false,
          createdAt: now,
          lastSeenAt: now,
          userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
          ip: "198.51.100.7",
        },
      ]
      let deletedEntries = [
        { nodeId: 9, revId: 7, path: ".trash/notes/旧计划.md", sha: "sha-deleted", purgedAt: "2026-10-26T15:56:00.000Z", expiresAt: "2026-11-25T15:56:00.000Z", revisions: 3 },
      ]
      const state = {
        vaultPath: "shard://test/auth",
        fragments: [
          {
            id: ride,
            path: `fragments/2026/10/${ride}.md`,
            content: "早上沿江骑了 40 公里。#骑行\n",
            tags: ["inbox", "骑行"],
            fileSha: "sha-current",
            createdAt: now,
            updatedAt: now,
            category: null,
            gitStatus: "saved",
            error: null,
            archived: false,
            lockbox: false,
            pinned: false,
            properties: [],
            related: [],
          },
        ],
        git: { ahead: 0, behind: 0, branch: "main", error: null, hasRemote: false, shortCommit: "no git", status: "no_git" },
        lockbox: { configured: false, expiresAt: null, ttlSeconds: 900, unlocked: false },
      }
      const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = []
      Object.assign(window, { __AUTH_CALLS__: calls })
      const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
      const failure = (status: number, code: string, message: string) => json({ code, message }, status)
      const stepUpRequired = () => failure(403, "STEP_UP_REQUIRED", "这个操作需要再输入一次密码。")
      const rpc: Record<string, (args: Record<string, unknown>) => Response | unknown> = {
        list_fragments: () => clone(state),
        list_library_tree: () => ({ entries: [], assets: [], trashEntries: [], fragmentTrashEntries: [], fragmentStream: { totalCount: 1, years: [] } }),
        list_mind_maps: () => [],
        list_csv_files: () => [],
        list_markdown_dialect_migration: () => ({ dialect: 2, sources: [] }),
        lockbox_snapshot: () => ({ configured: false, webUnlock: true, items: [], lockboxSeq: 0 }),
        list_deleted_entries: () => ({ entries: clone(deletedEntries), retentionDays: 30 }),
        erase_deleted_entries: () => {
          if (!auth.stepUpValid) return stepUpRequired()
          deletedEntries = []
          return { nodes: 1, revisions: 3, blobs: 0 }
        },
      }
      const realFetch = window.fetch.bind(window)
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href)
        if (!url.pathname.startsWith("/api/")) return realFetch(input, init)
        const method = (init?.method ?? "GET").toUpperCase()
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
        const path = url.pathname
        if (path !== "/api/events") calls.push({ method, path, body })
        if (path === "/api/events") {
          return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } })
        }
        if (path === "/api/auth/state") {
          return json({
            authenticated: auth.authenticated,
            setupRequired: auth.setupRequired,
            stepUpValid: auth.authenticated && auth.stepUpValid,
            vaultId: state.vaultPath,
            email: auth.authenticated ? auth.email : null,
          })
        }
        if (path === "/api/auth/login") {
          if (auth.setupRequired) return failure(409, "SETUP_REQUIRED", "还没有设置账号。")
          if (body?.email !== auth.email || body?.password !== auth.password) {
            return failure(401, "INVALID_CREDENTIALS", "邮箱或密码不对。")
          }
          auth.authenticated = true
          auth.stepUpValid = true
          return json({ ok: true })
        }
        if (path === "/api/auth/setup/check") {
          if (!options.setupToken || body?.token !== options.setupToken.token) {
            return failure(403, "SETUP_TOKEN_INVALID", "这个链接无效或已过期。")
          }
          return json({ purpose: options.setupToken.purpose, email: options.setupToken.purpose === "reset" ? auth.email : null })
        }
        if (path === "/api/auth/setup") {
          if (!options.setupToken || body?.token !== options.setupToken.token) {
            return failure(403, "SETUP_TOKEN_INVALID", "这个链接无效或已过期。")
          }
          auth.email = String(body.email)
          auth.password = String(body.password)
          auth.setupRequired = false
          auth.authenticated = true
          auth.stepUpValid = true
          return json({ ok: true })
        }
        if (!auth.authenticated) return failure(401, "UNAUTHENTICATED", "请先登录。")
        if (path === "/api/auth/stepup") {
          if (body?.password !== auth.password) return failure(401, "INVALID_CREDENTIALS", "密码不对。")
          auth.stepUpValid = true
          return json({ ok: true })
        }
        if (path === "/api/auth/account") {
          if (body?.currentPassword !== auth.password) return failure(401, "INVALID_CREDENTIALS", "密码不对。")
          auth.email = String(body.email)
          if (typeof body.newPassword === "string") {
            auth.password = body.newPassword
            sessions = sessions.filter((session) => session.current)
          }
          return json({ ok: true })
        }
        if (path === "/api/auth/logout") {
          // 退出后整页重载，假服务端随页面重建：退出记在 sessionStorage 里，重载后仍是未登录。
          sessionStorage.setItem("__AUTH_SIGNED_OUT__", "1")
          auth.authenticated = false
          return json({ ok: true })
        }
        if (path === "/api/auth/sessions") return json({ sessions: clone(sessions) })
        if (path.startsWith("/api/auth/sessions/") && method === "DELETE") {
          if (!auth.stepUpValid) return stepUpRequired()
          const id = decodeURIComponent(path.slice("/api/auth/sessions/".length))
          sessions = sessions.filter((session) => session.id !== id)
          return json({ ok: true })
        }
        if (path === "/api/devices") return json({ devices: [] })
        if (path.startsWith("/api/rpc/")) {
          const command = decodeURIComponent(path.slice("/api/rpc/".length))
          const handler = rpc[command]
          if (!handler) return failure(400, "UNKNOWN", `测试替身没有实现 ${command}`)
          const result = handler(body ?? {})
          return result instanceof Response ? result : json(result)
        }
        return failure(404, "NOT_FOUND", `测试替身没有实现 ${method} ${path}`)
      }
    },
    { options, ride: RIDE, email: EMAIL, password: PASSWORD }
  )
}

function apiCalls(page: Page, path?: string) {
  return page.evaluate(
    (path) =>
      (window as unknown as { __AUTH_CALLS__: ApiCall[] }).__AUTH_CALLS__.filter((call) => path === undefined || call.path === path),
    path
  )
}

const card = (page: Page) => page.locator(`[data-shard-fragment-id="${RIDE}"]`).first()

async function openSettings(page: Page) {
  await page.getByText("已连接服务器").click()
  const settings = page.getByRole("dialog", { name: "设置" })
  await expect(settings).toBeVisible()
  return settings
}

test.describe("登录页", () => {
  test("邮箱和密码正确：进入工作台；密码框可以显示明文", async ({ page }) => {
    await installAuthServerMock(page, {})
    await page.goto("/")
    await expect(page.locator("html")).toHaveAttribute("data-runtime", "web")
    await expect(page.getByRole("heading", { name: "登录" })).toBeVisible()

    const email = page.getByLabel("邮箱", { exact: true })
    const password = page.getByLabel("密码", { exact: true })
    // 浏览器与钥匙串靠这些属性识别登录表单。
    await expect(email).toHaveAttribute("type", "email")
    await expect(email).toHaveAttribute("autocomplete", "username")
    await expect(password).toHaveAttribute("type", "password")
    await expect(password).toHaveAttribute("autocomplete", "current-password")
    await expect(email).toBeFocused()

    await email.fill("  Me@Example.com ")
    await password.fill(PASSWORD)
    await page.getByRole("button", { name: "显示密码" }).click()
    await expect(password).toHaveAttribute("type", "text")
    await expect(password).toHaveValue(PASSWORD)
    await page.getByRole("button", { name: "隐藏密码" }).click()
    await expect(password).toHaveAttribute("type", "password")

    await password.press("Enter")
    await expect(card(page)).toBeVisible()
    expect((await apiCalls(page, "/api/auth/login")).map((call) => call.body)).toEqual([{ email: EMAIL, password: PASSWORD }])
  })

  test("密码不对：显示错误、清空密码，改对后进入", async ({ page }) => {
    await installAuthServerMock(page, {})
    await page.goto("/")
    const email = page.getByLabel("邮箱", { exact: true })
    const password = page.getByLabel("密码", { exact: true })
    const submit = page.getByRole("button", { name: "登录", exact: true })

    // 打开时不报错（kiln：校验在意图之后）。
    await expect(page.getByRole("alert")).toHaveCount(0)
    await expect(email).not.toHaveAttribute("aria-invalid", "true")
    // 前端先拦，不发请求：错误各自在字段下方，焦点到第一个有错的字段。
    await submit.click()
    await expect(page.getByRole("alert")).toHaveText(["请填写邮箱。", "请填写密码。"])
    await expect(email).toHaveAttribute("aria-invalid", "true")
    await expect(password).toHaveAttribute("aria-invalid", "true")
    await expect(email).toBeFocused()
    // 改的过程中按新值重新检查，改对就消失。
    await email.fill("me@@example.com")
    await expect(page.getByRole("alert")).toHaveText(["邮箱格式不对。", "请填写密码。"])
    await email.fill(EMAIL)
    await expect(page.getByRole("alert")).toHaveText(["请填写密码。"])
    await expect(email).not.toHaveAttribute("aria-invalid", "true")
    expect(await apiCalls(page, "/api/auth/login")).toEqual([])

    await password.fill("wrong password!!")
    await expect(page.getByRole("alert")).toHaveCount(0)
    await submit.click()
    // 服务器的拒绝是表单级的，放在登录按钮旁边。
    await expect(page.getByRole("alert")).toHaveText("邮箱或密码不对。")
    await expect(password).toBeFocused()
    await expect(password).toHaveValue("")
    await expect(email).toHaveValue(EMAIL)
    await expect(card(page)).toHaveCount(0)

    await password.fill(PASSWORD)
    await submit.click()
    await expect(card(page)).toBeVisible()
    expect(await apiCalls(page, "/api/auth/login")).toHaveLength(2)
  })

  test("还没设置账号：提示到服务器上运行 shard-server setup", async ({ page }) => {
    await installAuthServerMock(page, { setupRequired: true })
    await page.goto("/")
    await expect(page.getByRole("heading", { name: "还没有设置账号" })).toBeVisible()
    await expect(page.getByText("用它给出的链接设置邮箱和密码", { exact: false })).toBeVisible()
    await expect(page.locator("code", { hasText: "shard-server setup" })).toBeVisible()
    await expect(page.getByLabel("密码", { exact: true })).toHaveCount(0)
  })

  test("旧的 /pair 配对链接回到首页", async ({ page }) => {
    await installAuthServerMock(page, { authenticated: true })
    await page.goto("/pair")
    await expect(card(page)).toBeVisible()
    expect(new URL(page.url()).pathname).toBe("/")
  })
})

test.describe("一次性链接", () => {
  test("首次设置：两次密码不一致或太短被拦，设置成功后直接登录", async ({ page }) => {
    await installAuthServerMock(page, { setupRequired: true, setupToken: { token: "tok-setup", purpose: "setup" } })
    await page.goto("/setup#token=tok-setup")
    await expect(page.getByRole("heading", { name: "设置账号" })).toBeVisible()
    // 开发模式的 StrictMode 会把检查请求发两次（只读、不消耗链接），这里只核对内容。
    const checks = await apiCalls(page, "/api/auth/setup/check")
    expect(checks.length).toBeGreaterThan(0)
    expect(checks.every((call) => call.body?.token === "tok-setup")).toBe(true)

    const email = page.getByLabel("邮箱", { exact: true })
    const password = page.getByLabel("密码", { exact: true })
    const repeat = page.getByLabel("确认密码", { exact: true })
    await expect(email).toHaveValue("")
    await expect(email).toHaveAttribute("autocomplete", "username")
    // new-password：Safari / iCloud 钥匙串据此建议并保存强密码。
    await expect(password).toHaveAttribute("autocomplete", "new-password")
    await expect(repeat).toHaveAttribute("autocomplete", "new-password")
    const hint = page.getByText("至少 8 个字符。", { exact: true })
    await expect(hint).toBeVisible()
    // 页面只有标题、字段与按钮，没有叙述性的说明段落（kiln：文案按需添加）。
    await expect(page.getByText("完成后直接登录", { exact: false })).toHaveCount(0)

    const submit = page.getByRole("button", { name: "设置并登录" })
    await email.fill("New@Example.com")
    await password.fill("short12")
    await repeat.fill("short12")
    await submit.click()
    // 字段下方只有一行：出错时错误替换说明，改对后说明回来。
    await expect(page.getByRole("alert")).toHaveText("密码至少 8 个字符。")
    await expect(hint).toHaveCount(0)
    await expect(password).toHaveAttribute("aria-invalid", "true")
    await expect(password).toBeFocused()
    await password.fill("a long enough password")
    await expect(page.getByRole("alert")).toHaveCount(0)
    await expect(hint).toBeVisible()
    await repeat.fill("a long enough passw0rd")
    await submit.click()
    await expect(page.getByRole("alert")).toHaveText("两次输入的密码不一致。")
    await expect(repeat).toHaveAttribute("aria-invalid", "true")
    expect(await apiCalls(page, "/api/auth/setup")).toEqual([])

    await repeat.fill("a long enough password")
    await submit.click()
    await expect(card(page)).toBeVisible()
    expect(new URL(page.url()).pathname).toBe("/")
    expect((await apiCalls(page, "/api/auth/setup")).map((call) => call.body)).toEqual([
      { token: "tok-setup", email: "new@example.com", password: "a long enough password" },
    ])
  })

  test("重置密码：预填当前邮箱，设置新密码后直接登录", async ({ page }) => {
    await installAuthServerMock(page, { setupToken: { token: "tok-reset", purpose: "reset" } })
    await page.goto("/setup#token=tok-reset")
    await expect(page.getByRole("heading", { name: "重置密码" })).toBeVisible()
    await expect(page.getByLabel("邮箱", { exact: true })).toHaveValue(EMAIL)
    const password = page.getByLabel("新密码", { exact: true })
    await expect(password).toBeFocused()
    await password.fill("a brand new password")
    await page.getByLabel("确认新密码", { exact: true }).fill("a brand new password")
    await page.getByRole("button", { name: "重置并登录" }).click()
    await expect(card(page)).toBeVisible()
    expect((await apiCalls(page, "/api/auth/setup")).map((call) => call.body)).toEqual([
      { token: "tok-reset", email: EMAIL, password: "a brand new password" },
    ])
  })

  test("链接无效或已过期：说明怎么重新生成", async ({ page }) => {
    await installAuthServerMock(page, { setupToken: { token: "tok-reset", purpose: "reset" } })
    await page.goto("/setup#token=tok-stale")
    await expect(page.getByRole("heading", { name: "链接无效或已过期" })).toBeVisible()
    await expect(page.getByText("链接只能用一次，24 小时内有效。", { exact: false })).toBeVisible()
    await expect(page.locator("code", { hasText: "shard-server reset-password" })).toBeVisible()
    await expect(page.getByLabel("邮箱", { exact: true })).toHaveCount(0)
  })
})

test.describe("敏感操作前输入密码", () => {
  test("吊销其他会话：弹出密码确认框，密码错了在框里重试，确认后再执行", async ({ page }) => {
    await installAuthServerMock(page, { authenticated: true, stepUpValid: false })
    await page.goto("/")
    await expect(card(page)).toBeVisible()
    const settings = await openSettings(page)
    const account = settings.locator('[data-settings-section="account"]')
    await account.getByRole("button", { name: "退出这个会话" }).click()

    const prompt = page.getByRole("dialog", { name: "确认登录密码" })
    await expect(prompt).toBeVisible()
    const password = prompt.getByLabel("登录密码", { exact: true })
    await expect(password).toBeFocused()
    await expect(password).toHaveAttribute("type", "password")
    await expect(password).toHaveAttribute("autocomplete", "current-password")

    // 空着提交：框内提示，不发请求。
    await prompt.getByRole("button", { name: "确认" }).click()
    await expect(prompt.getByRole("alert")).toHaveText("请输入登录密码。")

    await password.fill("wrong password!!")
    await prompt.getByRole("button", { name: "确认" }).click()
    await expect(prompt.getByRole("alert")).toHaveText("登录密码不正确。")
    await expect(password).toHaveValue("")
    await expect(password).toBeFocused()

    await password.fill(PASSWORD)
    await password.press("Enter")
    await expect(prompt).toBeHidden()
    await expect(page.getByText("已让这个会话退出")).toBeVisible()
    await expect(account.getByRole("button", { name: "退出这个会话" })).toHaveCount(0)
    expect((await apiCalls(page, "/api/auth/stepup")).map((call) => call.body)).toEqual([
      { password: "wrong password!!" },
      { password: PASSWORD },
    ])
    // 先试一次被要求确认，确认后再试一次。
    expect((await apiCalls(page, "/api/auth/sessions/s-phone")).map((call) => call.method)).toEqual(["DELETE", "DELETE"])
  })

  test("取消密码确认：不执行操作，也不报错", async ({ page }) => {
    await installAuthServerMock(page, { authenticated: true, stepUpValid: false })
    await page.goto("/")
    await expect(card(page)).toBeVisible()
    const settings = await openSettings(page)
    const account = settings.locator('[data-settings-section="account"]')
    await account.getByRole("button", { name: "退出这个会话" }).click()

    const prompt = page.getByRole("dialog", { name: "确认登录密码" })
    await prompt.getByLabel("登录密码", { exact: true }).fill("typed but cancelled")
    await prompt.getByRole("button", { name: "取消" }).click()
    await expect(prompt).toBeHidden()
    await expect(account.getByRole("button", { name: "退出这个会话" })).toBeEnabled()
    await expect(page.getByText("操作没有完成")).toHaveCount(0)
    expect(await apiCalls(page, "/api/auth/stepup")).toEqual([])
    expect(await apiCalls(page, "/api/auth/sessions/s-phone")).toHaveLength(1)

    // Esc 关掉也一样按取消处理。
    await account.getByRole("button", { name: "退出这个会话" }).click()
    await expect(prompt).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(prompt).toBeHidden()
    expect(await apiCalls(page, "/api/auth/stepup")).toEqual([])
    expect(await apiCalls(page, "/api/auth/sessions/s-phone")).toHaveLength(2)
  })

  test("立即抹除：确认已过期时先输入密码，再执行", async ({ page }) => {
    await installAuthServerMock(page, { authenticated: true, stepUpValid: false })
    await page.goto("/")
    await expect(card(page)).toBeVisible()
    const settings = await openSettings(page)
    const data = settings.locator('[data-settings-section="data"]')
    await expect(data.getByText("需要输入密码确认", { exact: false })).toBeVisible()
    await data.getByRole("button", { name: "立即抹除" }).click()
    await data.getByRole("button", { name: "再点一次抹除" }).click()

    const prompt = page.getByRole("dialog", { name: "确认登录密码" })
    await prompt.getByLabel("登录密码", { exact: true }).fill(PASSWORD)
    await prompt.getByRole("button", { name: "确认" }).click()
    await expect(prompt).toBeHidden()
    await expect(data.getByText("最近 30 天没有彻底删除的内容", { exact: false })).toBeVisible()
    expect(await apiCalls(page, "/api/auth/stepup")).toHaveLength(1)
    expect((await apiCalls(page, "/api/rpc/erase_deleted_entries")).map((call) => call.body)).toEqual([{ nodeIds: [9] }])
  })
})

test.describe("账号设置", () => {
  test("修改邮箱或密码：校验、当前密码错误可重试，保存后显示新邮箱", async ({ page }) => {
    await installAuthServerMock(page, { authenticated: true })
    await page.goto("/")
    await expect(card(page)).toBeVisible()
    const settings = await openSettings(page)
    const account = settings.locator('[data-settings-section="account"]')
    await expect(account.getByText(EMAIL)).toBeVisible()
    await expect(account.getByText("通行密钥")).toHaveCount(0)
    await expect(account.getByText("还没有连接的桌面应用或命令行。在它们那里输入服务器地址、邮箱和密码即可连接。")).toBeVisible()
    await account.getByRole("button", { name: "修改邮箱或密码" }).click()

    const dialog = page.getByRole("dialog", { name: "修改邮箱或密码" })
    await expect(dialog.getByText("改了密码，其他浏览器会退出登录", { exact: false })).toBeVisible()
    const current = dialog.getByLabel("当前密码", { exact: true })
    const email = dialog.getByLabel("邮箱", { exact: true })
    const next = dialog.getByLabel("新密码", { exact: true })
    const repeat = dialog.getByLabel("确认新密码", { exact: true })
    await expect(current).toBeFocused()
    await expect(email).toHaveValue(EMAIL)
    await expect(current).toHaveAttribute("autocomplete", "current-password")
    await expect(next).toHaveAttribute("autocomplete", "new-password")
    const save = dialog.getByRole("button", { name: "保存" })

    await save.click()
    await expect(dialog.getByRole("alert")).toHaveText("请输入当前密码。")
    await current.fill("wrong password!!")
    await save.click()
    await expect(dialog.getByRole("alert")).toHaveText("邮箱和密码都没有改动。")
    await next.fill("short12")
    await save.click()
    await expect(dialog.getByRole("alert")).toHaveText("密码至少 8 个字符。")
    expect(await apiCalls(page, "/api/auth/account")).toEqual([])

    await email.fill("Other@Example.com")
    await next.fill("another long password")
    await repeat.fill("another long password")
    await save.click()
    await expect(dialog.getByRole("alert")).toHaveText("密码不对。")
    await expect(current).toHaveValue("")
    await expect(current).toBeFocused()

    await current.fill(PASSWORD)
    await save.click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText("邮箱和密码已修改，其他浏览器已退出登录")).toBeVisible()
    await expect(account.getByText("other@example.com")).toBeVisible()
    // 其他浏览器的会话已退出，只剩当前这个。
    await expect(account.getByRole("button", { name: "退出这个会话" })).toHaveCount(0)
    expect((await apiCalls(page, "/api/auth/account")).map((call) => call.body)).toEqual([
      { currentPassword: "wrong password!!", email: "other@example.com", newPassword: "another long password" },
      { currentPassword: PASSWORD, email: "other@example.com", newPassword: "another long password" },
    ])
  })

  test("只改邮箱：新密码留空，不提交 newPassword", async ({ page }) => {
    await installAuthServerMock(page, { authenticated: true })
    await page.goto("/")
    await expect(card(page)).toBeVisible()
    const settings = await openSettings(page)
    const account = settings.locator('[data-settings-section="account"]')
    await account.getByRole("button", { name: "修改邮箱或密码" }).click()
    const dialog = page.getByRole("dialog", { name: "修改邮箱或密码" })
    await dialog.getByLabel("当前密码", { exact: true }).fill(PASSWORD)
    await dialog.getByLabel("邮箱", { exact: true }).fill("work@example.com")
    await dialog.getByRole("button", { name: "保存" }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText("登录邮箱已修改")).toBeVisible()
    await expect(account.getByText("work@example.com")).toBeVisible()
    // 侧栏底部的个人中心随之换上新邮箱与首字母（设置还开着，侧栏在遮罩下，按属性找）。
    const trigger = page.locator("[data-shard-account-menu-trigger]")
    await expect(trigger).toHaveAttribute("aria-label", "个人中心：work@example.com")
    await expect(trigger).toHaveText("Wwork@example.com")
    expect((await apiCalls(page, "/api/auth/account")).map((call) => call.body)).toEqual([
      { currentPassword: PASSWORD, email: "work@example.com" },
    ])
  })
})

test("首次设置密匣前先验证登录密码，取消或验证失败不会创建密匣", async ({ page }) => {
  await installAuthServerMock(page, { authenticated: true, stepUpValid: false })
  await page.goto("/")
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "资料库", exact: true }).click()
  const entry = page.getByRole("complementary", { name: "资料库目录" }).getByRole("button", { name: "密匣（上锁空间）", exact: true })
  await entry.click()
  const prompt = page.getByRole("dialog", { name: "确认登录密码", exact: true })
  const setup = page.getByRole("dialog", { name: "设置密匣", exact: true })
  await expect(prompt).toBeVisible()
  await expect(prompt.locator('[data-slot="dialog-description"]')).toHaveCount(0)
  await expect(prompt).not.toContainText(EMAIL)
  await prompt.screenshot({ path: "/tmp/shard-password-confirm-clean.png" })
  await expect(setup).toHaveCount(0)
  await prompt.getByLabel("登录密码", { exact: true }).fill("a separate lockbox password")
  await prompt.getByRole("button", { name: "确认", exact: true }).click()
  await expect(prompt.getByRole("alert")).toHaveText("登录密码不正确。")
  await expect(setup).toHaveCount(0)
  expect(await apiCalls(page, "/api/rpc/lockbox_apply")).toEqual([])
  await prompt.getByRole("button", { name: "取消", exact: true }).click()
  await expect(prompt).toBeHidden()
  await expect(setup).toHaveCount(0)
  await expect(page.getByText("暂时无法设置密匣", { exact: true })).toHaveCount(0)
  await entry.click()
  await expect(prompt).toBeVisible()
  await prompt.getByLabel("登录密码", { exact: true }).fill(PASSWORD)
  await prompt.getByRole("button", { name: "确认", exact: true }).click()
  await expect(prompt).toBeHidden()
  await expect(setup).toBeVisible()
  await expect(setup.locator('[data-slot="dialog-description"]')).toHaveCount(0)
  expect(await apiCalls(page, "/api/rpc/lockbox_apply")).toEqual([])
})

test("网页密匣设置使用原生密码框，校验与显隐不丢失输入", async ({ page }) => {
  await installAuthServerMock(page, { authenticated: true })
  await page.goto("/")
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" }).getByRole("button", { name: "密匣（上锁空间）", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "设置密匣", exact: true })
  const password = dialog.getByLabel("新密码，至少 8 个字符", { exact: true })
  const repeat = dialog.getByLabel("再次输入新密码", { exact: true })
  for (const input of [password, repeat]) {
    await expect(input).toHaveAttribute("type", "password")
    await expect(input).toHaveAttribute("autocomplete", "off")
    await expect(input).not.toHaveAttribute("data-shard-password", /.*/)
  }
  await password.fill("short")
  await repeat.fill("short")
  await dialog.getByRole("button", { name: "设置密匣", exact: true }).click()
  await expect(dialog.getByRole("alert")).toHaveText("密匣密码至少需要 8 个字符。")
  await password.fill("test lockbox password")
  await repeat.fill("another password")
  await dialog.getByRole("button", { name: "设置密匣", exact: true }).click()
  await expect(dialog.getByRole("alert")).toHaveText("两次输入的密码不一致。")
  await dialog.getByRole("button", { name: "显示密码", exact: true }).first().click()
  await expect(password).toHaveAttribute("type", "text")
  await expect(password).toHaveValue("test lockbox password")
  await dialog.getByRole("button", { name: "隐藏密码", exact: true }).click()
  await expect(password).toHaveAttribute("type", "password")
  await expect(password).toHaveValue("test lockbox password")
  await expect(dialog.getByRole("status")).toHaveCount(0)
  expect(await apiCalls(page, "/api/rpc/lockbox_apply")).toEqual([])
})

test("密匣密码表单只显示单一 Kiln 焦点环，显隐按钮的细环留在输入框内", async ({ page }) => {
  await installAuthServerMock(page, { authenticated: true })
  await page.goto("/")
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" }).getByRole("button", { name: "密匣（上锁空间）", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "设置密匣", exact: true })
  const password = dialog.getByLabel("新密码，至少 8 个字符", { exact: true })
  const repeat = dialog.getByLabel("再次输入新密码", { exact: true })
  await password.fill("fixture password")
  await page.keyboard.press("Tab")
  const reveal = dialog.getByRole("button", { name: "显示密码", exact: true }).first()
  await expect(reveal).toBeFocused()
  await expect(reveal).toHaveCSS("outline-style", "none")
  await expect(reveal).toHaveCSS("box-shadow", /0px 0px 0px 1px inset/)
  await page.keyboard.press("Tab")
  await repeat.fill("fixture password")
  await expect(repeat).toHaveCSS("border-width", "1px")
  await expect(repeat).toHaveCSS("border-radius", "4px")
  await expect(repeat).toHaveCSS("outline-style", "none")
  await expect(repeat).toHaveCSS("box-shadow", /0px 0px 0px 1px/)
  await dialog.screenshot({ path: "/tmp/shard-kiln-password-focus.png" })
})

test("网页导航移到顶部，跟随页面切换，折叠侧栏后设置仍可访问", async ({ page }) => {
  await installAuthServerMock(page, { authenticated: true })
  await page.goto("/")
  await expect(card(page)).toBeVisible()

  const nav = page.getByRole("navigation", { name: "页面导航", exact: true })
  const sidebar = page.getByRole("complementary", { name: "Shard 侧边栏" })
  const spaces = sidebar.getByRole("navigation", { name: "工作台导航" })
  const title = nav.getByRole("heading", { level: 1 })
  await expect(nav).toBeVisible()
  await expect(nav).toHaveAttribute("data-focus-region", "page-navigation")
  await expect(page.getByRole("contentinfo", { name: "状态栏" })).toHaveCount(0)
  const box = (await nav.boundingBox())!
  expect(box.y).toBeCloseTo(0, 1)
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width)

  await spaces.getByRole("button", { name: "碎片", exact: true }).click()
  await expect(title).toHaveText("全部碎片")
  await spaces.getByRole("button", { name: /^全部碎片 \d+$/u }).click()
  await expect(title).toHaveText("全部碎片")
  await card(page).getByRole("button", { name: "打开标签主题页：骑行", exact: true }).click()
  await expect(title).toHaveText("#骑行")
  await nav.getByRole("button", { name: "碎片", exact: true }).click()
  await expect(title).toHaveText("全部碎片")
  await spaces.getByRole("button", { name: "日历", exact: true }).click()
  await expect(title).toHaveText("日历")
  await spaces.getByRole("button", { name: "资料库", exact: true }).click()
  await expect(title).toHaveText("资料库")

  await page.getByRole("button", { name: "折叠侧边栏", exact: true }).click()
  await expect(sidebar).toBeHidden()
  await expect(nav).toBeVisible()
  await nav.getByRole("button", { name: "展开侧边栏", exact: true }).click()
  await expect(sidebar).toBeVisible()

  await nav.getByText("已连接服务器", { exact: true }).click()
  const settings = page.getByRole("dialog", { name: "设置", exact: true })
  await expect(settings).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(settings).toBeHidden()
  await nav.locator("[data-shard-utility-menu-trigger]").click()
  await page.getByRole("menuitem", { name: "设置", exact: true }).click()
  await expect(settings).toBeVisible()
})

test("长草稿达到高度上限后仍保留导航下方的间距，页面不参与滚动", async ({ page }) => {
  await installAuthServerMock(page, { authenticated: true })
  await page.goto("/")
  const editor = page.locator('[data-shard-editor="composer"]')
  const composer = page.locator(".shard-content-measure").filter({ has: editor })
  await expect(editor).toBeVisible()
  // 读取捕捉框实际继承的值，网页外壳会覆盖根元素上的原生标题栏避让。
  const expectedGap = await composer.evaluate((element) =>
    parseFloat(getComputedStyle(element).getPropertyValue("--shard-composer-top-gap")))
  expect(expectedGap).toBeGreaterThan(0)

  await fillEditor(page, "composer", Array.from({ length: 120 }, (_, index) => `长草稿第 ${index + 1} 行`).join("\n"))
  await expect(editor.locator(".ProseMirror p")).toHaveCount(120)
  await expect.poll(() => composer.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(page.viewportSize()!.height / 2)
  await expect.poll(() => composer.evaluate((element) => {
    const nav = document.querySelector('nav[aria-label="页面导航"]')!
    return element.getBoundingClientRect().top - nav.getBoundingClientRect().bottom
  })).toBeCloseTo(expectedGap, 1)

  const geometry = await composer.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    contentHeight: element.querySelector(".ProseMirror")!.scrollHeight,
    scrollY: window.scrollY,
    pageOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }))
  expect(geometry.contentHeight).toBeGreaterThan(geometry.height)
  expect(geometry.scrollY).toBe(0)
  expect(geometry.pageOverflow).toBeLessThanOrEqual(1)
})

test.describe("个人中心", () => {
  const sidebar = (page: Page) => page.getByRole("complementary", { name: "Shard 侧边栏" })
  const trigger = (page: Page) => sidebar(page).getByRole("button", { name: `个人中心：${EMAIL}` })

  async function openThemeMenu(page: Page) {
    if (await trigger(page).getAttribute("aria-expanded") !== "true") await trigger(page).click()
    const theme = page.getByRole("menuitem", { name: "主题", exact: true })
    if (await theme.getAttribute("aria-expanded") !== "true") await theme.click()
    await expect(page.getByRole("menuitemradio", { name: "跟随系统" })).toBeVisible()
  }

  test("钉在侧栏底部：陶土红头像与登录邮箱，和导航项对齐；菜单向上打开「账号与安全」", async ({ page }) => {
    await installAuthServerMock(page, { authenticated: true })
    await page.goto("/")
    await expect(card(page)).toBeVisible()
    await expect(trigger(page)).toBeVisible()
    await expect(trigger(page)).toHaveText(`M${EMAIL}`)

    const geometry = await page.evaluate(() => {
      const aside = document.querySelector('aside[aria-label="Shard 侧边栏"]') as HTMLElement
      const button = aside.querySelector("[data-shard-account-menu-trigger]") as HTMLElement
      const [avatar, email] = Array.from(button.querySelectorAll(":scope > span")) as HTMLElement[]
      const nav = Array.from(aside.querySelectorAll("nav button")).find((node) => node.textContent?.startsWith("日历")) as HTMLElement
      const navIcon = nav.querySelector("svg") as SVGElement
      const navLabel = nav.querySelector("span") as HTMLElement
      const box = (node: Element) => node.getBoundingClientRect()
      const center = (node: Element) => box(node).left + box(node).width / 2
      const avatarStyle = getComputedStyle(avatar)
      return {
        avatarBackground: avatarStyle.backgroundColor,
        avatarColor: avatarStyle.color,
        avatarCenter: center(avatar),
        navIconCenter: center(navIcon),
        emailLeft: box(email).left,
        navLabelLeft: box(navLabel).left,
        buttonHeight: box(button).height,
        navHeight: box(nav).height,
        buttonBackground: getComputedStyle(button).backgroundColor,
        footerBottom: box(button.parentElement as HTMLElement).bottom,
        asideBottom: box(aside).bottom,
      }
    })
    // 陶土红实底 + 白字（kiln --primary / --primary-foreground）；触发器本身不是陶土红按钮。
    expect(geometry.avatarBackground).toBe("rgb(182, 83, 60)")
    expect(geometry.avatarColor).toBe("rgb(255, 255, 255)")
    expect(geometry.buttonBackground).not.toBe("rgb(182, 83, 60)")
    // 与导航项同高；头像中心对齐导航图标中心，邮箱左缘对齐导航文字左缘；钉在侧栏最底。
    expect(geometry.buttonHeight).toBe(geometry.navHeight)
    expect(Math.abs(geometry.avatarCenter - geometry.navIconCenter)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(geometry.emailLeft - geometry.navLabelLeft)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(geometry.asideBottom - geometry.footerBottom)).toBeLessThanOrEqual(1)

    await trigger(page).click()
    const menu = page.getByRole("menu")
    await expect(menu.getByRole("menuitem")).toHaveText(["账号与安全", "主题", "退出登录"])
    await menu.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)))
    const [menuBox, triggerBox] = await Promise.all([menu.boundingBox(), trigger(page).boundingBox()])
    expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual(triggerBox?.y ?? 0)

    await menu.getByRole("menuitem", { name: "账号与安全" }).click()
    const settings = page.getByRole("dialog", { name: "设置" })
    await expect(settings).toBeVisible()
    await expect(settings.getByRole("button", { name: "账号与安全" })).toHaveAttribute("aria-current", "true")
    const account = settings.locator('[data-settings-section="account"]')
    await expect(account.getByText(EMAIL)).toBeVisible()
    await expect(account.getByRole("button", { name: "修改邮箱或密码" })).toBeInViewport()
  })

  test("退出登录：通知服务器后回到登录页", async ({ page }) => {
    await installAuthServerMock(page, { authenticated: true })
    await page.goto("/")
    await expect(card(page)).toBeVisible()
    await trigger(page).click()
    await page.getByRole("menuitem", { name: "退出登录" }).click()
    await expect(page.getByRole("heading", { name: "登录" })).toBeVisible()
    // 假服务端收到了退出请求（调用记录随重载清空，看它留下的标记）。
    expect(await page.evaluate(() => sessionStorage.getItem("__AUTH_SIGNED_OUT__"))).toBe("1")
  })

  test("主题菜单切换日夜并持久化，固定模式不跟随系统", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" })
    await installAuthServerMock(page, { authenticated: true })
    await page.goto("/")
    await expect(card(page)).toBeVisible()

    await openThemeMenu(page)
    await expect(page.getByRole("menuitemradio", { name: "跟随系统" })).toBeChecked()
    await page.getByRole("menuitemradio", { name: "深色" }).click()
    await expect(page.locator("html")).toHaveClass(/\bdark\b/)
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(22, 18, 15)")
    expect(await page.evaluate(() => localStorage.getItem("shard.colorMode"))).toBe("dark")

    await page.reload()
    await expect(trigger(page)).toBeVisible()
    await expect(page.locator("html")).toHaveClass(/\bdark\b/)
    await openThemeMenu(page)
    await expect(page.getByRole("menuitemradio", { name: "深色" })).toBeChecked()
    await page.getByRole("menuitemradio", { name: "浅色" }).click()
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/)
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(251, 250, 248)")
    expect(await page.evaluate(() => localStorage.getItem("shard.colorMode"))).toBe("light")
    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/)

    await openThemeMenu(page)
    await page.getByRole("menuitemradio", { name: "跟随系统" }).click()
    await expect(page.locator("html")).toHaveClass(/\bdark\b/)
    await page.emulateMedia({ colorScheme: "light" })
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/)
  })

  test("主题菜单支持键盘，和设置里的外观选择保持一致", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" })
    await installAuthServerMock(page, { authenticated: true })
    await page.goto("/")
    await expect(card(page)).toBeVisible()

    await trigger(page).focus()
    await page.keyboard.press("Enter")
    const theme = page.getByRole("menuitem", { name: "主题", exact: true })
    await theme.focus()
    await page.keyboard.press("ArrowRight")
    const dark = page.getByRole("menuitemradio", { name: "深色" })
    await expect(dark).toBeVisible()
    await dark.focus()
    await page.keyboard.press("Enter")
    await expect(page.locator("html")).toHaveClass(/\bdark\b/)
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await expect(trigger(page)).toBeFocused()

    const settings = await openSettings(page)
    await settings.getByRole("button", { name: "外观", exact: true }).click()
    await expect(settings.getByRole("button", { name: "深色", exact: true })).toHaveAttribute("aria-pressed", "true")
    await settings.getByRole("button", { name: "浅色", exact: true }).click()
    await page.keyboard.press("Escape")
    await expect(settings).toBeHidden()
    await openThemeMenu(page)
    await expect(page.getByRole("menuitemradio", { name: "浅色" })).toBeChecked()
    await page.getByRole("menuitemradio", { name: "深色" }).click()
    await trigger(page).click()
    const reopened = await openSettings(page)
    await reopened.getByRole("button", { name: "外观", exact: true }).click()
    await expect(reopened.getByRole("button", { name: "深色", exact: true })).toHaveAttribute("aria-pressed", "true")
  })

  test("网页默认陶土红；外观里选过别的颜色就照旧，头像跟着强调色", async ({ page }) => {
    await installAuthServerMock(page, { authenticated: true })
    await page.goto("/")
    await expect(card(page)).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("data-shard-theme", "clay")

    await page.evaluate(() => localStorage.setItem("shard.accentTheme", "peacock"))
    await page.reload()
    await expect(trigger(page)).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("data-shard-theme", "peacock")
    const avatar = trigger(page).locator("span").first()
    await expect(avatar).toHaveCSS("background-color", "rgb(46, 110, 121)")
  })
})
