import { useEffect, useState, type ReactNode } from "react"
import {
  HelpCircleIcon,
  KeyboardIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SettingsIcon,
  type ShardIcon,
} from "@/components/icons"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { formatSyncedAgo } from "@/lib/relative-time"
import { isServerBacked, transport } from "@/lib/transport"
import {
  dismissRemoteSyncNotices,
  remoteConnectionState,
  remoteSyncStatus,
  requestRemoteSync,
  subscribeRemoteConnection,
  subscribeRemoteSync,
  type RemoteSyncStatus,
} from "@/lib/transport/desktop-remote"
import { getConnectionState, subscribeConnection, type ConnectionState } from "@/lib/transport/sse"
import { formatSaveState, type SaveState } from "@/lib/save-state"
import type { GitInfo } from "@/types"

import styles from "./status-bar.module.css"

const TOOLTIP_DIM_COLOR =
  "color-mix(in oklab, var(--background) calc(var(--shard-alpha-55) * 100%), transparent)"

interface StatusBarProps {
  git: GitInfo | null
  isCreating: boolean
  isSyncing: boolean
  lastSyncAt: number | null
  saveState: SaveState | null
  onCheckpoint: () => void
  onHelp: () => void
  onOpenGitSettings: () => void
  onOpenSettings: () => void
  onShortcuts: () => void
  onSync: () => void
}

/**
 * 桌面底部状态栏。承载 vault 的持久状态与随之而来的动作——git 与保存态，
 * 侧栏因此只剩导航（同 Tolaria 的 ADR 0032）。选底部而不是侧栏底，是因为
 * 侧栏折叠后这些状态仍然要看得见。
 *
 * 条带几何沿用 kiln 三级条带的契约：自身零垂直 padding，靠 --control-height-sm
 * 的控件在 --shard-status-bar-height 里居中撑出上下留白。
 */
export function StatusBar({
  git,
  isCreating,
  isSyncing,
  lastSyncAt,
  saveState,
  onCheckpoint,
  onHelp,
  onOpenGitSettings,
  onOpenSettings,
  onShortcuts,
  onSync,
}: StatusBarProps) {
  useStatusBarTicker(lastSyncAt !== null)

  const hasGit = git !== null && git.status !== "no_git"
  // 逐字沿用侧栏原先的禁用条件，避免两处判断漂移
  const isSyncDisabled =
    isSyncing || !git || git.status === "no_git" || !git.hasRemote
  const gitSummary = `${git?.branch || "main"} · ${git?.shortCommit || "未提交"}`
  const gitDivergence =
    git && (git.ahead > 0 || git.behind > 0)
      ? `↑${git.ahead} ↓${git.behind}`
      : null
  const saveLabel = isCreating
    ? "保存中…"
    : saveState
      ? formatSaveState(saveState)
      : null

  return (
    <footer
      aria-label="状态栏"
      className={styles.statusBar}
      data-shard-status-bar="true"
      role="contentinfo"
    >
      <div className={styles.group}>
        {isServerBacked() ? (
          <ServerConnectionStatus onOpenSettings={onOpenSettings} />
        ) : git === null ? (
          <StatusBarAction onClick={onOpenSettings}>
            未选择资料库
          </StatusBarAction>
        ) : git.status === "no_git" ? (
          <StatusBarAction onClick={onOpenGitSettings}>
            未启用 Git
          </StatusBarAction>
        ) : (
          <StatusBarAction onClick={onOpenGitSettings}>
            <span className={styles.branch}>{gitSummary}</span>
          </StatusBarAction>
        )}

        {hasGit && !isServerBacked() ? (
          <>
            <StatusBarSeparator />
            {!git.hasRemote ? (
              <StatusBarAction onClick={onOpenGitSettings}>
                <span className={styles.badge} data-tone="warning">
                  未连接远端
                </span>
              </StatusBarAction>
            ) : null}
            {git.status === "dirty" ? (
              <StatusBarAction onClick={onCheckpoint}>
                <span className={styles.badge} data-tone="warning">
                  未提交更改
                </span>
              </StatusBarAction>
            ) : null}
            {git.status === "error" ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      className={styles.action}
                      onClick={onOpenGitSettings}
                      size="sm"
                      type="button"
                      variant="ghost"
                    />
                  }
                >
                  <span className={styles.badge} data-tone="danger">
                    Git 错误
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <span className={styles.errorDetail}>
                    {git.error ?? "Git 出错了"}
                  </span>
                </TooltipContent>
              </Tooltip>
            ) : null}
            <SyncAction
              divergence={gitDivergence}
              git={git}
              isDisabled={isSyncDisabled}
              isSyncing={isSyncing}
              lastSyncAt={lastSyncAt}
              summary={gitSummary}
              onSync={onSync}
            />
          </>
        ) : null}
      </div>

      <div className={styles.group}>
        {saveLabel ? (
          <>
            <span className={styles.saveState} data-state={saveState ?? "saving"}>
              {saveLabel}
            </span>
            <StatusBarSeparator />
          </>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label="更多操作"
                data-shard-utility-menu-trigger
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <MoreHorizontalIcon className="size-(--shard-icon-size-sm)" />
            <span className="sr-only">更多操作</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" style={{ width: 160 }}>
            <StatusBarMenuItem
              icon={SettingsIcon}
              label="设置"
              onSelect={onOpenSettings}
            />
            <StatusBarMenuItem
              icon={KeyboardIcon}
              label="快捷键"
              onSelect={onShortcuts}
            />
            <StatusBarMenuItem
              icon={HelpCircleIcon}
              label="帮助"
              onSelect={onHelp}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </footer>
  )
}

