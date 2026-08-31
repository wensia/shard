import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
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
  const [insightIncludeLockbox, setInsightIncludeLockbox] = useState(false)

  const insightUnlockIntentRef = useRef(false)
  const unlockedForInsightRef = useRef(false)

  return {
    insightIncludeLockbox,
    insightUnlockIntentRef,
    isArchivingLockboxFragment,
    lockbox,
    lockboxDialogMode,
    pendingLockboxArchiveFragment,
    pendingLockboxMoveId,
    recoveryKey,
    selectedLockboxTag,
    setInsightIncludeLockbox,
    setIsArchivingLockboxFragment,
    setLockbox,
    setLockboxDialogMode,
    setPendingLockboxArchiveFragment,
    setPendingLockboxMoveId,
    setRecoveryKey,
    setSelectedLockboxTag,
    unlockedForInsightRef,
  }
}

interface LockboxSecurityEffectsOptions {
  autoLock: (options?: { returnToLibrary?: boolean }) => void
  insightIncludeLockbox: boolean
  insightUnlockIntentRef: MutableRefObject<boolean>
  lockbox: LockboxState | null
  route: WorkspaceRoute
  setInsightIncludeLockbox: (next: boolean) => void
  unlockedForInsightRef: MutableRefObject<boolean>
}

export function useLockboxSecurityEffects({
  autoLock,
  insightIncludeLockbox,
  insightUnlockIntentRef,
  lockbox,
  route,
  setInsightIncludeLockbox,
  unlockedForInsightRef,
}: LockboxSecurityEffectsOptions) {
  const autoLockRef = useRef(autoLock)
  autoLockRef.current = autoLock

  // 密匣空间是唯一安全区，离开即自动上锁；洞察仅在本次已勾选或正在重新校验时豁免。
  useEffect(() => {
    if (route.space === "lockbox") {
      return
    }
    if (
      route.space === "review" &&
      route.params.mode === "insight" &&
      (insightIncludeLockbox || insightUnlockIntentRef.current)
    ) {
      return
    }
    if (!lockbox?.unlocked) return
    autoLockRef.current()
  }, [route, lockbox?.unlocked, insightIncludeLockbox, insightUnlockIntentRef])

  // 密匣空间与含密匣洞察共享既有的 3 分钟活动计时语义。
  useEffect(() => {
    const isLockboxIdleScope = route.space === "lockbox" && lockbox?.unlocked
    const isInsightIdleScope =
      route.space === "review" &&
      route.params.mode === "insight" &&
      insightIncludeLockbox &&
      lockbox?.unlocked
    if (!isLockboxIdleScope && !isInsightIdleScope) return

    const onIdleTimeout = () => {
      autoLockRef.current(
        isLockboxIdleScope ? { returnToLibrary: true } : undefined
      )
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
  }, [route, lockbox?.unlocked, insightIncludeLockbox])

  // 任意原因上锁后，洞察包含态与本次洞察解锁会话一并清理。
  useEffect(() => {
    if (lockbox?.unlocked) return
    unlockedForInsightRef.current = false
    if (insightIncludeLockbox) setInsightIncludeLockbox(false)
  }, [
    lockbox?.unlocked,
    insightIncludeLockbox,
    setInsightIncludeLockbox,
    unlockedForInsightRef,
  ])

  // 离开洞察视角即取消勾选；复锁仍由上面的离开安全区域规则处理。
  useEffect(() => {
    if (route.space === "review" && route.params.mode === "insight") return
    if (insightIncludeLockbox) setInsightIncludeLockbox(false)
  }, [route, insightIncludeLockbox, setInsightIncludeLockbox])
}
