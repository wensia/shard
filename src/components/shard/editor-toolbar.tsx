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
    <div
      style={{
        display: "flex",
        minWidth: 0,
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--shard-space-3)",
      }}
    >
      <input
        accept="image/*"
        onChange={handleFileChange}
        ref={fileInputRef}
        style={{ display: "none" }}
        type="file"
      />

      <div
        style={{
          display: "flex",
          minWidth: 0,
          alignItems: "center",
          flexWrap: "wrap",
          gap: "var(--shard-space-1)",
        }}
      >
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
              icon={<ShardZenIcon height={18} width={18} />}
              label="禅模式"
              onClick={onOpenZen}
            />
          </>
        ) : null}
      </div>

      {trailing ? (
        <div
          style={{
            display: "flex",
            flexShrink: 0,
            alignItems: "center",
            gap: "var(--shard-space-2)",
          }}
        >
          {trailing}
        </div>
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
      aria-label={label}
      className="shard-edge-action"
      disabled={disabled}
      onMouseDown={(event) => {
        event.preventDefault()
        onClick()
      }}
      size="icon-sm"
      style={{ borderRadius: "var(--shard-radius-control)", color: "var(--muted-foreground)" }}
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
      aria-orientation="vertical"
      role="separator"
      style={{
        flexShrink: 0,
        height: 20,
        width: 1,
        marginInline: "var(--shard-space-1)",
        background: "var(--border)",
      }}
    />
  )
}
