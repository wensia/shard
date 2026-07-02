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

import { Button } from "@/components/ui/button"
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
          icon={<ImageIcon data-icon="inline-start" />}
          label="上传图片"
          onClick={() => fileInputRef.current?.click()}
        />
        <ToolbarDivider />
        <ToolbarButton
          disabled={disabled}
          icon={<HashIcon data-icon="inline-start" />}
          label="插入标签"
          onClick={onInsertTag}
        />
        <ToolbarButton
          disabled={disabled}
          icon={<ListIcon data-icon="inline-start" />}
          label="无序列表"
          onClick={() => onLineFormat("unordered")}
        />
        <ToolbarButton
          disabled={disabled}
          icon={<ListOrderedIcon data-icon="inline-start" />}
          label="有序列表"
          onClick={() => onLineFormat("ordered")}
        />
        <ToolbarButton
          disabled={disabled}
          icon={<ListTodoIcon data-icon="inline-start" />}
          label="复选框"
          onClick={() => onLineFormat("task")}
        />
        <ToolbarButton
          disabled={disabled}
          icon={<SeparatorHorizontalIcon data-icon="inline-start" />}
          label="分割线"
          onClick={onInsertHorizontalRule}
        />
        <ToolbarDivider />
        <ToolbarButton
          disabled={disabled}
          icon={<BoldIcon data-icon="inline-start" />}
          label="粗体"
          onClick={() => onInlineFormat("bold")}
        />
        <ToolbarButton
          disabled={disabled}
          icon={<UnderlineIcon data-icon="inline-start" />}
          label="下划线"
          onClick={() => onInlineFormat("underline")}
        />
        <ToolbarButton
          disabled={disabled}
          icon={<HighlighterIcon data-icon="inline-start" />}
          label="荧光笔"
          onClick={() => onInlineFormat("highlight")}
        />
        {onOpenZen ? (
          <>
            <ToolbarDivider />
            <ToolbarButton
              disabled={disabled}
              icon={
                <ShardZenIcon
                  className="size-[18px]"
                  data-icon="inline-start"
                />
              }
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
      disabled={disabled}
      onMouseDown={(event) => {
        event.preventDefault()
        onClick()
      }}
      size="icon-sm"
      title={label}
      type="button"
      variant="ghost"
    >
      {icon}
      <span className="sr-only">{label}</span>
    </Button>
  )
}

function ToolbarDivider() {
  return (
    <span
      aria-hidden="true"
      className="mx-[var(--shard-space-1)] h-5 w-px bg-border/[var(--shard-alpha-55)]"
    />
  )
}
