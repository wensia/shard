import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from '@tauri-apps/api/core'
import { MicIcon, Volume2Icon, SquareIcon, XIcon } from '@/components/icons'
import { ToolbarIconButton } from '@/components/ui/toolbar-icon-button'
import { Button } from '@/components/ui/button'
import type { VoiceContent } from '@/lib/voice-text'
import { useVoice } from './provider'
import { cancelSession, voiceError, voiceInvoke } from './api'
import styles from './voice.module.css'

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'error'
export function useVoiceDictation(options: { targetId: string; onBeforeStart?: () => void; onInsert: (text: string) => void; disabled?: boolean }) {
  const voice = useVoice()
  const latest = useRef({ options, voice }); latest.current = { options, voice }
  const session = useRef<{ id: string; targetId: string; release?: () => void; retryable: boolean } | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const phaseRef = useRef<Phase>('idle')
  const update = (next: Phase) => { phaseRef.current = next; setPhase(next) }
  const [error, setError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  function cancel() {
    const previous = session.current; session.current = null
    if (previous) { previous.release?.(); void cancelSession(previous.id) }
    update('idle'); setError(''); setElapsed(0)
  }
  const cancelRef = useRef(cancel); cancelRef.current = cancel
  useEffect(() => () => cancelRef.current(), [options.targetId])
  async function finish() {
    const current = session.current
    if (!current || !['recording', 'error'].includes(phaseRef.current)) return
    if (phaseRef.current === 'error' && !current.retryable) return
    update('transcribing'); setError(''); current.retryable = true
    try {
      const result = await voiceInvoke<{ text: string }>('voice_transcribe', { sessionId: current.id })
      // A successful transcription releases the recording in the backend; later failures cannot be retried.
      current.retryable = false
      if (session.current !== current || latest.current.options.targetId !== current.targetId) return
      if (!result.text.trim()) throw new Error('没有识别到文字，请重新录音')
      latest.current.options.onInsert(result.text)
      cancel()
    } catch (cause) {
      if (session.current === current) { update('error'); setError(voiceError(cause)) }
    }
  }
  const finishRef = useRef(finish); finishRef.current = finish
  useEffect(() => {
    if (phase !== 'recording') return
    const started = Date.now()
    const timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000)
      setElapsed(Math.min(120, seconds))
      if (seconds >= 120) void finishRef.current()
    }, 250)
    return () => clearInterval(timer)
  }, [phase])
  useEffect(() => {
    if (!isTauri()) return
    let disposed = false; let unlisten: (() => void) | undefined
    void listen<{ sessionId: string; reason: string; error?: string }>('voice-recording-stopped', event => {
      if (session.current?.id !== event.payload.sessionId) return
      if (event.payload.reason === 'limit') void finishRef.current()
      else { update('error'); setError(event.payload.error ?? '录音中断，请重新录音') }
    }).then(fn => { if (disposed) fn(); else unlisten = fn }, () => {})
    return () => { disposed = true; unlisten?.() }
  }, [])
  async function start() {
    if (latest.current.options.disabled || session.current) return
    const current = { id: crypto.randomUUID(), targetId: latest.current.options.targetId, retryable: false, release: undefined as (() => void) | undefined }
    session.current = current; setError(''); setElapsed(0)
    try {
      latest.current.options.onBeforeStart?.()
      current.release = latest.current.voice.claimRecording(() => cancelRef.current())
      update('starting')
      if (!(await latest.current.voice.configured(() => session.current === current))) { if (session.current === current) cancel(); return }
      if (session.current !== current) return
      await voiceInvoke('voice_start_recording', { sessionId: current.id })
      if (session.current !== current) { void cancelSession(current.id); return }
      // A stop event (interruption, device loss) can arrive before this reply; keep its error.
      if (phaseRef.current !== 'starting') return
      update('recording')
    } catch (cause) {
      if (session.current === current) { const message = voiceError(cause); cancel(); setError(message) }
    }
  }
  return { busy: phase !== 'idle', phase, error, elapsed, start, finish, cancel, retry: finish, canRetry: session.current?.retryable === true, disabled: options.disabled }
}
export type VoiceDictation = ReturnType<typeof useVoiceDictation>
export function VoiceInputControls({ dictation: d }: { dictation: VoiceDictation }) {
  return <span className={styles.controls} aria-busy={d.busy} onMouseDown={event => event.preventDefault()}>
    <ToolbarIconButton label={d.phase === 'recording' ? '结束并识别' : '语音输入'} variant="outline" disabled={d.disabled || !['idle', 'recording'].includes(d.phase)} onClick={() => void (d.phase === 'recording' ? d.finish() : d.start())}>{d.phase === 'recording' ? <SquareIcon /> : <MicIcon />}</ToolbarIconButton>
    {d.busy && <><span role="status" className={styles.status}>{d.phase === 'recording' ? `${d.elapsed}s` : d.phase === 'transcribing' ? '识别中…' : d.phase === 'starting' ? '准备录音…' : ''}</span><ToolbarIconButton label="取消录音" variant="outline" onClick={d.cancel}><XIcon /></ToolbarIconButton></>}
    {d.phase === 'error' && d.canRetry && <Button size="sm" variant="outline" onClick={() => void d.retry()}>重试识别</Button>}
    {d.error && <span role="alert" className={styles.error}>{d.error}</span>}
  </span>
}
export function ReadAloudButton({ targetId, getContent, disabled }: { targetId: string; getContent: () => VoiceContent; disabled?: boolean }) {
  const voice = useVoice(); const latest = useRef(voice); latest.current = voice
  useEffect(() => () => latest.current.stopOwner(targetId), [targetId])
  return <ToolbarIconButton label="朗读" variant="outline" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => void voice.read(targetId, getContent())}><Volume2Icon /></ToolbarIconButton>
}
