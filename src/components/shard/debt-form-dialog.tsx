import { useEffect, useId, useState, type FormEvent } from "react"
import { ArrowDownLeftIcon, ArrowUpRightIcon } from "lucide-react"

import { Button } from "@astryxdesign/core/Button"
import type { ISODateString } from "@astryxdesign/core/Calendar"
import { DateInput } from "@astryxdesign/core/DateInput"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout"
import { TextArea } from "@astryxdesign/core/TextArea"
import { TextInput } from "@astryxdesign/core/TextInput"

import { TagBadge } from "@/components/shard/tag-badge"
import { getApiErrorMessage } from "@/lib/api"
import { yuanInputToCents } from "@/lib/debt"
import { cn } from "@/lib/utils"
import type { Debt, DebtDirection } from "@/types"

export interface DebtFormValues {
  direction: DebtDirection
  counterparty: string
  principalCents: number
  dueDate: string | null
  note: string
  tags: string[]
}

const QUICK_TAGS = ["亲戚", "朋友", "信用卡", "其他"]

interface DebtFormDialogProps {
  debt?: Debt | null
  knownCounterparties: string[]
  mode: "create" | "edit"
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (values: DebtFormValues) => Promise<void>
}

export function DebtFormDialog({
  debt = null,
  knownCounterparties,
  mode,
  open,
  onOpenChange,
  onSubmit,
}: DebtFormDialogProps) {
  const formId = useId()
  const counterpartyListId = useId()
  const [direction, setDirection] = useState<DebtDirection>("borrow_in")
  const [counterparty, setCounterparty] = useState("")
  const [principalYuan, setPrincipalYuan] = useState("")
  const [dueDate, setDueDate] = useState("")
  const [note, setNote] = useState("")
  const [tags, setTags] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState("")
  const [error, setError] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return

    setError("")
    setIsSubmitting(false)
    setTagDraft("")

    if (mode === "edit" && debt) {
      setDirection(debt.direction)
      setCounterparty(debt.counterparty)
      setPrincipalYuan(String(debt.principalCents / 100))
      setDueDate(debt.dueDate ?? "")
      setNote(debt.note)
      setTags(debt.tags)
    } else {
      setDirection("borrow_in")
      setCounterparty("")
      setPrincipalYuan("")
      setDueDate("")
      setNote("")
      setTags([])
    }
  }, [open, mode, debt])

  function addTag(rawTag: string) {
    const tag = rawTag.trim()
    if (!tag) return
    setTags((current) => (current.includes(tag) ? current : [...current, tag]))
    setTagDraft("")
  }

  function removeTag(tag: string) {
    setTags((current) => current.filter((item) => item !== tag))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")

    const trimmedCounterparty = counterparty.trim()
    if (!trimmedCounterparty) {
      setError("请填写对方姓名")
      return
    }

    const principalCents = yuanInputToCents(principalYuan)
    if (principalCents === null) {
      setError("请填写正确的本金金额")
      return
    }

    setIsSubmitting(true)
    try {
      await onSubmit({
        direction,
        counterparty: trimmedCounterparty,
        principalCents,
        dueDate: dueDate || null,
        note,
        tags,
      })
    } catch (submitError) {
      setError(getApiErrorMessage(submitError))
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleDialogOpenChange(nextOpen: boolean) {
    if (!isSubmitting) onOpenChange(nextOpen)
  }

  return (
    <Dialog
      isOpen={open}
      onOpenChange={handleDialogOpenChange}
      width="min(480px, calc(100vw - 32px))"
    >
      <Layout
        header={
          <DialogHeader
            hasDivider
            onOpenChange={handleDialogOpenChange}
            subtitle={
              mode === "create"
                ? "记录一笔借入或借出的债务，支持分次还款与到期提醒。"
                : "方向创建后不可修改，录错方向请删除后重新登记。"
            }
            title={mode === "create" ? "新增债务" : "编辑债务"}
          />
        }
        content={
          <LayoutContent>
            <form
              className="flex flex-col gap-[var(--shard-space-4)]"
              id={formId}
              onSubmit={handleSubmit}
            >
              <div className="flex flex-col gap-[var(--shard-space-2)]">
                <span className="text-xs font-semibold text-muted-foreground">方向</span>
                <div className="grid grid-cols-2 gap-[var(--shard-space-2)]">
                  <button
                    className={directionButtonClass(direction === "borrow_in", mode === "edit")}
                    disabled={mode === "edit"}
                    onClick={() => setDirection("borrow_in")}
                    type="button"
                  >
                    <ArrowDownLeftIcon className="size-4 shrink-0 stroke-[1.75]" />
                    借入（我欠别人）
                  </button>
                  <button
                    className={directionButtonClass(direction === "lend_out", mode === "edit")}
                    disabled={mode === "edit"}
                    onClick={() => setDirection("lend_out")}
                    type="button"
                  >
                    <ArrowUpRightIcon className="size-4 shrink-0 stroke-[1.75]" />
                    借出（别人欠我）
                  </button>
                </div>
              </div>

              <TextInput
                hasClear
                label="对方"
                onChange={setCounterparty}
                placeholder="姓名或称呼"
                value={counterparty}
                {...({ list: counterpartyListId } as Record<"list", string>)}
              />
              <datalist id={counterpartyListId}>
                {knownCounterparties.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>

              <div className="grid grid-cols-2 gap-[var(--shard-space-3)]">
                <TextInput
                  label="本金（元）"
                  onChange={setPrincipalYuan}
                  placeholder="0.00"
                  value={principalYuan}
                />
                <DateInput
                  hasClear
                  label="到期日"
                  onChange={(value) => setDueDate(value ?? "")}
                  value={dueDate ? (dueDate as ISODateString) : undefined}
                />
              </div>

              <TextArea
                label="备注"
                onChange={setNote}
                placeholder="可选"
                value={note}
              />

              <div className="flex flex-col gap-[var(--shard-space-2)]">
                <span className="text-xs font-semibold text-muted-foreground">标签</span>
                {tags.length > 0 ? (
                  <div className="flex flex-wrap gap-[var(--shard-space-2)]">
                    {tags.map((tag) => (
                      <TagBadge key={tag} removable onRemove={removeTag} tag={tag} />
                    ))}
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-[var(--shard-space-2)]">
                  {QUICK_TAGS.map((tag) => (
                    <button
                      className={[
                        "shard-tag gap-[var(--shard-space-micro)] font-medium",
                        tags.includes(tag) ? "shard-tag-active" : "",
                      ].join(" ")}
                      key={tag}
                      onClick={() => (tags.includes(tag) ? removeTag(tag) : addTag(tag))}
                      type="button"
                    >
                      <span className="shard-chip-text">{tag}</span>
                    </button>
                  ))}
                </div>
                <div className="flex gap-[var(--shard-space-2)]">
                  <TextInput
                    isLabelHidden
                    label="自定义标签"
                    onChange={setTagDraft}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        addTag(tagDraft)
                      }
                    }}
                    placeholder="自定义标签，回车添加"
                    value={tagDraft}
                  />
                  <Button
                    isDisabled={!tagDraft.trim()}
                    label="添加"
                    onClick={() => addTag(tagDraft)}
                    type="button"
                    variant="secondary"
                  />
                </div>
              </div>

              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter className="flex justify-end gap-[var(--shard-space-2)]" hasDivider>
            <Button
              isDisabled={isSubmitting}
              label="取消"
              onClick={() => onOpenChange(false)}
              type="button"
              variant="secondary"
            />
            <Button
              form={formId}
              isLoading={isSubmitting}
              label={mode === "create" ? "新增债务" : "保存修改"}
              type="submit"
              variant="primary"
            />
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}

function directionButtonClass(active: boolean, disabled: boolean) {
  return cn(
    "flex h-10 items-center justify-center gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] border px-[var(--shard-space-3)] text-sm font-medium transition-colors",
    active
      ? "border-ring bg-sidebar-accent text-sidebar-accent-foreground"
      : "border-border bg-background text-muted-foreground hover:text-foreground",
    disabled ? "cursor-not-allowed opacity-[var(--shard-alpha-55)]" : ""
  )
}
