import { parseReminderAt } from "@shard/markdown/core"
import { useRef, useState, type ReactElement, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Dialog, DialogClose, DialogTrigger } from "@/components/ui/dialog"
import { PickerDialogContent } from "@/components/ui/picker-dialog"
import { TimeColumns } from "@/components/ui/time-columns"
import { reminderQuickOptions, splitReminderAt } from "@/lib/reminders"

export interface ReminderDialogProps {
  /** 当前提醒 `YYYY-MM-DD HH:mm`，没有时为 null。 */
  value: string | null
  /** 选中新时间或清除（null）。对话框随后自行关闭。 */
  onChange: (at: string | null) => void
  /** 触发器元素（按钮或芯片），经 base-ui 的 `render` 挂上开合行为。 */
  trigger: ReactElement<Record<string, unknown>>
  /** 触发器内容。 */
  children?: ReactNode
  disabled?: boolean
  /** 打开前的焦点元素已卸载时（触发器在铃铛与芯片之间切换）的退路，通常是编辑器本身。 */
  fallbackFocus?: () => HTMLElement | null
}

/** 草稿：`picked` 表示已有提醒或用户点过日期，只有这时摘要才显示日期部分。 */
type Draft = { date: string; hour: string | null; minute: string | null; picked: boolean }

function initialDraft(value: string | null): Draft {
  const { date, time } = splitReminderAt(value)
  const [hour, minute] = time ? time.split(":") : [null, null]
  // 空值不预选今天（kiln：标出今天不等于替用户选了今天）；日历仍翻到本月，今天格写「今」。
  return { date, hour, minute, picked: date !== "" }
}

/**
 * 备忘卡片的提醒对话框：快捷项直接写入；自定义时在同一层里点日期、点小时和分钟，再点「确定」。
 * 日历与时间列直接内嵌，不再叠第二层浮层。
 *
 * 弹层与遮罩带 `kiln-control-positioner`（见 PickerDialogContent）：卡片行内编辑按
 * 「失焦即提交」收尾，焦点落进对话框不算离开编辑器（见 fragment-editor 的失焦判定）。
 */
export function ReminderDialog({ value, onChange, trigger, children, disabled, fallbackFocus }: ReminderDialogProps) {
  const [open, setOpen] = useState(false)
  // 打开前焦点所在：指针优先下触发器不抢焦点，这通常就是编辑器；键盘打开时是触发器。
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [draft, setDraft] = useState<Draft>(() => initialDraft(value))
  const [quickOptions, setQuickOptions] = useState(() => reminderQuickOptions())
  const time = draft.hour && draft.minute ? `${draft.hour}:${draft.minute}` : ""
  const custom = draft.date && time ? `${draft.date} ${time}` : ""
  const customValid = custom !== "" && parseReminderAt(custom) !== null
  // 一项都没选时显示占位；选了一部分时显示已选部分，缺的部分用 `----` / `--` 占位。
  const touched = draft.picked || draft.hour !== null || draft.minute !== null
  const summary = touched ? `${draft.date || "----"} ${draft.hour ?? "--"}:${draft.minute ?? "--"}` : ""

  function changeOpen(next: boolean) {
    if (next) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setDraft(initialDraft(value))
      setQuickOptions(reminderQuickOptions())
    }
    setOpen(next)
  }

  function choose(at: string | null) {
    onChange(at)
    setOpen(false)
  }

  return (
    <Dialog open={open && !disabled} onOpenChange={changeOpen}>
      <DialogTrigger disabled={disabled} render={trigger}>
        {children}
      </DialogTrigger>
      <PickerDialogContent
        className="shard-reminder-dialog sm:max-w-lg"
        footer={
          <>
            <Button
              className="shard-reminder-dialog-clear"
              disabled={!value}
              onClick={() => choose(null)}
              size="sm"
              type="button"
              variant="outline"
            >
              清除提醒
            </Button>
            <DialogClose render={<Button size="sm" type="button" variant="outline" />}>取消</DialogClose>
            <Button disabled={!customValid} onClick={() => choose(custom)} size="sm" type="button">
              确定
            </Button>
          </>
        }
        // 设置或清除提醒会让触发器在铃铛与芯片之间切换，原触发器已卸载；焦点回到打开前的
        // 元素，它也不在了就交给 fallbackFocus，免得落到 body 上触发行内卡片的失焦提交。
        finalFocus={() => {
          const previous = returnFocusRef.current
          if (previous?.isConnected) return previous
          return fallbackFocus?.() ?? true
        }}
        initialFocus='.kiln-calendar-day[tabindex="0"]'
        onRequestClose={() => setOpen(false)}
        placeholder="选择日期和时间"
        slot="reminder-dialog"
        summary={summary}
        summaryLabel="提醒时间"
        title="设置提醒"
      >
        <div className="shard-reminder-dialog-quick">
          {quickOptions.map((option) => (
            <Button
              key={option.label}
              aria-pressed={option.at === value}
              onClick={() => choose(option.at)}
              size="sm"
              title={option.at}
              type="button"
              variant="outline"
            >
              {option.label}
            </Button>
          ))}
        </div>
        <div className="shard-reminder-dialog-body">
          <Calendar onValueChange={(date) => setDraft((current) => ({ ...current, date, picked: true }))} value={draft.date} />
          <div className="shard-reminder-dialog-time">
            <div className="shard-reminder-dialog-time-inner">
              <span className="shard-reminder-dialog-time-heading">时间</span>
              <TimeColumns
                className="shard-reminder-dialog-time-columns"
                hour={draft.hour}
                minute={draft.minute}
                onHourChange={(hour) => setDraft((current) => ({ ...current, hour }))}
                onMinuteChange={(minute) => setDraft((current) => ({ ...current, minute }))}
              />
            </div>
          </div>
        </div>
      </PickerDialogContent>
    </Dialog>
  )
}
