import { useMemo, useState } from "react"
import { HandCoinsIcon, PlusIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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

interface DebtWorkspaceProps {
  debts: Debt[]
  onDebtsChange: (debts: Debt[]) => void
}

type ArchiveFilter = "active" | "archived"
type DirectionFilter = "all" | DebtDirection
type DebtView = "timeline" | "contacts"

type FormDialogState = { mode: "create" } | { mode: "edit"; debt: Debt }

export function DebtWorkspace({ debts, onDebtsChange }: DebtWorkspaceProps) {
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
      toast.error("读取债务记录失败", { description: getApiErrorMessage(error) })
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
    toast.success("已创建")
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
    toast.success("已保存修改")
  }

  async function handleToggleArchive(debt: Debt) {
    try {
      const updated = await setDebtArchived(debt.id, !debt.archived)
      upsertDebt(updated)
      toast.success(updated.archived ? "已归档" : "已取消归档")
    } catch (error) {
      toast.error(debt.archived ? "取消归档失败" : "归档失败", {
        description: getApiErrorMessage(error),
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
      toast.success("已删除该债务")
      setDeletingDebt(null)
    } catch (error) {
      toast.error("删除失败", { description: getApiErrorMessage(error) })
    } finally {
      setIsDeleting(false)
    }
  }

  async function handleAddRepayment(debtId: string, values: DebtRepaymentValues) {
    const updated = await addRepayment({ debtId, ...values })
    upsertDebt(updated)
    setRepaymentDebt(null)
    toast.success("已登记还款")
  }

  async function handleDeleteRepayment(debtId: string, repaymentId: string) {
    try {
      const updated = await deleteRepayment(debtId, repaymentId)
      upsertDebt(updated)
      toast.success("已撤销还款")
    } catch (error) {
      toast.error("撤销还款失败", { description: getApiErrorMessage(error) })
    }
  }

  function openEditDialog(debt: Debt) {
    setFormDialog({ mode: "edit", debt })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shard-content-inset pb-[var(--shard-space-4)]">
        <div className="shard-content-measure flex flex-wrap items-center justify-between gap-[var(--shard-space-3)]">
          <div className="flex min-w-0 items-center gap-[var(--shard-space-3)]">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--shard-radius-control)] border border-border bg-card text-[color:var(--shard-sapphire)]">
              <HandCoinsIcon className="size-4 stroke-[1.75]" />
            </span>
            <div className="min-w-0">
              <h1 className="text-lg leading-6 font-bold text-balance">债务追踪</h1>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                {activeCount} 笔进行中 · {contactCount} 位联系人
              </p>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 items-center justify-end gap-[var(--shard-space-2)]">
            <Button
              aria-label="刷新债务列表"
              disabled={isRefreshing}
              onClick={() => void refresh()}
              size="icon"
              type="button"
              variant="ghost"
            >
              <RefreshCwIcon className={isRefreshing ? "animate-spin" : ""} />
            </Button>
            <Button onClick={() => setFormDialog({ mode: "create" })} type="button">
              <PlusIcon data-icon="inline-start" />
              新增债务
            </Button>
          </div>
        </div>
      </div>

      <div className="shard-content-inset pb-[var(--shard-space-4)]">
        <div className="shard-content-measure flex flex-wrap items-center gap-[var(--shard-space-3)]">
          <div className="flex items-center gap-[var(--shard-space-1)] rounded-[var(--shard-radius-control)] bg-muted p-[var(--shard-space-1)]">
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
          </div>

          {view === "timeline" ? (
            <>
              <div className="flex flex-wrap gap-[var(--shard-space-2)]">
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
              </div>
              <div className="flex flex-wrap gap-[var(--shard-space-2)]">
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
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div className="shard-content-inset min-h-0 flex-1 overflow-y-auto pb-[var(--shard-space-6)]">
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
            <div className="flex h-48 flex-col items-center justify-center gap-[var(--shard-space-2)] text-center text-muted-foreground">
              <HandCoinsIcon className="size-7 stroke-[1.5]" />
              <div className="text-sm font-semibold text-foreground">
                还没有记录任何债务
              </div>
              <p className="text-sm">点击右上角"新增债务"开始记录第一笔。</p>
              <Button
                onClick={() => setFormDialog({ mode: "create" })}
                type="button"
              >
                <PlusIcon data-icon="inline-start" />
                新增债务
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-[var(--shard-space-3)]">
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
            </div>
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
    </div>
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
      className={[
        "h-8 rounded-[var(--shard-radius-control)] px-[var(--shard-space-3)] text-[13px] font-semibold transition-colors",
        active
          ? "bg-card text-foreground shadow-card"
          : "text-muted-foreground hover:text-foreground",
      ].join(" ")}
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
    <Dialog
      open={debt !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isDeleting) onCancel()
      }}
    >
      <DialogContent
        className="w-[min(420px,calc(100vw-32px))]"
        showCloseButton={!isDeleting}
      >
        <DialogHeader>
          <DialogTitle>确定删除这笔债务？</DialogTitle>
          <DialogDescription>
            {repaymentCount > 0
              ? `该债务有 ${repaymentCount} 笔还款记录，删除后将一并清除且无法恢复。`
              : "删除后无法恢复。"}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-row justify-end gap-[var(--shard-space-2)]">
          <Button disabled={isDeleting} onClick={onCancel} type="button" variant="outline">
            取消
          </Button>
          <Button disabled={isDeleting} onClick={onConfirm} type="button" variant="destructive">
            {isDeleting ? "删除中" : "确定删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
