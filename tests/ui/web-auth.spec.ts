import { expect, test, type Page } from "@playwright/test"

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
        authenticated: options.authenticated ?? false,
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
        if (path === "/api/auth/logout") return json({ ok: true })
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

    // 前端先拦，不发请求。
    await submit.click()
    await expect(page.getByRole("alert")).toHaveText("请填写邮箱。")
    await email.fill("me@@example.com")
    await submit.click()
    await expect(page.getByRole("alert")).toHaveText("邮箱格式不对。")
    await email.fill(EMAIL)
    await submit.click()
    await expect(page.getByRole("alert")).toHaveText("请填写密码。")
    expect(await apiCalls(page, "/api/auth/login")).toEqual([])

    await password.fill("wrong password!!")
    await submit.click()
    await expect(page.getByRole("alert")).toHaveText("邮箱或密码不对。")
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
    await expect(page.getByText("打开它给出的链接设置邮箱和密码", { exact: false })).toBeVisible()
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
    await expect(page.getByText("至少 12 个字符", { exact: false })).toBeVisible()

    const submit = page.getByRole("button", { name: "设置并登录" })
    await email.fill("New@Example.com")
    await password.fill("short-pass1")
    await repeat.fill("short-pass1")
    await submit.click()
    await expect(page.getByRole("alert")).toHaveText("密码至少 12 个字符。")
    await password.fill("a long enough password")
    await repeat.fill("a long enough passw0rd")
    await submit.click()
    await expect(page.getByRole("alert")).toHaveText("两次输入的密码不一致。")
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
    await expect(page.getByText("这个链接无效或已过期。")).toBeVisible()
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

    const prompt = page.getByRole("dialog", { name: "输入密码确认" })
    await expect(prompt).toBeVisible()
    const password = prompt.getByLabel("密码", { exact: true })
    await expect(password).toBeFocused()
    await expect(password).toHaveAttribute("type", "password")
    await expect(password).toHaveAttribute("autocomplete", "current-password")

    // 空着提交：框内提示，不发请求。
    await prompt.getByRole("button", { name: "确认" }).click()
    await expect(prompt.getByRole("alert")).toHaveText("请输入密码。")

    await password.fill("wrong password!!")
    await prompt.getByRole("button", { name: "确认" }).click()
    await expect(prompt.getByRole("alert")).toHaveText("密码不对。")
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

    const prompt = page.getByRole("dialog", { name: "输入密码确认" })
    await prompt.getByLabel("密码", { exact: true }).fill("typed but cancelled")
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

    const prompt = page.getByRole("dialog", { name: "输入密码确认" })
    await prompt.getByLabel("密码", { exact: true }).fill(PASSWORD)
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
    await next.fill("too short")
    await save.click()
    await expect(dialog.getByRole("alert")).toHaveText("密码至少 12 个字符。")
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
    expect((await apiCalls(page, "/api/auth/account")).map((call) => call.body)).toEqual([
      { currentPassword: PASSWORD, email: "work@example.com" },
    ])
  })
})
