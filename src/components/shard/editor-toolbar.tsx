import type { ReactNode } from "react"
import { ShardZenIcon } from "@/components/icons"

import { ToolbarIconButton } from "@/components/ui/toolbar-icon-button"

interface EditorToolbarProps {
  disabled?: boolean
  onOpenZen?: () => void
  trailing?: ReactNode
}

/**
 * 编辑面底部的操作条。插入与块级转换（图片、标签、列表、分割线、表格、
 * 标题、引用、代码块）全部走 `/` 命令菜单，行内格式在选中文字后由
 * 编辑器里的选区浮动条提供；这里只留编辑面自身的动作与宿主的尾部操作。
 */
export function EditorToolbar({ disabled = false, onOpenZen, trailing }: EditorToolbarProps) {
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
      <div
        style={{
          display: "flex",
          minWidth: 0,
          alignItems: "center",
          gap: "var(--shard-space-1)",
        }}
      >
        {onOpenZen ? (
          <ToolbarIconButton
            className="shard-edge-action"
            disabled={disabled}
            label="禅模式"
            onMouseDown={(event) => {
              event.preventDefault()
              onOpenZen()
            }}
            style={{
              borderRadius: "var(--shard-radius-control)",
              color: "var(--muted-foreground)",
            }}
            type="button"
            variant="ghost"
          >
            <ShardZenIcon />
          </ToolbarIconButton>
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
