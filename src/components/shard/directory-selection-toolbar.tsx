import { FolderIcon, Trash2Icon } from "@/components/icons"
import { useLayoutEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

import styles from "./directory-selection-toolbar.module.css"

export function DirectorySelectionToolbar({
  busy, count, total, destinations, progress, error, visible, onSizeChange, onSelectAll, onDeselectAll, onMove, onDelete, onDone,
}: {
  visible: boolean
  onSizeChange(size: { width: number; height: number }): void
  busy: boolean
  count: number
  total: number
  destinations: string[]
  progress: string | null
  error: string | null
  onSelectAll(): void
  onDeselectAll(): void
  onMove(destination: string): void
  onDelete(): void
  onDone(): void
}) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const measure = () => {
      const { width, height } = element.getBoundingClientRect()
      onSizeChange({ width, height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [onSizeChange])

  return (
    <div ref={root} aria-label="文件批量操作" aria-busy={busy || undefined} aria-hidden={!visible} inert={!visible} role="toolbar" data-visible={visible} className={styles.root}>
      <div className={styles.toolbar}>
        <span aria-live="polite" className={styles.count}>{progress ?? `已选 ${count} 项`}</span>
        <Button disabled={busy || total === 0} onClick={count === total ? onDeselectAll : onSelectAll} size="sm" variant="outline">
          {count === total && total > 0 ? "取消全选" : "全选"}
        </Button>
        <div className={styles.actions}>
          <DropdownMenu>
            <DropdownMenuTrigger disabled={busy || count === 0 || destinations.length === 0} render={<Button size="sm" variant="outline" />}>
              <FolderIcon aria-hidden="true" />移动到…
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {destinations.map(path => (
                <DropdownMenuItem key={path} onClick={() => onMove(path)}>
                  {path === "notes" ? "资料库根目录" : path.replace(/^notes\//u, "")}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button aria-label="批量删除" disabled={busy || count === 0} onClick={onDelete} size="sm" variant="destructive">
            <Trash2Icon aria-hidden="true" />删除
          </Button>
          <Button disabled={busy} onClick={onDone} size="sm" variant="primary">完成</Button>
        </div>
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </div>
  )
}
