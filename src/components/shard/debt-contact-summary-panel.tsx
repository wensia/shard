import { useMemo, useState } from "react"
import { ChevronDownIcon, ChevronRightIcon, UsersIcon } from "lucide-react"

import { DebtCard } from "@/components/shard/debt-card"
import { centsToYuanLabel, summarizeByContact } from "@/lib/debt"
import type { Debt } from "@/types"

interface DebtContactSummaryPanelProps {
  debts: Debt[]
  onDelete: (debt: Debt) => void
  onEdit: (debt: Debt) => void
  onOpenDetail: (debt: Debt) => void
  onRegisterRepayment: (debt: Debt) => void
  onToggleArchive: (debt: Debt) => void
}

export function DebtContactSummaryPanel({
  debts,
  onDelete,
  onEdit,
  onOpenDetail,
  onRegisterRepayment,
  onToggleArchive,
}: DebtContactSummaryPanelProps) {
  const summaries = useMemo(() => summarizeByContact(debts), [debts])
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  if (summaries.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-[var(--shard-space-2)] text-center text-muted-foreground">
        <UsersIcon className="size-7 stroke-[1.5]" />
        <div className="text-sm font-semibold text-foreground">
          还没有联系人相关的债务
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-[var(--shard-space-3)]">
      {summaries.map((summary) => {
        const expanded = expandedKey === summary.counterpartyKey

        return (
          <div
            className="rounded-[var(--shard-surface-radius)] bg-card"
            key={summary.counterpartyKey}
          >
            <button
              className="flex w-full items-center justify-between gap-[var(--shard-space-3)] px-[var(--shard-card-padding-x)] py-[var(--shard-card-padding-y)] text-left"
              onClick={() =>
                setExpandedKey(expanded ? null : summary.counterpartyKey)
              }
              type="button"
            >
              <div className="flex min-w-0 items-center gap-[var(--shard-space-2)]">
                {expanded ? (
                  <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-foreground">
                    {summary.counterpartyDisplayName}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {summary.activeDebtCount} 笔进行中
                    {summary.overdueCount > 0
                      ? ` · ${summary.overdueCount} 笔逾期`
                      : ""}
                  </div>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className={netAmountClass(summary.netCents)}>
                  {formatNetLabel(summary.netCents)}
                </div>
              </div>
            </button>

            {expanded ? (
              <div className="flex flex-col gap-[var(--shard-space-3)] border-t border-border px-[var(--shard-card-padding-x)] py-[var(--shard-card-padding-y)]">
                {summary.debts.map((debt) => (
                  <DebtCard
                    debt={debt}
                    key={debt.id}
                    onDelete={onDelete}
                    onEdit={onEdit}
                    onOpenDetail={onOpenDetail}
                    onRegisterRepayment={onRegisterRepayment}
                    onToggleArchive={onToggleArchive}
                  />
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function netAmountClass(netCents: number) {
  const base = "text-sm font-semibold tabular-nums"
  if (netCents > 0) return `${base} text-[color:var(--shard-emerald)]`
  if (netCents < 0) return `${base} text-[color:var(--shard-ruby)]`
  return `${base} text-muted-foreground`
}

function formatNetLabel(netCents: number) {
  if (netCents === 0) return "两不相欠"
  if (netCents > 0) return `对方欠我 ${centsToYuanLabel(netCents)}`
  return `我欠对方 ${centsToYuanLabel(Math.abs(netCents))}`
}
