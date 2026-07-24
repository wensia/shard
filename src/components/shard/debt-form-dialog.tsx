import { useEffect, useId, useState, type FormEvent } from "react"
import { ArrowDownLeftIcon, ArrowUpRightIcon } from "lucide-react"

import { Button } from "@astryxdesign/core/Button"
import type { ISODateString } from "@astryxdesign/core/Calendar"
import { DateInput } from "@astryxdesign/core/DateInput"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { Grid } from "@astryxdesign/core/Grid"
import { HStack } from "@astryxdesign/core/HStack"
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout"
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl"
import { Stack } from "@astryxdesign/core/Stack"
import { TextArea } from "@astryxdesign/core/TextArea"
import { TextInput } from "@astryxdesign/core/TextInput"

import { TagBadge } from "@/components/shard/tag-badge"
import { getApiErrorMessage } from "@/lib/api"
import { yuanInputToCents } from "@/lib/debt"
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
              id={formId}
              onSubmit={handleSubmit}
              style={{ display: "flex", flexDirection: "column", gap: "var(--shard-space-4)" }}
            >
              <Stack gap={2}>
                <span
                  style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--muted-foreground)" }}
                >
                  方向
                </span>
                <SegmentedControl
                  isDisabled={mode === "edit"}
                  label="方向"
                  layout="fill"
                  onChange={(value) => setDirection(value as DebtDirection)}
                  value={direction}
                >
                  <SegmentedControlItem
                    icon={<ArrowDownLeftIcon size={16} strokeWidth={1.75} />}
                    label="借入（我欠别人）"
                    value="borrow_in"
                  />
                  <SegmentedControlItem
                    icon={<ArrowUpRightIcon size={16} strokeWidth={1.75} />}
                    label="借出（别人欠我）"
                    value="lend_out"
                  />
                </SegmentedControl>
              </Stack>

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

              <Grid columns={2} gap={3}>
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
              </Grid>

              <TextArea
                label="备注"
                onChange={setNote}
                placeholder="可选"
                value={note}
              />

              <Stack gap={2}>
                <span
                  style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--muted-foreground)" }}
                >
                  标签
                </span>
                {tags.length > 0 ? (
                  <HStack gap={2} wrap="wrap">
                    {tags.map((tag) => (
                      <TagBadge key={tag} removable onRemove={removeTag} tag={tag} />
                    ))}
                  </HStack>
                ) : null}
                <HStack gap={2} wrap="wrap">
                  {QUICK_TAGS.map((tag) => (
                    <button
                      className={
                        tags.includes(tag) ? "shard-tag shard-tag-active" : "shard-tag"
                      }
                      key={tag}
                      onClick={() => (tags.includes(tag) ? removeTag(tag) : addTag(tag))}
                      style={{ gap: "var(--shard-space-micro)", fontWeight: 500 }}
                      type="button"
                    >
                      <span className="shard-chip-text">{tag}</span>
                    </button>
                  ))}
                </HStack>
                <HStack gap={2}>
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
                </HStack>
              </Stack>

              {error ? (
                <p style={{ margin: 0, fontSize: "0.875rem", color: "var(--destructive)" }}>
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
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}
