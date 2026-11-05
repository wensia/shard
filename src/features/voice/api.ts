import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { IOS_NATIVE_EVENT, invokeIOSVoice, isIOSNative } from '@/lib/ios-native'
export interface VoiceSettingsData {
  mode: 'mimo' | 'openai'; baseUrl: string; transcriptionModel: string; speechModel: string; voice: string; hasKey: boolean
}
export interface VoiceRecordingStopped { sessionId: string; reason: string; error?: string }
export const defaultVoiceSettings: VoiceSettingsData = { mode: 'mimo', baseUrl: 'https://api.xiaomimimo.com/v1', transcriptionModel: 'mimo-v2.5-asr', speechModel: 'mimo-v2.5-tts', voice: '冰糖', hasKey: false }

/** 录音、钥匙串和语音服务请求都在原生侧：桌面（Tauri）与 iOS App 有，浏览器里没有。 */
export function voiceAvailable() {
  return isTauri() || isIOSNative()
}

/** 桌面直接走本机 IPC（连接服务器时也不经 VPS 转发）；iOS 走原生桥，密钥同样不进页面。 */
export function voiceInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) return invoke<T>(command, args)
  if (isIOSNative()) return invokeIOS<T>(command, args)
  return Promise.reject(new Error('语音功能需在 Shard 桌面端或 iOS App 中使用'))
}

async function invokeIOS<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await invokeIOSVoice(command, args)
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as { message?: unknown } | null
    throw new Error(typeof problem?.message === 'string' ? problem.message : '语音操作失败，请重试')
  }
  // 合成结果是原始 WAV 字节，与桌面的二进制 IPC 返回同一形态（ArrayBuffer）。
  if (response.headers.get('content-type')?.startsWith('audio/')) return await response.arrayBuffer() as T
  const text = await response.text()
  return (text ? JSON.parse(text) : null) as T
}

/** 后端结束了录音（到达时长上限或设备中断）。返回取消订阅函数。 */
export async function listenVoiceStopped(handler: (event: VoiceRecordingStopped) => void): Promise<() => void> {
  if (isTauri()) return listen<VoiceRecordingStopped>('voice-recording-stopped', event => handler(event.payload))
  if (!isIOSNative()) return () => {}
  const receive = (event: Event) => {
    const detail = (event as CustomEvent).detail
    if (detail?.type !== 'voice-recording-stopped' || typeof detail.id !== 'string' || typeof detail.reason !== 'string') return
    handler({ sessionId: detail.id, reason: detail.reason, error: typeof detail.error === 'string' ? detail.error : undefined })
  }
  window.addEventListener(IOS_NATIVE_EVENT, receive)
  return () => window.removeEventListener(IOS_NATIVE_EVENT, receive)
}

export function voiceError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '语音操作失败，请重试'
}
export const cancelSession = (sessionId: string) => voiceInvoke('voice_cancel', { sessionId }).catch(() => {})
