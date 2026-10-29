import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react"

import { SettingsGroup, SettingsGroupItem, SettingsMono, SettingsRow } from "@/components/shard/settings-controls"
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
import { Switch } from "@/components/ui/switch"
import { isServerFailure } from "@/lib/lockbox-client/client"
import { serverLockbox } from "@/lib/lockbox-client/transport"
import { notify } from "@/lib/notify"

import {
  AuthError,
  emailProblem,
  fetchAuthState,
  isCancelled,
  listDevices,
  listSessions,
  logout,
  MIN_PASSWORD_CHARS,
  newPasswordProblem,
  normalizeEmail,
  revokeDevice,
  revokeSession,
  updateAccount,
  withStepUp,
  type DeviceInfo,
  type SessionInfo,
} from "./api"
import styles from "./auth-pages.module.css"
import { FormError, FormField, PasswordInput } from "./form-fields"

function formatTime(value: string | null | undefined) {
  if (!value) return "从未"
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString("zh-CN", { hour12: false })
}

/** 浏览器 UA 里取个能认出来的名字：「iPhone · Safari」。 */
function describeUserAgent(userAgent: string | null) {
  if (!userAgent) return "未知设备"
  const device = /iPhone/u.test(userAgent)
    ? "iPhone"
    : /iPad/u.test(userAgent)
      ? "iPad"
      : /Android/u.test(userAgent)
        ? "Android"
        : /Macintosh/u.test(userAgent)
          ? "Mac"
          : /Windows/u.test(userAgent)
            ? "Windows"
            : "浏览器"
  const browser = /Edg\//u.test(userAgent)
    ? "Edge"
    : /Chrome\//u.test(userAgent)
      ? "Chrome"
      : /Firefox\//u.test(userAgent)
        ? "Firefox"
        : /Safari\//u.test(userAgent)
          ? "Safari"
          : ""
  return browser ? `${device} · ${browser}` : device
}

interface AccountData {
  email: string | null
  sessions: SessionInfo[]
  devices: DeviceInfo[]
}

/** 「允许在网页解锁密匣」：敏感操作，服务器要求 10 分钟内输过密码，过期时弹出密码确认框。 */
function setLockboxWebUnlock(allowed: boolean) {
  return withStepUp(async () => {
    const lockbox = serverLockbox()
    if (!lockbox) throw new Error("没有连接服务器。")
    await lockbox.setWebUnlock(allowed).catch((failure: unknown) => {
      if (isServerFailure(failure)) throw new AuthError(failure.code ?? "ERROR", String(failure.detail))
      throw failure
    })
  })
}

/**
 * 网页端设置里的「账号与安全」：登录邮箱与密码、网页解锁密匣开关、已连接的设备、登录会话、退出登录。
 * 吊销与开关都要求最近 10 分钟内输过密码，过期时弹出密码确认框。
 */
