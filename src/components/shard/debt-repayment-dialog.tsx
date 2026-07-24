import { useEffect, useId, useState, type FormEvent } from "react"

import { Button } from "@astryxdesign/core/Button"
import type { ISODateString } from "@astryxdesign/core/Calendar"
import { DateInput } from "@astryxdesign/core/DateInput"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { HStack } from "@astryxdesign/core/HStack"
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout"
import { TextArea } from "@astryxdesign/core/TextArea"
import { TextInput } from "@astryxdesign/core/TextInput"

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
  const formId = useId()
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

  function handleDialogOpenChange(nextOpen: boolean) {
    if (!isSubmitting && !nextOpen) onClose()
  }

  return (
    <Dialog
      isOpen={debt !== null}
      onOpenChange={handleDialogOpenChange}
      width="min(420px, calc(100vw - 32px))"
    >
      <Layout
        header={
          <DialogHeader
            hasDivider
            onOpenChange={handleDialogOpenChange}
            subtitle={
              debt
                ? `${debt.counterparty} · 剩余 ${centsToYuanLabel(debt.remainingCents)}`
                : undefined
            }
            title="登记还款"
          />
        }
        content={
          <LayoutContent>
            <form
              id={formId}
              onSubmit={handleSubmit}
              style={{ display: "flex", flexDirection: "column", gap: "var(--shard-space-4)" }}
            >
              <TextInput
                label="还款金额（元）"
                onChange={setAmountYuan}
                placeholder="0.00"
                value={amountYuan}
              />
              <DateInput
                label="还款日期"
                onChange={(value) => setPaidOn(value ?? "")}
                value={paidOn ? (paidOn as ISODateString) : undefined}
              />
              <TextArea
                label="备注"
                onChange={setNote}
                placeholder="可选"
                value={note}
              />

              {error ? (
                <p style={{ color: "var(--destructive)", fontSize: 14, margin: 0 }}>
                  {error}
                </p>
              ) : null}
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} hAlign="end">
              <Button
                isDisabled={isSubmitting}
                label="取消"
                onClick={onClose}
                type="button"
                variant="secondary"
              />
              <Button
                form={formId}
                isLoading={isSubmitting}
                label="登记还款"
                type="submit"
                variant="primary"
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}
