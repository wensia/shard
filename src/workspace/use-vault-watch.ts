import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { useEffect, useRef } from "react"

import type { VaultFileChange } from "@/lib/vault-changes"

const VAULT_CHANGED_EVENT = "vault-changed"

/**
 * 监听当前 vault 的外部写入：终端 `shard`、AI 助手、其他编辑器或同步工具改了文件，
 * App 不必等切回窗口就能刷新。浏览器预览和测试宿主没有监听能力时静默退回聚焦对账。
 */
export function useVaultWatch(vaultPath: string, onChange: (changes: VaultFileChange[]) => void) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!vaultPath || !isTauri()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      try {
        // 先挂监听再开始监视，开始后的第一批变化不会漏。
        const dispose = await listen<{ changes: VaultFileChange[] }>(VAULT_CHANGED_EVENT, (event) => {
          if (!disposed) onChangeRef.current(event.payload.changes)
        })
        if (disposed) {
          dispose()
          return
        }
        unlisten = dispose
        await invoke("watch_vault")
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
