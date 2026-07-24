import { useMemo, useState } from "react"
import { HandCoinsIcon, PlusIcon, RefreshCwIcon } from "lucide-react"

import { AlertDialog } from "@astryxdesign/core/AlertDialog"
import { Button } from "@astryxdesign/core/Button"
import { HStack } from "@astryxdesign/core/HStack"
import { Stack } from "@astryxdesign/core/Stack"
import { Text } from "@astryxdesign/core/Text"
import { useToast } from "@astryxdesign/core/Toast"

import { DebtCard } from "@/components/shard/debt-card"
import { DebtContactSummaryPanel } from "@/components/shard/debt-contact-summary-panel"
import { DebtDetailSheet } from "@/components/shard/debt-detail-sheet"
import {
  DebtFormDialog,
  type DebtFormValues,
} from "@/components/shard/debt-form-dialog"
import {
  DebtRepaymentDialog,
  type DebtRepaymentValues,
} from "@/components/shard/debt-repayment-dialog"
import { TagFilterButton } from "@/components/shard/tagged-panel"
import {
  addRepayment,
  createDebt,
  deleteDebt,
  deleteRepayment,
  getApiErrorMessage,
  listDebts,
  setDebtArchived,
  updateDebt,
} from "@/lib/api"
import { sortDebtsForDisplay } from "@/lib/debt"
import type { Debt, DebtDirection } from "@/types"

import styles from "./debt-workspace.module.css"

interface DebtWorkspaceProps {
  debts: Debt[]
  onDebtsChange: (debts: Debt[]) => void
}

type ArchiveFilter = "active" | "archived"
type DirectionFilter = "all" | DebtDirection
type DebtView = "timeline" | "contacts"

type FormDialogState = { mode: "create" } | { mode: "edit"; debt: Debt }

