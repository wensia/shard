import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpDownIcon,
  ChevronRightIcon,
  Grid2X2Icon,
  ListIcon,
} from "@/components/icons"
import { type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode, useMemo, useState } from "react"

import {
  LibraryItemGrid,
  type LibraryGridItem,
  type LibrarySelectionModifiers,
} from "@/components/shard/asset-grid"
import { FileContextMenu, LibraryEntryContextMenu, LibraryEntryMenu, TrashEntryMenu, type LibraryEntryMenuProps } from "@/components/shard/library-entry-menu"
export { LibraryEntryMenu, TrashEntryMenu }

import { LibraryFileIcon } from "@/components/shard/library-file-icon"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { formatBytes, formatModifiedAt } from "@/lib/file-metadata"
import {
  libraryEntryName,
  libraryEntryTypeLabel,
  sortLibraryEntries,
  type LibrarySort,
  type LibrarySortKey,
} from "@/lib/library-entry"
import type { LibraryTreeEntry } from "@/types"

import styles from "./directory-view.module.css"

export type DirectoryViewMode = "grid" | "list"

export const DIRECTORY_VIEW_STORAGE_KEY = "shard.library-directory-view"
const DIRECTORY_SORT_STORAGE_KEY = "shard.library-directory-sort"
const SORT_OPTIONS: { key: LibrarySortKey; label: string }[] = [
  { key: "name", label: "名称" },
  { key: "kind", label: "类型" },
  { key: "size", label: "大小" },
  { key: "createdAt", label: "创建时间" },
  { key: "modifiedAt", label: "修改时间" },
]

interface DirectorySortProps {
  sort: LibrarySort
  onSortChange: (sort: LibrarySort) => void
}

