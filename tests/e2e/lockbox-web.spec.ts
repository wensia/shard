import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { expect, test, type Browser, type BrowserContext, type Page, type Request } from "@playwright/test"

import { fillEditor, readEditor } from "../ui/editor-helpers"

/**
 * 网页端密匣（真实 shard-server + vite，见 playwright.e2e.config.ts）：
 * 设置 → 锁着 #密匣 速记 → 解锁看到并编辑 → 上锁看不到 → 公开笔记 / 碎片移入密匣 → 改口令 →
 * 另一个浏览器上下文经 SSE 看到变化 → 关掉网页解锁后锁着仍能速记、不能解锁。
 *
 * 全程记录浏览器发出的请求：口令、恢复密钥与密匣正文（金丝雀）一个都不能出现在请求里；
 * 最后在服务器数据目录的 shard.db* / blobs.db* 里找全部金丝雀（含先以明文存在、后被移入密匣的），必须为 0。
 */

const PASSWORD = "e2e lockbox password"
const NEW_PASSWORD = "e2e changed password"
const CANARY = {
  locked: "CANARY-锁着速记-a1f3",
  edit: "CANARY-解锁后编辑-b2e4",
  note: "CANARY-公开笔记原文-c3d5",
  fragmentOriginal: "CANARY-公开碎片原文-d4c6",
  fragmentSaved: "CANARY-保存进密匣-e5b7",
  sse: "CANARY-另一个窗口-f6a8",
  webUnlockOff: "CANARY-关掉网页解锁-g7f9",
}
/** 只在浏览器里出现、绝不能发给服务器的明文（公开原文两条是先经服务器创建的，不在此列）。 */
const NEVER_SENT = [PASSWORD, NEW_PASSWORD, CANARY.locked, CANARY.edit, CANARY.fragmentSaved, CANARY.sse, CANARY.webUnlockOff]
const NOTE_TITLE = "E2E 待移入的笔记"

test.describe.configure({ mode: "serial" })

const leaks: string[] = []
const secrets = [...NEVER_SENT]

/**
 * 一段明文可能以哪些样子出现在请求里：原文、URL 编码、base64 / base64url（三种字节对齐各取中间稳定的一段）。
 */
function encodings(secret: string): string[] {
  const bytes = Buffer.from(secret, "utf8")
  const forms = [secret, encodeURIComponent(secret)]
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64")
    // 前面补的字节影响开头 1–3 个字符，结尾的补齐影响最后几个字符：只取中间。
    const middle = encoded.slice(offset === 0 ? 0 : offset + 1, encoded.length - 4)
    if (middle.length >= 12) forms.push(middle, middle.replace(/\+/gu, "-").replace(/\//gu, "_"))
  }
  return forms
}

function scanRequest(request: Request) {
  const body = request.postDataBuffer() ?? Buffer.alloc(0)
  const haystacks = [
    request.url(),
    safeDecode(request.url()),
    body.toString("utf8"),
    body.toString("latin1"),
    ...Object.entries(request.headers()).map(([name, value]) => `${name}: ${value}`),
  ]
  for (const secret of secrets) {
    const hit = encodings(secret).some((form) => haystacks.some((text) => text.includes(form)) || body.includes(Buffer.from(form, "utf8")))
    if (hit) leaks.push(`${request.method()} ${request.url()}：${secret}`)
  }
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

async function openSession(browser: Browser, baseURL: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL, locale: "zh-CN", viewport: { height: 800, width: 1280 } })
  context.on("request", scanRequest)
  const login = await context.request.post("/api/test/session", { headers: headers(baseURL) })
  expect(login.ok(), await login.text()).toBe(true)
  const page = await context.newPage()
  await page.goto("/")
  await waitForVault(page)
  return { context, page }
}

/** 碎片列表（连同密匣状态）读回来以后才能操作：速记进密匣前要知道密匣已设置。 */
async function waitForVault(page: Page) {
  await expect(page.locator('[data-shard-editor="composer"]')).toBeVisible()
  await expect(page.locator("[data-shard-fragment-id]").first()).toBeVisible()
}

function headers(baseURL: string) {
  return { "x-shard-request": "1", origin: baseURL, "sec-fetch-site": "same-origin" }
}

