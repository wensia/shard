import { expect, test, type Page } from "@playwright/test"
import { installContentTypesMock } from "./content-types-mock"
import { fillEditor } from "./editor-helpers"
import { installLocalVoiceMock, voiceCalls } from "./voice-local-mock"

declare global { interface Window { __PLAYBACK__: { hold: boolean; release: (() => void) | null; plays: number; audio: HTMLMediaElement | null } } }

const composer = (page: Page) => page.locator('[data-shard-editor="composer"]').locator('xpath=ancestor::*[contains(@class,"composer")][last()]')
const player = (page: Page) => page.getByLabel("朗读控制", { exact: true })

async function openVoiceSettings(page: Page) {
  await page.getByRole("button", { name: "更多操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "设置", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("navigation").getByRole("button", { name: "语音", exact: true }).click()
  return dialog
}

/** 在速记里写好正文并点朗读；第一段合成会挂起，直到测试放行。 */
async function setup(page: Page, text = "这是需要朗读的记录。") {
  await installContentTypesMock(page)
  await page.goto("/")
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeVisible()
  await installLocalVoiceMock(page)
  await page.evaluate(() => {
    const state = window.__PLAYBACK__ = { hold: true, release: null as (() => void) | null, plays: 0, audio: null as HTMLMediaElement | null }
    const w = window as any
    const original = w.__TAURI_INTERNALS__.invoke
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "voice_synthesize" && state.hold) {
        w.__voiceCalls.push({ command, args })
        await new Promise<void>(resolve => { state.release = resolve })
        return w.__voiceWav()
      }
      return original(command, args)
    }
    HTMLMediaElement.prototype.play = async function () { state.plays++; state.audio = this }
    HTMLMediaElement.prototype.pause = function () {}
  })
  await fillEditor(page, "composer", text)
  await composer(page).getByRole("button", { name: "朗读", exact: true }).click()
  await expect.poll(async () => (await voiceCalls(page, "voice_synthesize")).length).toBe(1)
}

test("合成中暂停，迟到音频不会自动播放，继续后才播放", async ({ page }) => {
  await setup(page)
  await player(page).getByRole("button", { name: "暂停", exact: true }).click()
  await page.evaluate(() => { window.__PLAYBACK__.hold = false; window.__PLAYBACK__.release?.() })
  await expect(player(page).getByText("已暂停", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__PLAYBACK__.plays)).toBe(0)
  await player(page).getByRole("button", { name: "继续", exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__PLAYBACK__.plays)).toBe(1)
})

test("停止后忽略迟到合成结果", async ({ page }) => {
  await setup(page)
  await player(page).getByRole("button", { name: "停止", exact: true }).click()
  await page.evaluate(async () => { window.__PLAYBACK__.release?.(); await new Promise(resolve => setTimeout(resolve, 50)) })
  await expect(player(page)).toHaveCount(0)
  expect(await page.evaluate(() => window.__PLAYBACK__.plays)).toBe(0)
  expect(await voiceCalls(page, "voice_cancel")).toHaveLength(1)
})

test("长文只预取下一段，播完当前段才继续请求", async ({ page }) => {
  await setup(page, ("正文".repeat(150) + "。").repeat(4))
  await page.evaluate(() => { window.__PLAYBACK__.hold = false; window.__PLAYBACK__.release?.() })
  await expect.poll(() => page.evaluate(() => window.__PLAYBACK__.plays)).toBe(1)
  await expect.poll(async () => (await voiceCalls(page, "voice_synthesize")).length).toBe(2)
  await page.evaluate(() => window.__PLAYBACK__.audio?.dispatchEvent(new Event("ended")))
  await expect.poll(() => page.evaluate(() => window.__PLAYBACK__.plays)).toBe(2)
  expect(await voiceCalls(page, "voice_synthesize")).toHaveLength(3)
})

test("修改配置停止当前朗读", async ({ page }) => {
  await setup(page)
  const dialog = await openVoiceSettings(page)
  await dialog.getByLabel("合成模型", { exact: true }).fill("another-model")
  await expect(player(page)).toHaveCount(0)
  expect(await voiceCalls(page, "voice_cancel")).toHaveLength(1)
})

test("合成音频以二进制交给播放器，主线程不做 base64 解码", async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    window.atob = () => { throw new Error("UI thread audio decode forbidden") }
    window.__PLAYBACK__.hold = false; window.__PLAYBACK__.release?.()
  })
  await expect.poll(() => page.evaluate(() => window.__PLAYBACK__.plays)).toBe(1)
  await expect(player(page)).toContainText("正在朗读")
})

test("关闭设置时停止试听并丢弃迟到音频", async ({ page }) => {
  await setup(page)
  await player(page).getByRole("button", { name: "停止", exact: true }).click()
  const dialog = await openVoiceSettings(page)
  await dialog.getByRole("button", { name: "试听", exact: true }).click()
  await expect.poll(async () => (await voiceCalls(page, "voice_synthesize")).length).toBe(2)
  await dialog.getByRole("button", { name: "关闭", exact: true }).click()
  await expect(player(page)).toHaveCount(0)
  await page.evaluate(async () => { window.__PLAYBACK__.release?.(); await new Promise(resolve => setTimeout(resolve, 50)) })
  expect(await page.evaluate(() => window.__PLAYBACK__.plays)).toBe(0)
})

test("暂停中断尚未完成的 play Promise 时保留会话，可继续播放", async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    let rejectPending: ((reason: unknown) => void) | null = null
    HTMLMediaElement.prototype.play = function () {
      window.__PLAYBACK__.plays++
      window.__PLAYBACK__.audio = this
      if (window.__PLAYBACK__.plays > 1) return Promise.resolve()
      return new Promise<void>((_resolve, reject) => { rejectPending = reject })
    }
    HTMLMediaElement.prototype.pause = function () {
      rejectPending?.(new DOMException("play() interrupted by pause()", "AbortError"))
      rejectPending = null
    }
    window.__PLAYBACK__.hold = false; window.__PLAYBACK__.release?.()
  })
  await expect.poll(() => page.evaluate(() => window.__PLAYBACK__.plays)).toBe(1)
  await player(page).getByRole("button", { name: "暂停", exact: true }).click()
  await expect(player(page).getByText("已暂停", { exact: true })).toBeVisible()
  await expect(player(page).getByRole("alert")).toHaveCount(0)
  expect(await voiceCalls(page, "voice_cancel")).toHaveLength(0)
  await player(page).getByRole("button", { name: "继续", exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__PLAYBACK__.plays)).toBe(2)
  await expect(player(page).getByText("正在朗读", { exact: true })).toBeVisible()
  expect(await voiceCalls(page, "voice_synthesize")).toHaveLength(1)
})
