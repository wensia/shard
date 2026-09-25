import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { parseReminderAt } from "@shard/markdown/core"
import { useEffect, useState } from "react"

import { ClockIcon } from "@/components/icons"
import { formatReminderLabel } from "@/lib/reminders"

import { ReminderPopover } from "../blocks/reminder-popover"
import { removeReminder } from "../commands"
import { useNodeViewEditable } from "./node-view-utils"

/** setTimeout 的上限（约 24.8 天）；更远的提醒不挂定时器，重开页面时再判定。 */
const MAX_TIMER_DELAY = 2_147_483_647

/** 到点前挂一个定时器，到点后芯片自己切到警示态，不依赖外部重渲染。 */
function useDue(at: string) {
  const dueAt = parseReminderAt(at)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (dueAt === null) return
    const delay = dueAt - Date.now()
    if (delay <= 0 || delay > MAX_TIMER_DELAY) return
    const timer = window.setTimeout(() => setNow(Date.now()), delay + 50)
    return () => window.clearTimeout(timer)
  }, [dueAt])
  return dueAt !== null && dueAt <= now
}

/**
 * 提醒芯片：`⏰ YYYY-MM-DD HH:mm` 在编辑区的样子，显示成「时钟 10月1日 09:00」。
 *
 * 已到点时挂 `data-due`；只有它所在任务项未勾选时 CSS 才上警示色
 * （勾选态由外层 `li[data-checked]` 决定，与 Dock 角标「已到点且未勾选」口径一致）。
 * 可编辑时点开弹层改时间或清除；只读时只是一枚带完整时间 `title` 的标记。
 */
export function ReminderNodeView({ editor, getPos, node, updateAttributes }: ReactNodeViewProps) {
  const editable = useNodeViewEditable(editor)
  const at = String(node.attrs.at ?? "")
  const due = useDue(at)
  const label = formatReminderLabel(at)
  const title = `提醒：${at}`

  const chip = (
    <>
      <ClockIcon />
      <span>{label}</span>
    </>
  )

  return (
    <NodeViewWrapper as="span" className="shard-rich-reminder-wrapper" contentEditable={false}>
      {editable ? (
        <ReminderPopover
          onChange={(next) => {
            if (next) {
              updateAttributes({ at: next })
              return
            }
            const pos = getPos()
            if (typeof pos !== "number") return
            removeReminder(editor, pos)
            // 芯片（弹层的触发器）已被删掉，焦点交回正文，免得落到 body 上触发失焦提交。
            editor.commands.focus()
          }}
          trigger={
            <button
              aria-label={`${title}，点击修改`}
              className="shard-rich-reminder"
              data-due={due ? "true" : undefined}
              data-shard-reminder={at}
              // 指针优先：按下芯片不把光标从正文里抢走，弹层打开后再接管焦点。
              onMouseDown={(event) => event.preventDefault()}
              title={title}
              type="button"
            />
          }
          value={at}
        >
          {chip}
        </ReminderPopover>
      ) : (
        <span
          className="shard-rich-reminder"
          data-due={due ? "true" : undefined}
          data-shard-reminder={at}
          title={title}
        >
          {chip}
        </span>
      )}
    </NodeViewWrapper>
  )
}
