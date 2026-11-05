import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { SelectControl } from '@/components/ui/select'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { VoiceContent } from '@/lib/voice-text'
import { cancelSession, voiceError, voiceInvoke, type VoiceSettingsData } from './api'
import { VoiceSettings } from './settings'
import styles from './voice.module.css'

type Playback = { id: string; owner: string; audio: HTMLAudioElement | null; url: string | null; worker?: Worker; rejectWorker?: () => void; paused: boolean; resume?: () => void }
type VoiceContextValue = {
  openSettings: () => void; configured: (isCurrent?: () => boolean) => Promise<boolean>; stop: () => void;
  claimRecording: (cancel: () => void) => () => void;
  read: (owner: string, content: VoiceContent) => Promise<void>; stopOwner: (owner: string) => void
}
const missing: VoiceContextValue = { openSettings() {}, configured: async () => false, stop() {}, claimRecording: () => () => {}, read: async () => {}, stopOwner() {} }
const VoiceContext = createContext<VoiceContextValue>(missing)
export const useVoice = () => useContext(VoiceContext)

export function VoiceProvider({ children, scopeKey }: { children: ReactNode; scopeKey?: string }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [player, setPlayer] = useState<'idle' | 'loading' | 'playing' | 'paused'>('idle')
  const [error, setError] = useState('')
  const [speed, setSpeed] = useState(1)
  const speedRef = useRef(1)
  const current = useRef<Playback | null>(null)
  const recording = useRef<(() => void) | null>(null)
  const stop = () => {
    const session = current.current
    current.current = null
    if (session) {
      session.audio?.pause(); session.resume?.(); session.rejectWorker?.(); session.worker?.terminate()
      if (session.url) URL.revokeObjectURL(session.url)
      void cancelSession(session.id)
    }
    setPlayer('idle'); setError('')
  }
  const stopRef = useRef(stop); stopRef.current = stop
  useEffect(() => () => { stopRef.current(); recording.current?.() }, [])
  useEffect(() => { stopRef.current(); recording.current?.() }, [scopeKey])
  async function configured(isCurrent: () => boolean = () => true) {
    const settings = await voiceInvoke<VoiceSettingsData>('voice_get_settings')
    if (!isCurrent()) return false
    if (!settings.hasKey) { setSettingsOpen(true); return false }
    return true
  }
  async function read(owner: string, content: VoiceContent) {
    stop(); recording.current?.()
    const session: Playback = { id: crypto.randomUUID(), owner, audio: null, url: null, paused: false }
    current.current = session; setPlayer('loading')
    const active = () => current.current === session
    try {
      if (!(await configured(active))) { if (active()) stop(); return }
      if (!active()) return
      const chunks = await new Promise<string[]>((resolve, reject) => {
        const worker = new Worker(new URL('../../workers/voice-text.worker.ts', import.meta.url), { type: 'module' })
        session.worker = worker
        session.rejectWorker = () => reject(new Error('已取消'))
        worker.onmessage = (event: MessageEvent<{ chunks?: string[]; error?: string }>) => {
          worker.terminate(); session.worker = undefined; session.rejectWorker = undefined
          if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.chunks ?? [])
        }
        worker.onerror = () => { worker.terminate(); reject(new Error('无法读取朗读正文')) }
        worker.postMessage(content)
      })
      if (!active()) return
      if (!chunks.length) throw new Error('没有可朗读的正文')
      // The backend returns validated WAV bytes as a raw IPC payload: no base64, no decoding step here.
      // Wrap prefetch failures immediately, so cancelling during playback never leaks rejection.
      const synthesize = (text: string) => voiceInvoke<ArrayBuffer>('voice_synthesize', { sessionId: session.id, text })
        .then(value => ({ value, error: null as unknown }), error => ({ value: null, error }))
      let next = synthesize(chunks[0])
      for (let index = 0; index < chunks.length && active(); index++) {
        const result = await next
        if (!active()) return
        if (!result.value) throw result.error
        if (!(result.value instanceof ArrayBuffer) || !result.value.byteLength) throw new Error('服务返回了无效的音频数据')
        session.url = URL.createObjectURL(new Blob([result.value], { type: 'audio/wav' }))
        const audio = new Audio(session.url); session.audio = audio; audio.playbackRate = speedRef.current
        if (index + 1 < chunks.length) next = synthesize(chunks[index + 1])
        await new Promise<void>((resolve, reject) => {
          let ended = false
          let playAttempt = 0
          const resume = () => {
            if (!active()) { resolve(); return }
            if (ended) { resolve(); return }
            const attempt = ++playAttempt
            void audio.play().then(() => {
              if (active() && attempt === playAttempt && !session.paused) setPlayer('playing')
            }, cause => {
              // HTMLMediaElement.pause() can interrupt a still-pending play().
              // Keep this segment waiting for Resume instead of failing its session.
              if (attempt !== playAttempt) return
              if (active() && session.paused && cause instanceof DOMException && cause.name === 'AbortError') return
              reject(cause)
            })
          }
          session.resume = resume
          audio.onended = () => { ended = true; resolve() }
          audio.onerror = () => reject(new Error('无法播放返回的音频'))
          if (!session.paused) resume()
        })
        audio.pause(); audio.removeAttribute('src'); audio.load()
        if (session.url) URL.revokeObjectURL(session.url)
        session.url = null; session.audio = null
      }
      if (active()) stop()
    } catch (cause) {
      if (active()) { stop(); setError(voiceError(cause)) }
    }
  }
  const value: VoiceContextValue = {
    openSettings: () => setSettingsOpen(true), configured, stop: () => { stop(); recording.current?.() },
    claimRecording(cancel) {
      stop(); recording.current?.(); recording.current = cancel
      return () => { if (recording.current === cancel) recording.current = null }
    }, read,
    stopOwner(owner) { if (current.current?.owner === owner) stop() },
  }
  return <VoiceContext.Provider value={value}>
    {children}
    {(player !== 'idle' || error) && <div className={`${styles.player} ${styles.controls}`} data-focus-region="voice-player" aria-label="朗读控制">
      {error ? <span role="alert" className={styles.error}>{error}</span> : <>
        <span className={styles.status} role="status">{player === 'loading' ? '生成语音…' : player === 'paused' ? '已暂停' : '正在朗读'}</span>
        <Button size="sm" variant="outline" onClick={() => {
          const session = current.current; if (!session) return
          session.paused = !session.paused
          if (session.paused) { session.audio?.pause(); setPlayer('paused') }
          else { setPlayer(session.audio ? 'playing' : 'loading'); session.resume?.() }
        }}>{player === 'paused' ? '继续' : '暂停'}</Button>
        <SelectControl aria-label="朗读倍速" value={String(speed)} options={[0.75, 1, 1.25, 1.5, 2].map(value => ({ value: String(value), label: `${value}×` }))} onValueChange={value => { const rate = Number(value); setSpeed(rate); speedRef.current = rate; if (current.current?.audio) current.current.audio.playbackRate = rate }} />
      </>}
      <Button size="sm" variant="outline" onClick={stop}>{error ? '关闭' : '停止'}</Button>
    </div>}
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}><DialogContent><DialogTitle>语音</DialogTitle><VoiceSettings /></DialogContent></Dialog>
  </VoiceContext.Provider>
}
