import { useMemo, useState, type ComponentProps } from "react"
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  LockKeyholeIcon,
  TagIcon,
} from "@/components/icons"

import appStyles from "@/App.module.css"
import {
  FragmentSearchWorkspace,
  SearchContextBar,
} from "@/components/shard/fragment-search-workspace"
import { FragmentTimeline } from "@/components/shard/fragment-timeline"
import type { TaggedSummary } from "@/components/shard/tagged-panel"
import { Button } from "@/components/ui/button"
import type { Fragment, LockboxState } from "@/types"

import styles from "./lockbox-shell.module.css"

interface LockboxShellProps {
  isSearchModeActive: boolean
  lockbox: LockboxState | null
  notes: Fragment[]
  onChangePassword: () => void
  onLock: () => void
  onOpenNote: (fragment: Fragment) => void
  onSelectTag: (tag: string | null) => void
  onUnlock: () => void
  search: ComponentProps<typeof FragmentSearchWorkspace>
  searchContextBar: ComponentProps<typeof SearchContextBar> | null
  selectedTag: string | null
  summaries: TaggedSummary[]
  timeline: ComponentProps<typeof FragmentTimeline>
  totalCount: number
}

/**
 * 密匣一级空间：资料库树上的上锁挂载点推门进来的房间。
 * 内含密匣自己的笔记树（lockbox/notes/）与碎片流，安全区跟整个空间走。
 */
export function LockboxShell({
  isSearchModeActive,
  lockbox,
  notes,
  onChangePassword,
  onLock,
  onOpenNote,
  onSelectTag,
  onUnlock,
  search,
  searchContextBar,
  selectedTag,
  summaries,
  timeline,
  totalCount,
}: LockboxShellProps) {
  const unlocked = Boolean(lockbox?.unlocked)

  return (
    <section className={appStyles.workspaceColumn}>
      <div className={appStyles.workAreaStage}>
        <div
          aria-hidden={isSearchModeActive ? true : undefined}
          className={appStyles.normalWorkArea}
          data-search-hidden={isSearchModeActive ? "true" : undefined}
        >
          <LockboxHeader
            lockbox={lockbox}
            selectedTag={selectedTag}
            summaries={summaries}
            totalCount={totalCount}
            onChangePassword={onChangePassword}
            onLock={onLock}
            onSelectTag={onSelectTag}
            onUnlock={onUnlock}
          />
          {searchContextBar ? (
            <SearchContextBar {...searchContextBar} />
          ) : null}
          {unlocked && notes.length > 0 ? (
            <LockboxNotesTree notes={notes} onOpenNote={onOpenNote} />
          ) : null}
          <FragmentTimeline {...timeline} />
        </div>

        {isSearchModeActive ? (
          <div className={appStyles.searchWorkArea}>
            <FragmentSearchWorkspace {...search} />
          </div>
        ) : null}
      </div>
    </section>
  )
}

interface LockboxNoteDirectory {
  name: string
  path: string
  directories: LockboxNoteDirectory[]
  notes: Fragment[]
}

const LOCKBOX_NOTES_PREFIX = "lockbox/notes/"

function LockboxNotesTree({
  notes,
  onOpenNote,
}: {
  notes: Fragment[]
  onOpenNote: (fragment: Fragment) => void
}) {
  const root = useMemo(() => buildLockboxNoteTree(notes), [notes])
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(
    () => new Set()
  )

  return (
    <div className="shard-content-inset">
      <nav
        aria-label="密匣笔记"
        className={`shard-content-measure ${styles.notesTree}`}
      >
        <div className={styles.notesTreeHeader}>
          <FileTextIcon aria-hidden="true" className="size-(--shard-icon-size-sm)" />
          <span>密匣笔记</span>
          <span className={`tabular-nums ${styles.notesTreeCount}`}>
            {notes.length}
          </span>
        </div>
        <ul className={styles.tree} role="tree">
          <LockboxTreeLevel
            collapsedPaths={collapsedPaths}
            depth={0}
            directory={root}
            onOpenNote={onOpenNote}
            onToggleDirectory={(path) =>
              setCollapsedPaths((current) => {
                const next = new Set(current)
                if (next.has(path)) next.delete(path)
                else next.add(path)
                return next
              })
            }
          />
        </ul>
      </nav>
    </div>
  )
}

