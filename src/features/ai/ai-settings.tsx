import { useCallback, useEffect, useId, useRef, useState } from "react"

import {
  SettingsGroup,
  SettingsGroupItem,
  SettingsMono,
  SettingsRow,
} from "@/components/shard/settings-controls"
import { StatusIndicator, type StationTone } from "@/components/shard/settings-status"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { VoiceSettings, voiceAvailable } from "@/features/voice"
import { isServerBacked } from "@/lib/transport"

import {
  getAiSettings,
  saveAutoTagging,
  testAutoTagging,
  type AutoTaggingForm,
  type AutoTaggingView,
} from "./api"
import styles from "./ai-settings.module.css"

/** 后台状态刷新间隔：设置页开着时看得到排队数在走。 */
const STATUS_POLL_MS = 10_000

const STATE_META: Record<AutoTaggingView["state"], { label: string; tone: StationTone }> = {
  off: { label: "已关闭", tone: "empty" },
  running: { label: "运行中", tone: "emerald" },
  paused: { label: "已暂停", tone: "amber" },
}

/**
 * 设置 → AI：所有和 AI 有关的配置都在这一处。
 * - 自动标签：在 Shard 服务器上运行（网页、连接服务器的桌面、iOS）；本机资料库模式只给出说明。
 * - 语音输入与朗读：在本机直接调用服务商（桌面、iOS App），密钥在系统钥匙串。
 * - AI 助手接入：桌面安装 `shard` 命令后，Claude Code / Codex 等可以读写资料库。
 */
export function AiSettings({
  canInstallCli,
  onNavigate,
}: {
  /** 桌面有「终端命令」分区；网页与 iOS 没有。 */
  canInstallCli: boolean
  onNavigate: (section: "cli" | "server") => void
}) {
  return (
    <>
      {isServerBacked() ? (
        <AutoTaggingSettings />
      ) : (
        <SettingsGroup
          description="在 Shard 服务器上为没有主题标签的碎片和笔记自动补上标签，优先沿用已有标签。"
          id="auto-tagging"
          title="自动标签"
        >
          <SettingsRow
            controlWidth="auto"
            description="连接 Shard 服务器后，可以在这里开启，并配置模型和 API Key。"
            label="需要连接服务器"
          >
            <Button onClick={() => onNavigate("server")} size="md" type="button" variant="outline">
              前往服务器设置
            </Button>
          </SettingsRow>
        </SettingsGroup>
      )}

      {voiceAvailable() ? (
        <SettingsGroup
          description="录音识别和朗读由这台设备直接调用服务商接口，API Key 存在系统钥匙串，不经过 Shard 服务器。"
          id="voice"
          title="语音输入与朗读"
        >
          <SettingsGroupItem>
            <VoiceSettings />
          </SettingsGroupItem>
        </SettingsGroup>
      ) : null}

      {canInstallCli ? (
        <SettingsGroup
          description="让 Claude Code、Codex 等 AI 助手查找、记录和整理你的资料。"
          id="assistant"
          title="AI 助手接入"
        >
          <SettingsRow
            controlWidth="auto"
            description={
              <>
                先安装终端命令，再运行 <SettingsMono>shard --install-skill</SettingsMono> 为 Claude Code
                安装技能；其他助手可以直接调用 <SettingsMono>shard --json</SettingsMono>。
              </>
            }
            label="终端命令 shard"
          >
            <Button onClick={() => onNavigate("cli")} size="md" type="button" variant="outline">
              前往终端命令
            </Button>
          </SettingsRow>
        </SettingsGroup>
      ) : null}
    </>
  )
}

/** 新 App 连到还没升级的服务器：服务器不认识这组命令。 */
function isOutdatedServer(message: string) {
  return message.includes("没有这个命令") || message.includes("UNKNOWN_COMMAND")
}

function formFrom(view: AutoTaggingView): AutoTaggingForm {
  return { enabled: view.enabled, apiBase: view.apiBase, model: view.model }
}

