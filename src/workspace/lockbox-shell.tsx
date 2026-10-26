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
import { FragmentTimeline } from "@/components/shard/fragment-timeline"
import {
  LockboxPasswordInput,
  PASSWORD_IME_HINT,
  validateLockboxPasswordPair,
} from "@/components/shard/lockbox-dialog"
import type { TaggedSummary } from "@/components/shard/tagged-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getApiErrorMessage } from "@/lib/api"
import type { Fragment, LockboxState } from "@/types"

import styles from "./lockbox-shell.module.css"

interface LockboxShellProps {
  lockbox: LockboxState | null
  notes: Fragment[]
  onChangePassword: () => void
  onLock: () => void
  onBack: () => void
  onOpenNote: (fragment: Fragment) => void
  onResetPassword: (recoveryKey: string, newPassword: string) => Promise<void>
  onSelectTag: (tag: string | null) => void
  onUnlock: (password: string) => Promise<void>
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
  lockbox,
  notes,
  onBack,
  onChangePassword,
  onLock,
  onOpenNote,
  onResetPassword,
  onSelectTag,
  onUnlock,
  selectedTag,
  summaries,
  timeline,
  totalCount,
}: LockboxShellProps) {
  const unlocked = Boolean(lockbox?.unlocked)

  return (
    <section className={appStyles.workspaceColumn}>
      <div className={appStyles.workAreaStage}>
        <div className={appStyles.normalWorkArea}>
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
          {unlocked ? (
            <>
              {notes.length > 0 ? (
                <LockboxNotesTree notes={notes} onOpenNote={onOpenNote} />
              ) : null}
              <FragmentTimeline {...timeline} />
            </>
          ) : lockbox?.webUnlock === false ? (
            <LockboxWebUnlockOff />
          ) : (
            <LockboxGate
              onReset={onResetPassword}
              onUnlock={onUnlock}
              ttlSeconds={lockbox?.ttlSeconds}
            />
          )}
        </div>

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

/** 「闲置 3 分钟后自动上锁」——用真实时长，不说「数分钟」。 */
function describeAutoLock(ttlSeconds?: number) {
  if (!ttlSeconds || ttlSeconds <= 0) return "闲置一段时间后自动上锁"
  if (ttlSeconds < 60) return `闲置 ${ttlSeconds} 秒后自动上锁`
  return `闲置 ${Math.round(ttlSeconds / 60)} 分钟后自动上锁`
}

/**
 * 网页端关掉了「允许在网页解锁密匣」：不给口令框（服务器也不再下发密文）。
 * 锁着用 #密匣 速记仍可用——那只用公钥加密，不需要口令。
 */
function LockboxWebUnlockOff() {
  return (
    <div className={styles.gate}>
      <section aria-labelledby="lockbox-web-unlock-off-title" className={styles.lid}>
        <div className={styles.lidBody}>
          <h1 className={styles.gateTitle} id="lockbox-web-unlock-off-title">
            网页解锁已关闭
          </h1>
          <p className={styles.gateHint}>
            在网页上不能打开密匣。用 #密匣 速记仍会加密存入；要查看或修改，到桌面应用里解锁，或在设置的「账号与安全」里重新允许网页解锁。
          </p>
        </div>
      </section>
    </div>
  )
}

/**
 * 上锁态的主体区：解锁就在这里完成，不再弹窗。一张居中卡片只装标题与表单；
 * 忘记密码切到同一张卡片内的恢复密钥重置，重置成功后的「保存恢复密钥」仍由
 * LockboxDialog 承接。
 */
function LockboxGate({
  onReset,
  onUnlock,
  ttlSeconds,
}: {
  onReset: (recoveryKey: string, newPassword: string) => Promise<void>
  onUnlock: (password: string) => Promise<void>
  ttlSeconds?: number
}) {
  const [mode, setMode] = useState<"reset" | "unlock">("unlock")
  const [password, setPassword] = useState("")
  const [recoveryInput, setRecoveryInput] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [repeatPassword, setRepeatPassword] = useState("")
  const [error, setError] = useState("")
  const [isBusy, setIsBusy] = useState(false)
  const [imeBlocked, setImeBlocked] = useState(false)
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

  async function submit(action: () => Promise<void>, retry?: HTMLInputElement | null) {
    setError("")
    setIsBusy(true)
    try {
      await action()
    } catch (error) {
      setError(getApiErrorMessage(error))
      // 输错后选中已输入内容，直接重打即可覆盖
      requestAnimationFrame(() => retry?.select())
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <div className={styles.gate}>
      <section aria-labelledby="lockbox-gate-title" className={styles.lid}>
        <div className={styles.lidBody}>
          <h1 className={styles.gateTitle} id="lockbox-gate-title">
            {mode === "unlock" ? "密匣已上锁" : "重置密码"}
          </h1>

          {mode === "unlock" ? (
            <form
              aria-label="解锁密匣"
              className={styles.gateForm}
              onSubmit={(event) => {
                event.preventDefault()
                void submit(() => onUnlock(password), passwordRef.current)
              }}
            >
              <label className="sr-only" htmlFor="lockbox-gate-password">
                密匣密码
              </label>
              <div className={styles.gateRow}>
                <LockboxPasswordInput
                  aria-describedby="lockbox-gate-meta"
                  aria-invalid={error ? true : undefined}
                  disabled={isBusy}
                  id="lockbox-gate-password"
                  onImeBlockedChange={setImeBlocked}
                  onChange={(event) => {
                    setPassword(event.target.value)
                    if (error) setError("")
                  }}
                  placeholder="密匣密码"
                  ref={passwordRef}
                  value={password}
                />
                <Button
                  disabled={isBusy || !password}
                  type="submit"
                  variant="primary"
                >
                  {isBusy ? "解锁中" : "解锁"}
                </Button>
              </div>
              {/* 字段下方唯一的一行（kiln）：错误 > 输入法提示 > 自动上锁时长 */}
              <div className={styles.gateMeta} id="lockbox-gate-meta">
                {error ? (
                  <p className={styles.gateError} role="alert">
                    {error}
                  </p>
                ) : imeBlocked ? (
                  <span role="status">{PASSWORD_IME_HINT}</span>
                ) : (
                  <span>{describeAutoLock(ttlSeconds)}</span>
                )}
                <button
                  className={styles.gateLink}
                  disabled={isBusy}
                  onClick={() => switchMode("reset")}
                  type="button"
                >
                  忘记密码
                </button>
              </div>
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
                }, recoveryRef.current)
              }}
            >
              <p className={styles.gateHint}>密匣里的内容不受影响。</p>
              <div className={styles.gateField}>
                <label htmlFor="lockbox-gate-recovery-key">恢复密钥</label>
                <Input
                  disabled={isBusy}
                  id="lockbox-gate-recovery-key"
                  onChange={(event) => setRecoveryInput(event.target.value)}
                  placeholder="设置密匣时保存的恢复密钥"
                  ref={recoveryRef}
                  value={recoveryInput}
                />
              </div>
              <div className={styles.gateField}>
                <label htmlFor="lockbox-gate-new-password">新密码</label>
                <LockboxPasswordInput
                  disabled={isBusy}
                  id="lockbox-gate-new-password"
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="至少 8 个字符"
                  value={newPassword}
                />
              </div>
              <div className={styles.gateField}>
                <label htmlFor="lockbox-gate-repeat-password">确认新密码</label>
                <LockboxPasswordInput
                  disabled={isBusy}
                  id="lockbox-gate-repeat-password"
                  onChange={(event) => setRepeatPassword(event.target.value)}
                  placeholder="再次输入新密码"
                  value={repeatPassword}
                />
              </div>
              {error ? (
                <p className={styles.gateError} role="alert">
                  {error}
                </p>
              ) : null}
              <div className={styles.gateActions}>
                <Button
                  disabled={isBusy}
                  onClick={() => switchMode("unlock")}
                  type="button"
                  variant="outline"
                >
                  返回解锁
                </Button>
                <Button
                  disabled={isBusy || !recoveryInput}
                  type="submit"
                  variant="primary"
                >
                  {isBusy ? "重置中" : "重置密码"}
                </Button>
              </div>
            </form>
          )}
        </div>
      </section>
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
                color: "var(--primary-text)",
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