function SyncAction({
  divergence,
  git,
  isDisabled,
  isSyncing,
  lastSyncAt,
  summary,
  onSync,
}: {
  divergence: string | null
  git: GitInfo
  isDisabled: boolean
  isSyncing: boolean
  lastSyncAt: number | null
  summary: string
  onSync: () => void
}) {
  // 标签按信息量排序：正在发生的事 > 尚未同步的差异 > 上次同步于何时
  const label = isSyncing
    ? "同步中…"
    : divergence
      ? divergence
      : lastSyncAt !== null
        ? formatSyncedAgo(lastSyncAt)
        : "同步"

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            className={styles.action}
            disabled={isDisabled}
            onClick={onSync}
            size="sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <RefreshCwIcon className={isSyncing ? styles.spin : undefined} />
        <span className={divergence ? styles.divergence : undefined}>
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className={styles.tooltipStack}>
          <span>{isSyncing ? "正在同步" : `Git ${getGitStateLabel(git)}`}</span>
          <span style={{ color: TOOLTIP_DIM_COLOR }}>
            {summary}
            {divergence ? ` · ${divergence}` : ""}
          </span>
          {git.error ? (
            <span className={styles.errorDetail} style={{ color: TOOLTIP_DIM_COLOR }}>
              {git.error}
            </span>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * 状态栏里的一项：ghost 迷你按钮，静息 muted、hover 才提亮（同 Tolaria）。
 * 用 size="sm" 而不是 icon-sm——sm 档自带状态栏该用的 14px 图标与 1.75 补偿
 * 描边（见 design.md），不必也不允许在这里另写描边规则。
 */
function StatusBarAction({
  children,
  disabled,
  onClick,
  ...rest
}: {
  children: ReactNode
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <Button
      className={styles.action}
      disabled={disabled}
      onClick={onClick}
      size="sm"
      type="button"
      variant="ghost"
      {...rest}
    >
      {children}
    </Button>
  )
}

/** 分隔用字面竖线，不用 border——border 会在 flex 里跟着高度拉伸。 */
function StatusBarSeparator() {
  return (
    <span aria-hidden="true" className={styles.separator}>
      |
    </span>
  )
}

function StatusBarMenuItem({
  icon: Icon,
  label,
  onSelect,
}: {
  icon: ShardIcon
  label: string
  onSelect: () => void
}) {
  return (
    // 延迟一拍：让 Base UI 先归还焦点，再开对话框，否则两者抢焦点
    <DropdownMenuItem onClick={() => window.setTimeout(onSelect, 0)}>
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </DropdownMenuItem>
  )
}

/**
 * 相对时间自己不会变，靠 30s 一跳的计数器把它逼出重渲染。
 * 没有同步时间就不起定时器——空跑 setState 是纯浪费。
 */
function useStatusBarTicker(active: boolean) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [active])
}

function getGitStateLabel(git: GitInfo) {
  if (git.status === "no_git") return "未初始化"
  if (git.status === "error") return "错误"
  if (!git.hasRemote) return "未配置远端"
  if (
    git.status === "dirty" ||
    git.status === "syncing" ||
    git.ahead > 0 ||
    git.behind > 0
  ) {
    return "待同步"
  }
  return "已同步"
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "正在连接服务器…",
  connected: "已连接服务器",
  reconnecting: "与服务器断开，正在重连…",
  signedOut: "登录已过期",
}

/** 桌面不登录（凭设备令牌）：令牌失效时说「连接已失效」，其余与网页同一套文案。 */
const DESKTOP_SIGNED_OUT_LABEL = "连接已失效"

/**
 * 以服务器为真相时没有本地 Git：左侧显示与服务器实时通道的状态，点开是设置（网页落在账号，桌面落在服务器）。
 * 网页的状态来自自己的 SSE 连接；桌面来自 Rust 转发的 `remote-connection` 事件。
 * 桌面另有本机副本（S8b）：离线、同步中优先显示，后面跟待上传 / 冲突 / 上传失败的条数。
 */
function ServerConnectionStatus({ onOpenSettings }: { onOpenSettings: () => void }) {
  const desktop = transport().kind === "tauri-remote"
  const [state, setState] = useState<ConnectionState>(desktop ? remoteConnectionState : getConnectionState)
  const [sync, setSync] = useState<RemoteSyncStatus | null>(desktop ? remoteSyncStatus : null)
  useEffect(() => {
    setState(desktop ? remoteConnectionState() : getConnectionState())
    return desktop ? subscribeRemoteConnection(setState) : subscribeConnection(setState)
  }, [desktop])
  useEffect(() => {
    if (!desktop) return
    setSync(remoteSyncStatus())
    return subscribeRemoteSync(setSync)
  }, [desktop])
  const signedOut = desktop && state === "signedOut"
  const label = signedOut
    ? DESKTOP_SIGNED_OUT_LABEL
    : sync?.state === "offline"
      ? SYNC_OFFLINE_LABEL
      : sync?.state === "syncing" && state === "connected"
        ? SYNC_SYNCING_LABEL
        : CONNECTION_LABEL[state]
  const offline = !signedOut && sync?.state === "offline"
  return (
    <>
      {offline ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                className={styles.action}
                onClick={() => void requestRemoteSync()}
                size="sm"
                type="button"
                variant="ghost"
              />
            }
          >
            <span aria-live="polite" className={styles.badge} data-tone="warning">
              {label}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <span className={styles.errorDetail}>{SYNC_OFFLINE_HINT}</span>
          </TooltipContent>
        </Tooltip>
      ) : (
        <StatusBarAction onClick={onOpenSettings}>
          <span aria-live="polite">{label}</span>
        </StatusBarAction>
      )}
      {sync ? <RemoteSyncCounts sync={sync} /> : null}
    </>
  )
}

