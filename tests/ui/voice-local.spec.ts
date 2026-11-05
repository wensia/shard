import { installLocalVoiceMock, voiceCalls } from "./voice-local-mock"
import { expect, test, type Page } from "@playwright/test"
import { installContentTypesMock, card, revealCard } from "./content-types-mock"
import { fillEditor, readEditor, selectEditorText } from "./editor-helpers"

async function setup(page: Page, options: { fragmentBody?: string } = {}) {
  await installContentTypesMock(page, options)
  await page.goto("/")
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeVisible()
  await installLocalVoiceMock(page)
}

const composerBox = (page: Page) => page.locator('[data-shard-editor="composer"]').locator('xpath=ancestor::*[contains(@class,"composer")][last()]')
const composerEditor = (page: Page) => page.locator('[data-shard-editor="composer"] .ProseMirror')

test("速记选区转写保留格式，单步撤销，不自动提交", async ({ page }) => {
  await setup(page)
  await fillEditor(page, "composer", "前文 **替换** 后文")
  await selectEditorText(page, "composer", "替换")
  const composer = page.locator('[data-shard-editor="composer"]').locator('xpath=ancestor::*[contains(@class,"composer")][last()]')
  await composer.getByRole("button", { name: "语音输入", exact: true }).click()
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toHaveAttribute("contenteditable", "false")
  await composer.getByRole("button", { name: "结束并识别" }).click()
  await expect.poll(() => readEditor(page, "composer")).toBe("前文 **识别文字** 后文")
  await page.locator('[data-shard-editor="composer"] .ProseMirror').press("Meta+z")
  await expect.poll(() => readEditor(page, "composer")).toBe("前文 **替换** 后文")
  const writes = await page.evaluate(() => (window as any).__SHARD_TYPE_CALLS__.filter((c: any) => c.command === "create_fragment"))
  expect(writes).toHaveLength(0)
})

test("行内片段录音时失焦不会提交，取消迟到结果不回填", async ({ page }) => {
  await setup(page)
  const target = card(page, "card-fragment")
  await revealCard(target)
  await target.getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click()
  const editor = page.locator('[data-shard-editor="fragment:card-fragment"]')
  await expect(editor).toBeVisible()
  const controls = editor.locator("xpath=ancestor::article[1]")
  const before = await readEditor(page, "fragment:card-fragment")
  await controls.getByRole("button", { name: "语音输入", exact: true }).click()
  await page.getByRole("button", { name: "保存片段", exact: true }).focus()
  await expect(editor).toBeVisible()
  await page.evaluate(() => { (window as any).__voiceHold = true })
  await controls.getByRole("button", { name: "结束并识别" }).click()
  await expect(controls.getByText("识别中…")).toBeVisible()
  await controls.getByRole("button", { name: "取消录音" }).click()
  await page.evaluate(() => (window as any).__voiceRelease())
  await expect.poll(() => readEditor(page, "fragment:card-fragment")).toBe(before)
  const writes = await page.evaluate(() => (window as any).__SHARD_TYPE_CALLS__.filter((c: any) => c.command === "update_fragment"))
  expect(writes).toHaveLength(0)
})

test("密匣草稿不显示语音入口", async ({ page }) => {
  await setup(page)
  await fillEditor(page, "composer", "#密匣 私密内容")
  const composer = page.locator('[data-shard-editor="composer"]').locator('xpath=ancestor::*[contains(@class,"composer")][last()]')
  await expect(composer.getByRole("button", { name: "语音输入", exact: true })).toHaveCount(0)
  await expect(composer.getByRole("button", { name: "朗读", exact: true })).toHaveCount(0)
})

test("识别失败后使用原会话重试，不重新录音", async ({ page }) => {
  await setup(page)
  await fillEditor(page, "composer", "前文旧字后文")
  await selectEditorText(page, "composer", "旧字")
  await page.evaluate(() => {
    const w = window as any
    const original = w.__TAURI_INTERNALS__.invoke
    let failOnce = true
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: unknown) => {
      if (command === "voice_transcribe" && failOnce) {
        failOnce = false
        w.__failedVoiceSession = (args as any).sessionId
        throw new Error("语音服务返回 HTTP 500，请重试。")
      }
      return original(command, args)
    }
  })
  await page.getByRole("button", { name: "语音输入", exact: true }).click()
  await page.getByRole("button", { name: "结束并识别" }).click()
  await expect(page.getByRole("alert")).toContainText("HTTP 500")
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toHaveAttribute("contenteditable", "false")
  await page.getByRole("button", { name: "重试识别" }).click()
  await expect.poll(() => readEditor(page, "composer")).toBe("前文识别文字后文")
  expect(await page.evaluate(() => (window as any).__voiceCalls.filter((c: any) => c.command === "voice_start_recording").length)).toBe(1)
  expect(await page.evaluate(() => (window as any).__voiceCalls.find((c: any) => c.command === "voice_transcribe").args.sessionId === (window as any).__failedVoiceSession)).toBe(true)
})

