import type { ReactNode } from "react"

import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout"

import { cn } from "@/lib/utils"

/**
 * astryx 稳定版没有 Sheet/Drawer 组件（仅内部 lab 包有，未发布 npm）。仓库里只有
 * debt-detail-sheet.tsx 一处用到侧滑面板，且只需要从右侧滑入 —— 用 astryx 的
 * Dialog（原生 <dialog> 元素，自带焦点陷阱/Escape/backdrop 行为）打底，只重写
 * 定位与进出场动效，不做四方向通用抽象。样式在 frontend-rules.css 的
 * .shard-sheet-panel 里，用 ::backdrop 覆盖居中定位、改成从右侧滑入。
 */

interface SheetProps {
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => unknown
  children: ReactNode
  width?: number | string
}

export function Sheet({ isOpen, onOpenChange, children, width = 400 }: SheetProps) {
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      purpose="info"
      width={width}
      className="shard-sheet-panel"
    >
      {children}
    </Dialog>
  )
}

interface SheetHeaderProps {
  title: string
  subtitle?: string
  onOpenChange: (isOpen: boolean) => unknown
  endContent?: ReactNode
}

export function SheetHeader(props: SheetHeaderProps) {
  return <DialogHeader hasDivider {...props} />
}

export function SheetContent({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <LayoutContent className={cn(className)}>{children}</LayoutContent>
}

export function SheetFooter({ children }: { children: ReactNode }) {
  return <LayoutFooter hasDivider>{children}</LayoutFooter>
}
