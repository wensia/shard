import { expect, test, type Page } from "@playwright/test"

// 桌面「连接服务器」（S8a 在线客户端）：Tauri IPC 替身模拟 Rust——`remote_status` 决定启动走哪条通道，
// `remote_invoke` 回放服务器的响应。是否连接存在 localStorage 里，登录成功、断开后的整页重载能接着用。

test.use({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" })

const RIDE = "20261026-073012-a1b2c3d4-0a0b0c"
const TABLE = "20261026-080000-c0ffee00-1a1b1c"
const SERVER = "https://shard.example.com"
const DEFAULT_SERVER = "https://shard.askfish.net"

interface MockOptions {
  connected: boolean
  signedOut?: boolean
  statusError?: boolean
  /** Rust 同步引擎启动时的状态（S8b）；不给就是旧版本 Rust（没有 sync 字段）。 */
  sync?: { state: string; pending: number; conflicts: number; failed: number }
  /** 离线时 Rust 拒绝的服务器命令 → 说明文字。 */
  refuse?: Record<string, string>
}

async function installDesktopRemoteMock(page: Page, options: MockOptions) {
  await page.addInitScript(
    ({ initiallyConnected, initiallySignedOut, statusError, ride, table, server, initialSync, refuse }) => {
      const CONNECTED_KEY = "__desktop_remote_connected__"
      const stored = localStorage.getItem(CONNECTED_KEY)
      const connected = stored === null ? initiallyConnected : stored === "1"
      let connection = localStorage.getItem("__desktop_remote_signed_out__") === "1" || initiallySignedOut ? "signedOut" : "connected"
      const now = "2026-10-26T12:00:00.000Z"
      const fragment = (vaultPath: string, id = ride, content = "早上沿江骑了 40 公里。#骑行\n") => ({
        id,
        path: `fragments/2026/10/${id}.md`,
        content,
        tags: id === ride ? ["inbox", "骑行"] : ["inbox"],
        fileSha: "sha-current",
        createdAt: now,
        updatedAt: now,
        category: null,
        gitStatus: vaultPath.startsWith("shard://") ? "saved" : "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        properties: [],
        related: [],
      })
      const lockbox = { configured: false, unlocked: false, expiresAt: null, ttlSeconds: 900 }
      const tree = { entries: [], assets: [], trashEntries: [], fragmentTrashEntries: [], fragmentStream: { totalCount: 1, years: [] } }
      const remoteState = {
        vaultPath: "shard://shard.example.com/vault-1",
        fragments: [fragment("shard://"), fragment("shard://", table, "![[datasets/里程.csv]]")],
        git: { ahead: 0, behind: 0, branch: "main", error: null, hasRemote: false, shortCommit: "no git", status: "no_git" },
        lockbox,
      }
      const localState = {
        vaultPath: "/tmp/shard-desktop-local",
        fragments: [fragment("/tmp"), fragment("/tmp", table, "![[datasets/里程.csv]]")],
        git: { ahead: 0, behind: 0, branch: "main", error: null, hasRemote: true, shortCommit: "abc1234", status: "ready" },
        lockbox,
      }
      const revisions = [
        { revId: 12, nodeId: 3, path: `fragments/2026/10/${ride}.md`, sha: "sha-current", size: 30, reason: "edit", device: "device:mac", createdAt: "2026-10-26T15:55:00.000Z" },
        { revId: 4, nodeId: 3, path: `fragments/2026/10/${ride}.md`, sha: "sha-old", size: 60, reason: "import", device: null, createdAt: "2026-10-26T12:13:00.000Z" },
      ]
      const deletedEntries = [
        { nodeId: 9, revId: 7, path: ".trash/notes/旧计划.md", sha: "sha-deleted", purgedAt: "2026-10-26T15:56:00.000Z", expiresAt: "2026-11-25T15:56:00.000Z", revisions: 3 },
      ]
      const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
      const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))
      const csvFiles = [{ name: "里程.csv", path: "datasets/里程.csv" }]
      const csvBytes = () => Array.from(new TextEncoder().encode("日期,公里\n10-25,32\n10-26,40\n"))

      const serverHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {
        list_fragments: () => clone(remoteState),
        list_library_tree: () => clone(tree),
        list_mind_maps: () => [],
        list_csv_files: () => clone(csvFiles),
        read_csv_file: () => csvBytes(),
        list_diagram_documents: () => [],
        list_markdown_dialect_migration: () => ({ dialect: 2, sources: [] }),
        list_revisions: () => ({ nodeId: 3, path: `fragments/2026/10/${ride}.md`, revisions: clone(revisions) }),
        "remote:revision_bytes": (args) => {
          const text = args.revId === 4 ? "---\nid: x\n---\n\n早上沿江骑了 32 公里，风有点大。\n" : "早上沿江骑了 40 公里。\n"
          return { sha: args.revId === 4 ? "sha-old" : "sha-current", contentType: "text/plain; charset=utf-8", data: encode(text) }
        },
        restore_revision: () => ({ path: `fragments/2026/10/${ride}.md`, sha: "sha-old", revived: false }),
        list_deleted_entries: () => ({ entries: clone(deletedEntries), retentionDays: 30 }),
      }
      const localHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {
        list_fragments: () => clone(localState),
        list_library_tree: () => clone(tree),
        migrate_legacy_notes: () => ({ tree: clone(tree), migratedCount: 0 }),
        list_mind_maps: () => [],
        list_csv_files: () => clone(csvFiles),
        read_csv_file: () => csvBytes(),
        list_diagram_documents: () => [],
        list_markdown_dialect_migration: () => ({ dialect: 2, sources: [] }),
        watch_vault: () => null,
        checkpoint_vault: () => ({ status: "no_changes", changes: 0, reason: null, git: clone(localState.git) }),
      }
      // 本机能力：两种模式都直接走本机。
      const nativeHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {
        set_reminder_schedule: () => null,
        set_window_controls_hidden: () => null,
        set_canvas_grab_cursor: () => null,
        cli_install_status: () => ({ state: "notInstalled", linkPath: "/usr/local/bin/shard", shellConfigPath: null, message: null, declined: false }),
        install_cli: () => ({ state: "installed", linkPath: "/usr/local/bin/shard", shellConfigPath: null, message: null, declined: false }),
      }

      const remoteHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {
        remote_status: () => {
          if (statusError && localStorage.getItem("__desktop_remote_status_recovered__") !== "1") throw "无法读取服务器连接状态。"
          return connected
            ? { connected: true, server, deviceId: "dev-1", name: "工作室 Mac", connection, sync: initialSync }
            : { connected: false, server: null, deviceId: null, name: null, connection: null }
        },
        remote_sync_now: () => null,
        remote_sync_dismiss: () => null,
        // Rust 拿邮箱和密码向服务器换设备令牌；失败时抛给人看的中文。
        remote_login: (args) => {
          if (args.password !== "correct horse battery") throw "邮箱或密码不对。"
          localStorage.setItem(CONNECTED_KEY, "1")
          localStorage.removeItem("__desktop_remote_signed_out__")
          localStorage.setItem("__desktop_remote_status_recovered__", "1")
          // 成功后整页重载、调用记录清空：参数另存一份给用例核对。
          localStorage.setItem("__desktop_remote_login__", JSON.stringify(args))
          return { server: String(args.server), name: String(args.name) }
        },
        remote_disconnect: () => {
          localStorage.setItem(CONNECTED_KEY, "0")
          return null
        },
      }

      const calls: Array<{ command: string; args: Record<string, unknown> }> = []
      const unknown: string[] = []
      let callbackId = 0
      const callbacks = new Map<number, (event: unknown) => void>()
      const listeners: Array<{ event: string; handler: number }> = []
      Object.assign(window, {
        isTauri: true,
        __REMOTE_CALLS__: calls,
        __REMOTE_UNKNOWN__: unknown,
        __REMOTE_EMIT__: (event: string, payload: unknown) => {
          if (event === "remote-auth-required") {
            connection = "signedOut"
            localStorage.setItem("__desktop_remote_signed_out__", "1")
          }
          for (const listener of listeners.filter((item) => item.event === event)) {
            callbacks.get(listener.handler)?.({ event, id: listener.handler, payload })
          }
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
          transformCallback: (callback?: (event: unknown) => void) => {
            const id = ++callbackId
            if (callback) callbacks.set(id, callback)
            return id
          },
          invoke: async (command: string, args: Record<string, unknown> = {}) => {
            calls.push({ command, args: clone(args) })
            if (command === "plugin:event|listen") {
              listeners.push({ event: String(args.event), handler: Number(args.handler) })
              return ++callbackId
            }
            if (command === "plugin:app|version") return "0.1.3"
            if (command.startsWith("plugin:")) return null
            if (command in remoteHandlers) return remoteHandlers[command](args)
            if (command in nativeHandlers) return nativeHandlers[command](args)
            if (command === "remote_invoke") {
              if (!connected) throw "还没有连接服务器。"
              const inner = String(args.command)
              if (refuse && inner in refuse) throw refuse[inner]
              const handler = serverHandlers[inner]
              if (!handler) {
                unknown.push(`server:${inner}`)
                throw `测试替身没有实现 ${inner}`
              }
              return handler((args.args ?? {}) as Record<string, unknown>)
            }
            if (connected) {
              // 远程模式下不该有数据命令直达本机。
              unknown.push(`local:${command}`)
              throw new Error(`远程模式下的本机命令：${command}`)
            }
            const handler = localHandlers[command]
            if (!handler) {
              unknown.push(`local:${command}`)
              throw new Error(`Unhandled Tauri test command: ${command}`)
            }
            return handler(args)
          },
        },
      })
    },
    {
      initiallyConnected: options.connected,
      initiallySignedOut: options.signedOut ?? false,
      statusError: options.statusError ?? false,
      ride: RIDE,
      table: TABLE,
      server: SERVER,
      initialSync: options.sync ?? null,
      refuse: options.refuse ?? null,
    }
  )
}

