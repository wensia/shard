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

import { Button } from "@astryxdesign/core/Button"
import { HStack } from "@astryxdesign/core/HStack"
import { Stack } from "@astryxdesign/core/Stack"

import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
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

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) onClose()
  }

  function handleRevokeRepayment(repaymentId: string) {
    if (!debt) return
    if (!window.confirm("确定要撤销这笔还款记录吗？")) return
    onDeleteRepayment(debt.id, repaymentId)
  }

  return (
    <Sheet isOpen={debt !== null} onOpenChange={handleOpenChange}>
      {debt ? (
        <>
          <SheetHeader
            endContent={
              <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--shard-radius-control)] border border-border bg-background text-muted-foreground">
                {isLendOut ? (
                  <ArrowUpRightIcon className="size-4 stroke-[1.75]" />
                ) : (
                  <ArrowDownLeftIcon className="size-4 stroke-[1.75]" />
                )}
              </span>
            }
            onOpenChange={handleOpenChange}
            subtitle={isLendOut ? "借出（别人欠我）" : "借入（我欠别人）"}
            title={debt.counterparty}
          />

          <SheetContent>
            <Stack gap={4}>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <DebtStatusBadge urgency={urgency} />
                {dueLabel ? (
                  <span className="text-xs text-muted-foreground">{dueLabel}</span>
                ) : null}
                {debt.archived ? (
                  <span className="text-xs font-medium text-muted-foreground">
                    已归档
                  </span>
                ) : null}
              </HStack>

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
                <HStack className="shard-card-tags" gap={2} wrap="wrap">
                  {debt.tags.map((tag) => (
                    <TagBadge key={tag} tag={tag} />
                  ))}
                </HStack>
              ) : null}

              <div>
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
                          className="shrink-0"
                          icon={<XIcon />}
                          isIconOnly
                          label="撤销这笔还款"
                          onClick={() => handleRevokeRepayment(repayment.id)}
                          size="sm"
                          variant="ghost"
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Stack>
          </SheetContent>

          <SheetFooter>
            <HStack gap={2} wrap="wrap">
              <Button
                className="flex-1"
                icon={<HandCoinsIcon />}
                label="登记还款"
                onClick={() => onRegisterRepayment(debt)}
                variant="primary"
              />
              <Button
                icon={<PencilLineIcon />}
                label="编辑"
                onClick={() => onEdit(debt)}
                variant="secondary"
              />
              <Button
                icon={debt.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                label={debt.archived ? "取消归档" : "归档"}
                onClick={() => onToggleArchive(debt)}
                variant="secondary"
              />
              <Button
                icon={<Trash2Icon />}
                label="删除"
                onClick={() => onDelete(debt)}
                variant="destructive"
              />
            </HStack>
          </SheetFooter>
        </>
      ) : null}
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
