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
import { Grid } from "@astryxdesign/core/Grid"
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
              <span
                style={{
                  display: "flex",
                  width: 32,
                  height: 32,
                  flexShrink: 0,
                  alignItems: "center",
                  justifyContent: "center",
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
                  <span style={{ fontSize: "0.75rem", color: "var(--muted-foreground)" }}>
                    {dueLabel}
                  </span>
                ) : null}
                {debt.archived ? (
                  <span
                    style={{
                      fontSize: "0.75rem",
                      fontWeight: 500,
                      color: "var(--muted-foreground)",
                    }}
                  >
                    已归档
                  </span>
                ) : null}
              </HStack>

              <div
                style={{
                  borderRadius: "var(--shard-radius-control)",
                  border: "1px solid var(--border)",
                  background: "var(--background)",
                  padding: "var(--shard-space-3)",
                }}
              >
                <Grid columns={3} gap={2}>
                  <AmountStat label="本金" value={centsToYuanLabel(debt.principalCents)} />
                  <AmountStat label="已还" value={centsToYuanLabel(debt.paidCents)} />
                  <AmountStat
                    color={debt.settled ? "var(--shard-emerald)" : "var(--foreground)"}
                    label="剩余"
                    value={centsToYuanLabel(debt.remainingCents)}
                  />
                </Grid>
                <div
                  style={{
                    marginTop: "var(--shard-space-3)",
                    height: 6,
                    overflow: "hidden",
                    borderRadius: 9999,
                    background: "var(--muted)",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      borderRadius: 9999,
                      background: "var(--shard-sapphire)",
                      width: `${progressPercent}%`,
                    }}
                  />
                </div>
              </div>

              {debt.note ? (
                <div>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      color: "var(--muted-foreground)",
                    }}
                  >
                    备注
                  </div>
                  <p
                    style={{
                      margin: 0,
                      marginTop: "var(--shard-space-1)",
                      fontSize: "0.875rem",
                      whiteSpace: "pre-wrap",
                      color: "var(--foreground)",
                    }}
                  >
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
                <div
                  style={{
                    fontSize: "0.75rem",
                    fontWeight: 600,
                    color: "var(--muted-foreground)",
                  }}
                >
                  还款记录 · {debt.repayments.length} 笔
                </div>
                {debt.repayments.length === 0 ? (
                  <p
                    style={{
                      margin: 0,
                      marginTop: "var(--shard-space-2)",
                      fontSize: "0.875rem",
                      color: "var(--muted-foreground)",
                    }}
                  >
                    还没有登记过还款。
                  </p>
                ) : (
                  <Stack as="ul" gap={2} style={{ marginTop: "var(--shard-space-2)", listStyle: "none", padding: 0 }}>
                    {debt.repayments.map((repayment) => (
                      <HStack
                        as="li"
                        gap={2}
                        hAlign="between"
                        key={repayment.id}
                        style={{
                          borderRadius: "var(--shard-radius-control)",
                          border: "1px solid var(--border)",
                          background: "var(--background)",
                          paddingInline: "var(--shard-space-3)",
                          paddingBlock: "var(--shard-space-2)",
                        }}
                        vAlign="start"
                      >
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: "0.875rem",
                              fontWeight: 600,
                              fontVariantNumeric: "tabular-nums",
                              color: "var(--foreground)",
                            }}
                          >
                            {centsToYuanLabel(repayment.amountCents)}
                          </div>
                          <div
                            style={{
                              marginTop: 2,
                              fontSize: "0.75rem",
                              color: "var(--muted-foreground)",
                            }}
                          >
                            {repayment.paidOn}
                            {repayment.note ? ` · ${repayment.note}` : ""}
                          </div>
                        </div>
                        <Button
                          icon={<XIcon />}
                          isIconOnly
                          label="撤销这笔还款"
                          onClick={() => handleRevokeRepayment(repayment.id)}
                          size="sm"
                          style={{ flexShrink: 0 }}
                          variant="ghost"
                        />
                      </HStack>
                    ))}
                  </Stack>
                )}
              </div>
            </Stack>
          </SheetContent>

          <SheetFooter>
            <HStack gap={2} wrap="wrap">
              <Button
                icon={<HandCoinsIcon />}
                label="登记还款"
                onClick={() => onRegisterRepayment(debt)}
                style={{ flex: "1 1 auto" }}
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
  color,
  label,
  value,
}: {
  color?: string
  label: string
  value: string
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 500, color: "var(--muted-foreground)" }}>
        {label}
      </div>
      <div
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: "0.875rem",
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
          color: color ?? "var(--foreground)",
        }}
      >
        {value}
      </div>
    </div>
  )
}
