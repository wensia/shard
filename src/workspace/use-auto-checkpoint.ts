import { useCallback, useEffect, useRef } from "react"

/**
 * 自动检查点调度（docs/design/commit-coalescing-plan.md §7 B1）。
 *
 * 保存已即时落盘，git 提交由这里聚合成检查点：
 * - idle：应用活跃但距最后一次内容变更 ≥90s（从内容变更计时，不看鼠标活动）；
 * - inactive：窗口失焦/隐藏 ≥30s；失焦当下先立即 flush 草稿落盘，提交仍等阈值。
 *
 * 去重按「变更代」：仅当检查点处理的正是当前活动时间戳时才清除待办，
 * 期间产生的新变更留待下一轮。失败走 15s→60s→5min 有上限退避，
 * 避免瞬态 index.lock 变成每秒重试风暴或被永久放弃。
 * 1s 轮询只做内存判断，绝不每秒起 git 进程；有没有实际变更由后端裁决。
 */
const IDLE_THRESHOLD_MS = 90_000
const INACTIVE_THRESHOLD_MS = 30_000
const FAILURE_BACKOFF_MS = [15_000, 60_000, 300_000] as const

export interface AutoCheckpointCallbacks {
  /** git 就绪（非 no_git）且允许自动检查点。 */
  enabled: boolean
  /** 工作区稳定：无在飞保存/编辑/同步/模态。不稳定时本轮跳过，不消费退避。 */
  isStable: () => boolean
  /** 执行检查点。true=已处理（committed/no_changes/not_git），false=失败或 blocked（触发退避）。 */
  checkpoint: (trigger: string) => Promise<boolean>
  /** 失焦/隐藏时立即把草稿排空落盘（不提交）。 */
  flushDrafts: () => Promise<void>
}

export function useAutoCheckpoint(callbacks: AutoCheckpointCallbacks) {
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  const lastActivityRef = useRef<number | null>(null)
  const inFlightRef = useRef(false)
  const backoffUntilRef = useRef(0)
  const backoffStepRef = useRef(0)
  const appActiveRef = useRef(true)

  const recordContentActivity = useCallback(() => {
    lastActivityRef.current = Date.now()
  }, [])

  useEffect(() => {
    const maybeCheckpoint = () => {
      const current = callbacksRef.current
      if (!current.enabled || inFlightRef.current) return
      const activityAt = lastActivityRef.current
      if (activityAt === null) return
      if (Date.now() < backoffUntilRef.current) return
      const threshold = appActiveRef.current
        ? IDLE_THRESHOLD_MS
        : INACTIVE_THRESHOLD_MS
      if (Date.now() - activityAt < threshold) return
      if (!current.isStable()) return

      inFlightRef.current = true
      const trigger = appActiveRef.current ? "空闲" : "窗口失焦"
      void current
        .checkpoint(trigger)
        .then((handled) => {
          if (handled) {
            backoffStepRef.current = 0
            // 变更代去重：检查点期间又有新活动就保留待办
            if (lastActivityRef.current === activityAt) {
              lastActivityRef.current = null
            }
          } else {
            const step = Math.min(
              backoffStepRef.current,
              FAILURE_BACKOFF_MS.length - 1
            )
            backoffUntilRef.current = Date.now() + FAILURE_BACKOFF_MS[step]
            backoffStepRef.current = step + 1
          }
        })
        .finally(() => {
          inFlightRef.current = false
        })
    }

    const handleActiveChange = () => {
      const active =
        document.visibilityState === "visible" && document.hasFocus()
      if (appActiveRef.current === active) return
      appActiveRef.current = active
      if (!active) {
        // 失焦当下先把草稿落盘；提交仍按 inactive 阈值等待
        void callbacksRef.current.flushDrafts()
      }
    }
    const handleFocus = () => handleActiveChange()
    const handleBlur = () => handleActiveChange()

    window.addEventListener("focus", handleFocus)
    window.addEventListener("blur", handleBlur)
    document.addEventListener("visibilitychange", handleActiveChange)
    const timer = window.setInterval(maybeCheckpoint, 1_000)

    return () => {
      window.removeEventListener("focus", handleFocus)
      window.removeEventListener("blur", handleBlur)
      document.removeEventListener("visibilitychange", handleActiveChange)
      window.clearInterval(timer)
    }
  }, [])

  return { recordContentActivity }
}
