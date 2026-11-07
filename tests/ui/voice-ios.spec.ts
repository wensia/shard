import { expect, test, type Page } from "@playwright/test"
import type { IOSBridgeMessage } from "../../src/lib/ios-native"
import { fillEditor } from "./editor-helpers"

// iOS App 里的语音：共享网页界面经原生桥（type: "voice"）调用 Swift 的录音、钥匙串与语音服务请求，
// 命令名和参数与桌面 Tauri 命令一致。这里用页面内的假原生宿主走真实的前端代码路径。

test.use({ viewport: { width: 390, height: 844 }, locale: "zh-CN" })

const WAV = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA="

type VoiceCall = { command: string; args: Record<string, unknown> }
type NativeWindow = typeof window & {
  __VOICE_CALLS__: VoiceCall[]
  __VOICE_TEXT__: string
  __VOICE_PLAYS__: number
}

async function installNativeVoiceHost(page: Page) {
  await page.addInitScript((wav) => {
    const encode = (value: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    const reply = (body: unknown, status = 200) => ({ status, headers: { "content-type": "application/json" }, bodyBase64: encode(body) })
    const decode = (value?: string) => value ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)))) : {}
    const state = {
      serverURL: "https://shard.example.test", email: "me@example.test", authenticated: true,
      sync: { state: "online", pending: 0 }, legacyAvailable: false,
    }
    let settings = { mode: "mimo", baseUrl: "https://api.xiaomimimo.com/v1", transcriptionModel: "mimo-v2.5-asr", speechModel: "mimo-v2.5-tts", voice: "冰糖", hasKey: true }
    const rpc: Record<string, () => unknown> = {
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
    const w = window as typeof window & {
      __VOICE_CALLS__: VoiceCall[]; __VOICE_TEXT__: string; __VOICE_PLAYS__: number
      __VOICE_HOLD_START__?: boolean; __VOICE_RELEASE_START__?: () => void
    }
    w.__VOICE_CALLS__ = []
    w.__VOICE_TEXT__ = "原生识别文字"
    w.__VOICE_PLAYS__ = 0
    HTMLMediaElement.prototype.play = async function () { w.__VOICE_PLAYS__++ }
    HTMLMediaElement.prototype.pause = function () {}
    Object.assign(window, {
      webkit: { messageHandlers: { shardApp: { postMessage: async (message: IOSBridgeMessage) => {
        if (message.type === "bootstrap") return reply(state)
        if (message.type === "appearance" || message.type === "cancel") return reply({ ok: true })
        if (message.type === "stream") return { ...reply({}), headers: { "content-type": "text/event-stream" }, bodyBase64: "" }
        if (message.type === "voice") {
          const args = decode(message.bodyBase64)
          w.__VOICE_CALLS__.push({ command: message.path ?? "", args })
          switch (message.path) {
            case "voice_get_settings": return reply(settings)
            case "voice_save_settings":
              settings = { ...settings, ...args.settings, hasKey: typeof args.apiKey === "string" ? Boolean(args.apiKey) : settings.hasKey }
              return reply(settings)
            case "voice_start_recording":
              if (w.__VOICE_HOLD_START__) await new Promise<void>((resolve) => { w.__VOICE_RELEASE_START__ = resolve })
              return reply({})
            case "voice_transcribe": return reply({ text: w.__VOICE_TEXT__ })
            case "voice_synthesize": return { status: 200, headers: { "content-type": "audio/wav" }, bodyBase64: wav }
            case "voice_cancel": return reply({})
            default: return reply({ code: "VOICE_FAILED", message: "语音请求无效。" }, 400)
          }
        }
        if (message.path === "/api/auth/state") return reply({ authenticated: true, setupRequired: false, stepUpValid: true, vaultId: "native-fixture", email: "me@example.test" })
        if (message.path?.startsWith("/api/rpc/")) {
          const result = rpc[decodeURIComponent(message.path.slice("/api/rpc/".length))]
          return result ? reply(result()) : reply({ code: "UNKNOWN", message: "Unknown fixture command" }, 400)
        }
        return reply({ code: "NOT_FOUND" }, 404)
      } } } },
    })
  }, WAV)
}

const composer = (page: Page) => page.locator('[data-shard-editor="composer"]').locator('xpath=ancestor::*[contains(@class,"composer")][last()]')
const player = (page: Page) => page.getByLabel("朗读控制", { exact: true })
const calls = (page: Page, command: string) =>
  page.evaluate((command) => (window as NativeWindow).__VOICE_CALLS__.filter((call) => call.command === command), command)

async function open(page: Page) {
  await installNativeVoiceHost(page)
  await page.goto("/")
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeVisible()
}

test("iOS 速记语音输入经原生桥录音与识别，页面拿不到密钥", async ({ page }) => {
  await open(page)
  await composer(page).getByRole("button", { name: "语音输入", exact: true }).click()
  await expect(composer(page).getByRole("button", { name: "结束并识别", exact: true })).toBeVisible()
  const [start] = await calls(page, "voice_start_recording")
  expect(start.args.sessionId).toEqual(expect.any(String))
  await composer(page).getByRole("button", { name: "结束并识别", exact: true }).click()
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toContainText("原生识别文字")
  expect(await calls(page, "voice_transcribe")).toEqual([{ command: "voice_transcribe", args: { sessionId: start.args.sessionId } }])
  const all = await page.evaluate(() => (window as NativeWindow).__VOICE_CALLS__)
  expect(JSON.stringify(all)).not.toContain("apiKey")
})

