import type { Page } from "@playwright/test"

/**
 * 语音命令的浏览器替身：在页面加载后包住 Tauri invoke，只接管 voice_*。
 * 控制位挂在 window 上，测试可随时改：
 * - __voiceHasKey：false 时 voice_get_settings 报未配置密钥
 * - __voiceFailStart：voice_start_recording 抛权限错误
 * - __voiceHold：voice_transcribe 挂起，直到 __voiceRelease()
 * - __voiceText：识别结果
 */
export async function installLocalVoiceMock(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    const invoke = w.__TAURI_INTERNALS__.invoke
    w.__voiceCalls = []
    w.__voiceText = "识别文字"
    w.__voiceHasKey = true
    w.__voiceFailStart = false
    // voice_synthesize 返回原始 WAV 字节（Tauri 的二进制响应在页面里就是 ArrayBuffer）。
    const wav = Uint8Array.from(atob("UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA="), char => char.charCodeAt(0)).buffer
    w.__voiceWav = () => wav.slice(0)
    let settings = { mode: "mimo", baseUrl: "https://api.xiaomimimo.com/v1", transcriptionModel: "mimo-v2.5-asr", speechModel: "mimo-v2.5-tts", voice: "冰糖" }
    HTMLMediaElement.prototype.play = async function () {}
    HTMLMediaElement.prototype.pause = function () {}
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: Record<string, unknown> = {}) => {
      if (!command.startsWith("voice_")) return invoke(command, args)
      w.__voiceCalls.push({ command, args })
      if (command === "voice_get_settings") return { ...settings, hasKey: w.__voiceHasKey }
      if (command === "voice_save_settings") {
        settings = { ...settings, ...(args.settings as typeof settings) }
        if (typeof args.apiKey === "string") w.__voiceHasKey = Boolean(args.apiKey)
        return { ...settings, hasKey: w.__voiceHasKey }
      }
      if (command === "voice_start_recording") {
        if (w.__voiceFailStart) throw new Error("麦克风权限被拒绝，请在系统设置中允许 Shard 使用麦克风。")
        return null
      }
      if (command === "voice_transcribe") {
        if (w.__voiceHold) await new Promise<void>(resolve => { w.__voiceRelease = resolve })
        return { text: w.__voiceText }
      }
      if (command === "voice_synthesize") return w.__voiceWav()
      return null
    }
  })
}

export async function voiceCalls(page: Page, command: string): Promise<Array<{ command: string; args: Record<string, unknown> }>> {
  return page.evaluate(command => (window as any).__voiceCalls.filter((call: any) => call.command === command), command)
}
