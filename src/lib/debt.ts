import type { ContactDebtSummary, Debt, DebtUrgency } from "@/types"

// 临近到期窗口：到期日在未来 7 天内（含当天）。
// N=7 理由：给用户足够提前反应时间，又不至于让列表长期"到处是黄色"稀释警示效果；
// 与信用卡"账单日后还款日前提醒"的常见习惯一致。不做成可配置项（v1 范围之外）。
export const DEBT_DUE_SOON_DAYS = 7

/**
 * 本地时区 "YYYY-MM-DD"。绝不能用 `new Date().toISOString().slice(0, 10)`——
 * `toISOString()` 总是转成 UTC，在 UTC+8 时区，当地时间晚上 8 点后取到的日期
 * 其实已经是 UTC 的"明天"，会导致到期判断整体错一天。
 */
export function todayISODate(): string {
  return new Intl.DateTimeFormat("en-CA").format(new Date())
}

/**
 * RFC3339 时刻 → 本地时区 "YYYY-MM-DD"，用于把 `Debt.createdAt` 回填进日期选择
 * 器。同 `todayISODate`，走 `en-CA` 而非 `toISOString()`，避免跨时区错一天。
 */
export function isoDateOfTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return ""
  return new Intl.DateTimeFormat("en-CA").format(parsed)
}

/** a - b，用 UTC 毫秒数做减法避免夏令时/时分秒残留导致的偏差。 */
function daysBetweenISODates(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number)
  const [by, bm, bd] = b.split("-").map(Number)
  const diffMs = Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)
  return Math.round(diffMs / 86_400_000)
}

export function computeDebtUrgency(
  debt: Pick<Debt, "dueDate" | "settled">,
  today: string = todayISODate(),
  dueSoonDays: number = DEBT_DUE_SOON_DAYS
): DebtUrgency {
  if (debt.settled) return "settled" // 优先级最高：结清了不再判断逾期/临近
  if (!debt.dueDate) return "noDueDate"

  const diffDays = daysBetweenISODates(debt.dueDate, today) // dueDate - today，负数=已过期
  if (diffDays < 0) return "overdue"
  if (diffDays <= dueSoonDays) return "dueSoon"
  return "normal"
}

/** 到期日的人类可读描述，供卡片/详情展示逾期天数或倒计时。dueDate 为空时返回 null。 */
export function describeDueDate(
  dueDate: string | null,
  today: string = todayISODate()
): string | null {
  if (!dueDate) return null

  const diffDays = daysBetweenISODates(dueDate, today)
  if (diffDays < 0) return `已逾期 ${Math.abs(diffDays)} 天`
  if (diffDays === 0) return "今天到期"
  return `还有 ${diffDays} 天到期（${dueDate}）`
}

export function centsToYuanLabel(cents: number): string {
  const isNegative = cents < 0
  const amount = (Math.abs(cents) / 100).toFixed(2)
  return `${isNegative ? "-" : ""}¥${amount}`
}

export function yuanInputToCents(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const n = Number(trimmed)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 100) // Math.round 防浮点误差
}

export function summarizeByContact(debts: Debt[]): ContactDebtSummary[] {
  interface MutableSummary extends ContactDebtSummary {
    latestUpdatedAt: string
  }

  const map = new Map<string, MutableSummary>()

  for (const debt of debts) {
    if (debt.archived) continue

    const key = debt.counterparty.trim().toLowerCase()
    const entry: MutableSummary = map.get(key) ?? {
      counterpartyKey: key,
      counterpartyDisplayName: debt.counterparty,
      netCents: 0,
      lendOutRemainingCents: 0,
      borrowInRemainingCents: 0,
      activeDebtCount: 0,
      overdueCount: 0,
      debts: [],
      latestUpdatedAt: "",
    }

    entry.debts.push(debt)
    if (debt.updatedAt >= entry.latestUpdatedAt) {
      entry.latestUpdatedAt = debt.updatedAt
      entry.counterpartyDisplayName = debt.counterparty
    }
    if (!debt.settled) entry.activeDebtCount += 1
    if (debt.direction === "lend_out") {
      entry.lendOutRemainingCents += debt.remainingCents
    } else {
      entry.borrowInRemainingCents += debt.remainingCents
    }
    if (computeDebtUrgency(debt) === "overdue") entry.overdueCount += 1

    map.set(key, entry)
  }

  const summaries: ContactDebtSummary[] = [...map.values()].map((entry) => ({
    counterpartyKey: entry.counterpartyKey,
    counterpartyDisplayName: entry.counterpartyDisplayName,
    netCents: entry.lendOutRemainingCents - entry.borrowInRemainingCents,
    lendOutRemainingCents: entry.lendOutRemainingCents,
    borrowInRemainingCents: entry.borrowInRemainingCents,
    activeDebtCount: entry.activeDebtCount,
    overdueCount: entry.overdueCount,
    debts: entry.debts,
  }))

  return summaries.sort((a, b) => Math.abs(b.netCents) - Math.abs(a.netCents))
}

export function sortDebtsForDisplay(debts: Debt[]): Debt[] {
  // 排序：逾期 > 临近到期 > 进行中 > 已结清 > 无到期日；同组内按 dueDate 升序（无到期日排最后）
  const rank: Record<DebtUrgency, number> = {
    overdue: 0,
    dueSoon: 1,
    normal: 2,
    noDueDate: 3,
    settled: 4,
  }

  return [...debts].sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1

    const ra = rank[computeDebtUrgency(a)]
    const rb = rank[computeDebtUrgency(b)]
    if (ra !== rb) return ra - rb

    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate)
    if (a.dueDate) return -1
    if (b.dueDate) return 1
    return b.updatedAt.localeCompare(a.updatedAt)
  })
}
