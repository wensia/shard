import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react"

import type { GitInfo } from "@/types"

export function useVaultSync() {
  const [git, setGit] = useState<GitInfo | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)
  const autoSyncFailureNotifiedRef = useRef(false)
  const autoSyncTickRef = useRef<() => void>(() => {})

  return {
    autoSyncFailureNotifiedRef,
    autoSyncTickRef,
    git,
    isSyncing,
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
