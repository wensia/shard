import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { useRef, useState, type CSSProperties } from "react"

import { BellIcon, ChevronDownIcon, ChevronRightIcon, ClockIcon, ListTodoIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  MEMO_CARD_DETAIL_PLACEHOLDER,
  MEMO_CARD_TITLE_PLACEHOLDER,
} from "@/lib/slash-commands"
import { formatReminderLabel } from "@/lib/reminders"
import { useReminderDue } from "@/lib/use-reminder-due"

import { ReminderDialog } from "../blocks/reminder-dialog"
import { setTaskReminder, taskReminderOf } from "../commands"
import { convertMemoToTask } from "../memo-conversion"
import { useNodeViewEditable } from "./node-view-utils"
import { taskItemHasDetail } from "./task-item-utils"

/** NodeView 里不属于正文的装饰（复选框、提醒钮、折叠钮），事件不交给 ProseMirror。 */
export const TASK_ITEM_CONTROL_ATTRIBUTE = "data-shard-task-control"

/**
 * 占位文案经自定义属性下发给 CSS。
 *
 * 空标题段与空细节段的 `is-empty` 由 Placeholder 扩展打上，但那个回调只拿得到
 * 旧的 `editor.state`，在同一拍里解析新文档的位置会越界；占位文字因此不走
 * `data-placeholder`，改由卡片这一层按位置用 `::before` 取。
 */
const MEMO_PLACEHOLDER_STYLE = {
  "--shard-memo-title-placeholder": JSON.stringify(MEMO_CARD_TITLE_PLACEHOLDER),
  "--shard-memo-detail-placeholder": JSON.stringify(MEMO_CARD_DETAIL_PLACEHOLDER),
} as CSSProperties

/**
 * 任务项的 NodeView。内容区始终是可编辑的 `NodeViewContent`，不是隔离岛——
 * 标题与细节都要能直接打字、走输入法，只有复选框与折叠钮是不可编辑的装饰。
 *
 * 没有细节时渲染成普通任务行（复选框 + 一行文本），与迁移前一致；有细节时
 * 加卡片外框，并给细节区一个只存在于本次会话的折叠开关（不写文件）。
 */
export function TaskItemNodeView({
  editor,
  extension,
  getPos,
  node,
  updateAttributes,
}: ReactNodeViewProps) {
  const editable = useNodeViewEditable(editor)
  const [collapsed, setCollapsed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const convertAfterClose = useRef(false)
  const restoreMenuFocus = useRef(true)
  const checked = node.attrs.checked === true
  const memo = taskItemHasDetail(node)
  // 标题行尾的提醒已提升为属性：芯片画在右侧控件位，备忘卡片上替换铃铛。
  const pinned = typeof node.attrs.reminder === "string" && node.attrs.reminder ? node.attrs.reminder : null
  const reminder = pinned ?? (memo ? taskReminderOf(node, 0) : null)
  const due = useReminderDue(pinned)
  const checkboxLabel: string =
    extension.options.a11y?.checkboxLabel?.(node, checked) ??
    (checked ? "标记为未完成" : "标记为完成")

  return (
    <NodeViewWrapper
      className={memo ? "shard-rich-task shard-rich-memo" : "shard-rich-task"}
      data-collapsed={memo && collapsed ? "true" : undefined}
      data-shard-memo-card={memo ? "true" : undefined}
      style={memo ? MEMO_PLACEHOLDER_STYLE : undefined}
    >
      <span
        className="shard-rich-task-check"
        contentEditable={false}
        {...{ [TASK_ITEM_CONTROL_ATTRIBUTE]: "checkbox" }}
      >
        <Checkbox
          aria-label={checkboxLabel}
          checked={checked}
          disabled={!editable}
          onCheckedChange={(next) => updateAttributes({ checked: next === true })}
          // 指针优先：按下复选框不该把光标从正文里抢走。
          onMouseDown={(event) => event.preventDefault()}
        />
      </span>
      <NodeViewContent className="shard-rich-task-body" />
      {pinned || memo ? (
        <span
          className="shard-rich-task-reminder-slot"
          contentEditable={false}
          {...{ [TASK_ITEM_CONTROL_ATTRIBUTE]: "reminder" }}
        >
          {pinned && !editable ? (
            <span
              className="shard-rich-reminder"
              data-due={due && !checked ? "true" : undefined}
              title={`提醒：${pinned}`}
            >
              <ClockIcon />
              <span>{formatReminderLabel(pinned)}</span>
            </span>
          ) : (
            <ReminderDialog
              disabled={!editable}
              fallbackFocus={() => editor.view.dom}
              onChange={(at) => {
                const pos = getPos()
                if (typeof pos === "number") setTaskReminder(editor, pos, at)
              }}
              trigger={
                pinned ? (
                  <button
                    aria-label={`修改提醒（${pinned}）`}
                    className="shard-rich-reminder"
                    data-due={due && !checked ? "true" : undefined}
                    data-shard-reminder={pinned}
                    // 指针优先：按下不把光标从正文里抢走，对话框打开后再接管焦点。
                    onMouseDown={(event) => event.preventDefault()}
                    title={`提醒：${pinned}`}
                    type="button"
                  />
                ) : (
                  <Button
                    aria-label={reminder ? `修改提醒（${reminder}）` : "设置提醒"}
                    className="shard-rich-memo-reminder"
                    data-active={reminder ? "true" : undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    size="icon-sm"
                    title={reminder ? `提醒：${reminder}` : "设置提醒"}
                    variant="ghost"
                  />
                )
              }
              value={reminder}
            >
              {pinned ? (
                <>
                  <ClockIcon />
                  <span>{formatReminderLabel(pinned)}</span>
                </>
              ) : (
                <BellIcon />
              )}
            </ReminderDialog>
          )}
        </span>
      ) : null}
      {memo ? (
        <span contentEditable={false} {...{ [TASK_ITEM_CONTROL_ATTRIBUTE]: "menu" }}>
          <DropdownMenu
            modal={false}
            open={menuOpen}
            onOpenChange={(open, details) => {
              restoreMenuFocus.current = open || (details.reason !== "outside-press" && details.reason !== "focus-out")
              setMenuOpen(open)
            }}
            onOpenChangeComplete={(open) => {
              if (open || !convertAfterClose.current) return
              convertAfterClose.current = false
              const pos = getPos()
              if (typeof pos === "number") convertMemoToTask(editor, pos)
            }}
          >
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label="备忘卡片操作"
                  className="shard-rich-memo-toggle"
                  onMouseDown={(event) => event.preventDefault()}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <ChevronDownIcon aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              aria-label="备忘卡片操作"
              className="kiln-control-positioner"
              finalFocus={() => restoreMenuFocus.current && !editor.isDestroyed ? editor.view.dom : false}
            >
              <DropdownMenuItem onClick={() => setCollapsed(current => !current)}>
                {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
                {collapsed ? "展开备忘细节" : "收起备忘细节"}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!editable} onClick={() => { convertAfterClose.current = true }}>
                <ListTodoIcon />
                转为复选框
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      ) : null}
    </NodeViewWrapper>
  )
}