type Call = { command: string; args: Record<string, unknown> }

function calls(page: Page) {
  return page.evaluate(() => (window as unknown as { __REMOTE_CALLS__: Call[] }).__REMOTE_CALLS__)
}

async function serverCommands(page: Page) {
  return (await calls(page)).filter((call) => call.command === "remote_invoke").map((call) => String(call.args.command))
}

async function localCommands(page: Page) {
  return (await calls(page)).map((call) => call.command).filter((command) => command !== "remote_invoke" && !command.startsWith("plugin:"))
}

function emit(page: Page, event: string, payload: unknown) {
  return page.evaluate(
    ({ event, payload }) => (window as unknown as { __REMOTE_EMIT__: (event: string, payload: unknown) => void }).__REMOTE_EMIT__(event, payload),
    { event, payload }
  )
}

const statusBar = (page: Page) => page.getByRole("contentinfo", { name: "状态栏" })
const card = (page: Page) => page.locator(`[data-shard-fragment-id="${RIDE}"]`).first()
const csvPreview = (page: Page) =>
  page.locator(`[data-shard-fragment-id="${TABLE}"]`).first().locator('section[data-csv-path="datasets/里程.csv"]')

async function openSettings(page: Page) {
  await statusBar(page).getByRole("button", { name: "更多操作" }).click()
  await page.getByRole("menuitem", { name: "设置" }).click()
  const dialog = page.getByRole("dialog", { name: "设置" })
  await expect(dialog).toBeVisible()
  return dialog
}

