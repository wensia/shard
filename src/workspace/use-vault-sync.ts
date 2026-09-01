import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react"

import type { GitInfo } from "@/types"

export function useVaultSync() {
  const [git, setGit] = useState<GitInfo | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)
  // 只记在内存：磁盘上没有「上次同步于何时」这个事实，跨会话恢复等于编造。
  // 冷启动后到本会话首次同步之前，状态栏就不显示相对时间。
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null)
  const autoSyncFailureNotifiedRef = useRef(false)
  const autoSyncTickRef = useRef<() => void>(() => {})

  // 只在与远端同步成功后调用，本地检查点提交不算。
  const markSynced = useCallback(() => setLastSyncAt(Date.now()), [])

  return {
    autoSyncFailureNotifiedRef,
    autoSyncTickRef,
    git,
    isSyncing,
    lastSyncAt,
    markSynced,
    setGit,
    setIsSyncing,
  }
}

export function useVaultSyncSchedule({
  enabled,
  intervalMinutes,
  onDisabled,
  tickRef,
}: {
  enabled: boolean
  intervalMinutes: number
  onDisabled: () => void
  tickRef: MutableRefObject<() => void>
}) {
  const onDisabledRef = useRef(onDisabled)
  onDisabledRef.current = onDisabled

  useEffect(() => {
    if (!enabled) {
      onDisabledRef.current()
      return
    }

    const timer = window.setInterval(
      () => tickRef.current(),
      intervalMinutes * 60_000
    )

    return () => {
      window.clearInterval(timer)
    }
  }, [enabled, intervalMinutes, tickRef])
}