async function rpc<T = Record<string, any>>(context: BrowserContext, baseURL: string, command: string, args: object = {}): Promise<T> {
  const response = await context.request.post(`/api/rpc/${command}`, {
    data: args,
    headers: { ...headers(baseURL), "idempotency-key": randomUUID(), "x-shard-utc-offset": "480" },
  })
  expect(response.ok(), `${command}：${await response.text()}`).toBe(true)
  return (await response.json()) as T
}

async function stepUp(context: BrowserContext, baseURL: string) {
  const response = await context.request.post("/api/test/step-up", { headers: headers(baseURL) })
  expect(response.ok(), await response.text()).toBe(true)
}

async function goToFragments(page: Page) {
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "碎片", exact: true }).click()
  await expect(page.locator('[data-shard-editor="composer"]')).toBeVisible()
}

async function capture(page: Page, text: string) {
  await goToFragments(page)
  await fillEditor(page, "composer", text)
  await page.getByRole("button", { name: "保存片段", exact: true }).click()
  await expect.poll(() => readEditor(page, "composer")).toBe("")
}

async function openLockboxSpace(page: Page) {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page
    .getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: "密匣（上锁空间）", exact: true })
    .click()
}

async function unlock(page: Page, password: string) {
  await openLockboxSpace(page)
  const gate = page.getByRole("form", { name: "解锁密匣" })
  await gate.getByPlaceholder("密匣密码").fill(password)
  await gate.getByRole("button", { name: "解锁", exact: true }).click()
  await expect(page.getByRole("heading", { name: "密匣", exact: true })).toBeVisible()
}

function card(page: Page, id: string) {
  return page.locator(`[data-shard-fragment-id="${id}"]`)
}

interface Snapshot {
  configured: boolean
  itemsWithheld: boolean
  webUnlock: boolean
  manifest: { body: string; sha: string } | null
  items: Array<{ id: string; sha: string; path: string | null; envelope: string }>
}

