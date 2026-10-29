import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test"

/**
 * 邮箱密码登录走真实 shard-server（见 playwright.e2e.config.ts），不经 test-auth 的免密会话：
 * 服务器上 `shard-server setup` 的一次性链接 → 设置账号并登录 → 另一个浏览器输错再输对 → 过期后吊销它要再输一次密码 →
 * 改密码让其他浏览器退出 → `reset-password` 链接重置后全部浏览器退出。最后核对认证库里没有明文密码。
 */

const EMAIL = "e2e@example.com"
const PASSWORD = "e2e first password"
const CHANGED = "e2e changed password"
const RESET = "e2e reset password"

test.describe.configure({ mode: "serial" })

function dataDir() {
  const dir = process.env.SHARD_E2E_DATA_DIR
  if (!dir) throw new Error("缺少 SHARD_E2E_DATA_DIR（由 playwright.e2e.config.ts 设置）")
  return dir
}

/** 像管理员在服务器上一样生成链接，返回站内路径（`/setup#token=…`）。 */
function adminLink(baseURL: string, command: "setup" | "reset-password") {
  const output = execFileSync("target/debug/shard-server", [command, "--data-dir", dataDir(), "--origin", baseURL], {
    encoding: "utf8",
  })
  const link = new URL(output.trim().split("\n").at(-1) ?? "")
  expect(link.pathname).toBe("/setup")
  return `${link.pathname}${link.hash}`
}

async function newPage(browser: Browser, baseURL: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL, locale: "zh-CN", viewport: { height: 800, width: 1280 } })
  return { context, page: await context.newPage() }
}

async function expectWorkbench(page: Page) {
  await expect(page.locator('[data-shard-editor="composer"]')).toBeVisible()
}

async function login(page: Page, email: string, password: string) {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "登录" })).toBeVisible()
  await page.getByLabel("邮箱", { exact: true }).fill(email)
  await page.getByLabel("密码", { exact: true }).fill(password)
  await page.getByRole("button", { name: "登录", exact: true }).click()
}

async function openAccount(page: Page) {
  await page.getByText("已连接服务器").click()
  const settings = page.getByRole("dialog", { name: "设置" })
  await expect(settings).toBeVisible()
  return settings.locator('[data-settings-section="account"]')
}

/** 让这个浏览器的「10 分钟内输过密码」过期（登录本身算一次），好测再次输入。 */
async function expireStepUp(context: BrowserContext, baseURL: string) {
  const response = await context.request.post("/api/test/step-up?expire=1", {
    headers: { "x-shard-request": "1", origin: baseURL, "sec-fetch-site": "same-origin" },
  })
  expect(response.ok(), await response.text()).toBe(true)
}

