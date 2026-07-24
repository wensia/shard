import type { CSSProperties } from "react"
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
import { Center } from "@astryxdesign/core/Center"
import { Grid } from "@astryxdesign/core/Grid"
import { HStack } from "@astryxdesign/core/HStack"

import styles from "./debt-card.module.css"
import { DebtStatusBadge } from "@/components/shard/debt-status-badge"
import { TagBadge } from "@/components/shard/tag-badge"
import { centsToYuanLabel, computeDebtUrgency, describeDueDate } from "@/lib/debt"
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
    <article className={styles.card} onClick={() => onOpenDetail(debt)}>
      <HStack hAlign="between" vAlign="start" gap={3}>
        <HStack gap={3} vAlign="center" style={{ minWidth: 0 }}>
          <Center
            width={32}
            height={32}
            style={{
              flexShrink: 0,
              borderRadius: "var(--shard-radius-control)",
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "var(--muted-foreground)",
            }}
          >
            {isLendOut ? (
              <ArrowUpRightIcon size={16} strokeWidth={1.75} />
            ) : (
              <ArrowDownLeftIcon size={16} strokeWidth={1.75} />
            )}
          </Center>
          <div style={{ minWidth: 0 }}>
            <HStack gap={2} vAlign="center" style={{ minWidth: 0 }}>
              <h3
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "var(--font-size-sm)",
                  fontWeight: "var(--font-weight-semibold)",
                  color: "var(--foreground)",
                }}
              >
                {debt.counterparty}
              </h3>
              <span
                style={{
                  flexShrink: 0,
                  fontSize: "var(--font-size-xs)",
                  fontWeight: "var(--font-weight-medium)",
                  color: "var(--muted-foreground)",
                }}
              >
                {isLendOut ? "借出" : "借入"}
              </span>
            </HStack>
            {dueLabel ? (
              <div
                style={{
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "var(--font-size-xs)",
                  color: "var(--muted-foreground)",
                }}
              >
                {dueLabel}
              </div>
            ) : null}
          </div>
        </HStack>

        <HStack
          gap={2}
          vAlign="center"
          style={{ flexShrink: 0 }}
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
        </HStack>
      </HStack>

      <Grid
        columns={3}
        gap={2}
        style={{
          borderRadius: "var(--shard-radius-control)",
          background: "var(--background)",
          paddingInline: "var(--shard-space-3)",
          paddingBlock: "var(--shard-space-2)",
        }}
      >
        <AmountStat label="本金" value={centsToYuanLabel(debt.principalCents)} />
        <AmountStat label="已还" value={centsToYuanLabel(debt.paidCents)} />
        <AmountStat
          color={debt.settled ? "var(--shard-emerald)" : undefined}
          label="剩余"
          value={centsToYuanLabel(debt.remainingCents)}
        />
      </Grid>

      {debt.tags.length > 0 ? (
        <HStack className="shard-card-tags" wrap="wrap" gap={2}>
          {debt.tags.map((tag) => (
            <TagBadge key={tag} tag={tag} />
          ))}
        </HStack>
      ) : null}
    </article>
  )
}

function AmountStat({
  color,
  label,
  value,
}: {
  color?: string
  label: string
  value: string
}) {
  const valueStyle: CSSProperties = {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "var(--font-size-sm)",
    fontWeight: "var(--font-weight-semibold)",
    fontVariantNumeric: "tabular-nums",
    color: color ?? "var(--foreground)",
  }

  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: "var(--font-weight-medium)",
          color: "var(--muted-foreground)",
        }}
      >
        {label}
      </div>
      <div style={valueStyle}>{value}</div>
    </div>
  )
}
