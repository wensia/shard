import { useEffect, useRef } from "react"

import { transport } from "@/lib/transport"
import type { VaultFileChange } from "@/lib/vault-changes"

const VAULT_CHANGED_EVENT = "vault-changed"

/**
 * 监听当前 vault 的外部写入：终端 `shard`、AI 助手、其他编辑器或同步工具改了文件，
 * App 不必等切回窗口就能刷新。桌面由 Rust 监听文件系统；网页由服务器经 SSE 推送同形的变化。
 * 没有监听能力的测试宿主静默退回聚焦对账。
 */
export function useVaultWatch(vaultPath: string, onChange: (changes: VaultFileChange[]) => void) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!vaultPath) return
    const channel = transport()
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      try {
        // 先挂监听再开始监视，开始后的第一批变化不会漏。
        const dispose = await channel.listen<{ changes: VaultFileChange[] }>(VAULT_CHANGED_EVENT, (payload) => {
          if (!disposed) onChangeRef.current(payload.changes)
        })
        if (disposed) {
          dispose()
          return
        }
        unlisten = dispose
        // 网页端的推送随订阅自动开始；桌面要让 Rust 开始监视当前 vault。
        if (channel.kind === "tauri") await channel.invoke("watch_vault")
      } catch {
        // 没有监听能力时仍靠切回窗口的静默对账。
      }
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [vaultPath])
}