test.describe("已连接服务器", () => {
  test.beforeEach(async ({ page }) => {
    await installDesktopRemoteMock(page, { connected: true })
    await page.goto("/")
    await expect(page.locator("html")).toHaveAttribute("data-runtime", "desktop")
    await expect(card(page)).toBeVisible()
  })

  test("数据命令经 remote_invoke 发给服务器，本机能力仍走本地", async ({ page }) => {
    await expect.poll(() => serverCommands(page)).toEqual(
      expect.arrayContaining(["list_markdown_dialect_migration", "list_fragments", "list_mind_maps", "list_csv_files"])
    )
    // 提醒角标是本机能力：直接走本机命令。
    await expect.poll(() => localCommands(page)).toContain("set_reminder_schedule")
    const local = await localCommands(page)
    expect(local).not.toContain("list_fragments")
    expect(local).not.toContain("watch_vault")
    expect(local).not.toContain("migrate_legacy_notes")
    // 实时变化来自 Rust 转发的 SSE：订阅 vault-changed，不让 Rust 去监视本机目录。
    const listens = (await calls(page)).filter((call) => call.command === "plugin:event|listen").map((call) => call.args.event)
    expect(listens).toEqual(expect.arrayContaining(["vault-changed", "remote-connection", "remote-auth-required"]))
    expect(await page.evaluate(() => (window as unknown as { __REMOTE_UNKNOWN__: string[] }).__REMOTE_UNKNOWN__)).toEqual([])
  })

  test("资料库文件不在本机：不提供用默认程序打开", async ({ page }) => {
    const preview = csvPreview(page)
    await expect(preview.getByText("共 2 行", { exact: true })).toBeVisible()
    await expect(preview.getByRole("button", { name: "编辑", exact: true })).toBeVisible()
    await expect(preview.getByRole("button", { name: "用默认程序打开" })).toHaveCount(0)
    await expect(preview.getByRole("button", { name: "下载 CSV" })).toHaveCount(0)
    expect(await serverCommands(page)).toContain("read_csv_file")
  })

  test("状态栏显示与服务器的连接，跟随 Rust 的事件", async ({ page }) => {
    const bar = statusBar(page)
    await expect(bar.getByText("已连接服务器")).toBeVisible()
    await expect(bar.getByText("未启用 Git")).toHaveCount(0)
    await emit(page, "remote-connection", { state: "reconnecting" })
    await expect(bar.getByText("与服务器断开，正在重连…")).toBeVisible()
    await emit(page, "remote-connection", { state: "connected" })
    await expect(bar.getByText("已连接服务器")).toBeVisible()
    // 桌面凭设备令牌访问，设备信息在服务器设置里，不重复网页版个人中心。
    await expect(page.locator("[data-shard-account-menu-trigger]")).toHaveCount(0)
  })

  test("令牌失效立即回到登录页，不能读取本机资料库", async ({ page }) => {
    await emit(page, "remote-auth-required", { server: SERVER })
    await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible()
    await expect(card(page)).toHaveCount(0)
    await expect(page.getByLabel("快速记录", { exact: true })).toHaveCount(0)
    const local = await localCommands(page)
    for (const command of ["list_fragments", "watch_vault", "checkpoint_vault", "migrate_legacy_notes"]) expect(local).not.toContain(command)
    await page.reload()
    await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible()
    expect(await serverCommands(page)).toEqual([])
  })

  test("碎片菜单有版本历史：经 Rust 读旧版本预览，恢复带当前版本作基线", async ({ page }) => {
    await card(page).getByRole("button", { name: "片段操作" }).click()
    await page.getByRole("menuitem", { name: "版本历史" }).click()
    const dialog = page.getByRole("dialog", { name: /版本历史/u })
    const list = dialog.getByRole("list", { name: "版本列表" })
    await expect(list.getByRole("button")).toHaveCount(2)
    await list.getByRole("button").nth(1).click()
    await expect(dialog.getByText("早上沿江骑了 32 公里，风有点大。")).toBeVisible()
    // 桌面下载走保存对话框，不是浏览器链接。
    await expect(dialog.getByRole("button", { name: "下载这个版本" })).not.toHaveAttribute("href", /.*/u)
    await dialog.getByRole("button", { name: "恢复为这个版本" }).click()
    await expect(dialog).toBeHidden()
    const restore = (await calls(page)).find((call) => call.command === "remote_invoke" && call.args.command === "restore_revision")
    expect(restore?.args.args).toEqual({ revId: 4, expectedSha: "sha-current" })
  })

  test("设置：本机资料库与 Git 隐藏，服务器与数据找回出现，导出与抹除指向网页版", async ({ page }) => {
    const dialog = await openSettings(page)
    const nav = dialog.getByRole("navigation", { name: "设置分区" })
    await expect(nav.getByRole("button")).toHaveText(["服务器", "数据与备份", "外观", "语音", "终端命令", "快捷键"])
    await expect(nav.getByRole("button", { name: "服务器" })).toHaveAttribute("aria-current", "true")
    await expect(dialog.getByRole("button", { name: "选择已有目录" })).toHaveCount(0)
    await expect(dialog.getByText("本地 Git")).toHaveCount(0)

    const server = dialog.locator('[data-settings-section="server"]')
    await expect(server.getByText(SERVER)).toBeVisible()
    await expect(server.getByText("工作室 Mac")).toBeVisible()
    await expect(server.getByText("已连接", { exact: true })).toBeVisible()

    const data = dialog.locator('[data-settings-section="data"]')
    await expect(data.getByText("旧计划.md", { exact: true })).toBeVisible()
    await expect(data.getByRole("button", { name: "找回" })).toBeVisible()
    await expect(data.getByRole("button", { name: "立即抹除" })).toHaveCount(0)
    await expect(data.getByRole("button", { name: "导出 zip" })).toHaveCount(0)
    await expect(data.getByText("请在网页版「设置 → 数据与备份」里操作", { exact: false })).toBeVisible()
    // 终端命令是本机能力，仍问本机。
    expect(await localCommands(page)).toContain("cli_install_status")
  })

  test("退出连接后显示登录页，重启仍不打开本机资料库", async ({ page }) => {
    const dialog = await openSettings(page)
    await dialog.locator('[data-settings-section="server"]').getByRole("button", { name: "断开连接", exact: true }).click()
    const confirm = page.getByRole("alertdialog", { name: "断开与服务器的连接？" })
    await confirm.getByRole("button", { name: "断开连接", exact: true }).click()
    await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible()
    await expect(page.getByLabel("快速记录", { exact: true })).toHaveCount(0)
    expect(await serverCommands(page)).toEqual([])
    expect(await localCommands(page)).not.toContain("list_fragments")
    await page.reload()
    await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible()
    expect(await localCommands(page)).not.toContain("list_fragments")
  })
})

