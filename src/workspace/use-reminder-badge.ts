import { useEffect, useRef } from "react"

import { setReminderSchedule } from "@/lib/api"
import { collectReminderDueTimes } from "@/lib/reminders"
import type { Fragment } from "@/types"

const PUSH_DEBOUNCE_MS = 500

/**
 * 备忘提醒 → Dock 角标：从碎片汇总未勾选任务项的提醒时间，推给 Rust 调度线程。
 *
 * - 只算公开、未进回收站的内容，密匣不外泄到角标（见 `collectReminderDueTimes`）；
 * - 解析放在去抖定时器里而不是渲染路径上，且按正文缓存，只重解析改动过的碎片；
 * - 列表与上次推送相同就不再发命令；`enabled` 为 false（碎片还在加载）时不推送，
 *   首次加载完成即推一次，已过期的提醒启动时立即计入角标。
 */
export function useReminderBadge(fragments: readonly Fragment[], enabled: boolean) {
  const cacheRef = useRef(new Map<string, { content: string; dueAt: number[] }>())
  const lastPushedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    const timer = window.setTimeout(() => {
      const dueAt = collectReminderDueTimes(fragments, cacheRef.current)
      const key = dueAt.join(",")
      if (key === lastPushedRef.current) return
      lastPushedRef.current = key
      void setReminderSchedule(dueAt).catch((error) => {
        // 推送失败下次内容变化时重试。
        lastPushedRef.current = null
        console.warn("[shard] 更新提醒角标失败：", error)
      })
    }, PUSH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [enabled, fragments])
}
