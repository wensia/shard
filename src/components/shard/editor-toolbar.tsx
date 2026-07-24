import { useRef, type ChangeEvent, type ReactNode } from "react"
import {
  BoldIcon,
  HashIcon,
  HighlighterIcon,
  ImageIcon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  SeparatorHorizontalIcon,
  UnderlineIcon,
} from "lucide-react"

import { Button } from "@astryxdesign/core/Button"
import { Divider } from "@astryxdesign/core/Divider"
import { ShardZenIcon } from "@/components/shard/shard-zen-icon"
import type { InlineFormat, LineFormat } from "@/lib/editor-format"

interface EditorToolbarProps {
  disabled?: boolean
  onImageUpload: (file: File) => void | Promise<void>
  onInlineFormat: (format: InlineFormat) => void
  onInsertHorizontalRule: () => void
  onInsertTag: () => void
  onLineFormat: (format: LineFormat) => void
  onOpenZen?: () => void
  trailing?: ReactNode
}

export function EditorToolbar({
  disabled = false,
  onImageUpload,
  onInlineFormat,
  onInsertHorizontalRule,
  onInsertTag,
  onLineFormat,
  onOpenZen,
  trailing,
}: EditorToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ""
    if (!file) return

    await onImageUpload(file)
  }

  return (
    <div className="flex min-w-0 items-center justify-between gap-[var(--shard-space-3)]">
      <input
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
        ref={fileInputRef}
        type="file"
      />

      <div className="flex min-w-0 flex-wrap items-center gap-[var(--shard-space-1)]">
        <ToolbarButton
          disabled={disabled}
          icon={<ImageIcon />}
          label="上传图片"
          onClick={() => fileInputRef.current?.click()}
        />
        <ToolbarDivider />
        <ToolbarButton
          disabled={disabled}
          icon={<HashIcon />}
          label="插入标签"
          onClick={onInsertTag}
        />
        <ToolbarButton
          disabled={disabled}
          icon={<ListIcon />}
          label="无序列表"
          onClick={() => onLineFormat("unordered")}
        />
        <ToolbarButton
          disabled={disabled}
          icon={<ListOrderedIcon />}
          label="有序列表"
          onClick={() => onLineFormat("ordered")}
        />
        <ToolbarButton
          disabled={disabled}
          icon={<ListTodoIcon />}
          label="复选框"
          onClick={() => onLineFormat("task")}
        />
        <ToolbarButton
          disabled={disabled}
          icon={<SeparatorHorizontalIcon />}
          label="分割线"
          onClick={onInsertHorizontalRule}
        />
        <ToolbarDivider />
        <ToolbarButton
          disabled={disabled}
          icon={<BoldIcon />}
          label="粗体"
          onClick={() => onInlineFormat("bold")}
        />
        <ToolbarButton
          disabled={disabled}
          icon={<UnderlineIcon />}
          label="下划线"
          onClick={() => onInlineFormat("underline")}
        />
        <ToolbarButton
          disabled={disabled}
          icon={<HighlighterIcon />}
          label="荧光笔"
          onClick={() => onInlineFormat("highlight")}
        />
        {onOpenZen ? (
          <>
            <ToolbarDivider />
            <ToolbarButton
              disabled={disabled}
              icon={<ShardZenIcon className="size-[18px]" />}
              label="禅模式"
              onClick={onOpenZen}
            />
          </>
        ) : null}
      </div>

      {trailing ? (
        <div className="flex shrink-0 items-center">{trailing}</div>
      ) : null}
    </div>
  )
}

interface ToolbarButtonProps {
  disabled: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}

function ToolbarButton({ disabled, icon, label, onClick }: ToolbarButtonProps) {
  return (
    <Button
      className="shard-edge-action rounded-[var(--shard-radius-control)] text-muted-foreground"
      icon={icon}
      isDisabled={disabled}
      isIconOnly
      label={label}
      onMouseDown={(event) => {
        event.preventDefault()
        onClick()
      }}
      size="sm"
      tooltip={label}
      type="button"
      variant="ghost"
    />
  )
}

function ToolbarDivider() {
  return <Divider className="mx-[var(--shard-space-1)]" orientation="vertical" />
}
