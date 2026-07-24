import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  HandCoinsIcon,
  PencilLineIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { DebtStatusBadge } from "@/components/shard/debt-status-badge"
import { TagBadge } from "@/components/shard/tag-badge"
import {
  centsToYuanLabel,
  computeDebtUrgency,
  describeDueDate,
} from "@/lib/debt"
import type { Debt } from "@/types"

interface DebtDetailSheetProps {
  debt: Debt | null
  onClose: () => void
  onDelete: (debt: Debt) => void
  onDeleteRepayment: (debtId: string, repaymentId: string) => void
  onEdit: (debt: Debt) => void
  onRegisterRepayment: (debt: Debt) => void
  onToggleArchive: (debt: Debt) => void
}

export function DebtDetailSheet({
  debt,
  onClose,
  onDelete,
  onDeleteRepayment,
  onEdit,
  onRegisterRepayment,
  onToggleArchive,
}: DebtDetailSheetProps) {
  const isLendOut = debt?.direction === "lend_out"
  const urgency = debt ? computeDebtUrgency(debt) : "normal"
  const dueLabel = debt ? describeDueDate(debt.dueDate) : null
  const progressPercent = debt
    ? Math.min(100, Math.max(0, (debt.paidCents / debt.principalCents) * 100))
    : 0

  function handleRevokeRepayment(repaymentId: string) {
    if (!debt) return
    if (!window.confirm("确定要撤销这笔还款记录吗？")) return
    onDeleteRepayment(debt.id, repaymentId)
  }

  return (
    <Sheet
      open={debt !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md" side="right">
        {debt ? (
          <>
            <SheetHeader className="border-b border-border">
              <div className="flex items-center gap-[var(--shard-space-2)] pr-[var(--shard-space-6)]">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--shard-radius-control)] border border-border bg-background text-muted-foreground">
                  {isLendOut ? (
                    <ArrowUpRightIcon className="size-4 stroke-[1.75]" />
                  ) : (
                    <ArrowDownLeftIcon className="size-4 stroke-[1.75]" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate">{debt.counterparty}</SheetTitle>
                  <SheetDescription>
                    {isLendOut ? "借出（别人欠我）" : "借入（我欠别人）"}
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>

            <div className="flex min-h-0 flex-1 flex-col gap-[var(--shard-space-4)] overflow-y-auto p-4">
              <div className="flex flex-wrap items-center gap-[var(--shard-space-2)]">
                <DebtStatusBadge urgency={urgency} />
                {dueLabel ? (
                  <span className="text-xs text-muted-foreground">{dueLabel}</span>
                ) : null}
                {debt.archived ? (
                  <span className="text-xs font-medium text-muted-foreground">
                    已归档
                  </span>
                ) : null}
              </div>

              <div className="rounded-[var(--shard-radius-control)] border border-border bg-background p-[var(--shard-space-3)]">
                <div className="grid grid-cols-3 gap-[var(--shard-space-2)]">
                  <AmountStat label="本金" value={centsToYuanLabel(debt.principalCents)} />
                  <AmountStat label="已还" value={centsToYuanLabel(debt.paidCents)} />
                  <AmountStat
                    className={
                      debt.settled ? "text-[color:var(--shard-emerald)]" : "text-foreground"
                    }
                    label="剩余"
                    value={centsToYuanLabel(debt.remainingCents)}
                  />
                </div>
                <div className="mt-[var(--shard-space-3)] h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-[color:var(--shard-sapphire)]"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>

              {debt.note ? (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground">备注</div>
                  <p className="mt-1 text-sm whitespace-pre-wrap text-foreground">
                    {debt.note}
                  </p>
                </div>
              ) : null}

              {debt.tags.length > 0 ? (
                <div className="shard-card-tags flex flex-wrap gap-[var(--shard-space-2)]">
                  {debt.tags.map((tag) => (
                    <TagBadge key={tag} tag={tag} />
                  ))}
                </div>
              ) : null}

              <div className="min-h-0 flex-1">
                <div className="text-xs font-semibold text-muted-foreground">
                  还款记录 · {debt.repayments.length} 笔
                </div>
                {debt.repayments.length === 0 ? (
                  <p className="mt-[var(--shard-space-2)] text-sm text-muted-foreground">
                    还没有登记过还款。
                  </p>
                ) : (
                  <ul className="mt-[var(--shard-space-2)] flex flex-col gap-[var(--shard-space-2)]">
                    {debt.repayments.map((repayment) => (
                      <li
                        className="flex items-start justify-between gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] border border-border bg-background px-[var(--shard-space-3)] py-[var(--shard-space-2)]"
                        key={repayment.id}
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-semibold tabular-nums text-foreground">
                            {centsToYuanLabel(repayment.amountCents)}
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {repayment.paidOn}
                            {repayment.note ? ` · ${repayment.note}` : ""}
                          </div>
                        </div>
                        <Button
                          aria-label="撤销这笔还款"
                          className="shrink-0"
                          onClick={() => handleRevokeRepayment(repayment.id)}
                          size="icon-xs"
                          type="button"
                          variant="ghost"
                        >
                          <XIcon />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <SheetFooter className="border-t border-border">
              <div className="flex flex-wrap gap-[var(--shard-space-2)]">
                <Button
                  className="flex-1"
                  onClick={() => onRegisterRepayment(debt)}
                  type="button"
                >
                  <HandCoinsIcon data-icon="inline-start" />
                  登记还款
                </Button>
                <Button onClick={() => onEdit(debt)} type="button" variant="outline">
                  <PencilLineIcon data-icon="inline-start" />
                  编辑
                </Button>
                <Button
                  onClick={() => onToggleArchive(debt)}
                  type="button"
                  variant="outline"
                >
                  {debt.archived ? (
                    <ArchiveRestoreIcon data-icon="inline-start" />
                  ) : (
                    <ArchiveIcon data-icon="inline-start" />
                  )}
                  {debt.archived ? "取消归档" : "归档"}
                </Button>
                <Button onClick={() => onDelete(debt)} type="button" variant="destructive">
                  <Trash2Icon data-icon="inline-start" />
                  删除
                </Button>
              </div>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function AmountStat({
  className,
  label,
  value,
}: {
  className?: string
  label: string
  value: string
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className={`truncate text-sm font-semibold tabular-nums ${className ?? ""}`}>
        {value}
      </div>
    </div>
  )
}
