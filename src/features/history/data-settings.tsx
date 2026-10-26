import { useCallback, useEffect, useRef, useState } from "react"

import { SettingsGroup, SettingsGroupItem, SettingsRow } from "@/components/shard/settings-controls"
import { Button } from "@/components/ui/button"
import { fetchAuthState, stepUp } from "@/features/auth/webauthn"
import { notify } from "@/lib/notify"

import { eraseDeletedEntries, exportZipUrl, listDeletedEntries, openRevisionHistory, restoreRevision, type DeletedEntry } from "./history-api"
import { formatRevisionTime } from "./revision-history-dialog"
import styles from "./history.module.css"

function fileName(path: string) {
  const name = path.split("/").pop() || path
  // 碎片文件名是 id（含创建时间），给人看的名字用「碎片 · 时间」。
  const fragment = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}-[0-9a-f]+-[0-9a-f]+\.md$/u.exec(name)
  if (fragment && /(^|\/)fragments\//u.test(path)) {
    const [, , month, day, hour, minute] = fragment
    return `碎片 · ${Number(month)}/${Number(day)} ${hour}:${minute}`
  }
  return name
}

function daysLeft(expiresAt: string) {
  const ms = new Date(expiresAt).getTime() - Date.now()
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 86_400_000)) : null
}

/** 服务器要求 10 分钟内验证过通行密钥（登录本身算一次）：过期了才弹系统确认。 */
async function ensureFreshPasskey() {
  const state = await fetchAuthState()
  if (!state.stepUpValid) await stepUp()
}

/** 导出是一次普通下载（流式，不进内存），先确认验证没过期再跳转。 */
async function downloadExport() {
  await ensureFreshPasskey()
  const link = document.createElement("a")
  link.href = exportZipUrl()
  link.download = ""
  document.body.append(link)
  link.click()
  link.remove()
}

/**
 * 网页端设置里的「数据与备份」：导出全部为 zip（旧版桌面 App 能直接打开），以及最近 30 天彻底删除的内容——
 * 可以找回，也可以立即抹除（不可撤销，要求验证通行密钥）。
 */
export function DataSettings() {
  const [entries, setEntries] = useState<DeletedEntry[] | null>(null)
  const [retentionDays, setRetentionDays] = useState(30)
  const [busy, setBusy] = useState<string | null>(null)
  /** 立即抹除不可撤销：第一次点只是进入确认态，4 秒内再点才执行。 */
  const [confirmingErase, setConfirmingErase] = useState<number | null>(null)
  const confirmTimer = useRef<number | undefined>(undefined)

  const load = useCallback(async () => {
    try {
      const result = await listDeletedEntries()
      setEntries(result.entries)
      setRetentionDays(result.retentionDays)
    } catch (error) {
      notify.failure("读取最近删除失败", error)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => () => window.clearTimeout(confirmTimer.current), [])

  function eraseNow(entry: DeletedEntry) {
    if (confirmingErase !== entry.nodeId) {
      setConfirmingErase(entry.nodeId)
      window.clearTimeout(confirmTimer.current)
      confirmTimer.current = window.setTimeout(() => setConfirmingErase(null), 4000)
      return
    }
    setConfirmingErase(null)
    void run(
      `erase:${entry.nodeId}`,
      async () => {
        await ensureFreshPasskey()
        return eraseDeletedEntries([entry.nodeId])
      },
      `已抹除 ${fileName(entry.path)} 的全部历史`
    )
  }

  async function run(key: string, action: () => Promise<unknown>, success: string) {
    setBusy(key)
    try {
      await action()
      notify.success(success)
      await load()
    } catch (error) {
      notify.failure("操作没有完成", error)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <SettingsGroup busy={busy === "export"}>
        <SettingsRow
          controlWidth="auto"
          description="按原来的资料库目录打包成 zip，旧版桌面 App 能直接打开；密匣内容仍是加密的。需要验证通行密钥。"
          label="导出全部"
        >
          <Button
            aria-busy={busy === "export"}
            disabled={busy !== null}
            onClick={() =>
              void (async () => {
                setBusy("export")
                try {
                  await downloadExport()
                } catch (error) {
                  notify.failure("导出没有开始", error)
                } finally {
                  setBusy(null)
                }
              })()
            }
            size="sm"
            variant="outline"
          >
            导出 zip
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup busy={busy !== null && busy !== "export"}>
        {entries === null ? (
          <SettingsGroupItem>正在读取最近删除…</SettingsGroupItem>
        ) : entries.length === 0 ? (
          <SettingsGroupItem>最近 {retentionDays} 天没有彻底删除的内容。彻底删除的文件会在这里保留 {retentionDays} 天，可以找回。</SettingsGroupItem>
        ) : (
          entries.map((entry) => {
            const left = daysLeft(entry.expiresAt)
            return (
              <SettingsRow
                controlWidth="auto"
                description={`${entry.path.replace(/^\.trash\//u, "")} · 删除于 ${formatRevisionTime(entry.purgedAt)}${left !== null ? ` · ${left} 天后永久清除` : ""}`}
                key={entry.nodeId}
                label={fileName(entry.path)}
              >
                <div className={styles.actions}>
                  <Button
                    disabled={busy !== null}
                    onClick={() =>
                      openRevisionHistory({ target: { nodeId: entry.nodeId }, title: fileName(entry.path) })
                    }
                    size="sm"
                    variant="ghost"
                  >
                    历史
                  </Button>
                  <Button
                    disabled={busy !== null}
                    onClick={() => void run(`restore:${entry.nodeId}`, () => restoreRevision(entry.revId), `已找回 ${fileName(entry.path)}`)}
                    size="sm"
                    variant="outline"
                  >
                    找回
                  </Button>
                  <Button
                    disabled={busy !== null}
                    onClick={() => eraseNow(entry)}
                    size="sm"
                    variant={confirmingErase === entry.nodeId ? "destructive" : "outline"}
                  >
                    {confirmingErase === entry.nodeId ? "再点一次抹除" : "立即抹除"}
                  </Button>
                </div>
              </SettingsRow>
            )
          })
        )}
      </SettingsGroup>
    </>
  )
}