export function AccountSettings() {
  const [data, setData] = useState<AccountData | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [webUnlock, setWebUnlock] = useState<boolean | null>(null)
  const [editing, setEditing] = useState(false)

  const load = useCallback(async () => {
    try {
      const [state, sessions, devices] = await Promise.all([fetchAuthState(), listSessions(), listDevices()])
      setData({ email: state.email, sessions, devices })
    } catch (error) {
      notify.failure("读取账号信息失败", error)
    }
  }, [])

  const loadWebUnlock = useCallback(async () => {
    try {
      const lockbox = serverLockbox()
      if (lockbox) setWebUnlock((await lockbox.webUnlock()) ?? true)
    } catch (error) {
      notify.failure("读取密匣设置失败", error)
    }
  }, [])

  useEffect(() => {
    void load()
    void loadWebUnlock()
  }, [load, loadWebUnlock])

  async function run(key: string, action: () => Promise<unknown>, success: string) {
    setBusy(key)
    try {
      await action()
      notify.success(success)
      await load()
      await loadWebUnlock()
    } catch (error) {
      // 在密码确认框里点了取消：什么都不做。
      if (!isCancelled(error)) notify.failure("操作没有完成", error)
    } finally {
      setBusy(null)
    }
  }

  if (!data) {
    return (
      <SettingsGroup busy>
        <SettingsGroupItem>正在读取…</SettingsGroupItem>
      </SettingsGroup>
    )
  }

  return (
    <>
      <SettingsGroup busy={busy !== null}>
        <SettingsRow
          controlWidth="auto"
          description={data.email ? <SettingsMono>{data.email}</SettingsMono> : "没有读到当前邮箱。"}
          label="登录邮箱"
        >
          <Button disabled={busy !== null} onClick={() => setEditing(true)} size="sm" variant="outline">
            修改邮箱或密码
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup busy={busy === "webUnlock"}>
        <SettingsRow
          controlWidth="auto"
          description="关掉后服务器不再把密文发给浏览器，网页上打不开密匣（本页立即上锁，其他已解锁的网页下次上锁后也打不开）；用 #密匣 速记照常加密存入。它防的是被盗的浏览器会话，防不了被篡改的网页：在不信任的设备上不要输入密匣口令。"
          label="允许在网页解锁密匣"
        >
          <Switch
            aria-label="允许在网页解锁密匣"
            checked={webUnlock ?? true}
            disabled={busy !== null || webUnlock === null}
            onCheckedChange={(next) =>
              void run("webUnlock", () => setLockboxWebUnlock(next), next ? "已允许在网页解锁密匣" : "已关闭网页解锁")
            }
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup busy={busy !== null}>
        {data.devices.length === 0 ? (
          <SettingsGroupItem>还没有连接的桌面应用或命令行。在它们那里输入服务器地址、邮箱和密码即可连接。</SettingsGroupItem>
        ) : (
          data.devices.map((device) => (
            <SettingsRow
              controlWidth="auto"
              description={`${device.kind === "cli" ? "命令行" : "桌面应用"} · 上次活动 ${formatTime(device.lastSeenAt)}${device.lastIp ? ` · ${device.lastIp}` : ""}`}
              key={device.id}
              label={device.name}
            >
              <Button
                disabled={busy !== null}
                onClick={() => void run(`device:${device.id}`, () => revokeDevice(device.id), "设备已吊销")}
                size="sm"
                variant="outline"
              >
                吊销
              </Button>
            </SettingsRow>
          ))
        )}
      </SettingsGroup>

      <SettingsGroup busy={busy !== null}>
        {data.sessions.map((session) => (
          <SettingsRow
            controlWidth="auto"
            description={`登录于 ${formatTime(session.createdAt)} · 上次活动 ${formatTime(session.lastSeenAt)}${session.ip ? ` · ${session.ip}` : ""}`}
            key={session.id}
            label={`${describeUserAgent(session.userAgent)}${session.current ? "（当前）" : ""}`}
          >
            {session.current ? (
              <Button
                disabled={busy !== null}
                onClick={() =>
                  void (async () => {
                    await logout().catch(() => undefined)
                    window.location.assign("/")
                  })()
                }
                size="sm"
                variant="outline"
              >
                退出登录
              </Button>
            ) : (
              <Button
                disabled={busy !== null}
                onClick={() => void run(`session:${session.id}`, () => revokeSession(session.id), "已让这个会话退出")}
                size="sm"
                variant="outline"
              >
                退出这个会话
              </Button>
            )}
          </SettingsRow>
        ))}
      </SettingsGroup>

      {editing ? (
        <AccountDialog
          currentEmail={data.email ?? ""}
          onClose={() => setEditing(false)}
          onSaved={({ emailChanged, passwordChanged }) => {
            setEditing(false)
            notify.success(
              passwordChanged
                ? `${emailChanged ? "邮箱和密码" : "密码"}已修改，其他浏览器已退出登录`
                : "登录邮箱已修改"
            )
            void load()
          }}
        />
      ) : null}
    </>
  )
}