test("首次设置、登录、再次输入密码、改密码与重置", async ({ browser, baseURL }) => {
  const origin = baseURL ?? ""

  // 管理员生成首次设置链接；有了账号之后不能再生成。
  const setupLink = adminLink(origin, "setup")
  const owner = await newPage(browser, origin)
  await owner.page.goto(setupLink)
  await expect(owner.page.getByRole("heading", { name: "设置账号" })).toBeVisible()
  await owner.page.getByLabel("邮箱", { exact: true }).fill("  E2E@Example.com ")
  await owner.page.getByLabel("密码", { exact: true }).fill(PASSWORD)
  await owner.page.getByLabel("确认密码", { exact: true }).fill(PASSWORD)
  await owner.page.getByRole("button", { name: "设置并登录" }).click()
  await expectWorkbench(owner.page)
  await expect(owner.page).toHaveURL(/\/$/u)
  expect(() => adminLink(origin, "setup")).toThrow()
  // 链接只能用一次。
  const reused = await newPage(browser, origin)
  await reused.page.goto(setupLink)
  await expect(reused.page.getByRole("heading", { name: "链接无效或已过期" })).toBeVisible()
  await reused.context.close()

  // 另一个浏览器：输错再输对。
  const phone = await newPage(browser, origin)
  await login(phone.page, EMAIL, "not the password")
  await expect(phone.page.getByRole("alert")).toHaveText("邮箱或密码不对。")
  await login(phone.page, EMAIL, PASSWORD)
  await expectWorkbench(phone.page)

  // 主浏览器的确认过期后让手机退出：先弹密码框，输错可重试，确认后才执行。
  await expireStepUp(owner.context, origin)
  const account = await openAccount(owner.page)
  await expect(account.getByText(EMAIL)).toBeVisible()
  // 同一个服务器上前面的用例也留下了会话；列表按最近活动排序，刚登录的手机排在最前。
  await account.getByRole("button", { name: "退出这个会话" }).first().click()
  const prompt = owner.page.getByRole("dialog", { name: "输入密码确认" })
  await prompt.getByLabel("密码", { exact: true }).fill("still not it")
  await prompt.getByRole("button", { name: "确认" }).click()
  await expect(prompt.getByRole("alert")).toHaveText("密码不对。")
  await prompt.getByLabel("密码", { exact: true }).fill(PASSWORD)
  await prompt.getByRole("button", { name: "确认" }).click()
  await expect(prompt).toBeHidden()
  await expect(owner.page.getByText("已让这个会话退出")).toBeVisible()
  await phone.page.reload()
  await expect(phone.page.getByRole("heading", { name: "登录" })).toBeVisible()

  // 手机重新登录，主浏览器改密码：手机退出，旧密码失效。
  await login(phone.page, EMAIL, PASSWORD)
  await expectWorkbench(phone.page)
  await account.getByRole("button", { name: "修改邮箱或密码" }).click()
  const dialog = owner.page.getByRole("dialog", { name: "修改邮箱或密码" })
  await dialog.getByLabel("当前密码", { exact: true }).fill(PASSWORD)
  await dialog.getByLabel("新密码", { exact: true }).fill(CHANGED)
  await dialog.getByLabel("确认新密码", { exact: true }).fill(CHANGED)
  await dialog.getByRole("button", { name: "保存" }).click()
  await expect(owner.page.getByText("密码已修改，其他浏览器已退出登录")).toBeVisible()
  await phone.page.reload()
  await expect(phone.page.getByRole("heading", { name: "登录" })).toBeVisible()
  await login(phone.page, EMAIL, PASSWORD)
  await expect(phone.page.getByRole("alert")).toHaveText("邮箱或密码不对。")
  await login(phone.page, EMAIL, CHANGED)
  await expectWorkbench(phone.page)

  // 忘记密码：管理员生成重置链接，预填邮箱；重置后所有浏览器退出。
  const resetPage = await newPage(browser, origin)
  await resetPage.page.goto(adminLink(origin, "reset-password"))
  await expect(resetPage.page.getByRole("heading", { name: "重置密码" })).toBeVisible()
  await expect(resetPage.page.getByLabel("邮箱", { exact: true })).toHaveValue(EMAIL)
  await resetPage.page.getByLabel("新密码", { exact: true }).fill(RESET)
  await resetPage.page.getByLabel("确认新密码", { exact: true }).fill(RESET)
  await resetPage.page.getByRole("button", { name: "重置并登录" }).click()
  await expectWorkbench(resetPage.page)
  for (const signedOut of [owner.page, phone.page]) {
    await signedOut.reload()
    await expect(signedOut.getByRole("heading", { name: "登录" })).toBeVisible()
  }
  await login(owner.page, EMAIL, RESET)
  await expectWorkbench(owner.page)

  for (const session of [owner, phone, resetPage]) await session.context.close()

  // 认证库里只有 argon2id 哈希，没有任何一个明文密码。
  const authFiles = fs.readdirSync(dataDir()).filter((name) => name.startsWith("auth.db"))
  expect(authFiles.length).toBeGreaterThan(0)
  for (const name of authFiles) {
    const bytes = fs.readFileSync(path.join(dataDir(), name))
    for (const secret of [PASSWORD, CHANGED, RESET]) {
      expect(bytes.includes(Buffer.from(secret, "utf8")), `${name} 里出现了明文密码`).toBe(false)
    }
  }
})
