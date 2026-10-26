import { useCallback, useEffect, useState } from "react"

import { SettingsGroup, SettingsGroupItem, SettingsRow } from "@/components/shard/settings-controls"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { isServerFailure } from "@/lib/lockbox-client/client"
import { serverLockbox } from "@/lib/lockbox-client/transport"
import { notify } from "@/lib/notify"

import {
  AuthError,
  addPasskey,
  defaultPasskeyLabel,
  listDevices,
  listPasskeys,
  listSessions,
  logout,
  revokeDevice,
  revokePasskey,
  revokeSession,
  withStepUp,
  type DeviceInfo,
  type PasskeyInfo,
  type SessionInfo,
} from "./webauthn"

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
  passkeys: PasskeyInfo[]
  sessions: SessionInfo[]
  devices: DeviceInfo[]
}

/** 「允许在网页解锁密匣」：敏感操作，服务器要求 10 分钟内验证过通行密钥，过期时弹出系统确认。 */
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
 * 网页端设置里的「账号与安全」：通行密钥、登录会话、已配对设备、退出登录。
 * 吊销与添加都要求最近 10 分钟内验证过通行密钥，过期时会弹出系统的通行密钥确认。
 */
export function AccountSettings() {
  const [data, setData] = useState<AccountData | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [webUnlock, setWebUnlock] = useState<boolean | null>(null)

  const load = useCallback(async () => {
    try {
      const [passkeys, sessions, devices] = await Promise.all([listPasskeys(), listSessions(), listDevices()])
      setData({ passkeys, sessions, devices })
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
      notify.failure("操作没有完成", error)
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

  const onlyOnePasskey = data.passkeys.length <= 1

  return (
    <>
      <SettingsGroup busy={busy !== null}>
        {data.passkeys.map((passkey) => (
          <SettingsRow
            controlWidth="auto"
            description={`添加于 ${formatTime(passkey.createdAt)}，上次使用 ${formatTime(passkey.lastUsedAt)}`}
            key={passkey.id}
            label={passkey.label || "通行密钥"}
          >
            <Button
              disabled={busy !== null || onlyOnePasskey}
              onClick={() => void run(`passkey:${passkey.id}`, () => revokePasskey(passkey.id), "通行密钥已吊销")}
              size="sm"
              title={onlyOnePasskey ? "至少保留一把通行密钥" : undefined}
              variant="outline"
            >
              吊销
            </Button>
          </SettingsRow>
        ))}
        <SettingsRow
          controlWidth="auto"
          description="建议至少两把（例如手机与电脑各一把），丢了一台设备还能登录。"
          label="添加通行密钥"
        >
          <Button
            aria-busy={busy === "add"}
            disabled={busy !== null}
            onClick={() => void run("add", () => addPasskey(defaultPasskeyLabel()), "已添加通行密钥")}
            size="sm"
            variant="outline"
          >
            在这台设备上添加
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
          <SettingsGroupItem>还没有配对的桌面应用或命令行。在它们那里选择「连接服务器」，再到本站 /pair 页面输入配对码。</SettingsGroupItem>
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
    </>
  )
}
