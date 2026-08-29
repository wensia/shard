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

import { ShardZenIcon } from "@/components/shard/shard-zen-icon"
import { TableSizePicker } from "@/components/shard/table-size-picker"
import { ToolbarIconButton } from "@/components/ui/toolbar-icon-button"
import type { InlineFormat, LineFormat } from "@/lib/editor-format"

interface EditorToolbarProps {
  disabled?: boolean
  onImageUpload: (file: File) => void | Promise<void>
  onInlineFormat: (format: InlineFormat) => void
  onImportTable?: () => void
  onInsertHorizontalRule: () => void
  onInsertTable: (columns: number, rows: number) => void
  onInsertTag: () => void
  onLineFormat: (format: LineFormat) => void
  onOpenZen?: () => void
  trailing?: ReactNode
}

export function EditorToolbar({
  disabled = false,
  onImageUpload,
  onImportTable,
  onInlineFormat,
  onInsertHorizontalRule,
  onInsertTable,
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
        <EditorToolbarButton
          disabled={disabled}
          icon={<ImageIcon />}
          label="上传图片"
          onClick={() => fileInputRef.current?.click()}
        />
        <ToolbarDivider />
        <EditorToolbarButton
          disabled={disabled}
          icon={<HashIcon />}
          label="插入标签"
          onClick={onInsertTag}
        />
        <EditorToolbarButton
          disabled={disabled}
          icon={<ListIcon />}
          label="无序列表"
          onClick={() => onLineFormat("unordered")}
        />
        <EditorToolbarButton
          disabled={disabled}
          icon={<ListOrderedIcon />}
          label="有序列表"
          onClick={() => onLineFormat("ordered")}
        />
        <EditorToolbarButton
          disabled={disabled}
          icon={<ListTodoIcon />}
          label="复选框"
          onClick={() => onLineFormat("task")}
        />
        <EditorToolbarButton
          disabled={disabled}
          icon={<SeparatorHorizontalIcon />}
          label="分割线"
          onClick={onInsertHorizontalRule}
        />
        <TableSizePicker
          disabled={disabled}
          onImport={onImportTable}
          onSelect={onInsertTable}
        />
        <ToolbarDivider />
        <EditorToolbarButton
          disabled={disabled}
          icon={<BoldIcon />}
          label="粗体"
          onClick={() => onInlineFormat("bold")}
        />
        <EditorToolbarButton
          disabled={disabled}
          icon={<UnderlineIcon />}
          label="下划线"
          onClick={() => onInlineFormat("underline")}
        />
        <EditorToolbarButton
          disabled={disabled}
          icon={<HighlighterIcon />}
          label="荧光笔"
          onClick={() => onInlineFormat("highlight")}
        />
        {onOpenZen ? (
          <>
            <ToolbarDivider />
            <EditorToolbarButton
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

interface EditorToolbarButtonProps {
  disabled: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}

function EditorToolbarButton({
  disabled,
  icon,
  label,
  onClick,
}: EditorToolbarButtonProps) {
  return (
    <ToolbarIconButton
      className="shard-edge-action"
      disabled={disabled}
      label={label}
      onMouseDown={(event) => {
        event.preventDefault()
        onClick()
      }}
      style={{
        borderRadius: "var(--shard-radius-control)",
        color: "var(--muted-foreground)",
      }}
      type="button"
      variant="ghost"
    >
      {icon}
    </ToolbarIconButton>
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