function LockboxTreeLevel({
  collapsedPaths,
  depth,
  directory,
  onOpenNote,
  onToggleDirectory,
}: {
  collapsedPaths: Set<string>
  depth: number
  directory: LockboxNoteDirectory
  onOpenNote: (fragment: Fragment) => void
  onToggleDirectory: (path: string) => void
}) {
  return (
    <>
      {directory.directories.map((child) => {
        const collapsed = collapsedPaths.has(child.path)
        return (
          <li aria-expanded={!collapsed} key={child.path} role="treeitem">
            <button
              className={styles.treeButton}
              data-depth={depth}
              onClick={() => onToggleDirectory(child.path)}
              type="button"
            >
              {collapsed ? (
                <ChevronRightIcon aria-hidden="true" />
              ) : (
                <ChevronDownIcon aria-hidden="true" />
              )}
              <FolderIcon aria-hidden="true" />
              <span className={styles.treeLabel}>{child.name}</span>
            </button>
            {collapsed ? null : (
              <ul role="group">
                <LockboxTreeLevel
                  collapsedPaths={collapsedPaths}
                  depth={depth + 1}
                  directory={child}
                  onOpenNote={onOpenNote}
                  onToggleDirectory={onToggleDirectory}
                />
              </ul>
            )}
          </li>
        )
      })}
      {directory.notes.map((note) => (
        <li key={note.id} role="treeitem">
          <button
            className={styles.treeButton}
            data-depth={depth}
            onClick={() => onOpenNote(note)}
            type="button"
          >
            <span className={styles.treeIndentIcon} />
            <FileTextIcon aria-hidden="true" />
            <span className={styles.treeLabel}>
              {lockboxNoteTitle(note.path)}
            </span>
          </button>
        </li>
      ))}
    </>
  )
}

function buildLockboxNoteTree(notes: Fragment[]): LockboxNoteDirectory {
  const root: LockboxNoteDirectory = {
    name: "",
    path: LOCKBOX_NOTES_PREFIX,
    directories: [],
    notes: [],
  }

  const sorted = [...notes].sort((a, b) => a.path.localeCompare(b.path, "zh-CN"))
  for (const note of sorted) {
    if (!note.path.startsWith(LOCKBOX_NOTES_PREFIX)) {
      root.notes.push(note)
      continue
    }
    const segments = note.path.slice(LOCKBOX_NOTES_PREFIX.length).split("/")
    let cursor = root
    for (const segment of segments.slice(0, -1)) {
      let child = cursor.directories.find(
        (candidate) => candidate.name === segment
      )
      if (!child) {
        child = {
          name: segment,
          path: `${cursor.path}${segment}/`,
          directories: [],
          notes: [],
        }
        cursor.directories.push(child)
      }
      cursor = child
    }
    cursor.notes.push(note)
  }

  return root
}

function lockboxNoteTitle(path: string) {
  const fileName = path.split("/").pop() ?? path
  return fileName.replace(/\.(md|shard)$/iu, "") || "无标题笔记"
}