test("原生通知录音到达上限后自动识别；设备中断时提示重新录音", async ({ page }) => {
  await open(page)
  const stopped = (id: unknown, reason: string, error?: string) => page.evaluate(({ id, reason, error }) => {
    window.dispatchEvent(new CustomEvent("shard:ios-event", { detail: { type: "voice-recording-stopped", id, reason, error } }))
  }, { id, reason, error })

  await composer(page).getByRole("button", { name: "语音输入", exact: true }).click()
  await expect(composer(page).getByRole("button", { name: "结束并识别", exact: true })).toBeVisible()
  const [first] = await calls(page, "voice_start_recording")
  await stopped("another-session", "limit")
  await stopped(first.args.sessionId, "limit")
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toContainText("原生识别文字")
  expect(await calls(page, "voice_transcribe")).toHaveLength(1)

  await composer(page).getByRole("button", { name: "语音输入", exact: true }).click()
  await expect(composer(page).getByRole("button", { name: "结束并识别", exact: true })).toBeVisible()
  const second = (await calls(page, "voice_start_recording"))[1]
  await stopped(second.args.sessionId, "error", "录音被系统中断，请重新录音。")
  await expect(composer(page).getByRole("alert")).toHaveText("录音被系统中断，请重新录音。")
  await expect(composer(page).getByRole("button", { name: "重试识别", exact: true })).toHaveCount(0)
  expect(await calls(page, "voice_transcribe")).toHaveLength(1)
})

test("启动回复晚于中断事件到达时，界面保持中断提示而不是回到录音中", async ({ page }) => {
  await open(page)
  await page.evaluate(() => { (window as typeof window & { __VOICE_HOLD_START__?: boolean }).__VOICE_HOLD_START__ = true })
  await composer(page).getByRole("button", { name: "语音输入", exact: true }).click()
  await expect.poll(async () => (await calls(page, "voice_start_recording")).length).toBe(1)
  const [start] = await calls(page, "voice_start_recording")
  await page.evaluate((id) => {
    window.dispatchEvent(new CustomEvent("shard:ios-event", { detail: { type: "voice-recording-stopped", id, reason: "error", error: "录音被系统中断，请重新录音。" } }))
  }, start.args.sessionId)
  await expect(composer(page).getByRole("alert")).toHaveText("录音被系统中断，请重新录音。")
  await page.evaluate(async () => {
    (window as typeof window & { __VOICE_RELEASE_START__?: () => void }).__VOICE_RELEASE_START__?.()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  await expect(composer(page).getByRole("alert")).toHaveText("录音被系统中断，请重新录音。")
  await expect(composer(page).getByRole("button", { name: "结束并识别", exact: true })).toHaveCount(0)
})

test("iOS 朗读经原生桥取回 WAV 播放，播放条留在底部导航之上", async ({ page }) => {
  await open(page)
  await fillEditor(page, "composer", "这是需要朗读的记录。")
  await composer(page).getByRole("button", { name: "朗读", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as NativeWindow).__VOICE_PLAYS__)).toBe(1)
  await expect(player(page)).toContainText("正在朗读")
  const [call] = await calls(page, "voice_synthesize")
  expect(call.args).toEqual({ sessionId: expect.any(String), text: "这是需要朗读的记录。" })

  const box = await player(page).boundingBox()
  const tabs = await page.getByRole("navigation", { name: "工作台" }).last().boundingBox()
  expect(box && tabs).toBeTruthy()
  expect(box!.y + box!.height).toBeLessThanOrEqual(tabs!.y)
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)

  await player(page).getByRole("button", { name: "停止", exact: true }).click()
  await expect(player(page)).toHaveCount(0)
  expect(await calls(page, "voice_cancel")).toEqual([{ command: "voice_cancel", args: { sessionId: call.args.sessionId } }])
})

test("iOS 设置的 AI 分区有语音分组，密钥经原生保存且不回显", async ({ page }) => {
  await open(page)
  await page.getByRole("button", { name: "更多操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "设置", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "设置", exact: true })
  await settings.getByRole("navigation").getByRole("button", { name: "AI", exact: true }).click()
  // iOS 连着服务器：AI 分区里还有自动标签（同样有 API Key 与保存），这里只看语音分组。
  const dialog = settings.locator('[data-settings-group="voice"]')
  const key = dialog.getByLabel("API Key", { exact: true })
  await expect(key).toHaveAttribute("placeholder", "已保存，留空保留")
  await key.fill("sk-native-only")
  await dialog.getByRole("button", { name: "保存", exact: true }).click()
  await expect(dialog.getByText("已保存", { exact: true })).toBeVisible()
  await expect(key).toHaveValue("")
  const [save] = await calls(page, "voice_save_settings")
  expect(save.args.apiKey).toBe("sk-native-only")
  expect(save.args.settings).toMatchObject({ mode: "mimo", baseUrl: "https://api.xiaomimimo.com/v1" })
})