/** 「修改邮箱或密码」：凭当前密码；新密码留空表示只改邮箱。 */
function AccountDialog({
  currentEmail,
  onClose,
  onSaved,
}: {
  currentEmail: string
  onClose: () => void
  onSaved: (changes: { emailChanged: boolean; passwordChanged: boolean }) => void
}) {
  const [currentPassword, setCurrentPassword] = useState("")
  const [email, setEmail] = useState(currentEmail)
  const [newPassword, setNewPassword] = useState("")
  const [repeat, setRepeat] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const currentRef = useRef<HTMLInputElement>(null)
  const currentId = useId()
  const emailId = useId()
  const newId = useId()
  const repeatId = useId()
  const hintId = useId()
  const errorId = useId()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const changingPassword = newPassword !== "" || repeat !== ""
    const changingEmail = normalizeEmail(email) !== normalizeEmail(currentEmail)
    const problem =
      (currentPassword ? null : "请输入当前密码。") ??
      emailProblem(email) ??
      (changingPassword ? newPasswordProblem(newPassword, repeat) : null) ??
      (changingPassword || changingEmail ? null : "邮箱和密码都没有改动。")
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError("")
    try {
      await updateAccount({ currentPassword, email, newPassword: changingPassword ? newPassword : undefined })
      onSaved({ emailChanged: changingEmail, passwordChanged: changingPassword })
    } catch (caught) {
      setBusy(false)
      setError(caught instanceof Error ? caught.message : String(caught))
      if (caught instanceof AuthError && caught.code === "INVALID_CREDENTIALS") {
        setCurrentPassword("")
        currentRef.current?.focus()
      }
    }
  }

  const describedBy = error ? errorId : undefined
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent aria-busy={busy} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>修改邮箱或密码</DialogTitle>
          <DialogDescription>新密码留空表示只改邮箱。改了密码，其他浏览器会退出登录，这个页面不受影响。</DialogDescription>
        </DialogHeader>
        <form className={styles.form} noValidate onSubmit={(event) => void submit(event)}>
          <FormField htmlFor={currentId} label="当前密码">
            <PasswordInput
              aria-describedby={describedBy}
              autoComplete="current-password"
              autoFocus
              id={currentId}
              onChange={(event) => setCurrentPassword(event.target.value)}
              readOnly={busy}
              ref={currentRef}
              value={currentPassword}
            />
          </FormField>
          <FormField htmlFor={emailId} label="邮箱">
            <Input
              aria-describedby={describedBy}
              autoCapitalize="off"
              autoComplete="username"
              id={emailId}
              inputMode="email"
              onChange={(event) => setEmail(event.target.value)}
              readOnly={busy}
              spellCheck={false}
              type="email"
              value={email}
            />
          </FormField>
          <FormField
            hint={`留空表示不改；至少 ${MIN_PASSWORD_CHARS} 个字符。`}
            hintId={hintId}
            htmlFor={newId}
            label="新密码"
          >
            <PasswordInput
              aria-describedby={describedBy ? `${hintId} ${describedBy}` : hintId}
              autoComplete="new-password"
              id={newId}
              onChange={(event) => setNewPassword(event.target.value)}
              readOnly={busy}
              value={newPassword}
            />
          </FormField>
          <FormField htmlFor={repeatId} label="确认新密码">
            <PasswordInput
              aria-describedby={describedBy}
              autoComplete="new-password"
              id={repeatId}
              onChange={(event) => setRepeat(event.target.value)}
              readOnly={busy}
              value={repeat}
            />
          </FormField>
          <FormError id={errorId} message={error} />
          <DialogFooter>
            <Button disabled={busy} onClick={onClose} type="button" variant="outline">
              取消
            </Button>
            <Button aria-busy={busy} disabled={busy} type="submit">
              {busy ? "正在保存…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
