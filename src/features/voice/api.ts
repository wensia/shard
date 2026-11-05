import { invoke, isTauri } from '@tauri-apps/api/core'
export interface VoiceSettingsData {
  mode: 'mimo' | 'openai'; baseUrl: string; transcriptionModel: string; speechModel: string; voice: string; hasKey: boolean
}
export const defaultVoiceSettings: VoiceSettingsData = { mode: 'mimo', baseUrl: 'https://api.xiaomimimo.com/v1', transcriptionModel: 'mimo-v2.5-asr', speechModel: 'mimo-v2.5-tts', voice: '冰糖', hasKey: false }
export function voiceInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error('语音功能需在桌面端使用'))
  return invoke<T>(command, args)
}
export function voiceError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '语音操作失败，请重试'
}
export const cancelSession = (sessionId: string) => voiceInvoke('voice_cancel', { sessionId }).catch(() => {})
