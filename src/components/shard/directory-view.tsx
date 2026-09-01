import {
  ChevronRightIcon,
  Grid2X2Icon,
  ListIcon,
} from "lucide-react"

import {
  LibraryItemGrid,
  type LibraryGridItem,
} from "@/components/shard/asset-grid"
import { Button } from "@/components/ui/button"
import { formatBytes, formatModifiedAt } from "@/lib/file-metadata"
import type { LibraryTreeEntry } from "@/types"

import styles from "./directory-view.module.css"

export type DirectoryViewMode = "grid" | "list"

export const DIRECTORY_VIEW_STORAGE_KEY = "shard.library-directory-view"

interface DirectoryViewProps {
  entries: LibraryTreeEntry[]
  onOpenEntry: (entry: LibraryTreeEntry) => void
  path: string
  viewMode: DirectoryViewMode
}

interface DirectoryViewToolbarProps {
  onSelectDirectory: (path: string) => void
  onViewModeChange: (mode: DirectoryViewMode) => void
  path: string
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
  return "Markdown"
}

function gridItem(entry: LibraryTreeEntry): LibraryGridItem {
  return {
    kind: entry.kind,
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

function breadcrumbParts(path: string) {
  const parts = path.split("/").filter(Boolean)
  return parts.map((part, index) => ({
    label: index === 0 && part === "notes" ? "资料库" : part,
    path: parts.slice(0, index + 1).join("/"),
  }))
}

export function DirectoryViewToolbar({
  onSelectDirectory,
  onViewModeChange,
  path,
  viewMode,
}: DirectoryViewToolbarProps) {
  return (
    <div className={styles.toolbar}>
      <nav aria-label="当前目录路径" className={styles.breadcrumbs}>
        {breadcrumbParts(path).map((part, index) => (
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
  )
}

export function DirectoryView({
  entries,
  onOpenEntry,
  path,
  viewMode,
}: DirectoryViewProps) {
  if (viewMode === "grid") {
    return (
      <LibraryItemGrid
        ariaLabel={`${path} 目录宫格`}
        emptyMessage="这个目录还是空的"
        items={entries.map(gridItem)}
        onSelectItem={(item) => {
          const entry = entries.find((candidate) => candidate.path === item.path)
          if (entry) onOpenEntry(entry)
        }}
      />
    )
  }

  if (entries.length === 0) {
    return (
      <div className={styles.empty}>
        <p>这个目录还是空的</p>
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
      </div>
      <div className={styles.listBody}>
        {entries.map((entry) => (
          <button
            aria-label={`打开${entry.kind === "directory" ? "目录" : "文件"} ${entry.name}`}
            className={styles.listRow}
            key={entry.path}
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
        ))}
      </div>
    </div>
  )
}
