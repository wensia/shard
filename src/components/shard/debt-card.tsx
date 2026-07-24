import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  HandCoinsIcon,
  MoreHorizontalIcon,
  PencilLineIcon,
  Trash2Icon,
} from "lucide-react"

import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu"

import { DebtStatusBadge } from "@/components/shard/debt-status-badge"
import { TagBadge } from "@/components/shard/tag-badge"
import { centsToYuanLabel, computeDebtUrgency, describeDueDate } from "@/lib/debt"
import { cn } from "@/lib/utils"
import type { Debt } from "@/types"

interface DebtCardProps {
  debt: Debt
  onDelete: (debt: Debt) => void
  onEdit: (debt: Debt) => void
  onOpenDetail: (debt: Debt) => void
  onRegisterRepayment: (debt: Debt) => void
  onToggleArchive: (debt: Debt) => void
}

export function DebtCard({
  debt,
  onDelete,
  onEdit,
  onOpenDetail,
  onRegisterRepayment,
  onToggleArchive,
}: DebtCardProps) {
  const urgency = computeDebtUrgency(debt)
  const dueLabel = describeDueDate(debt.dueDate)
  const isLendOut = debt.direction === "lend_out"

  return (
    <article
      className="group flex cursor-pointer flex-col gap-[var(--shard-space-3)] rounded-[var(--shard-surface-radius)] bg-card px-[var(--shard-card-padding-x)] py-[var(--shard-card-padding-y)] shadow-card transition-shadow hover:shadow-card-hover"
      onClick={() => onOpenDetail(debt)}
    >
      <div className="flex items-start justify-between gap-[var(--shard-space-3)]">
        <div className="flex min-w-0 items-center gap-[var(--shard-space-3)]">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--shard-radius-control)] border border-border bg-background text-muted-foreground">
            {isLendOut ? (
              <ArrowUpRightIcon className="size-4 stroke-[1.75]" />
            ) : (
              <ArrowDownLeftIcon className="size-4 stroke-[1.75]" />
            )}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-[var(--shard-space-2)]">
              <h3 className="truncate text-sm font-semibold text-foreground">
                {debt.counterparty}
              </h3>
              <span className="shrink-0 text-xs font-medium text-muted-foreground">
                {isLendOut ? "借出" : "借入"}
              </span>
            </div>
            {dueLabel ? (
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {dueLabel}
              </div>
            ) : null}
          </div>
        </div>

        <div
          className="flex shrink-0 items-center gap-[var(--shard-space-2)]"
          onClick={(event) => event.stopPropagation()}
        >
          <DebtStatusBadge urgency={urgency} />
          <DropdownMenu
            button={{
              icon: <MoreHorizontalIcon />,
              isIconOnly: true,
              label: "债务操作",
              size: "sm",
              variant: "ghost",
            }}
          >
            <DropdownMenuItem
              icon={PencilLineIcon}
              label="编辑"
              onClick={() => onEdit(debt)}
            />
            <DropdownMenuItem
              icon={HandCoinsIcon}
              label="登记还款"
              onClick={() => onRegisterRepayment(debt)}
            />
            <DropdownMenuItem
              icon={debt.archived ? ArchiveRestoreIcon : ArchiveIcon}
              label={debt.archived ? "取消归档" : "归档"}
              onClick={() => onToggleArchive(debt)}
            />
            <DropdownMenuItem
              icon={Trash2Icon}
              label="删除"
              onClick={() => onDelete(debt)}
            />
          </DropdownMenu>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] bg-background px-[var(--shard-space-3)] py-[var(--shard-space-2)]">
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

      {debt.tags.length > 0 ? (
        <div className="shard-card-tags flex flex-wrap gap-[var(--shard-space-2)]">
          {debt.tags.map((tag) => (
            <TagBadge key={tag} tag={tag} />
          ))}
        </div>
      ) : null}
    </article>
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
      <div className={cn("truncate text-sm font-semibold tabular-nums", className)}>
        {value}
      </div>
    </div>
  )
}