export interface DirectorySelection {
  active: boolean
  paths: ReadonlySet<string>
  onToggle: (entry: LibraryTreeEntry, modifiers?: LibrarySelectionModifiers) => void
  onSelectAll: () => void
  onClear: () => void
  onMenuTarget: (entry: LibraryTreeEntry) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

interface DirectoryViewProps extends DirectorySortProps {
  bottomInset?: number
  busy: boolean
  destinations: string[]
  entries: Array<LibraryTreeEntry & { content?: string }>
  emptyMessage?: string
  isEntryOpenable?: (entry: LibraryTreeEntry) => boolean
  onConvertToFragment: (entry: LibraryTreeEntry) => void
  onCreateNote?: () => void
  onCreateDirectory?: () => void
  onBatchDelete?: (entries: LibraryTreeEntry[]) => void
  onBatchMove?: (entries: LibraryTreeEntry[], destination: string) => void
  onCopyDocumentLink?: (entry: LibraryTreeEntry) => void
  onDelete: (entry: LibraryTreeEntry) => void
  onImportTable?: (entry: LibraryTreeEntry) => void
  onImportGraphToTimeline?: (entry: LibraryTreeEntry) => void
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
  renderEntryContextMenu?: (entry: LibraryTreeEntry, element: ReactElement) => ReactNode
  selection?: DirectorySelection
  viewMode: DirectoryViewMode
}

interface DirectoryViewToolbarProps extends DirectorySortProps {
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

export function readDirectorySortPreference(): LibrarySort {
  try {
    const stored = JSON.parse(window.localStorage.getItem(DIRECTORY_SORT_STORAGE_KEY) ?? "null")
    if (stored && SORT_OPTIONS.some(({ key }) => key === stored.key) &&
      (stored.direction === "asc" || stored.direction === "desc")) return stored
  } catch {
    // 无效或不可用的存储回退到目录默认顺序。
  }
  return { key: "name", direction: "asc" }
}

export function writeDirectorySortPreference(sort: LibrarySort) {
  try {
    window.localStorage.setItem(DIRECTORY_SORT_STORAGE_KEY, JSON.stringify(sort))
  } catch {
    // 排序仍在当前会话内生效。
  }
}

function initialSort(key: LibrarySortKey): LibrarySort {
  return { key, direction: key === "name" || key === "kind" ? "asc" : "desc" }
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
        : formatBytes(entry.size),
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
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
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
  onSortChange,
  path,
  rootLabel,
  sort,
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
        <DropdownMenu>
          <DropdownMenuTrigger render={
            <Button
              aria-label={`排序：${SORT_OPTIONS.find(({ key }) => key === sort.key)?.label}，${sort.direction === "asc" ? "升序" : "降序"}`}
              size="sm"
              variant="outline"
            />
          }>
            {sort.direction === "asc" ? <ArrowUpIcon /> : <ArrowDownIcon />}
            {SORT_OPTIONS.find(({ key }) => key === sort.key)?.label}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              aria-label="排序字段"
              value={sort.key}
              onValueChange={(key) => onSortChange(initialSort(key as LibrarySortKey))}
            >
              {SORT_OPTIONS.map(({ key, label }) => (
                <DropdownMenuRadioItem key={key} value={key}>{label}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              aria-label="排序方向"
              value={sort.direction}
              onValueChange={(direction) => onSortChange({ ...sort, direction: direction as LibrarySort["direction"] })}
            >
              <DropdownMenuRadioItem value="asc">升序</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="desc">降序</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
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
  bottomInset,
  busy,
  destinations,
  entries,
  emptyMessage = "这个目录还是空的",
  isEntryOpenable = () => true,
  onConvertToFragment,
  onCreateNote,
  onCreateDirectory,
  onBatchDelete,
  onBatchMove,
  onCopyDocumentLink,
  onDelete,
  onImportTable,
  onImportGraphToTimeline,
  onMove,
  onMoveToLockbox,
  onOpenEntry,
  onRename,
  onRenameCancel,
  onRenameChange,
  onRenameSubmit,
  onSortChange,
  path,
  renaming,
  renderEntryActions,
  renderEntryContextMenu,
  selection,
  sort,
  viewMode,
}: DirectoryViewProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const sortedEntries = useMemo(() => sortLibraryEntries(entries, sort), [entries, sort])
  const selectedCount = sortedEntries.filter((entry) => selection?.paths.has(entry.path)).length
  const handleEntryClick = (entry: LibraryTreeEntry, event: MouseEvent<HTMLElement>) => {
    if (busy || renaming?.path === entry.path) return
    if (selection && (selection.active || event.shiftKey || event.metaKey || event.ctrlKey || !isEntryOpenable(entry))) {
      event.preventDefault()
      selection.onToggle(entry, event)
    } else if (isEntryOpenable(entry)) {
      onOpenEntry(entry)
    }
  }
  function menuControl(owner: string) {
    return {
      open: openMenu === owner,
      onOpenChange: (open: boolean) => setOpenMenu(current => open ? owner : current === owner ? null : current),
    }
  }
  function menuProps(entry: LibraryTreeEntry): LibraryEntryMenuProps {
    const targets = selection?.paths.has(entry.path)
      ? sortedEntries.filter(item => selection.paths.has(item.path)) : [entry]
    const batch = targets.length > 1 && onBatchDelete && onBatchMove ? {
      count: targets.length,
      onDelete: () => onBatchDelete(targets),
      onMove: (destination: string) => onBatchMove(targets, destination),
    } : undefined
    return {
      busy: busy || Boolean(renaming), entry, batch,
      destinations: targets.reduce((available, item) => libraryEntryDestinations(item, available), destinations),
      onConvertToFragment, onCopyDocumentLink, onDelete, onImportGraphToTimeline, onImportTable, onMove, onMoveToLockbox, onRename,
      onOpenEntry: isEntryOpenable(entry) ? onOpenEntry : undefined,
      onPrepare: () => selection?.onMenuTarget(entry),
    }
  }
  const renderEntryMenu = (entry: LibraryTreeEntry) => renderEntryActions?.(entry) ?? (
    <LibraryEntryMenu {...menuProps(entry)} {...menuControl(`overflow:${entry.path}`)} />
  )
  const wrapEntry = (entry: LibraryTreeEntry, element: ReactElement) => renderEntryContextMenu?.(entry, element) ?? (
    <LibraryEntryContextMenu key={entry.path} {...menuProps(entry)} {...menuControl(`context:${entry.path}`)}>
      {element}
    </LibraryEntryContextMenu>
  )
  const wrapDirectory = (element: ReactElement) => selection || onCreateNote || onCreateDirectory ? (
    <FileContextMenu busy={busy || Boolean(renaming)} {...menuControl(`blank:${path}`)} content={run => <>
      {onCreateNote ? <DropdownMenuItem onClick={() => run(onCreateNote)}>新建文档</DropdownMenuItem> : null}
      {onCreateDirectory ? <DropdownMenuItem onClick={() => run(onCreateDirectory)}>新建目录</DropdownMenuItem> : null}
      {(onCreateNote || onCreateDirectory) && selection ? <DropdownMenuSeparator /> : null}
      {selection ? <>
        <DropdownMenuItem disabled={entries.length === 0} onClick={() => run(selection.onSelectAll)}>全选</DropdownMenuItem>
        {selection.active ? <DropdownMenuItem onClick={() => run(selection.onClear)}>退出多选</DropdownMenuItem> : null}
      </> : null}
    </>}>
      <div className={styles.directorySurface}>{element}</div>
    </FileContextMenu>
  ) : element

  if (viewMode === "grid") {
    return wrapDirectory(
      <LibraryItemGrid
        bottomInset={bottomInset}
        ariaLabel={`${path} 目录宫格`}
        busy={busy}
        emptyMessage={emptyMessage}
        isItemOpenable={(item) => {
          const entry = entries.find((candidate) => candidate.path === item.path)
          return entry ? isEntryOpenable(entry) : false
        }}
        items={sortedEntries.map(gridItem)}
        renderItemContainer={(item, element) => {
          const entry = entries.find(candidate => candidate.path === item.path)
          return entry ? wrapEntry(entry, element) : element
        }}
        onSelectItem={(item) => {
          const entry = entries.find((candidate) => candidate.path === item.path)
          if (entry && !busy) onOpenEntry(entry)
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
        selection={selection ? {
          active: selection.active,
          paths: selection.paths,
          onKeyDown: selection.onKeyDown,
          onToggle: (item, modifiers) => {
            const entry = entries.find((candidate) => candidate.path === item.path)
            if (entry && !busy) selection.onToggle(entry, modifiers)
          },
        } : undefined}
      />
    )
  }

  if (entries.length === 0) {
    return wrapDirectory(
      <div aria-busy={busy} className={styles.empty} onKeyDown={selection?.onKeyDown} tabIndex={selection ? 0 : undefined}>
        <p>{emptyMessage}</p>
      </div>
    )
  }

  return wrapDirectory(
    <div
      aria-busy={busy}
      aria-label={`${path} 目录列表`}
      className={styles.list}
      style={bottomInset === undefined ? undefined : {
        paddingBottom: bottomInset,
        scrollPaddingBottom: bottomInset,
        scrollbarGutter: "stable",
      }}
      data-selection-active={selection?.active || undefined}
      onKeyDown={selection?.onKeyDown}
      role="region"
      tabIndex={selection ? 0 : undefined}
    >
      <table aria-label="目录文件" className={styles.listTable}>
        <colgroup>
          {selection ? <col className={styles.selectionColumn} /> : null}
          <col />
          <col className={styles.typeColumn} />
          <col className={styles.sizeColumn} />
          <col className={styles.dateColumn} />
          <col className={styles.dateColumn} />
          <col className={styles.actionsColumn} />
        </colgroup>
        <thead>
          <tr className={styles.listHeader}>
            {selection ? (
              <th className={styles.selectionCell} scope="col">
                <span className={styles.selectionControl}>
                  <Checkbox
                    aria-label="全选当前目录"
                    checked={selectedCount === sortedEntries.length}
                    disabled={busy}
                    indeterminate={selectedCount > 0 && selectedCount < sortedEntries.length}
                    onCheckedChange={() => {
                      if (busy) return
                      if (selectedCount === sortedEntries.length) selection.onClear()
                      else selection.onSelectAll()
                    }}
                  />
                </span>
              </th>
            ) : null}
            {SORT_OPTIONS.map(({ key, label }) => {
              const active = sort.key === key
              const SortIcon = active ? (sort.direction === "asc" ? ArrowUpIcon : ArrowDownIcon) : ArrowUpDownIcon
              return (
                <th
                  aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
                  className={key === "size" ? styles.sizeCell : undefined}
                  key={key}
                  scope="col"
                >
                  <Button
                    aria-label={`按${label}排序`}
                    className={styles.sortButton}
                    data-active={active}
                    onClick={() => onSortChange(active
                      ? { ...sort, direction: sort.direction === "asc" ? "desc" : "asc" }
                      : initialSort(key))}
                    size="sm"
                    title={`${label}：${active && sort.direction === "asc" ? "切换为降序" : active ? "切换为升序" : "点击排序"}`}
                    variant="ghost"
                  >
                    {label}
                    <SortIcon />
                  </Button>
                </th>
              )
            })}
            <th scope="col"><span className="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody>
          {sortedEntries.map((entry) => {
            const isRenaming = renaming?.path === entry.path
            const openable = isEntryOpenable(entry)
            const name = libraryEntryName(entry)
            const fileName = (
              <span className={styles.nameCell} title={entry.name}>
                <LibraryFileIcon kind={entry.kind} />
                <span className={styles.nameText}>{name}</span>
              </span>
            )
            return wrapEntry(entry,
              <tr
                className={styles.listRow}
                data-path={entry.path}
                data-selected={selection?.paths.has(entry.path) || undefined}
                key={entry.path}
                onClick={(event) => handleEntryClick(entry, event)}
              >
                {selection ? (
                  <td className={styles.selectionCell} onClick={(event) => event.stopPropagation()}>
                    <span className={styles.selectionControl}>
                      <Checkbox
                        aria-label={`选择 ${entry.name}`}
                        checked={selection.paths.has(entry.path)}
                        disabled={busy || isRenaming}
                        onCheckedChange={(_, { event }) => {
                          if (busy || isRenaming) return
                          selection.onToggle(entry, {
                            shiftKey: "shiftKey" in event && event.shiftKey === true,
                            metaKey: "metaKey" in event && event.metaKey === true,
                            ctrlKey: "ctrlKey" in event && event.ctrlKey === true,
                          })
                        }}
                      />
                    </span>
                  </td>
                ) : null}
                <td>
                  {isRenaming ? (
                    <span className={styles.nameCell}>
                      <LibraryFileIcon kind={entry.kind} />
                      <RenameInput
                        busy={busy}
                        onCancel={onRenameCancel}
                        onChange={onRenameChange}
                        onSubmit={onRenameSubmit}
                        value={renaming.value}
                      />
                    </span>
                  ) : openable || selection ? (
                    <button
                      aria-label={`${selection?.active || !openable ? "选择" : "打开"}${entry.kind === "directory" ? "目录" : "文件"} ${entry.name}`}
                      aria-pressed={selection?.active ? selection.paths.has(entry.path) : undefined}
                      className={styles.listOpenButton}
                      disabled={busy}
                      onClick={(event) => { event.stopPropagation(); handleEntryClick(entry, event) }}
                      type="button"
                    >
                      {fileName}
                    </button>
                  ) : fileName}
                </td>
                <td>{libraryEntryTypeLabel(entry.kind)}</td>
                <td className={styles.sizeCell}>
                  {entry.kind === "directory" ? "—" : formatBytes(entry.size)}
                </td>
                <td className={styles.numericCell}>
                  {formatModifiedAt(entry.createdAt ?? "") || "未知"}
                </td>
                <td className={styles.numericCell}>
                  {formatModifiedAt(entry.modifiedAt) || "未知"}
                </td>
                <td className={styles.actionsCell} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                  {isRenaming ? null : renderEntryMenu(entry)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
