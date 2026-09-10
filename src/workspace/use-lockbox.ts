import {
  useEffect,
  useRef,
  useState,
} from "react"

import type { LockboxDialogMode } from "@/components/shard/lockbox-dialog"
import type { Fragment, LockboxState } from "@/types"
import type { WorkspaceRoute } from "@/workspace/route"

const LOCKBOX_IDLE_TIMEOUT_MS = 3 * 60 * 1000

export function useLockbox() {
  const [lockbox, setLockbox] = useState<LockboxState | null>(null)
  const [lockboxDialogMode, setLockboxDialogMode] =
    useState<LockboxDialogMode | null>(null)
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)
  const [selectedLockboxTag, setSelectedLockboxTag] = useState<string | null>(null)
  const [pendingLockboxArchiveFragment, setPendingLockboxArchiveFragment] =
    useState<Fragment | null>(null)
  const [pendingLockboxMoveId, setPendingLockboxMoveId] = useState<string | null>(null)
  const [isArchivingLockboxFragment, setIsArchivingLockboxFragment] =
    useState(false)

  return {
    isArchivingLockboxFragment,
    lockbox,
    lockboxDialogMode,
    pendingLockboxArchiveFragment,
    pendingLockboxMoveId,
    recoveryKey,
    selectedLockboxTag,
    setIsArchivingLockboxFragment,
    setLockbox,
    setLockboxDialogMode,
    setPendingLockboxArchiveFragment,
    setPendingLockboxMoveId,
    setRecoveryKey,
    setSelectedLockboxTag,
  }
}

interface LockboxSecurityEffectsOptions {
  autoLock: (options?: { returnToLibrary?: boolean }) => void
  lockbox: LockboxState | null
  route: WorkspaceRoute
}

export function useLockboxSecurityEffects({
  autoLock,
  lockbox,
  route,
}: LockboxSecurityEffectsOptions) {
  const autoLockRef = useRef(autoLock)
  autoLockRef.current = autoLock

  // 密匣空间是唯一安全区，离开即自动上锁。
  useEffect(() => {
    if (route.space === "lockbox" || !lockbox?.unlocked) return
    autoLockRef.current()
  }, [route, lockbox?.unlocked])

  useEffect(() => {
    if (route.space !== "lockbox" || !lockbox?.unlocked) return

    const onIdleTimeout = () => {
      autoLockRef.current({ returnToLibrary: true })
    }

    let timeoutId = window.setTimeout(onIdleTimeout, LOCKBOX_IDLE_TIMEOUT_MS)
    const resetTimer = () => {
      window.clearTimeout(timeoutId)
      timeoutId = window.setTimeout(onIdleTimeout, LOCKBOX_IDLE_TIMEOUT_MS)
    }
    const activityEvents = [
      "focusin",
      "input",
      "keydown",
      "pointerdown",
      "touchstart",
      "wheel",
    ] as const

    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, resetTimer, { capture: true })
    })

    return () => {
      window.clearTimeout(timeoutId)
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, resetTimer, { capture: true })
      })
    }
  }, [route, lockbox?.unlocked])
}
