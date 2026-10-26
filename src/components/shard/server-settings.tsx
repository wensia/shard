import { invoke } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"
import { useEffect, useRef, useState, type FormEvent } from "react"

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

import { SettingsGroup, SettingsGroupItem, SettingsMono, SettingsRow } from "./settings-controls"
import { StatusIndicator, type StationTone } from "./settings-status"
import styles from "./vault-guide.module.css"

const DEFAULT_DEVICE_NAME = "我的 Mac"

/** Rust `remote_pair_start`。 */
interface PairingInfo {
  server: string
  userCode: string
  verificationUri: string
  expiresIn: number
  intervalMs: number
}

/** Rust `remote_pair_poll`。 */
type PairPollResult =
  | { status: "pending"; intervalMs: number }
  | { status: "connected"; server: string; name: string }
  | { status: "expired" }

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
 * 设置里的「服务器」分区（桌面专属）。没连接时发起设备配对；连接后显示服务器与这台设备，可以断开回到本机资料库。
 * 网页端没有这个分区（网页本身就在服务器上）。
 */
export function ServerSettings() {
  const status = desktopRemoteStatus()
  return status ? <ConnectedServer status={status} /> : <PairServer />
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

type Phase =
  | { kind: "idle"; error: string | null }
  | { kind: "starting" }
  | { kind: "pairing"; info: PairingInfo; deadline: number }
  | { kind: "connected" }

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function formatRemaining(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

/** 每秒一跳的当前时间（只在配对等待时走）。 */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

function PairServer() {
  const [server, setServer] = useState("")
  const [name, setName] = useState(DEFAULT_DEVICE_NAME)
  const [phase, setPhase] = useState<Phase>({ kind: "idle", error: null })
  /** 每次发起配对加一；取消、关闭设置或重新发起后，旧的轮询看到编号变了就停。 */
  const session = useRef(0)
  const pairing = useRef(false)
  const now = useNow(phase.kind === "pairing")

  useEffect(
    () => () => {
      // 关掉设置时放弃进行中的配对：服务器上的配对码随之过期作废。
      session.current += 1
      if (pairing.current) void invoke("remote_pair_cancel").catch(() => undefined)
    },
    []
  )

  async function poll(id: number, interval: number) {
    await delay(interval)
    if (id !== session.current) return
    let result: PairPollResult
    try {
      result = await invoke<PairPollResult>("remote_pair_poll")
    } catch (error) {
      if (id === session.current) {
        pairing.current = false
        setPhase({ kind: "idle", error: getApiErrorMessage(error) })
      }
      return
    }
    if (result.status === "connected") {
      // 取消后才收到批准也已经连上了：照样切换，免得 Rust 已连接而界面还在本地模式。
      pairing.current = false
      setPhase({ kind: "connected" })
      reloadApp()
      return
    }
    if (id !== session.current) return
    if (result.status === "expired") {
      pairing.current = false
      setPhase({ kind: "idle", error: "配对码已过期，请重新连接。" })
      return
    }
    void poll(id, result.intervalMs)
  }

  async function start(event: FormEvent) {
    event.preventDefault()
    const address = server.trim()
    if (!address) {
      setPhase({ kind: "idle", error: "请填写服务器地址。" })
      return
    }
    const id = ++session.current
    setPhase({ kind: "starting" })
    try {
      const info = await invoke<PairingInfo>("remote_pair_start", {
        server: address,
        name: name.trim() || DEFAULT_DEVICE_NAME,
      })
      if (id !== session.current) return
      pairing.current = true
      setPhase({ kind: "pairing", info, deadline: Date.now() + info.expiresIn * 1000 })
      void poll(id, info.intervalMs)
    } catch (error) {
      if (id === session.current) setPhase({ kind: "idle", error: getApiErrorMessage(error) })
    }
  }

  function cancel() {
    session.current += 1
    pairing.current = false
    void invoke("remote_pair_cancel").catch(() => undefined)
    setPhase({ kind: "idle", error: null })
  }

  async function openVerification(uri: string) {
    try {
      await openUrl(uri)
    } catch (error) {
      notify.failure("没能打开浏览器", error, { description: "可以手动复制地址到浏览器里打开。" })
    }
  }

  if (phase.kind === "pairing" || phase.kind === "connected") {
    const info = phase.kind === "pairing" ? phase.info : null
    return (
      <SettingsGroup busy>
        {info ? (
          <>
            <SettingsRow
              controlWidth="auto"
              description="在已登录的浏览器里打开验证地址，输入配对码并验证通行密钥。"
              label="配对码"
            >
              <span className={styles.pairingCode} data-testid="server-pairing-code">
                {info.userCode}
              </span>
            </SettingsRow>
            <SettingsRow
              controlWidth="auto"
              description={<SettingsMono>{info.verificationUri}</SettingsMono>}
              label="验证地址"
            >
              <Button onClick={() => void openVerification(info.verificationUri)} size="md" type="button" variant="outline">
                在浏览器中打开
              </Button>
            </SettingsRow>
            <SettingsRow
              controlWidth="auto"
              description={
                phase.kind === "pairing" ? `${formatRemaining(phase.deadline - now)} 后过期，过期后需要重新连接。` : undefined
              }
              label="等待批准"
            >
              <Button onClick={cancel} size="md" type="button" variant="outline">
                取消
              </Button>
            </SettingsRow>
          </>
        ) : (
          <SettingsGroupItem>
            <div aria-live="polite" className={styles.busyLine}>
              <Loader2Icon aria-hidden="true" className={`${styles.spin} size-(--shard-icon-size-md)`} />
              <span>已连接，正在切换到服务器上的资料库…</span>
            </div>
          </SettingsGroupItem>
        )}
      </SettingsGroup>
    )
  }

  const starting = phase.kind === "starting"
  const error = phase.kind === "idle" ? phase.error : null
  return (
    <form noValidate onSubmit={(event) => void start(event)}>
      <SettingsGroup busy={starting}>
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
            disabled={starting}
            inputMode="url"
            onChange={(event) => setServer(event.target.value)}
            placeholder="https://shard.example.com"
            spellCheck={false}
            value={server}
          />
        </SettingsRow>
        <SettingsRow
          controlWidth="default"
          description="显示在网页「设置 → 设备」里，可以单独吊销。"
          label="设备名"
          labelId="server-settings-device"
        >
          <Input
            aria-labelledby="server-settings-device"
            disabled={starting}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </SettingsRow>
        <SettingsRow
          controlWidth="auto"
          description="连接后数据以服务器为准，需要联网；这台电脑上的资料库不会改动，断开后回到它。"
          label="连接服务器"
        >
          <Button aria-busy={starting} disabled={starting} size="md" type="submit" variant="default">
            {starting ? <Loader2Icon aria-hidden="true" className={styles.spin} /> : null}
            {starting ? "正在发起" : "连接"}
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
