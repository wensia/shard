import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SelectControl } from '@/components/ui/select'
import { useVoice } from './provider'
import { useVoiceDictation, VoiceInputControls } from './dictation'
import { defaultVoiceSettings, voiceError, voiceInvoke, type VoiceSettingsData } from './api'
import styles from './voice.module.css'
export function VoiceSettings() {
  const id = useId(); const voice = useVoice()
  const latestVoice = useRef(voice); latestVoice.current = voice
  useEffect(() => () => latestVoice.current.stopOwner(`voice-preview-${id}`), [id])
  const [settings, setSettings] = useState(defaultVoiceSettings)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [transcript, setTranscript] = useState('')
  const [dirty, setDirty] = useState(false)
  const test = useVoiceDictation({ targetId: `voice-test-${id}`, disabled: busy || dirty || !settings.hasKey, onInsert: setTranscript })
  useEffect(() => {
    let active = true
    void voiceInvoke<VoiceSettingsData>('voice_get_settings').then(value => { if (active) setSettings(value) }, cause => { if (active) setError(voiceError(cause)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [])
  const edit = (patch: Partial<VoiceSettingsData>) => { voice.stop(); setSettings(current => ({ ...current, ...patch })); setDirty(true); setMessage('') }
  async function save() {
    voice.stop(); test.cancel(); setBusy(true); setError(''); setMessage('')
    try {
      const saved = await voiceInvoke<VoiceSettingsData>('voice_save_settings', { settings, ...(key ? { apiKey: key } : {}) })
      setSettings(saved); setKey(''); setDirty(false); setMessage('已保存')
    } catch (cause) { setError(voiceError(cause)) }
    finally { setBusy(false) }
  }
  return <div className={styles.settings} aria-busy={busy} data-focus-region="voice-settings">
    <label className={styles.field} htmlFor={`${id}-mode`}>接口模式<SelectControl id={`${id}-mode`} value={settings.mode} disabled={busy || test.busy} options={[{ value: 'mimo', label: 'MiMo' }, { value: 'openai', label: 'OpenAI 兼容' }]} onValueChange={mode => edit({ mode: mode as VoiceSettingsData['mode'] })} /></label>
    {([['baseUrl', 'Base URL'], ['transcriptionModel', '识别模型'], ['speechModel', '合成模型'], ['voice', '音色']] as const).map(([field, label]) => <label className={styles.field} htmlFor={`${id}-${field}`} key={field}>{label}<Input id={`${id}-${field}`} value={settings[field]} disabled={busy || test.busy} onChange={event => edit({ [field]: event.target.value })} /></label>)}
    <label className={styles.field} htmlFor={`${id}-key`}>API Key<Input id={`${id}-key`} type="password" autoComplete="off" value={key} placeholder={settings.hasKey ? '已保存，留空保留' : '输入 API Key'} disabled={busy || test.busy} onChange={event => { voice.stop(); setKey(event.target.value); setDirty(true); setMessage('') }} /></label>
    <p className={styles.status}>录音及朗读文本会发送至配置的服务。</p>
    <div className={styles.controls}><Button disabled={busy || test.busy} onClick={() => void save()}>保存</Button><span className={styles.status} role="status">{message}</span></div>
    <div className={styles.controls}><span className={styles.status}>识别测试</span><VoiceInputControls dictation={test} /><Button variant="outline" disabled={busy || dirty || test.busy || !settings.hasKey} onClick={() => void voice.read(`voice-preview-${id}`, { text: '你好，这是 Shard 的语音试听。', format: 'text' })}>试听</Button></div>
    {dirty && <span className={styles.status}>保存后可测试。</span>}
    {transcript && <p className={styles.status} role="status">识别结果：{transcript}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>
}
