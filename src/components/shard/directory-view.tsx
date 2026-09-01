import {
  ArchiveRestoreIcon,
  ChevronRightIcon,
  Grid2X2Icon,
  ListIcon,
  MoreHorizontalIcon,
  Trash2Icon,
} from "@/components/icons"
import type { ReactNode } from "react"

import {
  LibraryItemGrid,
  type LibraryGridItem,
} from "@/components/shard/asset-grid"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { formatBytes, formatModifiedAt } from "@/lib/file-metadata"
import type { LibraryTreeEntry } from "@/types"

import styles from "./directory-view.module.css"

export type DirectoryViewMode = "grid" | "list"

export const DIRECTORY_VIEW_STORAGE_KEY = "shard.library-directory-view"

interface DirectoryViewProps {
  busy: boolean
  destinations: string[]
  entries: Array<LibraryTreeEntry & { content?: string }>
  emptyMessage?: string
  isEntryOpenable?: (entry: LibraryTreeEntry) => boolean
  onConvertToFragment: (entry: LibraryTreeEntry) => void
  onDelete: (entry: LibraryTreeEntry) => void
  onMove: (entry: LibraryTreeEntry, destinationDirectory: string) => void
  onMoveToLockbox: (entry: LibraryTreeEntry) => void
  onOpenEntry: (entry: LibraryTreeEntry) => void
  onRename: (entry: LibraryTreeEntry) => void
  onRenameCancel: () => void
  onRenameChange: (value: string) => void
  onRenameSubmit: () => void
  path: string
  renaming: { path: string; value: string } | null
  renderEntryActions?: (entry: LibraryTreeEntry) => ReactNode
  viewMode: DirectoryViewMode
}

interface LibraryEntryMenuProps {
  busy: boolean
  className?: string
  destinations: string[]
  entry: LibraryTreeEntry
  onConvertToFragment: (entry: LibraryTreeEntry) => void
  onDelete: (entry: LibraryTreeEntry) => void
  onMove: (entry: LibraryTreeEntry, destinationDirectory: string) => void
  onMoveToLockbox: (entry: LibraryTreeEntry) => void
  onRename: (entry: LibraryTreeEntry) => void
}

interface TrashEntryMenuProps {
  busy: boolean
  entry: LibraryTreeEntry
  onPurge: (entry: LibraryTreeEntry) => void
  onRestore: (entry: LibraryTreeEntry) => void
}

interface DirectoryViewToolbarProps {
  action?: ReactNode
  onSelectDirectory: (path: string) => void
  onViewModeChange: (mode: DirectoryViewMode) => void
  path: string
  rootLabel?: string
  viewMode: DirectoryViewMode
}

export function readDirectoryViewPreference(): DirectoryViewMode {
  try {
    const stored = window.localStorage.getItem(DIRECTORY_VIEW_STORAGE_KEY)
    return stored === "grid" || stored === "list" ? stored : "list"
  } catch {
    return "list"
  }
}

export function writeDirectoryViewPreference(mode: DirectoryViewMode) {
  try {
    window.localStorage.setItem(DIRECTORY_VIEW_STORAGE_KEY, mode)
  } catch {
    // localStorage 可被隐私策略禁用；视图仍在当前会话内正常切换。
  }
}

function entryTypeLabel(kind: LibraryTreeEntry["kind"]) {
  if (kind === "directory") return "目录"
  if (kind === "csv") return "CSV"
  if (kind === "mindmap") return "思维导图"
  if (kind === "image") return "图片"
  if (kind === "file") return "文件"
  return "Markdown"
}

function gridItem(
  entry: LibraryTreeEntry & { content?: string }
): LibraryGridItem {
  return {
    content: entry.kind === "markdown" ? entry.content : undefined,
    kind: entry.kind,
    mindMapId: entry.mindMapId,
    modifiedAt: entry.modifiedAt,
    name: entry.name,
    path: entry.path,
    secondary:
      entry.kind === "directory"
        ? `${entry.children?.length ?? 0} 项`
        : [entryTypeLabel(entry.kind), formatBytes(entry.size)].join(" · "),
    size: entry.size,
  }
}

