import { collectTaskReminders, formatReminder, parseReminderAt } from "@shard/markdown/core"

import type { Fragment } from "@/types"

/** 芯片上的简写：今年省略年份，`10月1日 09:00`；跨年带上年份。 */
export function formatReminderLabel(at: string, now: Date = new Date()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/u.exec(at)
  if (!match) return at
  const [, year, month, day, time] = match
  const date = `${Number(month)}月${Number(day)}日`
  return Number(year) === now.getFullYear() ? `${date} ${time}` : `${Number(year)}年${date} ${time}`
}

export interface ReminderQuickOption {
  label: string
  at: string
}

function at(base: Date, dayOffset: number, hour: number) {
  const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, 0)
  return formatReminder(date)
}

/** 提醒弹层的快捷项：今天 18:00 / 明天 09:00 / 下周一 09:00（今天是周一则取七天后）。 */
export function reminderQuickOptions(now: Date = new Date()): ReminderQuickOption[] {
  const untilMonday = ((8 - now.getDay()) % 7) || 7
  return [
    { label: "今天 18:00", at: at(now, 0, 18) },
    { label: "明天 09:00", at: at(now, 1, 9) },
    { label: "下周一 09:00", at: at(now, untilMonday, 9) },
  ]
}

/** `YYYY-MM-DD HH:mm` 拆成日期与时间两段；不合法时两段都为空。 */
export function splitReminderAt(value: string | null): { date: string; time: string } {
  if (!value || parseReminderAt(value) === null) return { date: "", time: "" }
  const [date, time] = value.split(" ")
  return { date, time }
}

export function isReminderDue(at: string, now: number = Date.now()) {
  const dueAt = parseReminderAt(at)
  return dueAt !== null && dueAt <= now
}

interface CachedReminders {
  content: string
  dueAt: number[]
}

/**
 * 从碎片里汇总所有「未勾选任务项」的提醒时间戳，供 Dock 角标调度。
 *
 * 只看公开、未进回收站的内容：密匣正文不外泄到角标；冲突副本与原件内容重复，
 * 计入会让同一张卡片数两次。正文不含 `⏰` 的直接跳过；按正文缓存解析结果，
 * 只有改动过的碎片才重新解析。
 */
export function collectReminderDueTimes(
  fragments: readonly Fragment[],
  cache: Map<string, CachedReminders> = new Map()
): number[] {
  const dueAt: number[] = []
  const seen = new Set<string>()
  for (const fragment of fragments) {
    if (fragment.archived || fragment.lockbox || fragment.conflictOf) continue
    if (!fragment.content.includes("⏰")) continue
    seen.add(fragment.id)
    let cached = cache.get(fragment.id)
    if (!cached || cached.content !== fragment.content) {
      cached = {
        content: fragment.content,
        dueAt: collectTaskReminders(fragment.content)
          .filter((reminder) => !reminder.checked)
          .map((reminder) => reminder.dueAt),
      }
      cache.set(fragment.id, cached)
    }
    dueAt.push(...cached.dueAt)
  }
  for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id)
  return dueAt.sort((left, right) => left - right)
}