export function LockboxHeader({
  lockbox,
  selectedTag,
  summaries,
  totalCount,
  onChangePassword,
  onLock,
  onSelectTag,
  onUnlock,
}: {
  lockbox: LockboxState | null
  selectedTag: string | null
  summaries: TaggedSummary[]
  totalCount: number
  onChangePassword: () => void
  onLock: () => void
  onSelectTag: (tag: string | null) => void
  onUnlock: () => void
}) {
  return (
    <div
      className="shard-content-inset"
      data-tauri-drag-region
      style={{
        paddingBottom: "var(--shard-space-4)",
        paddingTop: "var(--shard-top-inset)",
      }}
    >
      <div
        className="shard-content-measure"
        style={{
          borderBottom: "1px solid var(--border)",
          paddingBottom: "var(--shard-space-4)",
        }}
      >
        <div
          style={{
            display: "flex",
            minWidth: 0,
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "var(--shard-space-3)",
          }}
        >
          <div
            style={{
              display: "flex",
              minWidth: 0,
              alignItems: "center",
              gap: "var(--shard-space-3)",
            }}
          >
            <span
              style={{
                display: "flex",
                flexShrink: 0,
                width: 32,
                height: 32,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "var(--shard-radius-control)",
                border: "1px solid var(--border)",
                background: "var(--card)",
                color: "var(--shard-sapphire)",
              }}
            >
              <LockKeyholeIcon className="size-(--shard-icon-size-md)" />
            </span>
            <div style={{ minWidth: 0 }}>
              <h1
                style={{
                  fontSize: 18,
                  lineHeight: "24px",
                  fontWeight: 700,
                  textWrap: "balance",
                }}
              >
                密匣
              </h1>
              <p
                style={{
                  marginTop: 4,
                  fontSize: 14,
                  lineHeight: "20px",
                  textWrap: "pretty",
                  color: "var(--muted-foreground)",
                }}
              >
                {lockbox?.unlocked
                  ? `已解锁${lockbox.expiresAt ? `至 ${formatLockboxExpiry(lockbox.expiresAt)}` : ""}`
                  : "需要密码访问。私密笔记不会出现在主页、回顾或普通统计中。"}
              </p>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexShrink: 0,
              alignItems: "center",
              gap: "var(--shard-space-2)",
            }}
          >
            {lockbox?.unlocked ? (
              <>
                <Button onClick={onChangePassword} size="sm" variant="secondary">
                  修改密码
                </Button>
                <Button onClick={onLock} size="sm" variant="secondary">
                  上锁
                </Button>
              </>
            ) : (
              <Button onClick={onUnlock} size="sm" variant="primary">
                解锁
              </Button>
            )}
          </div>
        </div>

        {lockbox?.unlocked ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--shard-space-2)",
              marginTop: "var(--shard-space-3)",
            }}
          >
            <div
              style={{
                display: "flex",
                height: "var(--shard-chip-height)",
                alignItems: "center",
                gap: "var(--shard-space-2)",
                fontSize: 12,
                fontWeight: 500,
                color: "var(--muted-foreground)",
              }}
            >
              <TagIcon className="size-(--shard-icon-size-sm)" />
              <span className="tabular-nums">{summaries.length} 子标签</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{totalCount} 条</span>
            </div>

            <div
              className="shard-tag-filters"
              style={{
                display: "flex",
                maxHeight: 72,
                flexWrap: "wrap",
                alignContent: "flex-start",
                gap: "var(--shard-space-2)",
                overflowY: "auto",
                paddingRight: "var(--shard-space-1)",
              }}
            >
              <LockboxTagFilterButton
                active={selectedTag === null}
                count={totalCount}
                label="全部"
                onClick={() => onSelectTag(null)}
              />
              {summaries.map((summary) => (
                <LockboxTagFilterButton
                  active={selectedTag === summary.tag}
                  count={summary.count}
                  key={summary.tag}
                  label={`#${summary.tag}`}
                  onClick={() => onSelectTag(summary.tag)}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function LockboxTagFilterButton({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean
  count: number
  label: string
  onClick: () => void
}) {
  return (
    <button
      aria-pressed={active}
      className={["shard-tag", active ? "shard-tag-active" : ""].join(" ")}
      onClick={onClick}
      style={{ maxWidth: "100%", gap: "var(--shard-space-micro)", fontWeight: 500 }}
      title={label}
      type="button"
    >
      <span
        className="shard-chip-text"
        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {label}
      </span>
      <span className="shard-chip-text shard-tag-count">{count}</span>
    </button>
  )
}

function formatLockboxExpiry(expiresAt: string) {
  return new Date(expiresAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  })
}