function formatTime(seconds: number) {
  const date = new Date(seconds * 1000)
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
  const today = new Date()
  return date.toDateString() === today.toDateString()
    ? time
    : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}

function statusDescription(view: AutoTaggingView) {
  const parts: string[] = []
  if (view.counts) {
    parts.push(`已处理 ${view.counts.done} 条`)
    if (view.counts.pending) parts.push(`排队 ${view.counts.pending} 条`)
    if (view.counts.failed) parts.push(`跳过 ${view.counts.failed} 条`)
  }
  if (view.state === "paused") {
    parts.push(
      view.source === "env"
        ? "模型配置有误，修改服务器环境变量并重启服务后恢复"
        : "模型配置有误，修改并保存后自动恢复"
    )
  }
  if (view.lastError && (view.lastErrorAt ?? 0) >= (view.lastSuccessAt ?? 0)) {
    parts.push(`最近一次失败：${view.lastError}`)
  } else if (view.lastSuccessAt) {
    parts.push(`最近一次成功：${formatTime(view.lastSuccessAt)}`)
  }
  return parts.join(" · ")
}

function AutoTaggingSettings() {
  const id = useId()
  const [view, setView] = useState<AutoTaggingView | null>(null)
  const [form, setForm] = useState<AutoTaggingForm>({ enabled: false, apiBase: "", model: "" })
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState<"load" | "save" | "test" | null>("load")
  const [loadError, setLoadError] = useState("")
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const mounted = useRef(true)

  const load = useCallback(async (resetForm: boolean) => {
    try {
      const next = (await getAiSettings()).autoTagging
      if (!mounted.current) return
      setView(next)
      setLoadError("")
      if (resetForm) setForm(formFrom(next))
    } catch (cause) {
      if (mounted.current && resetForm) setLoadError(String(cause))
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load(true).finally(() => {
      if (mounted.current) setBusy(null)
    })
    // 只刷新状态与计数，不覆盖正在编辑的表单。
    const timer = window.setInterval(() => void load(false), STATUS_POLL_MS)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
    }
  }, [load])

  if (!view) {
    return (
      <SettingsGroup busy={busy === "load"} id="auto-tagging" title="自动标签">
        <SettingsGroupItem>
          {loadError && isOutdatedServer(loadError) ? (
            <p className={styles.feedback} role="status">
              当前连接的 Shard 服务器版本较旧，还不支持自动标签。更新服务器后即可在这里配置。
            </p>
          ) : loadError ? (
            <div className={styles.actions}>
              <p className={styles.error} role="alert">
                读取自动标签设置失败：{loadError}
              </p>
              <Button
                onClick={() => {
                  setBusy("load")
                  void load(true).finally(() => setBusy(null))
                }}
                size="md"
                type="button"
                variant="outline"
              >
                重试
              </Button>
            </div>
          ) : (
            <p className={styles.feedback}>正在读取…</p>
          )}
        </SettingsGroupItem>
      </SettingsGroup>
    )
  }

  const managed = view.source === "env"
  const locked = busy !== null || managed
  const dirty = form.apiBase.trim() !== view.apiBase || form.model.trim() !== view.model || key.trim() !== ""
  const state = STATE_META[view.state]

  /** 成功返回 true；失败时错误显示在操作行下方。 */
  async function save(next: AutoTaggingForm, success: string) {
    setBusy("save")
    setError("")
    setMessage("")
    try {
      const saved = (await saveAutoTagging({ ...next, ...(key.trim() ? { apiKey: key } : {}) })).autoTagging
      setView(saved)
      setForm(formFrom(saved))
      setKey("")
      setMessage(success)
      return true
    } catch (cause) {
      setError(String(cause))
      return false
    } finally {
      setBusy(null)
    }
  }

  async function runTest() {
    setBusy("test")
    setError("")
    setMessage("")
    try {
      const result = await testAutoTagging({ ...form, ...(key.trim() ? { apiKey: key } : {}) })
      if (result.ok) {
        setMessage(
          result.tags.length
            ? `连接正常，示例内容得到标签：${result.tags.join("、")}`
            : "连接正常，模型对示例内容没有给出标签"
        )
      } else {
        setError(`连接失败：${result.message}`)
      }
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsGroup
      busy={busy !== null}
      description={
        managed
          ? "由服务器环境变量 SHARD_AUTO_TAG_* 托管，这里只能查看和测试。"
          : "在服务器上为没有主题标签的碎片和笔记补上 1–3 个标签，优先沿用已有标签。开启后，这些内容会发送给下面的模型服务（密匣内容不会发送），费用由该服务计。"
      }
      id="auto-tagging"
      title="自动标签"
    >
      <SettingsRow
        controlWidth="auto"
        description={statusDescription(view) || undefined}
        label="自动标签"
        labelId={`${id}-enabled`}
      >
        <span aria-live="polite">
          <StatusIndicator label={state.label} tone={state.tone} />
        </span>
        <Switch
          aria-labelledby={`${id}-enabled`}
          checked={form.enabled}
          disabled={locked}
          onCheckedChange={(enabled) => {
            // 开关即时生效：连同表单里已填的地址、模型、密钥一起保存；失败时回到服务器上的状态。
            setForm((current) => ({ ...current, enabled }))
            void save({ ...form, enabled }, enabled ? "已开启" : "已关闭").then((ok) => {
              if (!ok) setForm((current) => ({ ...current, enabled: view.enabled }))
            })
          }}
        />
      </SettingsRow>
      <SettingsRow
        description="OpenAI 兼容的 Chat Completions 接口，填到 /v1 为止，须为 HTTPS。"
        label="接口地址"
        labelId={`${id}-base`}
      >
        <Input
          aria-labelledby={`${id}-base`}
          autoComplete="off"
          disabled={locked}
          onChange={(event) => {
            setForm((current) => ({ ...current, apiBase: event.target.value }))
            setMessage("")
          }}
          placeholder="https://api.openai.com/v1"
          spellCheck={false}
          value={form.apiBase}
        />
      </SettingsRow>
      <SettingsRow description="需支持 JSON 输出。" label="模型" labelId={`${id}-model`}>
        <Input
          aria-labelledby={`${id}-model`}
          autoComplete="off"
          disabled={locked}
          onChange={(event) => {
            setForm((current) => ({ ...current, model: event.target.value }))
            setMessage("")
          }}
          placeholder="模型名称"
          spellCheck={false}
          value={form.model}
        />
      </SettingsRow>
      <SettingsRow
        description={
          view.hasKey
            ? "已保存在你的服务器上，不再显示；留空表示不改。"
            : "只保存在你的服务器上，保存后不再显示。"
        }
        label="API Key"
        labelId={`${id}-key`}
      >
        <Input
          aria-labelledby={`${id}-key`}
          autoComplete="off"
          disabled={locked}
          onChange={(event) => {
            setKey(event.target.value)
            setMessage("")
          }}
          placeholder={view.hasKey ? "已保存，留空保留" : "输入 API Key"}
          type="password"
          value={key}
        />
      </SettingsRow>
      <SettingsGroupItem>
        <div className={styles.actions}>
          <span className={styles.feedback} role="status">
            {message}
          </span>
          {!managed && view.hasKey && !form.enabled ? (
            <Button
              disabled={busy !== null}
              onClick={() => void save({ ...form, clearKey: true }, "已移除 API Key")}
              size="md"
              type="button"
              variant="ghost"
            >
              移除 API Key
            </Button>
          ) : null}
          <Button
            disabled={busy !== null || (!managed && !form.model.trim())}
            onClick={() => void runTest()}
            size="md"
            type="button"
            variant="outline"
          >
            {busy === "test" ? "正在测试…" : "测试连接"}
          </Button>
          {managed ? null : (
            <Button
              disabled={busy !== null || !dirty}
              onClick={() => void save(form, "已保存")}
              size="md"
              type="button"
              variant="default"
            >
              {busy === "save" ? "正在保存…" : "保存"}
            </Button>
          )}
        </div>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </SettingsGroupItem>
    </SettingsGroup>
  )
}
