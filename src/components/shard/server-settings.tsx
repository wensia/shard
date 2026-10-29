import { invoke } from "@tauri-apps/api/core"
import { useEffect, useState, type FormEvent } from "react"

import { Loader2Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { emailProblem, normalizeEmail } from "@/features/auth/api"
import { getApiErrorMessage } from "@/lib/api"
import { notify } from "@/lib/notify"
import { desktopRemoteStatus } from "@/lib/transport"
import {
  isRemoteAuthRequired,
  remoteConnectionState,
  subscribeRemoteAuthRequired,
  subscribeRemoteConnection,
  type RemoteStatus,
} from "@/lib/transport/desktop-remote"
import type { ConnectionState } from "@/lib/transport/sse"

import { LockboxPasswordInput } from "./lockbox-dialog"
import { SettingsGroup, SettingsGroupItem, SettingsMono, SettingsRow } from "./settings-controls"
import { StatusIndicator, type StationTone } from "./settings-status"
import styles from "./vault-guide.module.css"

const DEFAULT_DEVICE_NAME = "我的 Mac"

/** Rust `remote_login`：成功后 Rust 已存好设备令牌，前端整页重载切到服务器模式。 */
interface RemoteLoginResult {
  server: string
  name: string
}

const CONNECTION_STATUS: Record<ConnectionState, { label: string; tone: StationTone }> = {
  connecting: { label: "正在连接", tone: "info" },
  connected: { label: "已连接", tone: "emerald" },
  reconnecting: { label: "正在重连", tone: "amber" },
  signedOut: { label: "连接已失效", tone: "ruby" },
}

/** 切换本地 / 服务器模式：整页重载，启动时按 Rust 的连接状态重新选择传输。 */
function reloadApp() {
  window.location.reload()
}

/**
 * 设置里的「服务器」分区（桌面专属）。没连接时用邮箱和密码登录服务器；连接后显示服务器与这台设备，可以断开回到本机资料库。
 * 网页端没有这个分区（网页本身就在服务器上）。
 */
export function ServerSettings() {
  const status = desktopRemoteStatus()
  return status ? <ConnectedServer status={status} /> : <LoginServer />
}

/** 与服务器的实时通道状态，以及设备令牌是否已失效。 */
function useRemoteConnection() {
  const [state, setState] = useState<ConnectionState>(remoteConnectionState)
  const [authRequired, setAuthRequired] = useState(isRemoteAuthRequired)
  useEffect(() => {
    setState(remoteConnectionState())
    setAuthRequired(isRemoteAuthRequired())
    const stopState = subscribeRemoteConnection(setState)
    const stopAuth = subscribeRemoteAuthRequired(() => setAuthRequired(true))
    return () => {
      stopState()
      stopAuth()
    }
  }, [])
  return { connection: state, authRequired }
}

function ConnectedServer({ status }: { status: RemoteStatus }) {
  const { connection, authRequired } = useRemoteConnection()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const { label, tone } = CONNECTION_STATUS[connection]

  async function disconnect() {
    setBusy(true)
    try {
      await invoke("remote_disconnect")
      reloadApp()
    } catch (error) {
      notify.failure("断开连接没有完成", error)
      setBusy(false)
    }
  }

  return (
    <>
      <SettingsGroup busy={busy}>
        <SettingsRow
          controlWidth="auto"
          description={<SettingsMono>{status.server}</SettingsMono>}
          label="服务器"
        >
          <span aria-live="polite">
            <StatusIndicator label={label} tone={tone} />
          </span>
        </SettingsRow>
        {authRequired ? (
          <SettingsGroupItem>
            <span className={styles.errorLine} role="alert">
              这台设备的连接已失效，请断开后重新连接服务器。
            </span>
          </SettingsGroupItem>
        ) : null}
        <SettingsRow
          controlWidth="auto"
          description="在网页「设置 → 设备」里按这个名字查看与吊销。"
          label="这台设备"
        >
          <span className={styles.statusIndicator}>{status.name || DEFAULT_DEVICE_NAME}</span>
        </SettingsRow>
        <SettingsRow
          controlWidth="auto"
          description="断开后回到这台电脑上的资料库；服务器上的数据不受影响。"
          label="断开连接"
        >
          <Button disabled={busy} onClick={() => setConfirming(true)} size="md" type="button" variant="outline">
            断开连接
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <Dialog open={confirming} onOpenChange={(open) => !busy && setConfirming(open)}>
        <DialogContent role="alertdialog">
          <DialogHeader>
            <DialogTitle>断开与服务器的连接？</DialogTitle>
            <DialogDescription>
              本机不再保存这台设备的令牌，App 回到本机资料库。服务器上的设备记录请到网页「设置 → 设备」吊销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={busy} onClick={() => setConfirming(false)} type="button" variant="outline">
              取消
            </Button>
            <Button aria-busy={busy} disabled={busy} onClick={() => void disconnect()} type="button" variant="destructive">
              {busy ? <Loader2Icon aria-hidden="true" className={styles.spin} /> : null}
              断开连接
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

type Phase = { kind: "idle"; error: string | null } | { kind: "signingIn" } | { kind: "connected" }

/**
 * 没连接时的登录表单：服务器地址、邮箱、密码、设备名。Rust 拿邮箱和密码向服务器换这台设备的令牌，
 * 之后凭令牌访问服务器；邮箱格式先按服务器的规则拦一道，服务器是最终裁决。
 */
function LoginServer() {
  const [server, setServer] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState(DEFAULT_DEVICE_NAME)
  const [phase, setPhase] = useState<Phase>({ kind: "idle", error: null })

  async function signIn(event: FormEvent) {
    event.preventDefault()
    const address = server.trim()
    const problem = (address ? null : "请填写服务器地址。") ?? emailProblem(email) ?? (password ? null : "请填写密码。")
    if (problem) {
      setPhase({ kind: "idle", error: problem })
      return
    }
    setPhase({ kind: "signingIn" })
    try {
      await invoke<RemoteLoginResult>("remote_login", {
        server: address,
        email: normalizeEmail(email),
        password,
        name: name.trim() || DEFAULT_DEVICE_NAME,
      })
      setPassword("")
      setPhase({ kind: "connected" })
      reloadApp()
    } catch (error) {
      setPhase({ kind: "idle", error: getApiErrorMessage(error) })
    }
  }

  if (phase.kind === "connected") {
    return (
      <SettingsGroup busy>
        <SettingsGroupItem>
          <div aria-live="polite" className={styles.busyLine}>
            <Loader2Icon aria-hidden="true" className={`${styles.spin} size-(--shard-icon-size-md)`} />
            <span>已连接，正在切换到服务器上的资料库…</span>
          </div>
        </SettingsGroupItem>
      </SettingsGroup>
    )
  }

  const signingIn = phase.kind === "signingIn"
  const error = phase.kind === "idle" ? phase.error : null
  return (
    <form noValidate onSubmit={(event) => void signIn(event)}>
      <SettingsGroup busy={signingIn}>
        <SettingsRow
          controlWidth="default"
          description="https 地址；本机开发可以用 http://localhost。"
          label="服务器地址"
          labelId="server-settings-address"
        >
          <Input
            aria-labelledby="server-settings-address"
            autoCapitalize="off"
            autoComplete="url"
            disabled={signingIn}
            inputMode="url"
            onChange={(event) => setServer(event.target.value)}
            placeholder="https://shard.example.com"
            spellCheck={false}
            value={server}
          />
        </SettingsRow>
        <SettingsRow
          controlWidth="default"
          description="网页版登录用的邮箱和密码。"
          label="邮箱"
          labelId="server-settings-email"
        >
          <Input
            aria-labelledby="server-settings-email"
            autoCapitalize="off"
            autoComplete="username"
            disabled={signingIn}
            inputMode="email"
            onChange={(event) => setEmail(event.target.value)}
            spellCheck={false}
            type="email"
            value={email}
          />
        </SettingsRow>
        <SettingsRow controlWidth="default" label="密码" labelId="server-settings-password">
          {/* 桌面 WKWebView 的密码框统一用 LockboxPasswordInput（type="text" + 遮蔽，见 frontend-rules.css）；
              外面包一层撑满控件列，与上下的输入框同宽。 */}
          <div className="w-full">
            <LockboxPasswordInput
              aria-labelledby="server-settings-password"
              disabled={signingIn}
              onChange={(event) => setPassword(event.target.value)}
              value={password}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          controlWidth="default"
          description="显示在网页「设置 → 设备」里，可以单独吊销。"
          label="设备名"
          labelId="server-settings-device"
        >
          <Input
            aria-labelledby="server-settings-device"
            disabled={signingIn}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </SettingsRow>
        <SettingsRow
          controlWidth="auto"
          description="连接后数据以服务器为准，需要联网；这台电脑上的资料库不会改动，断开后回到它。"
          label="连接服务器"
        >
          <Button aria-busy={signingIn} disabled={signingIn} size="md" type="submit" variant="default">
            {signingIn ? <Loader2Icon aria-hidden="true" className={styles.spin} /> : null}
            {signingIn ? "正在连接" : "连接"}
          </Button>
        </SettingsRow>
        {error ? (
          <SettingsGroupItem>
            <span className={styles.errorLine} role="alert">
              {error}
            </span>
          </SettingsGroupItem>
        ) : null}
      </SettingsGroup>
    </form>
  )
}