test("切换资料库取消仍挂载的速记语音会话", async ({ page }) => {
  await setup(page)
  await fillEditor(page, "composer", "原草稿")
  await page.evaluate(() => {
    const w = window as any
    const original = w.__TAURI_INTERNALS__.invoke
    w.__voiceHold = true
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: unknown) => {
      if (command === "plugin:dialog|open") return "/tmp/shard-other-voice-vault"
      if (command === "set_vault_path") return { ...await original("list_fragments", {}), vaultPath: "/tmp/shard-other-voice-vault" }
      return original(command, args)
    }
  })
  await page.getByRole("button", { name: "语音输入", exact: true }).click()
  await page.getByRole("button", { name: "结束并识别" }).click()
  await expect(page.getByText("识别中…", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "更多操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "设置", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "选择已有目录", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__voiceCalls.filter((call: any) => call.command === "voice_cancel").length)).toBeGreaterThan(0)
  await page.evaluate(async () => { (window as any).__voiceRelease(); await new Promise(resolve => setTimeout(resolve, 50)) })
  expect(await readEditor(page, "composer")).not.toContain("识别文字")
})

test("准备录音时点卡片朗读，迟到的设置响应不会重新开麦", async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const w = window as any
    const original = w.__TAURI_INTERNALS__.invoke
    let holdNextSettings = true
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: unknown) => {
      if (command === "voice_get_settings" && holdNextSettings) {
        holdNextSettings = false
        await new Promise<void>(resolve => { w.__releaseVoiceSettings = resolve })
      }
      return original(command, args)
    }
  })
  await composerBox(page).getByRole("button", { name: "语音输入", exact: true }).click()
  await expect(composerBox(page).getByText("准备录音…", { exact: true })).toBeVisible()
  const target = card(page, "card-fragment")
  await revealCard(target)
  await target.getByRole("button", { name: "朗读", exact: true }).click()
  const player = page.getByLabel("朗读控制", { exact: true })
  await expect(player).toContainText("正在朗读")
  await page.evaluate(async () => { (window as any).__releaseVoiceSettings(); await new Promise(resolve => setTimeout(resolve, 50)) })
  expect(await voiceCalls(page, "voice_start_recording")).toHaveLength(0)
  await expect(composerEditor(page)).toHaveAttribute("contenteditable", "true")
  await expect(player).toContainText("正在朗读")
})

test("麦克风权限被拒绝时提示并恢复编辑", async ({ page }) => {
  await setup(page)
  await page.evaluate(() => { (window as any).__voiceFailStart = true })
  await composerBox(page).getByRole("button", { name: "语音输入", exact: true }).click()
  await expect(composerBox(page).getByRole("alert")).toContainText("麦克风权限被拒绝")
  await expect(composerEditor(page)).toHaveAttribute("contenteditable", "true")
  expect(await voiceCalls(page, "voice_start_recording")).toHaveLength(1)
})

test("未保存密钥时录音入口打开语音设置且不开麦，保存只改配置", async ({ page }) => {
  await setup(page)
  await page.evaluate(() => { (window as any).__voiceHasKey = false })
  await composerBox(page).getByRole("button", { name: "语音输入", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "语音", exact: true })).toBeVisible()
  expect(await voiceCalls(page, "voice_start_recording")).toHaveLength(0)
  await expect(dialog.getByLabel("识别模型", { exact: true })).toHaveValue("mimo-v2.5-asr")
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveValue("")
  await dialog.getByLabel("合成模型", { exact: true }).fill("custom-tts")
  await dialog.getByRole("button", { name: "保存", exact: true }).click()
  await expect(dialog.getByText("已保存", { exact: true })).toBeVisible()
  const saves = await voiceCalls(page, "voice_save_settings")
  expect(saves[0].args.apiKey).toBeUndefined()
  expect(saves[0].args.settings).toMatchObject({ speechModel: "custom-tts" })
  const style = await dialog.getByLabel("API Key", { exact: true }).evaluate(node => ({ radius: getComputedStyle(node).borderRadius, font: getComputedStyle(node).fontFamily }))
  expect(style.radius).toBe("4px")
  expect(style.font).toContain("Noto Sans SC")
})

test("设置页的语音分区复用同一份配置", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "更多操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "设置", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("navigation").getByRole("button", { name: "语音", exact: true }).click()
  await expect(dialog.getByLabel("Base URL", { exact: true })).toBeInViewport()
  await expect(dialog.getByLabel("音色", { exact: true })).toHaveValue("冰糖")
})

test("卡片朗读提取正文并支持暂停继续停止", async ({ page }) => {
  await setup(page, { fragmentBody: "这是需要朗读的记录。" })
  const target = card(page, "card-fragment")
  await revealCard(target)
  await target.getByRole("button", { name: "朗读", exact: true }).click()
  await expect.poll(async () => (await voiceCalls(page, "voice_synthesize")).length).toBe(1)
  expect((await voiceCalls(page, "voice_synthesize"))[0].args.text).toBe("这是需要朗读的记录。")
  const player = page.getByLabel("朗读控制", { exact: true })
  await player.getByRole("button", { name: "暂停", exact: true }).click()
  await expect(player.getByText("已暂停", { exact: true })).toBeVisible()
  await player.getByRole("button", { name: "继续", exact: true }).click()
  await expect(player.getByText("正在朗读", { exact: true })).toBeVisible()
  await player.getByRole("button", { name: "停止", exact: true }).click()
  await expect(player).toHaveCount(0)
})
