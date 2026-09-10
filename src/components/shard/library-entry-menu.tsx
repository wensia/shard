import { Menu } from "@base-ui/react/menu"
import { cloneElement, createContext, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode, useContext, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"

import { ArchiveRestoreIcon, FileTextIcon, FolderIcon, LockKeyholeIcon, MoreHorizontalIcon, PencilLineIcon, Trash2Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { LibraryTreeEntry } from "@/types"

import styles from "./directory-view.module.css"

interface MenuControl {
  open?: boolean
  onOpenChange?: (open: boolean) => void
}
type MenuAction = (action: () => void) => void
const EntryMenuContext = createContext<{ handle: Menu.Handle<unknown>; triggerId: string } | null>(null)

function useMenuAction() {
  const pending = useRef<(() => void) | null>(null)
  return {
    run: (action: () => void) => { pending.current = action },
    onOpenChangeComplete(open: boolean) {
      if (open) return
      const action = pending.current
      pending.current = null
      action?.()
    },
  }
}

export interface LibraryEntryMenuProps extends MenuControl {
  busy: boolean
  className?: string
  destinations: string[]
  entry: LibraryTreeEntry
  onConvertToFragment: (entry: LibraryTreeEntry) => void
  onCopyDocumentLink?: (entry: LibraryTreeEntry) => void
  onDelete: (entry: LibraryTreeEntry) => void
  onImportTable?: (entry: LibraryTreeEntry) => void
  onMove: (entry: LibraryTreeEntry, destinationDirectory: string) => void
  onMoveToLockbox: (entry: LibraryTreeEntry) => void
  onOpenEntry?: (entry: LibraryTreeEntry) => void
  onRename: (entry: LibraryTreeEntry) => void
  onPrepare?: () => void
  batch?: {
    count: number
    onDelete(): void
    onMove(destination: string): void
  }
}

interface TrashEntryMenuProps {
  busy: boolean
  entry: LibraryTreeEntry
  onPurge: (entry: LibraryTreeEntry) => void
  onRestore: (entry: LibraryTreeEntry) => void
}

function isEditing(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, [contenteditable="true"], [role="textbox"]'))
}

/** Context and overflow menus share the exact same item tree and operation scope. */
function LibraryEntryMenuItems({ entry, destinations, batch, run, ...actions }: LibraryEntryMenuProps & { run: MenuAction }) {
  return <>
    <div className={styles.menuHeading} title={entry.name}>{batch ? `已选 ${batch.count} 项` : entry.name}</div>
    {batch ? null : <>
      {actions.onOpenEntry ? <DropdownMenuItem onClick={() => run(() => actions.onOpenEntry?.(entry))}>
        {entry.kind === "directory" ? <FolderIcon /> : <FileTextIcon />}打开
      </DropdownMenuItem> : null}
      {actions.onImportTable && /\.(?:csv|xlsx)$/iu.test(entry.name) ? (
        <DropdownMenuItem onClick={() => run(() => actions.onImportTable?.(entry))}>导入为多维表格</DropdownMenuItem>
      ) : null}
      {actions.onCopyDocumentLink && (entry.kind === "mindmap" || entry.kind === "flowchart") ? (
        <DropdownMenuItem onClick={() => actions.onCopyDocumentLink?.(entry)}>复制文档链接</DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onClick={() => run(() => actions.onRename(entry))}><PencilLineIcon />重命名</DropdownMenuItem>
    </>}
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={destinations.length === 0}>
        <FolderIcon />{batch ? `移动 ${batch.count} 项到…` : "移动到…"}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {destinations.map(directory => <DropdownMenuItem key={directory} onClick={() => batch ? batch.onMove(directory) : actions.onMove(entry, directory)}>
          {directory === "notes" ? "资料库根目录" : directory.replace(/^notes\//u, "")}
        </DropdownMenuItem>)}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
    {!batch && entry.kind === "markdown" ? <>
      <DropdownMenuItem onClick={() => run(() => actions.onConvertToFragment(entry))}>转回碎片</DropdownMenuItem>
      <DropdownMenuItem onClick={() => actions.onMoveToLockbox(entry)}><LockKeyholeIcon />移入密匣</DropdownMenuItem>
    </> : null}
    <DropdownMenuSeparator />
    <DropdownMenuItem onClick={() => run(() => batch ? batch.onDelete() : actions.onDelete(entry))} variant="destructive">
      <Trash2Icon />{batch ? `删除 ${batch.count} 项` : "删除"}
    </DropdownMenuItem>
  </>
}

export function LibraryEntryMenu(props: LibraryEntryMenuProps) {
  const action = useMenuAction()
  const context = useContext(EntryMenuContext)
  if (context) return <DropdownMenuTrigger handle={context.handle} id={context.triggerId} disabled={props.busy} render={
    <Button aria-label={`${props.entry.name} 操作`} className={props.className} size="icon-sm" type="button" variant="ghost" />
  }><MoreHorizontalIcon aria-hidden="true" /></DropdownMenuTrigger>
  return <DropdownMenu modal={false} open={props.open} onOpenChange={open => { props.onOpenChange?.(open); if (open) props.onPrepare?.() }} onOpenChangeComplete={action.onOpenChangeComplete}>
    <DropdownMenuTrigger disabled={props.busy} render={
      <Button aria-label={`${props.entry.name} 操作`} className={props.className} size="icon-sm" type="button" variant="ghost" />
    }><MoreHorizontalIcon aria-hidden="true" /></DropdownMenuTrigger>
    <DropdownMenuContent align="end"><LibraryEntryMenuItems {...props} run={action.run} /></DropdownMenuContent>
  </DropdownMenu>
}

export function FileContextMenu({ busy, children, content, hasEntryTrigger = false, onPrepare, open, onOpenChange }: MenuControl & {
  busy: boolean
  children: ReactElement
  content: (run: MenuAction) => ReactNode
  hasEntryTrigger?: boolean
  onPrepare?: () => void
}) {
  const action = useMenuAction()
  const [handle] = useState(() => Menu.createHandle<unknown>())
  const triggerId = useId()
  const [localOpen, setLocalOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ getBoundingClientRect: () => DOMRect } | null>(null)
  const focusTarget = useRef<HTMLElement | null>(null)
  const restoreFocus = useRef(false)
  const isOpen = open ?? localOpen
  const trigger = children as ReactElement<HTMLAttributes<HTMLElement>>
  function setOpen(next: boolean) {
    if (open === undefined) setLocalOpen(next)
    onOpenChange?.(next)
    if (next) onPrepare?.()
  }
  function openAt(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, x: number, y: number) {
    event.preventDefault()
    event.stopPropagation()
    focusTarget.current = event.target instanceof HTMLElement && event.target.closest("button, [tabindex]") || event.currentTarget
    restoreFocus.current = false
    setAnchor({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) })
    handle.open(triggerId)
  }
  const triggerProps = {
    "data-library-context-menu": "",
    "data-popup-open": isOpen ? "" : undefined,
    tabIndex: trigger.props.tabIndex ?? -1,
    onContextMenu(event: MouseEvent<HTMLElement>) {
      trigger.props.onContextMenu?.(event)
      if (event.defaultPrevented || busy) return
      if (isEditing(event.target)) { event.stopPropagation(); return }
      openAt(event, event.clientX, event.clientY)
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      trigger.props.onKeyDown?.(event)
      if (event.defaultPrevented || busy || isEditing(event.target)) return
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return
      const bounds = (event.target as HTMLElement).getBoundingClientRect()
      openAt(event, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
    },
  }
  // Register the real overflow button for menu/submenu navigation. Keeping all
  // popup focus guards in body also preserves the table and grid list structure.
  // The background uses event guards so aria-disabled cannot disable its inputs.
  return <EntryMenuContext.Provider value={hasEntryTrigger ? { handle, triggerId } : null}>
    {hasEntryTrigger ? cloneElement(trigger, triggerProps) : <DropdownMenuTrigger
      handle={handle}
      id={triggerId}
      nativeButton={false}
      onClick={event => event.preventBaseUIHandler()}
      onMouseDown={event => event.preventBaseUIHandler()}
      onKeyDown={event => event.preventBaseUIHandler()}
      render={cloneElement(trigger, { ...triggerProps, role: trigger.props.role ?? "presentation" })}
    />}
    {createPortal(<DropdownMenu handle={handle} disabled={hasEntryTrigger && busy} modal={false} open={isOpen} onOpenChange={(next, details) => {
      restoreFocus.current = !next && details.reason === "escape-key"
      if (next && details.reason === "trigger-press") {
        setAnchor(null)
        focusTarget.current = details.trigger instanceof HTMLElement ? details.trigger : null
      }
      setOpen(next)
    }} onOpenChangeComplete={action.onOpenChangeComplete}>
      <DropdownMenuContent
        anchor={anchor ?? undefined}
        align={anchor ? "start" : "end"}
        aria-label="文件操作"
        aria-labelledby={undefined}
        data-slot={anchor ? "context-menu-content" : "dropdown-menu-content"}
        finalFocus={() => restoreFocus.current && focusTarget.current?.isConnected ? focusTarget.current : false}
        onKeyDown={event => event.stopPropagation()}
        positionMethod="fixed"
      >{content(action.run)}</DropdownMenuContent>
    </DropdownMenu>, document.body)}
  </EntryMenuContext.Provider>
}

export function LibraryEntryContextMenu({ children, ...props }: LibraryEntryMenuProps & { children: ReactElement }) {
  return <FileContextMenu busy={props.busy} hasEntryTrigger open={props.open} onOpenChange={props.onOpenChange} onPrepare={props.onPrepare} content={run => <LibraryEntryMenuItems {...props} run={run} />}>
    {children}
  </FileContextMenu>
}

function TrashEntryMenuItems({ entry, onPurge, onRestore, run }: TrashEntryMenuProps & { run: MenuAction }) {
  return <>
    <div className={styles.menuHeading} title={entry.name}>{entry.name}</div>
    <DropdownMenuItem onClick={() => onRestore(entry)}><ArchiveRestoreIcon aria-hidden="true" />恢复</DropdownMenuItem>
    <DropdownMenuItem onClick={() => run(() => onPurge(entry))} variant="destructive"><Trash2Icon aria-hidden="true" />彻底删除</DropdownMenuItem>
  </>
}

export function TrashEntryMenu(props: TrashEntryMenuProps) {
  const action = useMenuAction()
  const context = useContext(EntryMenuContext)
  if (context) return <DropdownMenuTrigger handle={context.handle} id={context.triggerId} disabled={props.busy} render={
    <Button aria-label={`${props.entry.name} 操作`} size="icon-sm" type="button" variant="ghost" />
  }><MoreHorizontalIcon aria-hidden="true" /></DropdownMenuTrigger>
  return <DropdownMenu modal={false} onOpenChangeComplete={action.onOpenChangeComplete}>
    <DropdownMenuTrigger disabled={props.busy} render={
      <Button aria-label={`${props.entry.name} 操作`} size="icon-sm" type="button" variant="ghost" />
    }><MoreHorizontalIcon aria-hidden="true" /></DropdownMenuTrigger>
    <DropdownMenuContent align="end"><TrashEntryMenuItems {...props} run={action.run} /></DropdownMenuContent>
  </DropdownMenu>
}

export function TrashEntryContextMenu({ children, ...props }: TrashEntryMenuProps & { children: ReactElement }) {
  return <FileContextMenu busy={props.busy} hasEntryTrigger content={run => <TrashEntryMenuItems {...props} run={run} />}>{children}</FileContextMenu>
}