test.describe("默认 VPS 登录", () => {
  test.beforeEach(async ({ page }) => {
    await installDesktopRemoteMock(page, { connected: false })
    await page.goto("/")
    await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible()
  })

  test("未登录默认预填 VPS 地址，不执行任何旧资料库读取与提交", async ({ page }) => {
    await expect(page.getByRole("textbox", { name: "服务器地址", exact: true })).toHaveValue(DEFAULT_SERVER)
    await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible()
    await expect(page.getByLabel("密码", { exact: true })).toBeVisible()
    await expect(page.getByLabel("快速记录", { exact: true })).toHaveCount(0)
    await expect(statusBar(page)).toHaveCount(0)
    await expect(page.getByText("配对码")).toHaveCount(0)
    const local = await localCommands(page)
    for (const command of ["list_fragments", "list_library_tree", "watch_vault", "checkpoint_vault", "migrate_legacy_notes", "set_vault_path"]) expect(local).not.toContain(command)
    expect(await serverCommands(page)).toEqual([])
  })

  test("登录表单校验字段，正确密码登录后只走服务器命令", async ({ page }) => {
    const server = page.getByLabel("服务器地址", { exact: true })
    const email = page.getByLabel("邮箱", { exact: true })
    const password = page.getByLabel("密码", { exact: true })
    const submit = page.getByRole("button", { name: "登录", exact: true })
    await server.fill("")
    await submit.click()
    await expect(page.getByRole("alert")).toHaveText(["请填写服务器地址。", "请填写邮箱。", "请填写密码。"])
    await expect(server).toHaveAttribute("aria-invalid", "true")
    await server.fill(SERVER)
    await email.fill("me@")
    await expect(page.getByRole("alert")).toHaveText(["邮箱格式不对。", "请填写密码。"])
    await email.fill("  Me@Example.com ")
    await password.fill("correct horse battery")
    await submit.click()
    await expect(statusBar(page).getByText("已连接服务器")).toBeVisible()
    await expect.poll(() => serverCommands(page)).toContain("list_fragments")
    expect(await localCommands(page)).not.toContain("list_fragments")
    const login = await page.evaluate(() => JSON.parse(localStorage.getItem("__desktop_remote_login__") ?? "null"))
    expect(login).toEqual({ server: SERVER, email: "me@example.com", password: "correct horse battery", name: "我的 Mac" })
    await page.reload()
    await expect(card(page)).toBeVisible()
    expect((await calls(page)).map((call) => call.command)).not.toContain("remote_login")
  })

  test("密码错误保留登录页，可以直接重试", async ({ page }) => {
    await page.getByLabel("邮箱", { exact: true }).fill("me@example.com")
    const password = page.getByLabel("密码", { exact: true })
    await password.fill("wrong password!")
    await page.getByRole("button", { name: "登录", exact: true }).click()
    await expect(page.getByRole("alert")).toHaveText(/邮箱或密码不(?:对|正确)/u)
    await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeEnabled()
    expect(await serverCommands(page)).toEqual([])
    expect(await localCommands(page)).not.toContain("list_fragments")
    await password.fill("correct horse battery")
    await page.getByRole("button", { name: "登录", exact: true }).click()
    await expect(card(page)).toBeVisible()
  })

  test("登录框复用 Kiln 边框、半径与单一焦点环，显隐按钮不丢密码", async ({ page }) => {
    const email = page.getByLabel("邮箱", { exact: true })
    const password = page.getByLabel("密码", { exact: true })
    const card = page.getByRole("main").locator("section").first()
    await expect(card).toHaveCSS("border-radius", "6px")
    for (const field of [page.getByLabel("服务器地址", { exact: true }), email, password]) {
      await expect(field).toHaveCSS("border-width", "1px")
      await expect(field).toHaveCSS("border-radius", "4px")
      const height = await field.evaluate(node => ({ height: getComputedStyle(node).height, token: getComputedStyle(node).getPropertyValue("--control-height").trim() }))
      expect(height.height).toBe(height.token)
    }
    await password.fill("fixture password")
    await page.keyboard.press("Tab")
    const reveal = page.getByRole("button", { name: "显示密码", exact: true })
    await expect(reveal).toBeFocused()
    await expect(reveal).toHaveCSS("outline-style", "none")
    await expect(reveal).toHaveCSS("box-shadow", /0px 0px 0px 1px inset/u)
    await reveal.press("Space")
    await expect(password).toHaveValue("fixture password")
    await expect(page.getByRole("button", { name: "隐藏密码", exact: true })).toBeVisible()
    await password.click()
    await page.keyboard.press("Tab")
    await page.keyboard.press("Shift+Tab")
    await expect(password).toBeFocused()
    await expect(password).toHaveCSS("outline-style", "none")
    await expect(password).toHaveCSS("box-shadow", /0px 0px 0px 1px/u)
    await page.screenshot({ path: "/tmp/shard-desktop-vps-login-kiln.png" })
  })
})

