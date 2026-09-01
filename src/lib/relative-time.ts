/**
 * 状态栏的「上次同步」相对时间。
 *
 * 刻意不用 Intl.RelativeTimeFormat：zh-CN 在 numeric:"auto" 下会把「1 天前」
 * 渲染成「昨天」，与同一条状态栏里的「3 分钟前」粒度混排，读起来像两套语言。
 *
 * now 可注入，纯粹是为了让边界能被测到。
 */
export function formatSyncedAgo(syncedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - syncedAt) / 1000))
  if (seconds < 60) return "刚刚同步"

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前同步`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前同步`

  return `${Math.floor(hours / 24)} 天前同步`
}