const SYNC_OFFLINE_LABEL = "离线"
const SYNC_SYNCING_LABEL = "同步中…"
const SYNC_OFFLINE_HINT = "连不上服务器：碎片照常记、照常改，联网后自动上传；改名、移动、删除等需要联网。点一下立即重试。"

/** 待上传、冲突、上传失败的条数（只在有的时候出现）。冲突与失败点一下表示已看过，计数清零。 */
function RemoteSyncCounts({ sync }: { sync: RemoteSyncStatus }) {
  if (sync.pending === 0 && sync.conflicts === 0 && sync.failed === 0) return null
  return (
    <>
      <StatusBarSeparator />
      {sync.pending > 0 ? (
        <span className={styles.syncCount} data-shard-sync-pending="true">
          待上传 {sync.pending} 条
        </span>
      ) : null}
      {sync.conflicts > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                className={styles.action}
                onClick={() => void dismissRemoteSyncNotices()}
                size="sm"
                type="button"
                variant="ghost"
              />
            }
          >
            <span className={styles.badge} data-tone="warning">
              冲突 {sync.conflicts} 条
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <span className={styles.errorDetail}>
              这些碎片在别处也改过（或已删除），你的版本另存为标着「冲突副本」的新碎片。点一下表示已看过。
            </span>
          </TooltipContent>
        </Tooltip>
      ) : null}
      {sync.failed > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                className={styles.action}
                onClick={() => void dismissRemoteSyncNotices()}
                size="sm"
                type="button"
                variant="ghost"
              />
            }
          >
            <span className={styles.badge} data-tone="danger">
              上传失败 {sync.failed} 条
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <span className={styles.errorDetail}>
              这些离线修改没能上传（服务器拒绝、一直出错，或条目已移入密匣），不会再自动重试；内容已另存在本机。点一下表示已看过。
            </span>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  )
}
