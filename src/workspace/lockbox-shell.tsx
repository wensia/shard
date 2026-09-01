import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react"
import {
  ArrowLeftIcon,
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
import {
  LockboxFormError,
  LockboxPasswordInput,
  validateLockboxPasswordPair,
} from "@/components/shard/lockbox-dialog"
import type { TaggedSummary } from "@/components/shard/tagged-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getApiErrorMessage } from "@/lib/api"
import type { Fragment, LockboxState } from "@/types"

import styles from "./lockbox-shell.module.css"

interface LockboxShellProps {
  isSearchModeActive: boolean
  lockbox: LockboxState | null
  notes: Fragment[]
  onChangePassword: () => void
  onLock: () => void
  onBack: () => void
  onOpenNote: (fragment: Fragment) => void
  onResetPassword: (recoveryKey: string, newPassword: string) => Promise<void>
  onSelectTag: (tag: string | null) => void
  onUnlock: (password: string) => Promise<void>
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
  onBack,
  onChangePassword,
  onLock,
  onOpenNote,
  onResetPassword,
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
          {/*
           * 上锁态整页就是主体的解锁面板，不顶重复的标题说明条；但密匣是从
           * 资料库推门进来的一级空间，得留一条原路返回的出口。
           */}
          {unlocked ? (
            <LockboxHeader
              lockbox={lockbox}
              selectedTag={selectedTag}
              summaries={summaries}
              totalCount={totalCount}
              onBack={onBack}
              onChangePassword={onChangePassword}
              onLock={onLock}
              onSelectTag={onSelectTag}
            />
          ) : (
            <div className={styles.gateTopBar}>
              <LockboxBackButton onBack={onBack} />
            </div>
          )}
          {searchContextBar ? (
            <SearchContextBar {...searchContextBar} />
          ) : null}
          {unlocked ? (
            <>
              {notes.length > 0 ? (
                <LockboxNotesTree notes={notes} onOpenNote={onOpenNote} />
              ) : null}
              <FragmentTimeline {...timeline} />
            </>
          ) : (
            <LockboxGate onReset={onResetPassword} onUnlock={onUnlock} />
          )}
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

/** 原路返回资料库——密匣是从资料库挂载点推门进来的一级空间。 */
function LockboxBackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button aria-label="返回资料库" onClick={onBack} size="sm" variant="ghost">
      <ArrowLeftIcon aria-hidden="true" />
      资料库
    </Button>
  )
}

/**
 * 上锁态的主体区：解锁就在这里完成，不再弹窗。忘记密码切到同一块面板内的
 * 恢复密钥重置，重置成功后的「保存恢复密钥」仍由 LockboxDialog 承接。
 */
