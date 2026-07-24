import { useMemo, useState } from "react"
import { ChevronDownIcon, ChevronRightIcon, UsersIcon } from "lucide-react"

import { HStack, Stack } from "@astryxdesign/core/Stack"

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
      <Stack
        height={192}
        hAlign="center"
        vAlign="center"
        gap={2}
        style={{ textAlign: "center", color: "var(--muted-foreground)" }}
      >
        <UsersIcon size={28} strokeWidth={1.5} />
        <div
          style={{
            fontSize: "var(--font-size-sm)",
            fontWeight: 600,
            color: "var(--foreground)",
          }}
        >
          还没有联系人相关的债务
        </div>
      </Stack>
    )
  }

  return (
    <Stack gap={3}>
      {summaries.map((summary) => {
        const expanded = expandedKey === summary.counterpartyKey

        return (
          <div
            key={summary.counterpartyKey}
            style={{
              borderRadius: "var(--shard-surface-radius)",
              background: "var(--card)",
            }}
          >
            <button
              onClick={() =>
                setExpandedKey(expanded ? null : summary.counterpartyKey)
              }
              style={{ width: "100%", textAlign: "left" }}
              type="button"
            >
              <HStack hAlign="between" vAlign="center" gap={3} padding={4}>
                <HStack gap={2} vAlign="center" style={{ minWidth: 0 }}>
                  {expanded ? (
                    <ChevronDownIcon
                      size={16}
                      style={{ flexShrink: 0, color: "var(--muted-foreground)" }}
                    />
                  ) : (
                    <ChevronRightIcon
                      size={16}
                      style={{ flexShrink: 0, color: "var(--muted-foreground)" }}
                    />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: "var(--font-size-sm)",
                        fontWeight: 600,
                        color: "var(--foreground)",
                      }}
                    >
                      {summary.counterpartyDisplayName}
                    </div>
                    <div
                      style={{
                        marginTop: 2,
                        fontSize: "var(--font-size-xs)",
                        color: "var(--muted-foreground)",
                      }}
                    >
                      {summary.activeDebtCount} 笔进行中
                      {summary.overdueCount > 0
                        ? ` · ${summary.overdueCount} 笔逾期`
                        : ""}
                    </div>
                  </div>
                </HStack>
                <div style={{ flexShrink: 0, textAlign: "right" }}>
                  <div style={netAmountStyle(summary.netCents)}>
                    {formatNetLabel(summary.netCents)}
                  </div>
                </div>
              </HStack>
            </button>

            {expanded ? (
              <Stack
                gap={3}
                padding={4}
                style={{ borderTop: "1px solid var(--border)" }}
              >
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
              </Stack>
            ) : null}
          </div>
        )
      })}
    </Stack>
  )
}

function netAmountStyle(netCents: number) {
  return {
    fontSize: "var(--font-size-sm)",
    fontWeight: 600,
    fontVariantNumeric: "tabular-nums",
    color:
      netCents > 0
        ? "var(--shard-emerald)"
        : netCents < 0
          ? "var(--shard-ruby)"
          : "var(--muted-foreground)",
  }
}

function formatNetLabel(netCents: number) {
  if (netCents === 0) return "两不相欠"
  if (netCents > 0) return `对方欠我 ${centsToYuanLabel(netCents)}`
  return `我欠对方 ${centsToYuanLabel(Math.abs(netCents))}`
}
