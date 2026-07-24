import { useEffect, useState, type FormEvent } from "react"
import { Loader2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { getApiErrorMessage } from "@/lib/api"
import { centsToYuanLabel, todayISODate, yuanInputToCents } from "@/lib/debt"
import type { Debt } from "@/types"

export interface DebtRepaymentValues {
  amountCents: number
  paidOn: string
  note: string
}

interface DebtRepaymentDialogProps {
  debt: Debt | null
  onClose: () => void
  onSubmit: (values: DebtRepaymentValues) => Promise<void>
}

export function DebtRepaymentDialog({
  debt,
  onClose,
  onSubmit,
}: DebtRepaymentDialogProps) {
  const [amountYuan, setAmountYuan] = useState("")
  const [paidOn, setPaidOn] = useState(() => todayISODate())
  const [note, setNote] = useState("")
  const [error, setError] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (!debt) return
    setAmountYuan("")
    setPaidOn(todayISODate())
    setNote("")
    setError("")
    setIsSubmitting(false)
  }, [debt])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")

    const amountCents = yuanInputToCents(amountYuan)
    if (amountCents === null) {
      setError("请填写正确的还款金额")
      return
    }
    if (!paidOn) {
      setError("请选择还款日期")
      return
    }

    setIsSubmitting(true)
    try {
      await onSubmit({ amountCents, paidOn, note })
    } catch (submitError) {
      setError(getApiErrorMessage(submitError))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog
      open={debt !== null}
      onOpenChange={(nextOpen) => {
        if (!isSubmitting && !nextOpen) onClose()
      }}
    >
      <DialogContent className="w-[min(420px,calc(100vw-32px))]">
        <DialogHeader>
          <DialogTitle>登记还款</DialogTitle>
          <DialogDescription>
            {debt
              ? `${debt.counterparty} · 剩余 ${centsToYuanLabel(debt.remainingCents)}`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-[var(--shard-space-4)]" onSubmit={handleSubmit}>
          <label className="flex flex-col gap-[var(--shard-space-2)] text-xs font-semibold text-muted-foreground">
            还款金额（元）
            <Input
              inputMode="decimal"
              onChange={(event) => setAmountYuan(event.target.value)}
              placeholder="0.00"
              value={amountYuan}
            />
          </label>
          <label className="flex flex-col gap-[var(--shard-space-2)] text-xs font-semibold text-muted-foreground">
            还款日期
            <Input
              onChange={(event) => setPaidOn(event.target.value)}
              type="date"
              value={paidOn}
            />
          </label>
          <label className="flex flex-col gap-[var(--shard-space-2)] text-xs font-semibold text-muted-foreground">
            备注
            <Textarea
              onChange={(event) => setNote(event.target.value)}
              placeholder="可选"
              value={note}
            />
          </label>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter className="flex-row justify-end gap-[var(--shard-space-2)]">
            <Button disabled={isSubmitting} onClick={onClose} type="button" variant="outline">
              取消
            </Button>
            <Button disabled={isSubmitting} type="submit">
              {isSubmitting ? (
                <Loader2Icon className="animate-spin" data-icon="inline-start" />
              ) : null}
              登记还款
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
