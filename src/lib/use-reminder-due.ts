import { parseReminderAt } from "@shard/markdown/core"
import { useEffect, useState } from "react"

/** setTimeout 的上限（约 24.8 天）；更远的提醒不挂定时器，重开页面时再判定。 */
const MAX_TIMER_DELAY = 2_147_483_647

/**
 * 提醒是否已到点。到点前挂一个定时器，到点后调用方自己切到警示态，不依赖外部重渲染。
 * 编辑区芯片与时间线卡片的提醒标记共用。
 */
export function useReminderDue(at: string | null) {
  const dueAt = at ? parseReminderAt(at) : null
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (dueAt === null) return
    const delay = dueAt - Date.now()
    if (delay <= 0 || delay > MAX_TIMER_DELAY) return
    const timer = window.setTimeout(() => setNow(Date.now()), delay + 50)
    return () => window.clearTimeout(timer)
  }, [dueAt])
  return dueAt !== null && dueAt <= now
}