export function DebtWorkspace({ debts, onDebtsChange }: DebtWorkspaceProps) {
  const toast = useToast()
  const [view, setView] = useState<DebtView>("timeline")
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>("active")
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all")
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [formDialog, setFormDialog] = useState<FormDialogState | null>(null)
  const [repaymentDebt, setRepaymentDebt] = useState<Debt | null>(null)
  const [detailDebtId, setDetailDebtId] = useState<string | null>(null)
  const [deletingDebt, setDeletingDebt] = useState<Debt | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const knownCounterparties = useMemo(() => {
    const seen = new Set<string>()
    for (const debt of debts) seen.add(debt.counterparty)
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [debts])

  const scopedDebts = useMemo(
    () =>
      debts.filter((debt) =>
        archiveFilter === "active" ? !debt.archived : debt.archived
      ),
    [debts, archiveFilter]
  )

  const filteredDebts = useMemo(
    () =>
      scopedDebts.filter(
        (debt) => directionFilter === "all" || debt.direction === directionFilter
      ),
    [scopedDebts, directionFilter]
  )

  const sortedDebts = useMemo(
    () => sortDebtsForDisplay(filteredDebts),
    [filteredDebts]
  )

  const detailDebt = useMemo(
    () =>
      detailDebtId ? debts.find((debt) => debt.id === detailDebtId) ?? null : null,
    [debts, detailDebtId]
  )

  const activeCount = debts.filter((debt) => !debt.archived && !debt.settled).length
  const contactCount = new Set(
    debts.filter((debt) => !debt.archived).map((debt) => debt.counterparty.trim().toLowerCase())
  ).size
  const borrowInCount = scopedDebts.filter((debt) => debt.direction === "borrow_in").length
  const lendOutCount = scopedDebts.filter((debt) => debt.direction === "lend_out").length
  const activeArchiveCount = debts.filter((debt) => !debt.archived).length
  const archivedCount = debts.filter((debt) => debt.archived).length

  async function refresh() {
    setIsRefreshing(true)
    try {
      onDebtsChange(await listDebts())
    } catch (error) {
      toast({
        body: `读取债务记录失败：${getApiErrorMessage(error)}`,
        type: "error",
      })
    } finally {
      setIsRefreshing(false)
    }
  }

  function upsertDebt(updated: Debt) {
    onDebtsChange(
      debts.some((debt) => debt.id === updated.id)
        ? debts.map((debt) => (debt.id === updated.id ? updated : debt))
        : [updated, ...debts]
    )
  }

  async function handleCreate(values: DebtFormValues) {
    const created = await createDebt(values)
    upsertDebt(created)
    setFormDialog(null)
    toast({ body: "已创建" })
  }

  async function handleUpdate(id: string, values: DebtFormValues) {
    const updated = await updateDebt({
      id,
      counterparty: values.counterparty,
      principalCents: values.principalCents,
      dueDate: values.dueDate,
      note: values.note,
      tags: values.tags,
    })
    upsertDebt(updated)
    setFormDialog(null)
    toast({ body: "已保存修改" })
  }

  async function handleToggleArchive(debt: Debt) {
    try {
      const updated = await setDebtArchived(debt.id, !debt.archived)
      upsertDebt(updated)
      toast({ body: updated.archived ? "已归档" : "已取消归档" })
    } catch (error) {
      toast({
        body: `${debt.archived ? "取消归档失败" : "归档失败"}：${getApiErrorMessage(error)}`,
        type: "error",
      })
    }
  }

  async function confirmDelete() {
    if (!deletingDebt) return

    setIsDeleting(true)
    try {
      const nextDebts = await deleteDebt(deletingDebt.id)
      onDebtsChange(nextDebts)
      if (detailDebtId === deletingDebt.id) setDetailDebtId(null)
      toast({ body: "已删除该债务" })
      setDeletingDebt(null)
    } catch (error) {
      toast({ body: `删除失败：${getApiErrorMessage(error)}`, type: "error" })
    } finally {
      setIsDeleting(false)
    }
  }

  async function handleAddRepayment(debtId: string, values: DebtRepaymentValues) {
    const updated = await addRepayment({ debtId, ...values })
    upsertDebt(updated)
    setRepaymentDebt(null)
    toast({ body: "已登记还款" })
  }

  async function handleDeleteRepayment(debtId: string, repaymentId: string) {
    try {
      const updated = await deleteRepayment(debtId, repaymentId)
      upsertDebt(updated)
      toast({ body: "已撤销还款" })
    } catch (error) {
      toast({
        body: `撤销还款失败：${getApiErrorMessage(error)}`,
        type: "error",
      })
    }
  }

  function openEditDialog(debt: Debt) {
    setFormDialog({ mode: "edit", debt })
  }

  return (
    <Stack minHeight={0} style={{ flex: "1 1 0%" }}>
      <div
        className="shard-content-inset"
        data-tauri-drag-region
        style={{
          paddingBottom: "var(--shard-space-4)",
          paddingTop: "var(--shard-top-inset)",
        }}
      >
        <HStack
          className="shard-content-measure"
          gap={3}
          hAlign="between"
          vAlign="center"
          wrap="wrap"
        >
          <HStack gap={3} vAlign="center" style={{ minWidth: 0 }}>
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
                background: "var(--card)",
                color: "var(--shard-sapphire)",
              }}
            >
              <HandCoinsIcon strokeWidth={1.75} style={{ width: 16, height: 16 }} />
            </span>
            <div style={{ minWidth: 0 }}>
              <Text as="h1" display="block" textWrap="balance" type="large" weight="bold">
                债务追踪
              </Text>
              <Text
                as="p"
                color="secondary"
                display="block"
                style={{ marginTop: 4 }}
                type="body"
              >
                {activeCount} 笔进行中 · {contactCount} 位联系人
              </Text>
            </div>
          </HStack>

          <HStack
            gap={2}
            hAlign="end"
            vAlign="center"
            style={{ minWidth: 0, flex: "1 1 0%" }}
          >
            <Button
              icon={
                <RefreshCwIcon
                  className={isRefreshing ? styles.spin : undefined}
                />
              }
              isDisabled={isRefreshing}
              isIconOnly
              label="刷新债务列表"
              onClick={() => void refresh()}
              size="sm"
              variant="ghost"
            />
            <Button
              icon={<PlusIcon />}
              label="新增债务"
              onClick={() => setFormDialog({ mode: "create" })}
              variant="primary"
            />
          </HStack>
        </HStack>
      </div>

      <div
        className="shard-content-inset"
        style={{ paddingBottom: "var(--shard-space-4)" }}
      >
        <HStack
          className="shard-content-measure"
          gap={3}
          vAlign="center"
          wrap="wrap"
        >
          <HStack
            gap={1}
            vAlign="center"
            style={{
              borderRadius: "var(--shard-radius-control)",
              background: "var(--muted)",
              padding: "var(--shard-space-1)",
            }}
          >
            <ViewTabButton
              active={view === "timeline"}
              label="按时间"
              onClick={() => setView("timeline")}
            />
            <ViewTabButton
              active={view === "contacts"}
              label="按联系人"
              onClick={() => setView("contacts")}
            />
          </HStack>

          {view === "timeline" ? (
            <>
              <HStack gap={2} wrap="wrap">
                <TagFilterButton
                  active={archiveFilter === "active"}
                  count={activeArchiveCount}
                  label="进行中"
                  onClick={() => setArchiveFilter("active")}
                />
                <TagFilterButton
                  active={archiveFilter === "archived"}
                  count={archivedCount}
                  label="已归档"
                  onClick={() => setArchiveFilter("archived")}
                />
              </HStack>
              <HStack gap={2} wrap="wrap">
                <TagFilterButton
                  active={directionFilter === "all"}
                  count={scopedDebts.length}
                  label="全部"
                  onClick={() => setDirectionFilter("all")}
                />
                <TagFilterButton
                  active={directionFilter === "borrow_in"}
                  count={borrowInCount}
                  label="借入"
                  onClick={() => setDirectionFilter("borrow_in")}
                />
                <TagFilterButton
                  active={directionFilter === "lend_out"}
                  count={lendOutCount}
                  label="借出"
                  onClick={() => setDirectionFilter("lend_out")}
                />
              </HStack>
            </>
          ) : null}
        </HStack>
      </div>

      <div
        className="shard-content-inset"
        style={{
          minHeight: 0,
          flex: "1 1 0%",
          overflowY: "auto",
          paddingBottom: "var(--shard-space-6)",
        }}
      >
        <div className="shard-content-measure">
          {view === "contacts" ? (
            <DebtContactSummaryPanel
              debts={debts}
              onDelete={setDeletingDebt}
              onEdit={openEditDialog}
              onOpenDetail={(debt) => setDetailDebtId(debt.id)}
              onRegisterRepayment={setRepaymentDebt}
              onToggleArchive={(debt) => void handleToggleArchive(debt)}
            />
          ) : sortedDebts.length === 0 ? (
            <Stack
              gap={2}
              hAlign="center"
              style={{
                height: 192,
                textAlign: "center",
                color: "var(--muted-foreground)",
              }}
              vAlign="center"
            >
              <HandCoinsIcon strokeWidth={1.5} style={{ width: 28, height: 28 }} />
              <Text as="div" display="block" type="body" weight="semibold">
                还没有记录任何债务
              </Text>
              <Text as="p" color="secondary" display="block" type="body">
                点击右上角"新增债务"开始记录第一笔。
              </Text>
              <Button
                icon={<PlusIcon />}
                label="新增债务"
                onClick={() => setFormDialog({ mode: "create" })}
                variant="primary"
              />
            </Stack>
          ) : (
            <Stack gap={3}>
              {sortedDebts.map((debt) => (
                <DebtCard
                  debt={debt}
                  key={debt.id}
                  onDelete={setDeletingDebt}
                  onEdit={openEditDialog}
                  onOpenDetail={(target) => setDetailDebtId(target.id)}
                  onRegisterRepayment={setRepaymentDebt}
                  onToggleArchive={(target) => void handleToggleArchive(target)}
                />
              ))}
            </Stack>
          )}
        </div>
      </div>

      <DebtFormDialog
        debt={formDialog?.mode === "edit" ? formDialog.debt : null}
        knownCounterparties={knownCounterparties}
        mode={formDialog?.mode ?? "create"}
        onOpenChange={(next) => {
          if (!next) setFormDialog(null)
        }}
        onSubmit={(values) =>
          formDialog?.mode === "edit"
            ? handleUpdate(formDialog.debt.id, values)
            : handleCreate(values)
        }
        open={formDialog !== null}
      />

      <DebtRepaymentDialog
        debt={repaymentDebt}
        onClose={() => setRepaymentDebt(null)}
        onSubmit={(values) => handleAddRepayment(repaymentDebt?.id ?? "", values)}
      />

      <DebtDetailSheet
        debt={detailDebt}
        onClose={() => setDetailDebtId(null)}
        onDelete={setDeletingDebt}
        onDeleteRepayment={(debtId, repaymentId) =>
          void handleDeleteRepayment(debtId, repaymentId)
        }
        onEdit={(target) => {
          setDetailDebtId(null)
          openEditDialog(target)
        }}
        onRegisterRepayment={setRepaymentDebt}
        onToggleArchive={(target) => void handleToggleArchive(target)}
      />

      <DebtDeleteConfirmDialog
        debt={deletingDebt}
        isDeleting={isDeleting}
        onCancel={() => setDeletingDebt(null)}
        onConfirm={() => void confirmDelete()}
      />
    </Stack>
  )
}

function ViewTabButton({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      aria-pressed={active}
      className={`${styles.viewTab} ${
        active ? styles.viewTabActive : styles.viewTabInactive
      }`}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  )
}

function DebtDeleteConfirmDialog({
  debt,
  isDeleting,
  onCancel,
  onConfirm,
}: {
  debt: Debt | null
  isDeleting: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const repaymentCount = debt?.repayments.length ?? 0

  return (
    <AlertDialog
      actionLabel={isDeleting ? "删除中" : "确定删除"}
      actionVariant="destructive"
      cancelLabel="取消"
      description={
        repaymentCount > 0
          ? `该债务有 ${repaymentCount} 笔还款记录，删除后将一并清除且无法恢复。`
          : "删除后无法恢复。"
      }
      isActionLoading={isDeleting}
      isOpen={debt !== null}
      onAction={onConfirm}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isDeleting) onCancel()
      }}
      title="确定删除这笔债务？"
      width={420}
    />
  )
}
