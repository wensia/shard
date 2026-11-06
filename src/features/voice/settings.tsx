import { useEffect, useId, useRef, useState } from 'react'
import { SquareIcon, Volume2Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SelectControl } from '@/components/ui/select'
import { useVoice } from './provider'
import { useVoiceDictation, VoiceInputControls } from './dictation'
import { defaultVoiceSettings, voiceError, voiceInvoke, type VoiceSettingsData } from './api'
import styles from './voice.module.css'

type Mode = VoiceSettingsData['mode']
const CUSTOM_VOICE = '__custom__'
/** MiMo 是 mimo-v2.5-tts 的官方预置音色（中文音色的 ID 就是名字）；OpenAI 兼容服务的音色各家不同，列 OpenAI 自家的，其余走自定义。 */
const VOICE_PRESETS: Record<Mode, { value: string; label: string }[]> = {
  mimo: [
    { value: '冰糖', label: '冰糖 · 中文女声' }, { value: '茉莉', label: '茉莉 · 中文女声' },
    { value: '苏打', label: '苏打 · 中文男声' }, { value: '白桦', label: '白桦 · 中文男声' },
    { value: 'Mia', label: 'Mia · 英文女声' }, { value: 'Chloe', label: 'Chloe · 英文女声' },
    { value: 'Milo', label: 'Milo · 英文男声' }, { value: 'Dean', label: 'Dean · 英文男声' },
  ],
  openai: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'].map(value => ({ value, label: value })),
}
const isPreset = (mode: Mode, voice: string) => VOICE_PRESETS[mode].some(preset => preset.value === voice)
/** 试听只覆盖音色；其余字段改动后要先保存，因为密钥按已保存的 Base URL 存放。 */
const CONNECTION_FIELDS = ['mode', 'baseUrl', 'transcriptionModel', 'speechModel'] as const

export function VoiceSettings() {
  const id = useId(); const voice = useVoice()
  const previewOwner = `voice-preview-${id}`
  const latestVoice = useRef(voice); latestVoice.current = voice
  useEffect(() => () => latestVoice.current.stopOwner(previewOwner), [previewOwner])
  const [settings, setSettings] = useState(defaultVoiceSettings)
  const [saved, setSaved] = useState(defaultVoiceSettings)
  const [customVoice, setCustomVoice] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [transcript, setTranscript] = useState('')
  const pending = key !== '' || CONNECTION_FIELDS.some(field => settings[field] !== saved[field])
  const test = useVoiceDictation({ targetId: `voice-test-${id}`, disabled: busy || pending || !saved.hasKey, onInsert: setTranscript })
  const load = (value: VoiceSettingsData) => { setSettings(value); setSaved(value); setCustomVoice(!isPreset(value.mode, value.voice)) }
  useEffect(() => {
    let active = true
    void voiceInvoke<VoiceSettingsData>('voice_get_settings').then(value => { if (active) load(value) }, cause => { if (active) setError(voiceError(cause)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [])
  const edit = (patch: Partial<VoiceSettingsData>) => { voice.stop(); setSettings(current => ({ ...current, ...patch })); setMessage('') }
  async function save() {
    voice.stop(); test.cancel(); setBusy(true); setError(''); setMessage('')
    try {
      load(await voiceInvoke<VoiceSettingsData>('voice_save_settings', { settings, ...(key ? { apiKey: key } : {}) }))
      setKey(''); setMessage('已保存')
    } catch (cause) { setError(voiceError(cause)) }
    finally { setBusy(false) }
  }
  const locked = busy || test.busy
  const previewing = voice.activeOwner === previewOwner
  const previewVoice = settings.voice.trim()
  return <div className={styles.settings} aria-busy={busy} data-focus-region="voice-settings">
    <label className={styles.field} htmlFor={`${id}-mode`}>接口模式<SelectControl id={`${id}-mode`} value={settings.mode} disabled={locked} options={[{ value: 'mimo', label: 'MiMo' }, { value: 'openai', label: 'OpenAI 兼容' }]} onValueChange={value => {
      const mode = value as Mode
      // 换模式时预置音色跟着换成新模式的默认；自定义的音色 ID 原样保留。
      edit(customVoice || mode === settings.mode ? { mode } : { mode, voice: VOICE_PRESETS[mode][0].value })
    }} /></label>
    {([['baseUrl', 'Base URL'], ['transcriptionModel', '识别模型'], ['speechModel', '合成模型']] as const).map(([field, label]) => <label className={styles.field} htmlFor={`${id}-${field}`} key={field}>{label}<Input id={`${id}-${field}`} value={settings[field]} disabled={locked} onChange={event => edit({ [field]: event.target.value })} /></label>)}
    <div className={styles.field}>
      <label htmlFor={`${id}-voice`}>音色</label>
      <div className={styles.voiceRow}>
        <SelectControl id={`${id}-voice`} className={styles.voiceSelect} value={customVoice ? CUSTOM_VOICE : settings.voice} disabled={locked}
          options={[...VOICE_PRESETS[settings.mode], { value: CUSTOM_VOICE, label: '自定义' }]}
          onValueChange={value => { if (value === CUSTOM_VOICE) setCustomVoice(true); else { setCustomVoice(false); edit({ voice: value }) } }} />
        <Button variant="outline" disabled={!previewing && (locked || pending || !saved.hasKey || !previewVoice)}
          onClick={() => { if (previewing) voice.stopOwner(previewOwner); else void voice.read(previewOwner, { text: '你好，这是 Shard 的语音试听。', format: 'text' }, { voice: previewVoice }) }}>
          {previewing ? <SquareIcon data-icon="inline-start" /> : <Volume2Icon data-icon="inline-start" />}{previewing ? '停止' : '试听'}
        </Button>
      </div>
      {customVoice && <Input aria-label="自定义音色" placeholder="填写服务商提供的音色 ID" value={settings.voice} disabled={locked} onChange={event => edit({ voice: event.target.value })} />}
    </div>
    <label className={styles.field} htmlFor={`${id}-key`}>API Key<Input id={`${id}-key`} type="password" autoComplete="off" value={key} placeholder={saved.hasKey ? '已保存，留空保留' : '输入 API Key'} disabled={locked} onChange={event => { voice.stop(); setKey(event.target.value); setMessage('') }} /></label>
    <p className={styles.status}>录音及朗读文本会发送至配置的服务。</p>
    <div className={styles.controls}><Button disabled={locked} onClick={() => void save()}>保存</Button><span className={styles.status} role="status">{message}</span></div>
    <div className={styles.controls}><span className={styles.status}>识别测试</span><VoiceInputControls dictation={test} /></div>
    {pending && <span className={styles.status}>保存后可测试。</span>}
    {transcript && <p className={styles.status} role="status">识别结果：{transcript}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>
}