function LockboxGate({
  onReset,
  onUnlock,
}: {
  onReset: (recoveryKey: string, newPassword: string) => Promise<void>
  onUnlock: (password: string) => Promise<void>
}) {
  const [mode, setMode] = useState<"reset" | "unlock">("unlock")
  const [password, setPassword] = useState("")
  const [recoveryInput, setRecoveryInput] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [repeatPassword, setRepeatPassword] = useState("")
  const [error, setError] = useState("")
  const [isBusy, setIsBusy] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)
  const recoveryRef = useRef<HTMLInputElement>(null)

  // 进入上锁态与切换子表单时把焦点落到第一个输入框
  useEffect(() => {
    const target = mode === "unlock" ? passwordRef.current : recoveryRef.current
    target?.focus()
  }, [mode])

  function switchMode(next: "reset" | "unlock") {
    setMode(next)
    setError("")
    setPassword("")
    setRecoveryInput("")
    setNewPassword("")
    setRepeatPassword("")
  }

  async function submit(action: () => Promise<void>) {
    setError("")
    setIsBusy(true)
    try {
      await action()
    } catch (error) {
      setError(getApiErrorMessage(error))
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <div className={styles.gate}>
      <div className={styles.gateCard}>
        <LockKeyholeIcon
          aria-hidden="true"
          className="size-(--shard-icon-size-xl)"
        />
        <h2 className={styles.gateTitle}>
          {mode === "unlock" ? "密匣已上锁" : "重置密匣密码"}
        </h2>
        <p className={styles.gateHint}>
          {mode === "unlock"
            ? "解锁后闲置数分钟自动上锁。"
            : "用恢复密钥设置新密码，密匣内容保持不变。"}
        </p>

        {mode === "unlock" ? (
          <form
            aria-label="解锁密匣"
            className={styles.gateForm}
            onSubmit={(event) => {
              event.preventDefault()
              void submit(() => onUnlock(password))
            }}
          >
            <label className="sr-only" htmlFor="lockbox-gate-password">
              密匣密码
            </label>
            <div className={styles.gateRow}>
              <LockboxPasswordInput
                disabled={isBusy}
                id="lockbox-gate-password"
                onChange={(event) => setPassword(event.target.value)}
                placeholder="密匣密码"
                ref={passwordRef}
                value={password}
              />
              <Button
                disabled={isBusy || !password}
                size="sm"
                type="submit"
                variant="primary"
              >
                {isBusy ? "解锁中" : "解锁"}
              </Button>
            </div>
            <LockboxFormError message={error} />
            <Button
              className={styles.gateLink}
              disabled={isBusy}
              onClick={() => switchMode("reset")}
              size="sm"
              type="button"
              variant="ghost"
            >
              忘记密码
            </Button>
          </form>
        ) : (
          <form
            aria-label="重置密匣密码"
            className={styles.gateForm}
            onSubmit={(event) => {
              event.preventDefault()
              const message = validateLockboxPasswordPair(
                newPassword,
                repeatPassword
              )
              if (message) {
                setError(message)
                return
              }
              void submit(async () => {
                await onReset(recoveryInput, newPassword)
                switchMode("unlock")
              })
            }}
          >
            <label className="sr-only" htmlFor="lockbox-gate-recovery-key">
              恢复密钥
            </label>
            <Input
              disabled={isBusy}
              id="lockbox-gate-recovery-key"
              onChange={(event) => setRecoveryInput(event.target.value)}
              placeholder="恢复密钥"
              ref={recoveryRef}
              value={recoveryInput}
            />
            <label className="sr-only" htmlFor="lockbox-gate-new-password">
              新密码，至少 8 个字符
            </label>
            <LockboxPasswordInput
              disabled={isBusy}
              id="lockbox-gate-new-password"
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="新密码，至少 8 个字符"
              value={newPassword}
            />
            <label className="sr-only" htmlFor="lockbox-gate-repeat-password">
              再次输入新密码
            </label>
            <LockboxPasswordInput
              disabled={isBusy}
              id="lockbox-gate-repeat-password"
              onChange={(event) => setRepeatPassword(event.target.value)}
              placeholder="再次输入新密码"
              value={repeatPassword}
            />
            <LockboxFormError message={error} />
            <div className={styles.gateActions}>
              <Button
                disabled={isBusy}
                onClick={() => switchMode("unlock")}
                size="sm"
                type="button"
                variant="ghost"
              >
                返回解锁
              </Button>
              <Button
                disabled={isBusy || !recoveryInput}
                size="sm"
                type="submit"
                variant="primary"
              >
                {isBusy ? "重置中" : "重置密码"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
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
  onBack,
  onChangePassword,
  onLock,
  onSelectTag,
}: {
  lockbox: LockboxState | null
  selectedTag: string | null
  summaries: TaggedSummary[]
  totalCount: number
  onBack: () => void
  onChangePassword: () => void
  onLock: () => void
  onSelectTag: (tag: string | null) => void
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
                {`已解锁${lockbox?.expiresAt ? `至 ${formatLockboxExpiry(lockbox.expiresAt)}` : ""}`}
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
            <LockboxBackButton onBack={onBack} />
            <Button onClick={onChangePassword} size="sm" variant="secondary">
              修改密码
            </Button>
            <Button onClick={onLock} size="sm" variant="secondary">
              上锁
            </Button>
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