test("网页端密匣：设置、速记、解锁编辑、移入、改口令、SSE 同步、网页解锁开关，明文不出浏览器", async ({ browser, baseURL }) => {
  const base = baseURL!
  const { context, page } = await openSession(browser, base)
  const snapshot = () => rpc<Snapshot>(context, base, "lockbox_snapshot")

  await test.step("自检：请求监视能抓到浏览器发出的明文（原文、请求头、base64）", async () => {
    secrets.push("LEAK-PROBE-明文探针")
    await page.evaluate(() => fetch("/healthz", { method: "POST", body: "LEAK-PROBE-明文探针" }).catch(() => undefined))
    await expect.poll(() => leaks.length).toBe(1)
    await page.evaluate(() => fetch("/healthz", { headers: { "x-probe": encodeURIComponent("LEAK-PROBE-明文探针") } }).catch(() => undefined))
    await expect.poll(() => leaks.length).toBe(2)
    await page.evaluate(() => {
      const bytes = new TextEncoder().encode("xyLEAK-PROBE-明文探针")
      const base64 = btoa(String.fromCharCode(...bytes))
      return fetch("/healthz", { method: "POST", body: JSON.stringify({ data: base64 }) }).catch(() => undefined)
    })
    await expect.poll(() => leaks.length).toBe(3)
    await page.evaluate(() => fetch("/healthz", { method: "POST", body: new TextEncoder().encode("\u0000LEAK-PROBE-明文探针") }).catch(() => undefined))
    await expect.poll(() => leaks.length).toBe(4)
    secrets.pop()
    leaks.length = 0
  })

  await test.step("在网页上设置密匣，拿到恢复密钥", async () => {
    await openLockboxSpace(page)
    const dialog = page.getByRole("dialog", { name: "设置密匣" })
    await dialog.getByPlaceholder("新密码，至少 8 个字符").fill(PASSWORD)
    await dialog.getByPlaceholder("再次输入新密码").fill(PASSWORD)
    await dialog.getByRole("button", { name: "设置密匣", exact: true }).click()
    const keyDialog = page.getByRole("dialog", { name: "保存恢复密钥" })
    const recoveryKey = (await keyDialog.getByText(/^shard-[0-9a-f]{6}(-[0-9a-f]{6})+$/u).textContent())!.trim()
    secrets.push(recoveryKey)
    const code = recoveryKey.split("-").at(-1)!
    await keyDialog.getByPlaceholder(code).fill(code)
    await keyDialog.getByRole("button", { name: "我已保存恢复密钥", exact: true }).click()
    await expect(keyDialog).toHaveCount(0)

    const after = await snapshot()
    expect(after.configured).toBe(true)
    expect(after.items).toEqual([])
    expect(after.manifest!.body).not.toContain(PASSWORD)
  })

  let lockedId = ""
  await test.step("锁着用 #密匣 速记：公钥加密写入，不需要口令", async () => {
    await capture(page, `${CANARY.locked} #密匣`)
    await expect(page.getByText("已保存到密匣")).toBeVisible()
    await expect.poll(async () => (await snapshot()).items.length).toBe(1)
    const [item] = (await snapshot()).items
    lockedId = item.id
    expect(item.envelope).not.toContain(CANARY.locked)
    expect(item.path).toMatch(/^lockbox\/fragments\/\d{4}\/\d{2}\/.+\.shard$/u)
    // 公开列表里没有它；锁着时界面上也看不到正文。
    const listed = await rpc(context, base, "list_fragments")
    expect(listed.fragments.some((fragment: { id: string }) => fragment.id === lockedId)).toBe(false)
    await expect(page.getByText(CANARY.locked)).toHaveCount(0)
  })

  await test.step("解锁后看到并编辑；上锁后看不到", async () => {
    await unlock(page, PASSWORD)
    const target = card(page, lockedId)
    await expect(target).toContainText(CANARY.locked)
    const before = (await snapshot()).items[0].sha

    await target.getByRole("button", { name: "片段操作" }).click()
    await page.getByRole("menuitem", { name: "编辑", exact: true }).click()
    const editorId = `fragment:${lockedId}`
    await expect(page.locator(`[data-shard-editor="${editorId}"] .ProseMirror`)).toBeVisible()
    await fillEditor(page, editorId, `${CANARY.edit} 第二段`)
    await page.getByRole("heading", { name: "密匣", exact: true }).click()
    await expect(target).toContainText(CANARY.edit)
    await expect.poll(async () => (await snapshot()).items[0].sha).not.toBe(before)
    expect((await snapshot()).items[0].envelope).not.toContain(CANARY.edit)

    await page.getByRole("button", { name: "上锁", exact: true }).click()
    await expect(page.getByRole("complementary", { name: "资料库目录" })).toBeVisible()
    await openLockboxSpace(page)
    await expect(page.getByRole("heading", { name: "密匣已上锁", exact: true })).toBeVisible()
    await expect(page.getByText(CANARY.edit)).toHaveCount(0)
    await expect(card(page, lockedId)).toHaveCount(0)
  })

  let noteId = ""
  let fragmentId = ""
  await test.step("把公开笔记与公开碎片移入密匣（锁着，用公钥）", async () => {
    const created = await rpc(context, base, "create_library_note", { parentPath: "notes", title: NOTE_TITLE })
    noteId = created.fragment.id
    await rpc(context, base, "update_fragment", {
      id: noteId,
      content: `${CANARY.note} 笔记正文`,
      tags: created.fragment.tags,
      expectedFileSha: created.fragment.fileSha,
    })
    const fragment = await rpc(context, base, "create_fragment", { content: CANARY.fragmentOriginal, tags: ["inbox"] })
    fragmentId = fragment.id
    await page.reload()
    await waitForVault(page)

    // 资料库里的笔记：条目菜单「移入密匣」。
    await page.getByRole("button", { name: "资料库", exact: true }).click()
    await page.getByRole("complementary", { name: "资料库目录" }).getByRole("button", { name: /^文件（/u }).click()
    const rootList = page.getByRole("region", { name: "notes 目录列表", exact: true })
    await expect(rootList.getByRole("button", { name: `打开文件 ${NOTE_TITLE}.md`, exact: true })).toBeVisible()
    page.once("dialog", (dialog) => void dialog.accept())
    await rootList.getByRole("button", { name: `${NOTE_TITLE}.md 操作`, exact: true }).click()
    await page.getByRole("menuitem", { name: "移入密匣", exact: true }).click()
    await expect(page.getByText("已移入密匣")).toBeVisible()
    await expect(rootList.getByRole("button", { name: `打开文件 ${NOTE_TITLE}.md`, exact: true })).toHaveCount(0)

    // 碎片流里的公开碎片：编辑时加上 #密匣，保存即整篇移入，新正文不经服务器明文。
    await goToFragments(page)
    const publicCard = card(page, fragmentId)
    await expect(publicCard).toContainText(CANARY.fragmentOriginal)
    await publicCard.getByRole("button", { name: "片段操作" }).click()
    await page.getByRole("menuitem", { name: "编辑", exact: true }).click()
    const editorId = `fragment:${fragmentId}`
    await expect(page.locator(`[data-shard-editor="${editorId}"] .ProseMirror`)).toBeVisible()
    await fillEditor(page, editorId, `${CANARY.fragmentSaved} #密匣`)
    await page.locator('[data-shard-editor="composer"]').click()
    await expect(card(page, fragmentId)).toHaveCount(0)

    const listed = await rpc(context, base, "list_fragments")
    const ids = listed.fragments.map((item: { id: string }) => item.id)
    expect(ids).not.toContain(noteId)
    expect(ids).not.toContain(fragmentId)
    const items = (await snapshot()).items
    expect(items.map((item) => item.id).sort()).toEqual([lockedId, noteId, fragmentId].sort())
    // 服务器上的路径只由 id 推出：笔记标题只在加密载荷里（解锁后的笔记树照样显示标题，见下一步）。
    expect(items.find((item) => item.id === noteId)!.path).toBe(`lockbox/notes/${noteId}.shard`)
    for (const item of items) expect(item.path ?? "").not.toContain(NOTE_TITLE)
    // 明文历史随移入一起抹掉。
    const history = await context.request.post("/api/rpc/list_revisions", {
      data: { id: fragmentId },
      headers: { ...headers(base), "idempotency-key": randomUUID() },
    })
    expect(history.status()).toBe(404)
  })

  await test.step("改口令：旧口令失效，内容不受影响", async () => {
    await unlock(page, PASSWORD)
    await expect(card(page, lockedId)).toContainText(CANARY.edit)
    await expect(card(page, fragmentId)).toContainText(CANARY.fragmentSaved)
    await expect(page.getByRole("navigation", { name: "密匣笔记" }).getByRole("button", { name: NOTE_TITLE, exact: true })).toBeVisible()
    const envelopes = Object.fromEntries((await snapshot()).items.map((item) => [item.id, item.sha]))

    await page.getByRole("button", { name: "修改密码", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "修改密匣密码" })
    await dialog.getByPlaceholder("当前密码").fill(PASSWORD)
    await dialog.getByPlaceholder("新密码，至少 8 个字符").fill(NEW_PASSWORD)
    await dialog.getByPlaceholder("再次输入新密码").fill(NEW_PASSWORD)
    await dialog.getByRole("button", { name: "修改密码", exact: true }).click()
    await expect(page.getByText("密匣密码已修改")).toBeVisible()
    // 只重包 manifest，信封一条没动。
    expect(Object.fromEntries((await snapshot()).items.map((item) => [item.id, item.sha]))).toEqual(envelopes)

    await page.getByRole("button", { name: "上锁", exact: true }).click()
    await openLockboxSpace(page)
    const gate = page.getByRole("form", { name: "解锁密匣" })
    await gate.getByPlaceholder("密匣密码").fill(PASSWORD)
    await gate.getByRole("button", { name: "解锁", exact: true }).click()
    await expect(gate.getByRole("alert")).toHaveText("密码不正确。")
    await gate.getByPlaceholder("密匣密码").fill(NEW_PASSWORD)
    await gate.getByRole("button", { name: "解锁", exact: true }).click()
    await expect(card(page, lockedId)).toContainText(CANARY.edit)
  })

  await test.step("密匣空间里的搜索只在浏览器内存里做（查询词也不发给服务器）", async () => {
    await page.keyboard.press("Control+k")
    const palette = page.getByRole("dialog", { name: "搜索", exact: true })
    const input = palette.getByRole("combobox", { name: "搜索内容" })
    await input.fill(CANARY.edit)
    await expect(palette.getByRole("option").filter({ hasText: CANARY.edit })).toHaveCount(1)
    // 公开内容不出现在密匣范围里。
    await input.fill("沿江骑了")
    await expect(palette.getByRole("option")).toHaveCount(0)
    await input.fill(CANARY.edit)
    // 打开结果（本地解密读取目标）：回到密匣空间定位到那张卡片，没有报错。
    await palette.getByRole("option").filter({ hasText: CANARY.edit }).click()
    await expect(palette).toHaveCount(0)
    await expect(card(page, lockedId)).toContainText(CANARY.edit)
    await expect(page.getByRole("heading", { name: "密匣", exact: true })).toBeVisible()
  })

  await test.step("另一个浏览器上下文写入密匣，这边经 SSE 看到", async () => {
    const other = await openSession(browser, base)
    await capture(other.page, `${CANARY.sse} #密匣`)
    await expect(other.page.getByText("已保存到密匣")).toBeVisible()
    // 第一个上下文停在已解锁的密匣空间里，不刷新页面。
    await expect(page.locator("[data-shard-fragment-id]").filter({ hasText: CANARY.sse })).toBeVisible()
    await other.context.close()
  })

  await test.step("关掉网页解锁：密匣空间只显示提示，锁着的 #密匣 速记照常可用", async () => {
    await stepUp(context, base)
    await page.getByRole("button", { name: "更多操作" }).click()
    await page.getByRole("menuitem", { name: "设置" }).click()
    const toggle = page.getByRole("switch", { name: "允许在网页解锁密匣" })
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect(page.getByText("已关闭网页解锁")).toBeVisible()
    await expect(toggle).not.toBeChecked()
    await page.keyboard.press("Escape")

    // 本页立即上锁，服务器不再下发密文。
    await expect(page.getByText(CANARY.edit)).toHaveCount(0)
    const withheld = await snapshot()
    expect(withheld.webUnlock).toBe(false)
    expect(withheld.itemsWithheld).toBe(true)
    expect(withheld.items).toEqual([])

    await openLockboxSpace(page)
    await expect(page.getByRole("heading", { name: "网页解锁已关闭", exact: true })).toBeVisible()
    await expect(page.getByRole("form", { name: "解锁密匣" })).toHaveCount(0)

    await capture(page, `${CANARY.webUnlockOff} #密匣`)
    await expect(page.getByText("已保存到密匣").last()).toBeVisible()

    // 重新打开后，关着时记下的那条也能解开。
    await stepUp(context, base)
    await rpc(context, base, "set_lockbox_web_unlock", { allowed: true })
    expect((await snapshot()).items).toHaveLength(5)
    await page.reload()
    await waitForVault(page)
    await unlock(page, NEW_PASSWORD)
    await expect(page.locator("[data-shard-fragment-id]").filter({ hasText: CANARY.webUnlockOff })).toBeVisible()
    await page.getByRole("button", { name: "上锁", exact: true }).click()
  })

  await test.step("口令、恢复密钥与密匣正文没有出现在任何请求里，服务器库文件里找不到任何金丝雀", async () => {
    expect(leaks).toEqual([])
    const dataDir = process.env.SHARD_E2E_DATA_DIR!
    const files = fs.readdirSync(dataDir).filter((name) => /^(shard|blobs)\.db/u.test(name))
    expect(files).toContain("shard.db")
    const found: string[] = []
    const contains = (needle: string) =>
      files.some((name) => fs.readFileSync(path.join(dataDir, name)).includes(Buffer.from(needle, "utf8")))
    // 自检：公开内容确实以明文在库里（找得到才说明找不到金丝雀有意义）。
    expect(contains("早上沿江骑了 32 公里")).toBe(true)
    for (const name of files) {
      const bytes = fs.readFileSync(path.join(dataDir, name))
      for (const canary of [...Object.values(CANARY), ...secrets]) {
        if (bytes.includes(Buffer.from(canary, "utf8"))) found.push(`${name}：${canary}`)
      }
    }
    expect(found).toEqual([])
    // 移入密匣的笔记标题：服务器的密匣路径里没有它（上面已断言）；这里记下库文件里是否还有别处留着它。
    const titleHits = files.filter((name) => fs.readFileSync(path.join(dataDir, name)).includes(Buffer.from(NOTE_TITLE, "utf8")))
    test.info().annotations.push({ type: "note-title-in-db", description: titleHits.join(",") || "none" })
    console.log(`笔记标题出现在：${titleHits.join(",") || "无"}`)
  })

  await context.close()
})
