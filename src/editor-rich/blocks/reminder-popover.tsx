import { Popover } from "@base-ui/react/popover"
import { parseReminderAt } from "@shard/markdown/core"
import { useState, type ReactElement, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { DatePicker } from "@/components/ui/date-picker"
import { TimePicker } from "@/components/ui/time-picker"
import { reminderQuickOptions, splitReminderAt } from "@/lib/reminders"

export interface ReminderPopoverProps {
  /** 当前提醒 `YYYY-MM-DD HH:mm`，没有时为 null。 */
  value: string | null
  /** 选中新时间或清除（null）。弹层随后自行关闭。 */
  onChange: (at: string | null) => void
  /** 触发器元素（按钮或芯片），经 base-ui 的 `render` 挂上开合行为。 */
  trigger: ReactElement<Record<string, unknown>>
  /** 触发器内容。 */
  children?: ReactNode
  disabled?: boolean
}

/**
 * 备忘卡片的提醒弹层：快捷项、自定义日期 + 时间、清除。
 *
 * 定位层带 `kiln-control-positioner`：卡片行内编辑按「失焦即提交」收尾，
 * 焦点落进这类共享控件浮层时不算离开编辑器（见 fragment-editor 的失焦判定）；
 * 内层的 DatePicker / TimePicker 浮层用的是同一个类名。
 */
export function ReminderPopover({ value, onChange, trigger, children, disabled }: ReminderPopoverProps) {
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState("")
  const [time, setTime] = useState("")
  const [quickOptions, setQuickOptions] = useState(() => reminderQuickOptions())
  const custom = date && time ? `${date} ${time}` : ""
  const customValid = custom !== "" && parseReminderAt(custom) !== null

  function changeOpen(next: boolean) {
    if (next) {
      const initial = splitReminderAt(value)
      setDate(initial.date)
      setTime(initial.time)
      setQuickOptions(reminderQuickOptions())
    }
    setOpen(next)
  }

  function choose(at: string | null) {
    onChange(at)
    setOpen(false)
  }

  return (
    <Popover.Root open={open && !disabled} onOpenChange={changeOpen}>
      <Popover.Trigger disabled={disabled} render={trigger}>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          align="start"
          className="kiln-control-positioner click-outside-ignore"
          collisionPadding={8}
          onKeyDown={(event) => event.stopPropagation()}
          sideOffset={4}
        >
          <Popover.Popup aria-label="设置提醒" className="shard-reminder-popup" data-slot="reminder-popover">
            <Popover.Title className="shard-reminder-popup-title">提醒</Popover.Title>
            <div className="shard-reminder-popup-quick">
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
            <div className="shard-reminder-popup-custom">
              <DatePicker aria-label="提醒日期" onValueChange={setDate} value={date} />
              <TimePicker aria-label="提醒时间" onValueChange={setTime} value={time} />
            </div>
            <div className="shard-reminder-popup-footer">
              <Button
                disabled={!value}
                onClick={() => choose(null)}
                size="sm"
                type="button"
                variant="outline"
              >
                清除提醒
              </Button>
              <Button
                disabled={!customValid}
                onClick={() => choose(custom)}
                size="sm"
                type="button"
              >
                设置
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