function breadcrumbParts(path: string, rootLabel?: string) {
  const parts = path.split("/").filter(Boolean)
  return parts.map((part, index) => ({
    label:
      index === 0
        ? rootLabel ?? (part === "notes" ? "资料库" : part)
        : part,
    path: parts.slice(0, index + 1).join("/"),
  }))
}

export function libraryEntryDestinations(
  entry: LibraryTreeEntry,
  directories: string[]
) {
  return directories.filter(
    (path) =>
      path !== entry.path &&
      !path.startsWith(`${entry.path}/`) &&
      path !== entry.path.slice(0, entry.path.lastIndexOf("/"))
  )
}

export function LibraryEntryMenu({
  busy,
  className,
  destinations,
  entry,
  onConvertToFragment,
  onDelete,
  onMove,
  onMoveToLockbox,
  onRename,
}: LibraryEntryMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={busy}
        render={
          <Button
            aria-label={`${entry.name} 操作`}
            className={className}
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <MoreHorizontalIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onRename(entry)}>
          重命名
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>移动到…</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {destinations.map((directory) => (
              <DropdownMenuItem
                key={directory}
                onClick={() => onMove(entry, directory)}
              >
                {directory === "notes"
                  ? "资料库根目录"
                  : directory.replace(/^notes\//u, "")}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {entry.kind === "markdown" ? (
          <>
            <DropdownMenuItem onClick={() => onConvertToFragment(entry)}>
              转为碎片
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onMoveToLockbox(entry)}>
              移入密匣
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => onDelete(entry)}
          variant="destructive"
        >
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TrashEntryMenu({
  busy,
  entry,
  onPurge,
  onRestore,
}: TrashEntryMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={busy}
        render={
          <Button
            aria-label={`${entry.name} 操作`}
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <MoreHorizontalIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onRestore(entry)}>
          <ArchiveRestoreIcon aria-hidden="true" />
          恢复
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onPurge(entry)}
          variant="destructive"
        >
          <Trash2Icon aria-hidden="true" />
          彻底删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RenameInput({
  busy,
  onCancel,
  onChange,
  onSubmit,
  value,
}: {
  busy: boolean
  onCancel: () => void
  onChange: (value: string) => void
  onSubmit: () => void
  value: string
}) {
  return (
    <Input
      aria-label="重命名名称"
      autoFocus
      disabled={busy}
      onBlur={onSubmit}
      onChange={(event) => onChange(event.target.value)}
      onFocus={(event) => event.target.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          onSubmit()
        } else if (event.key === "Escape") {
          event.stopPropagation()
          onCancel()
        }
      }}
      value={value}
    />
  )
}

export function DirectoryViewToolbar({
  action,
  onSelectDirectory,
  onViewModeChange,
  path,
  rootLabel,
  viewMode,
}: DirectoryViewToolbarProps) {
  return (
    <div className={styles.toolbar}>
      <nav aria-label="当前目录路径" className={styles.breadcrumbs}>
        {breadcrumbParts(path, rootLabel).map((part, index) => (
          <span className={styles.breadcrumbPart} key={part.path}>
            {index > 0 ? <ChevronRightIcon aria-hidden="true" /> : null}
            <button
              aria-current={part.path === path ? "page" : undefined}
              className={styles.breadcrumbButton}
              onClick={() => onSelectDirectory(part.path)}
              type="button"
            >
              {part.label}
            </button>
          </span>
        ))}
      </nav>
      <div className={styles.toolbarActions}>
        {action}
        <div aria-label="目录视图形态" className={styles.viewToggle} role="group">
          <Button
            aria-label="列表视图"
            aria-pressed={viewMode === "list"}
            onClick={() => onViewModeChange("list")}
            size="icon-sm"
            title="列表视图"
            type="button"
            variant={viewMode === "list" ? "primary" : "outline"}
          >
            <ListIcon aria-hidden="true" />
          </Button>
          <Button
            aria-label="宫格视图"
            aria-pressed={viewMode === "grid"}
            onClick={() => onViewModeChange("grid")}
            size="icon-sm"
            title="宫格视图"
            type="button"
            variant={viewMode === "grid" ? "primary" : "outline"}
          >
            <Grid2X2Icon aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  )
}

export function DirectoryView({
  busy,
  destinations,
  entries,
  emptyMessage = "这个目录还是空的",
  isEntryOpenable = () => true,
  onConvertToFragment,
  onDelete,
  onMove,
  onMoveToLockbox,
  onOpenEntry,
  onRename,
  onRenameCancel,
  onRenameChange,
  onRenameSubmit,
  path,
  renaming,
  renderEntryActions,
  viewMode,
}: DirectoryViewProps) {
  const renderEntryMenu = (entry: LibraryTreeEntry) =>
    renderEntryActions?.(entry) ?? (
      <LibraryEntryMenu
      busy={busy}
      destinations={libraryEntryDestinations(entry, destinations)}
      entry={entry}
      onConvertToFragment={onConvertToFragment}
      onDelete={onDelete}
      onMove={onMove}
      onMoveToLockbox={onMoveToLockbox}
      onRename={onRename}
      />
    )

  if (viewMode === "grid") {
    return (
      <LibraryItemGrid
        ariaLabel={`${path} 目录宫格`}
        emptyMessage={emptyMessage}
        isItemOpenable={(item) => {
          const entry = entries.find((candidate) => candidate.path === item.path)
          return entry ? isEntryOpenable(entry) : false
        }}
        items={entries.map(gridItem)}
        onSelectItem={(item) => {
          const entry = entries.find((candidate) => candidate.path === item.path)
          if (entry) onOpenEntry(entry)
        }}
        renderItemActions={(item) => {
          const entry = entries.find((candidate) => candidate.path === item.path)
          return entry ? renderEntryMenu(entry) : null
        }}
        renderItemRename={(item) =>
          renaming?.path === item.path ? (
            <RenameInput
              busy={busy}
              onCancel={onRenameCancel}
              onChange={onRenameChange}
              onSubmit={onRenameSubmit}
              value={renaming.value}
            />
          ) : null
        }
      />
    )
  }

  if (entries.length === 0) {
    return (
      <div className={styles.empty}>
        <p>{emptyMessage}</p>
      </div>
    )
  }

  return (
    <div aria-label={`${path} 目录列表`} className={styles.list} role="region">
      <div className={styles.listHeader}>
        <span>名称</span>
        <span>类型</span>
        <span>大小</span>
        <span>修改时间</span>
        <span aria-hidden="true" />
      </div>
      <div className={styles.listBody}>
        {entries.map((entry) => {
          const isRenaming = renaming?.path === entry.path
          return (
            <div className={styles.listRow} key={entry.path}>
              {isRenaming ? (
                <div className={styles.listOpenButton}>
                  <RenameInput
                    busy={busy}
                    onCancel={onRenameCancel}
                    onChange={onRenameChange}
                    onSubmit={onRenameSubmit}
                    value={renaming.value}
                  />
                  <span>{entryTypeLabel(entry.kind)}</span>
                  <span className={styles.numericCell}>
                    {entry.kind === "directory" ? "—" : formatBytes(entry.size)}
                  </span>
                  <span className={styles.numericCell}>
                    {formatModifiedAt(entry.modifiedAt) || "未知"}
                  </span>
                </div>
              ) : isEntryOpenable(entry) ? (
                <button
                  aria-label={`打开${entry.kind === "directory" ? "目录" : "文件"} ${entry.name}`}
                  className={styles.listOpenButton}
                  onClick={() => onOpenEntry(entry)}
                  type="button"
                >
                  <span className={styles.nameCell} title={entry.name}>
                    {entry.name}
                  </span>
                  <span>{entryTypeLabel(entry.kind)}</span>
                  <span className={styles.numericCell}>
                    {entry.kind === "directory" ? "—" : formatBytes(entry.size)}
                  </span>
                  <span className={styles.numericCell}>
                    {formatModifiedAt(entry.modifiedAt) || "未知"}
                  </span>
                </button>
              ) : (
                <div className={styles.listOpenButton}>
                  <span className={styles.nameCell} title={entry.name}>
                    {entry.name}
                  </span>
                  <span>{entryTypeLabel(entry.kind)}</span>
                  <span className={styles.numericCell}>
                    {entry.kind === "directory" ? "—" : formatBytes(entry.size)}
                  </span>
                  <span className={styles.numericCell}>
                    {formatModifiedAt(entry.modifiedAt) || "未知"}
                  </span>
                </div>
              )}
              {isRenaming ? <span /> : renderEntryMenu(entry)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
