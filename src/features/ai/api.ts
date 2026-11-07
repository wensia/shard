import { getApiErrorMessage } from "@/lib/api"
import { transport } from "@/lib/transport"

/** 服务端 `ai_settings::view` 的自动标签部分。密钥从不返回，只有 `hasKey`。 */
export interface AutoTaggingView {
  /** `env`：服务器环境变量托管，App 里只读。 */
  source: "app" | "env"
  enabled: boolean
  apiBase: string
  model: string
  hasKey: boolean
  state: "off" | "running" | "paused"
  lastSuccessAt: number | null
  lastError: string | null
  lastErrorAt: number | null
  counts: { pending: number; done: number; failed: number } | null
}

export interface AiSettingsView {
  autoTagging: AutoTaggingView
}

export interface AutoTaggingForm {
  enabled: boolean
  apiBase: string
  model: string
  /** 留空表示保留已保存的密钥。 */
  apiKey?: string
  clearKey?: boolean
}

export type ConnectionTestResult = { ok: true; tags: string[] } | { ok: false; message: string }

function call<T>(command: string, args: Record<string, unknown>) {
  return transport()
    .invoke<T>(command, args)
    .catch((error: unknown) => Promise.reject(errorMessage(error)))
}

/** RPC 失败可能是字符串，也可能是带 message 的结构化错误。 */
function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return getApiErrorMessage(error)
}

export function getAiSettings() {
  return call<AiSettingsView>("ai_settings_get", {})
}

export function saveAutoTagging(form: AutoTaggingForm) {
  return call<AiSettingsView>("ai_settings_save", { autoTagging: form })
}

export function testAutoTagging(form: AutoTaggingForm) {
  return call<ConnectionTestResult>("ai_settings_test", { autoTagging: form })
}