test("启动时令牌已经失效，直接显示登录页而不读取旧数据", async ({ page }) => {
  await installDesktopRemoteMock(page, { connected: true, signedOut: true })
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible()
  await expect(page.getByLabel("快速记录", { exact: true })).toHaveCount(0)
  expect(await localCommands(page)).not.toContain("list_fragments")
  expect(await serverCommands(page)).toEqual([])
})

test("读取连接配置失败时不降级打开旧资料库", async ({ page }) => {
  await installDesktopRemoteMock(page, { connected: false, statusError: true })
  await page.goto("/")
  await expect(page.getByLabel("快速记录", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: /登录|连不上服务器/u })).toBeVisible()
  expect(await localCommands(page)).not.toContain("list_fragments")
  expect(await serverCommands(page)).toEqual([])
  await page.getByLabel("邮箱", { exact: true }).fill("me@example.com")
  await page.getByLabel("密码", { exact: true }).fill("correct horse battery")
  await page.getByRole("button", { name: "登录", exact: true }).click()
  await expect(card(page)).toBeVisible()
  expect(await localCommands(page)).not.toContain("list_fragments")
})

test.describe("离线（S8b）", () => {
  const ONLINE = { state: "online", pending: 0, conflicts: 0, failed: 0 }

  test("状态栏跟随同步状态：离线、同步中、待上传、冲突；看过冲突后清零", async ({ page }) => {
    await installDesktopRemoteMock(page, { connected: true, sync: ONLINE })
    await page.goto("/")
    await expect(card(page)).toBeVisible()
    const bar = statusBar(page)
    await expect(bar.getByText("已连接服务器")).toBeVisible()
    await expect(bar.getByText(/待上传/u)).toHaveCount(0)

    await emit(page, "sync-status", { state: "offline", pending: 2, conflicts: 0, failed: 0 })
    await expect(bar.getByText("离线", { exact: true })).toBeVisible()
    await expect(bar.getByText("待上传 2 条")).toBeVisible()

    await emit(page, "sync-status", { state: "syncing", pending: 1, conflicts: 1, failed: 1 })
    await expect(bar.getByText("同步中…")).toBeVisible()
    await expect(bar.getByText("待上传 1 条")).toBeVisible()
    await expect(bar.getByText("冲突 1 条")).toBeVisible()
    await expect(bar.getByText("上传失败 1 条")).toBeVisible()
    await bar.getByRole("button", { name: "冲突 1 条" }).click()
    await expect.poll(async () => (await localCommands(page)).includes("remote_sync_dismiss")).toBe(true)

    await emit(page, "sync-status", ONLINE)
    await expect(bar.getByText("已连接服务器")).toBeVisible()
    await expect(bar.getByText(/待上传|冲突|上传失败/u)).toHaveCount(0)
  })

  test("启动时就离线：先用本机副本显示，状态栏直接是离线；点一下立即重试", async ({ page }) => {
    await installDesktopRemoteMock(page, { connected: true, sync: { state: "offline", pending: 3, conflicts: 0, failed: 0 } })
    await page.goto("/")
    await expect(card(page)).toBeVisible()
    const bar = statusBar(page)
    await expect(bar.getByText("离线", { exact: true })).toBeVisible()
    await expect(bar.getByText("待上传 3 条")).toBeVisible()
    await bar.getByRole("button", { name: "离线" }).click()
    await expect.poll(async () => (await localCommands(page)).includes("remote_sync_now")).toBe(true)
  })

  test("离线时删除碎片：给出「需要联网」的提示，碎片还在", async ({ page }) => {
    await installDesktopRemoteMock(page, {
      connected: true,
      sync: { state: "offline", pending: 0, conflicts: 0, failed: 0 },
      refuse: { set_fragment_archived: "需要联网：删除（移入回收站）。现在连不上服务器，联网后再试。" },
    })
    await page.goto("/")
    await expect(card(page)).toBeVisible()
    await card(page).getByRole("button", { name: "片段操作" }).click()
    await page.getByRole("menuitem", { name: "删除" }).click()
    await expect(page.getByText("需要联网", { exact: true })).toBeVisible()
    await expect(page.getByText("删除（移入回收站）。现在连不上服务器，联网后再试。")).toBeVisible()
    await expect(card(page)).toBeVisible()
    expect(await serverCommands(page)).toContain("set_fragment_archived")
  })

  test("离线修改没能上传（条目已移入密匣）：提示原话与另存位置", async ({ page }) => {
    await installDesktopRemoteMock(page, { connected: true, sync: ONLINE })
    await page.goto("/")
    await expect(card(page)).toBeVisible()
    const message = "这条已移入密匣，离线时的修改没有上传，已另存在本机：/Users/me/remote-recovered/unsent-x.md"
    await emit(page, "sync-failed", { command: "update_fragment", target: `fragment:${RIDE}`, message })
    await expect(page.getByText("有离线修改没能上传")).toBeVisible()
    await expect(page.getByText(message)).toBeVisible()
  })

  test("补交时另存了冲突副本：提示两份都在", async ({ page }) => {
    await installDesktopRemoteMock(page, { connected: true, sync: ONLINE })
    await page.goto("/")
    await expect(card(page)).toBeVisible()
    await emit(page, "sync-conflict", { id: RIDE, copyId: "20261027-090000-0a0b0c0d-1a2b3c", reason: "stale" })
    await expect(page.getByText("已另存冲突副本")).toBeVisible()
    await expect(page.getByText("这条碎片在别处也改过，你离线时的版本另存为一条新碎片，两份都在。")).toBeVisible()
  })
})
