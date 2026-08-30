import { open } from "@tauri-apps/plugin-dialog"
import {
  CheckIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GitBranchIcon,
  KeyboardIcon,
  Loader2Icon,
  PaletteIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react"
import { useEffect, useRef, useState, type CSSProperties } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  AUTO_SYNC_INTERVAL_OPTIONS,
  type AppSettings,
} from "@/lib/app-settings"
import {
  ACCENT_THEMES,
  applyAccentTheme,
  getStoredAccentTheme,
  type AccentTheme,
} from "@/lib/theme"
import {
  createGithubVaultRepo,
  getGithubCliStatus,
  getApiErrorMessage,
  initializeVaultGit,
  setVaultPath,
  setVaultRemote,
} from "@/lib/api"
import type { GithubCliInfo, GitInfo, VaultState } from "@/types"

import styles from "./vault-guide.module.css"

/*
 * Shared inline-style objects for text/spacing patterns that repeat verbatim
 * across sections. Kept as plain style objects (not a CSS utility layer) so
 * each still reads as "real CSS for this exact spot" — just deduplicated.
 */
const eyebrowStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: "16px",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--muted-foreground)",
}

const sectionTitleStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: "20px",
  fontWeight: 600,
}

const sectionDescriptionStyle: CSSProperties = {
  marginTop: "var(--shard-space-1)",
  fontSize: 12,
  lineHeight: "20px",
  textWrap: "pretty",
  color: "var(--muted-foreground)",
}

const monoPathStyle: CSSProperties = {
  marginTop: "var(--shard-space-1)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12,
  lineHeight: "20px",
  wordBreak: "break-all",
  color: "var(--muted-foreground)",
  userSelect: "all",
}

export type SettingsSection = "appearance" | "git" | "shortcuts" | "vault"

interface VaultGuideProps {
  autoSyncEnabled: boolean
  autoSyncIntervalMinutes: number
  git: GitInfo | null
  initialSection: SettingsSection
  isSyncing: boolean
  onAutoSyncChange: (patch: Partial<AppSettings>) => void
  onClose: () => void
  onSync: () => void
  onVaultState: (
    state: VaultState,
    options?: { resetView?: boolean }
  ) => void
  open: boolean
  required: boolean
  vaultPath: string
}

type VaultAction = "create" | "github" | "git" | "open" | "remote" | null
type SettingsLocale = "en" | "zh"

interface SettingsCopy {
  autoSyncDescription: string
  autoSyncEnableLabel: string
  autoSyncIntervalLabel: string
  autoSyncNeedsRemote: string
  autoSyncTitle: string
  close: string
  connectRemote: string
  connectRemoteBusy: string
  createRepo: string
  createRepoBusy: string
  createVaultDescription: string
  createVaultLabel: string
  dialogTitleCreate: string
  dialogTitleOpen: string
  directoryDescription: string
  directoryTitle: string
  folderSelected: string
  githubBusy: string
  githubChecking: string
  githubCurrentAccount: string
  githubIdle: string
  githubMissing: string
  githubNotAuthenticated: string
  gitDescription: string
  gitStatus: Record<"dirty" | "error" | "local" | "none" | "ready" | "syncing", string>
  headlineDefault: string
  headlineNeedsRemote: string
  initGitDescription: string
  initGitLabel: string
  manualDividerLabel: string
  manualRemoteHint: string
  navAppearance: string
  navGit: string
  navShortcuts: string
  noVault: string
  openVaultDescription: string
  openVaultLabel: string
  remoteAlreadyConnected: string
  remoteBusy: string
  remoteStatus: Record<"connected" | "connecting" | "creating" | "missing" | "pending", string>
  remoteUrlLabel: string
  repoNameLabel: string
  settingsTitle: string
  sideCurrent: string
  sideGit: string
  sideRemote: string
  syncNow: string
  syncNowBusy: string
  syncSetupTitle: string
  themeDescription: string
  themeTitle: string
  toastGithubCreated: string
  toastGithubCreatedDescription: string
  toastGithubFailed: string
  toastGitInitialized: string
  toastGitInitializeFailed: string
  toastRepoRequired: string
  toastRemoteConfigured: string
  toastRemoteFailed: string
  toastRemoteRequired: string
  toastVaultCreated: string
  toastVaultFailed: string
  toastVaultSwitched: string
  vaultTitle: string
  autoSyncMinutes(minutes: number): string
  githubAuthenticated(account: string, protocol: string): string
  githubProtocol(protocol: string): string
}

const settingsCopy: Record<SettingsLocale, SettingsCopy> = {
  en: {
    autoSyncDescription:
      "Sync to the remote on a fixed interval. Skipped while you are editing or a dialog is open.",
    autoSyncEnableLabel: "Enable auto sync",
    autoSyncIntervalLabel: "Sync interval",
    autoSyncNeedsRemote: "Connect a Git remote to enable auto sync.",
    autoSyncTitle: "Auto sync",
    close: "Close",
    connectRemote: "Connect remote",
    connectRemoteBusy: "Connecting",
    createRepo: "Auto configure sync",
    createRepoBusy: "Configuring",
    createVaultDescription: "Choose an empty folder and initialize Git.",
    createVaultLabel: "Create folder",
    dialogTitleCreate: "Choose or create a Shard vault folder",
    dialogTitleOpen: "Choose an existing vault folder",
    directoryDescription:
      "Open an existing ShardVault or choose a new folder. Switching never moves your files.",
    directoryTitle: "Folder",
    folderSelected: "Selected",
    githubBusy:
      "Initializing Git if needed, creating a private GitHub repository, connecting origin, and pushing the current commit.",
    githubChecking: "Checking GitHub CLI sign-in...",
    githubCurrentAccount: "current account",
    githubIdle:
      "When available, Shard will initialize Git if needed, create a private repository, connect origin, and push local commits.",
    githubMissing:
      "GitHub CLI was not found. You can still enter a remote URL manually.",
    githubNotAuthenticated: "gh is not signed in. Run gh auth login first.",
    gitDescription:
      "Shard uses local Git for fragment history. The remote is only for cloud sync.",
    gitStatus: {
      dirty: "Unsynced",
      error: "Git error",
      local: "Local only",
      none: "No Git",
      ready: "Ready",
      syncing: "Syncing",
    },
    headlineDefault:
      "Choose an existing Shard folder, or create a new one as the local root for Markdown and Git.",
    headlineNeedsRemote:
      "The current folder is usable, but sync is not configured yet. Auto configure GitHub sync, or enter any Git remote URL manually.",
    initGitDescription: "Enable local commit history for the current folder.",
    initGitLabel: "Initialize Git",
    manualDividerLabel: "Or connect a remote manually",
    manualRemoteHint:
      "The manual URL is saved as origin. You can also run git remote add origin <url> in the current folder.",
    navAppearance: "Appearance",
    navGit: "Git sync",
    navShortcuts: "Shortcuts",
    noVault: "No folder selected",
    openVaultDescription: "Open an existing ShardVault or Git repository.",
    openVaultLabel: "Choose folder",
    remoteAlreadyConnected:
      "The current vault already has a Git remote. Use the sidebar sync action when needed.",
    remoteBusy: "Connecting Git remote.",
    remoteStatus: {
      connected: "Connected",
      connecting: "Connecting",
      creating: "Creating",
      missing: "Not configured",
      pending: "Pending",
    },
    remoteUrlLabel: "Git remote URL",
    repoNameLabel: "GitHub repository name",
    settingsTitle: "Settings",
    sideCurrent: "Folder",
    sideGit: "Local Git",
    sideRemote: "Remote",
    syncNow: "Sync now",
    syncNowBusy: "Syncing",
    syncSetupTitle: "Set up sync",
    themeDescription:
      "Choose the restrained accent used for focus, selection, links, and primary actions.",
    themeTitle: "Accent color",
    toastGithubCreated: "Git sync configured",
    toastGithubCreatedDescription:
      "A private GitHub repository is connected as origin. Use the sidebar sync action for future updates.",
    toastGithubFailed: "GitHub setup failed",
    toastGitInitialized: "Git initialized",
    toastGitInitializeFailed: "Git initialization failed",
    toastRepoRequired: "GitHub repository name is required",
    toastRemoteConfigured: "Git remote configured",
    toastRemoteFailed: "Git remote setup failed",
    toastRemoteRequired: "Git remote URL is required",
    toastVaultCreated: "Vault created",
    toastVaultFailed: "Vault setup failed",
    toastVaultSwitched: "Vault switched",
    vaultTitle: "Vault",
    autoSyncMinutes: (minutes) => `${minutes} min`,
    githubAuthenticated: (account, protocol) =>
      `Signed in as ${account}${protocol}. Shard can configure GitHub sync automatically.`,
    githubProtocol: (protocol) => `, Git protocol ${protocol}`,
  },
  zh: {
    autoSyncDescription:
      "按固定间隔在后台同步到远端；正在编辑或有弹窗时会自动跳过。",
    autoSyncEnableLabel: "启用自动同步",
    autoSyncIntervalLabel: "同步间隔",
    autoSyncNeedsRemote: "连接 Git 远端后即可启用自动同步。",
    autoSyncTitle: "自动同步",
    close: "关闭",
    connectRemote: "连接远端",
    connectRemoteBusy: "连接中",
    createRepo: "自动配置同步",
    createRepoBusy: "配置中",
    createVaultDescription: "选择一个空目录，并为它初始化 Git。",
    createVaultLabel: "创建新目录",
    dialogTitleCreate: "选择或新建 Shard vault 目录",
    dialogTitleOpen: "选择已有 vault 目录",
    directoryDescription: "打开已有 ShardVault，或新建一个空目录。更换目录不会移动现有文件。",
    directoryTitle: "目录",
    folderSelected: "已选择",
    githubBusy: "正在初始化 Git、创建 GitHub 私有仓库、连接 origin，并推送当前提交。",
    githubChecking: "正在检查 GitHub CLI 登录状态...",
    githubCurrentAccount: "当前账号",
    githubIdle: "可用时会自动初始化 Git、创建私有仓库、连接 origin，并推送本地提交。",
    githubMissing: "未检测到 gh。可以继续手动填写远端 URL。",
    githubNotAuthenticated: "gh 尚未登录。请先运行 gh auth login。",
    gitDescription: "Shard 用本地 Git 保存片段历史，remote 只负责云端同步。",
    gitStatus: {
      dirty: "未同步",
      error: "Git 错误",
      local: "仅本地",
      none: "未初始化",
      ready: "已就绪",
      syncing: "同步中",
    },
    headlineDefault:
      "选择已有 Shard 目录，或创建一个新目录作为 Markdown 与 Git 的本地根目录。",
    headlineNeedsRemote:
      "当前目录已经可用，但还没有完成同步配置。可以自动配置 GitHub 同步，也可以手动填写任意 Git 远端。",
    initGitDescription: "为当前目录开启本地提交历史。",
    initGitLabel: "初始化 Git",
    manualDividerLabel: "或手动连接远端",
    manualRemoteHint:
      "手动 URL 会保存为 origin。也可以在当前目录运行 git remote add origin <url>。",
    navAppearance: "外观",
    navGit: "Git 同步",
    navShortcuts: "快捷键",
    noVault: "未选择目录",
    openVaultDescription: "打开已有 ShardVault 或 Git 仓库。",
    openVaultLabel: "选择已有目录",
    remoteAlreadyConnected: "当前 vault 已有 Git 远端，可以从侧栏执行同步。",
    remoteBusy: "正在连接 Git 远端。",
    remoteStatus: {
      connected: "已连接",
      connecting: "连接中",
      creating: "创建中",
      missing: "未配置",
      pending: "待配置",
    },
    remoteUrlLabel: "Git 远端 URL",
    repoNameLabel: "GitHub 仓库名",
    settingsTitle: "设置",
    sideCurrent: "目录",
    sideGit: "本地 Git",
    sideRemote: "远端",
    syncNow: "立即同步",
    syncNowBusy: "同步中",
    syncSetupTitle: "配置同步",
    themeDescription: "选择用于焦点、选中、链接和主要操作的克制强调色。",
    themeTitle: "主题色",
    toastGithubCreated: "Git 同步已配置",
    toastGithubCreatedDescription:
      "私有 GitHub 仓库已连接为 origin，后续可直接从侧栏同步。",
    toastGithubFailed: "自动配置 GitHub 失败",
    toastGitInitialized: "Git 已初始化",
    toastGitInitializeFailed: "Git 初始化失败",
    toastRepoRequired: "GitHub 仓库名不能为空",
    toastRemoteConfigured: "Git 远端已配置",
    toastRemoteFailed: "Git 远端配置失败",
    toastRemoteRequired: "Git 远端 URL 不能为空",
    toastVaultCreated: "Vault 已创建",
    toastVaultFailed: "Vault 设置失败",
    toastVaultSwitched: "Vault 已切换",
    vaultTitle: "Vault",
    autoSyncMinutes: (minutes) => `${minutes} 分钟`,
    githubAuthenticated: (account, protocol) =>
      `已登录 ${account}${protocol}。Shard 可以自动配置 GitHub 同步。`,
    githubProtocol: (protocol) => `，Git 协议 ${protocol}`,
  },
}

const shortcutRows: Record<
  SettingsLocale,
  { keys: string[]; label: string }[]
> = {
  en: [
    { keys: ["⌘", "Enter"], label: "Save fragment" },
    { keys: ["⌘", "K"], label: "Search" },
    { keys: ["⌘", "N"], label: "Quick capture" },
    { keys: ["⌘", "⇧", "F"], label: "Zen mode (in composer)" },
    { keys: ["Enter"], label: "New line" },
    { keys: ["Esc"], label: "Exit editing" },
  ],
  zh: [
    { keys: ["⌘", "Enter"], label: "保存片段" },
    { keys: ["⌘", "K"], label: "搜索" },
    { keys: ["⌘", "N"], label: "快速捕捉" },
    { keys: ["⌘", "⇧", "F"], label: "禅模式（输入框内）" },
    { keys: ["Enter"], label: "换行" },
    { keys: ["Esc"], label: "退出编辑" },
  ],
}

function getPreferredSettingsLocale(): SettingsLocale {
  const language =
    typeof navigator === "undefined"
      ? ""
      : navigator.languages?.[0] || navigator.language || ""

  return language.toLowerCase().startsWith("zh") ? "zh" : "en"
}

export function VaultGuide({
  autoSyncEnabled,
  autoSyncIntervalMinutes,
  git,
  initialSection,
  isSyncing,
  onAutoSyncChange,
  onClose,
  onSync,
  onVaultState,
  open: isOpen,
  required,
  vaultPath,
}: VaultGuideProps) {
  const [activeAction, setActiveAction] = useState<VaultAction>(null)
  const [githubStatus, setGithubStatus] = useState<GithubCliInfo | null>(null)
  const [isCheckingGithub, setIsCheckingGithub] = useState(false)
  const [remoteUrl, setRemoteUrl] = useState("")
  const [repoName, setRepoName] = useState(defaultRepoName(vaultPath))
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [accentTheme, setAccentTheme] =
    useState<AccentTheme>(getStoredAccentTheme)
  const dialogRef = useRef<HTMLDivElement>(null)
  const locale = getPreferredSettingsLocale()
  const copy = settingsCopy[locale]

  const needsRemote = Boolean(vaultPath && git && !git.hasRemote)
  const isCreatingGithubRepo = activeAction === "github"
  const isConfiguringRemote = activeAction === "remote"
  const isRemoteBusy = isCreatingGithubRepo || isConfiguringRemote
  const isVaultActionBusy = activeAction !== null
  const remoteLabel = isCreatingGithubRepo
    ? copy.remoteStatus.creating
    : isConfiguringRemote
      ? copy.remoteStatus.connecting
      : needsRemote
        ? copy.remoteStatus.missing
        : git?.hasRemote
          ? copy.remoteStatus.connected
          : copy.remoteStatus.pending
  const folderName =
    vaultPath.split(/[\\/]/).filter(Boolean).pop() || copy.vaultTitle
  const gitTone: StationTone =
    !git || git.status === "no_git"
      ? "empty"
      : git.status === "error"
        ? "ruby"
        : git.status === "dirty"
          ? "amber"
          : git.status === "syncing"
            ? "info"
            : "emerald"
  const remoteTone: StationTone = isRemoteBusy
    ? "info"
    : git?.hasRemote
      ? "emerald"
      : needsRemote
        ? "amber"
        : "empty"

  useEffect(() => {
    setRepoName(defaultRepoName(vaultPath))
  }, [vaultPath])

  useEffect(() => {
    if (isOpen) {
      setSection(initialSection)
    }
  }, [initialSection, isOpen])

  useEffect(() => {
    if (!isOpen || !needsRemote) {
      setIsCheckingGithub(false)
      return
    }

    let cancelled = false
    let frameId: number | null = null
    let timerId: number | null = null

    frameId = window.requestAnimationFrame(() => {
      timerId = window.setTimeout(() => {
        if (cancelled) return

        setIsCheckingGithub(true)
        void getGithubCliStatus()
          .then((status) => {
            if (!cancelled) {
              setGithubStatus(status)
            }
          })
          .catch((error) => {
            if (!cancelled) {
              setGithubStatus({
                authenticated: false,
                error: getApiErrorMessage(error),
                installed: false,
                login: null,
                protocol: null,
              })
            }
          })
          .finally(() => {
            if (!cancelled) {
              setIsCheckingGithub(false)
            }
          })
      }, 0)
    })

    return () => {
      cancelled = true
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId)
      }
      if (timerId !== null) {
        window.clearTimeout(timerId)
      }
    }
  }, [isOpen, needsRemote])

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        dialogRef.current?.focus()
      })
    }
  }, [isOpen])

  if (!isOpen) return null

  const gitLabel = getGitStatusLabel(git, copy)

  async function chooseVault(initializeGit: boolean) {
    setActiveAction(initializeGit ? "create" : "open")

    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: initializeGit ? copy.dialogTitleCreate : copy.dialogTitleOpen,
      })

      const path = Array.isArray(selected) ? selected[0] : selected
      if (!path) return

      const state = await setVaultPath(path, initializeGit)
      onVaultState(state, { resetView: true })
      toast(initializeGit ? copy.toastVaultCreated : copy.toastVaultSwitched)
    } catch (error) {
      toast.error(`${copy.toastVaultFailed}: ${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    } finally {
      setActiveAction(null)
    }
  }

  async function initializeGit() {
    setActiveAction("git")

    try {
      const state = await initializeVaultGit()
      onVaultState(state)
      toast(copy.toastGitInitialized)
    } catch (error) {
      toast.error(
        `${copy.toastGitInitializeFailed}: ${getApiErrorMessage(error)}`,
        {
          duration: Infinity,
        }
      )
    } finally {
      setActiveAction(null)
    }
  }

  async function configureRemote() {
    const nextRemoteUrl = remoteUrl.trim()
    if (!nextRemoteUrl) {
      toast.error(copy.toastRemoteRequired, { duration: Infinity })
      return
    }

    setActiveAction("remote")

    try {
      const state = await setVaultRemote(nextRemoteUrl)
      onVaultState(state)
      setRemoteUrl("")
      toast(copy.toastRemoteConfigured)
    } catch (error) {
      toast.error(`${copy.toastRemoteFailed}: ${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    } finally {
      setActiveAction(null)
    }
  }

  async function createGithubRepo() {
    const nextRepoName = repoName.trim()
    if (!nextRepoName) {
      toast.error(copy.toastRepoRequired, { duration: Infinity })
      return
    }

    setActiveAction("github")

    try {
      const state = await createGithubVaultRepo(nextRepoName)
      onVaultState(state)
      toast(`${copy.toastGithubCreated}: ${copy.toastGithubCreatedDescription}`)
    } catch (error) {
      toast.error(`${copy.toastGithubFailed}: ${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    } finally {
      setActiveAction(null)
    }
  }

  const railSection = (
    <section className={styles.sectionPad}>
      <div className={styles.railRow}>
        <RailStation
          label={copy.sideCurrent}
          tone={vaultPath ? "emerald" : "empty"}
          value={vaultPath ? copy.folderSelected : copy.noVault}
        />
        <RailConnector />
        <RailStation
          detail={
            git?.shortCommit
              ? `${git.branch} · ${git.shortCommit}`
              : git?.error || undefined
          }
          label={copy.sideGit}
          tone={gitTone}
          value={gitLabel}
        />
        <RailConnector />
        <RailStation
          detail={git?.hasRemote ? "origin" : undefined}
          label={copy.sideRemote}
          tone={remoteTone}
          value={remoteLabel}
        />
      </div>
      <p style={{ ...sectionDescriptionStyle, marginTop: "var(--shard-space-4)" }}>
        {git?.hasRemote ? copy.remoteAlreadyConnected : copy.gitDescription}
      </p>
    </section>
  )

  const gitSetupSections = (
    <>
      {vaultPath && git?.status === "no_git" ? (
        <section className={styles.sectionPad}>
          <VaultActionButton
            active={activeAction === "git"}
            disabled={isVaultActionBusy}
            description={copy.initGitDescription}
            icon={GitBranchIcon}
            label={copy.initGitLabel}
            onClick={() => void initializeGit()}
          />
        </section>
      ) : null}

      {needsRemote ? (
        <section aria-busy={isRemoteBusy} className={styles.sectionPad}>
          <h3 style={sectionTitleStyle}>{copy.syncSetupTitle}</h3>
          <p style={sectionDescriptionStyle}>{copy.headlineNeedsRemote}</p>

          {isRemoteBusy ? (
            <div
              className="flex items-center gap-2"
              style={{
                marginTop: "var(--shard-space-3)",
                borderRadius: "var(--shard-radius-control)",
                border: "1px solid var(--border)",
                background: "var(--background)",
                paddingInline: "var(--shard-space-3)",
                paddingBlock: "var(--shard-space-2)",
                fontSize: 14,
                lineHeight: "20px",
                color: "var(--muted-foreground)",
              }}
            >
              <Loader2Icon
                className={styles.spin}
                size={16}
                style={{ flexShrink: 0 }}
              />
              <span>
                {isCreatingGithubRepo ? copy.githubBusy : copy.remoteBusy}
              </span>
            </div>
          ) : null}

          <div style={{ marginTop: "var(--shard-space-4)" }}>
            <div
              className="flex items-center gap-2"
              style={{ fontSize: 14, lineHeight: "20px", fontWeight: 600 }}
            >
              <GitBranchIcon size={16} style={{ flexShrink: 0 }} />
              GitHub
            </div>
            <p
              style={{
                ...sectionDescriptionStyle,
                marginTop: "var(--shard-space-1)",
              }}
            >
              {getGithubStatusText(githubStatus, isCheckingGithub, copy)}
            </p>
            <form
              className={styles.formGrid}
              onSubmit={(event) => {
                event.preventDefault()
                void createGithubRepo()
              }}
              style={{ marginTop: "var(--shard-space-2)" }}
            >
              <label className="sr-only" htmlFor="vault-github-repository">
                {copy.repoNameLabel}
              </label>
              <Input
                disabled={
                  isRemoteBusy ||
                  isCheckingGithub ||
                  !githubStatus?.authenticated
                }
                id="vault-github-repository"
                onChange={(event) => setRepoName(event.target.value)}
                value={repoName}
              />
              <Button
                disabled={
                  isRemoteBusy ||
                  isCheckingGithub ||
                  !githubStatus?.authenticated
                }
                type="submit"
                variant="default"
              >
                {isCreatingGithubRepo ? copy.createRepoBusy : copy.createRepo}
              </Button>
            </form>
          </div>

          <div
            className="flex items-center gap-3"
            role="separator"
            style={{ marginTop: "var(--shard-space-4)" }}
          >
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs font-medium text-muted-foreground">
              {copy.manualDividerLabel}
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <form
            className={styles.formGrid}
            onSubmit={(event) => {
              event.preventDefault()
              void configureRemote()
            }}
            style={{ marginTop: "var(--shard-space-3)" }}
          >
            <label className="sr-only" htmlFor="vault-remote-url">
              {copy.remoteUrlLabel}
            </label>
            <Input
              disabled={isRemoteBusy}
              id="vault-remote-url"
              onChange={(event) => setRemoteUrl(event.target.value)}
              placeholder="git@github.com:you/shard-vault.git"
              value={remoteUrl}
            />
            <Button
              disabled={isRemoteBusy}
              type="submit"
              variant="default"
            >
              {isConfiguringRemote
                ? copy.connectRemoteBusy
                : copy.connectRemote}
            </Button>
          </form>
          <p
            style={{
              ...sectionDescriptionStyle,
              marginTop: "var(--shard-space-2)",
            }}
          >
            {copy.manualRemoteHint}
          </p>
        </section>
      ) : null}
    </>
  )

  const appearanceSection = (
    <section className={styles.sectionPad}>
      <h3 style={sectionTitleStyle}>{copy.themeTitle}</h3>
      <p style={sectionDescriptionStyle}>{copy.themeDescription}</p>
      <div className={styles.themeGrid}>
        {ACCENT_THEMES.map((theme) => {
          const isActive = accentTheme === theme.id
          const label = locale === "zh" ? theme.labelZh : theme.labelEn

          return (
            <button
              aria-pressed={isActive}
              className={styles.themeButton}
              key={theme.id}
              onClick={() => {
                applyAccentTheme(theme.id)
                setAccentTheme(theme.id)
              }}
              type="button"
            >
              <span
                aria-hidden="true"
                className={styles.themeSwatch}
                style={{ background: theme.hex }}
              />
              <span className={styles.themeLabel}>{label}</span>
              {isActive ? (
                <CheckIcon
                  aria-hidden="true"
                  className={styles.themeCheck}
                  size={16}
                  strokeWidth={2}
                />
              ) : null}
            </button>
          )
        })}
      </div>
    </section>
  )

  const directorySection = (
    <section className={styles.sectionPad}>
      <h3 style={sectionTitleStyle}>{copy.directoryTitle}</h3>
      <p style={sectionDescriptionStyle}>{copy.directoryDescription}</p>
      <div
        className={styles.directoryGrid}
        style={{ marginTop: "var(--shard-space-3)" }}
      >
        <VaultActionButton
          active={activeAction === "open"}
          disabled={isVaultActionBusy}
          description={copy.openVaultDescription}
          icon={FolderOpenIcon}
          label={copy.openVaultLabel}
          onClick={() => void chooseVault(false)}
        />
        <VaultActionButton
          active={activeAction === "create"}
          disabled={isVaultActionBusy}
          description={copy.createVaultDescription}
          icon={FolderPlusIcon}
          label={copy.createVaultLabel}
          onClick={() => void chooseVault(true)}
        />
      </div>
    </section>
  )

  if (required || !vaultPath) {
    return (
      <Dialog
        open={isOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !required) onClose()
        }}
      >
        <DialogContent
          className={`${styles.panelBase} ${styles.panelSolo} gap-0 p-0 ring-0`}
          finalFocus={getUtilityMenuTrigger}
          ref={dialogRef}
          showCloseButton={false}
          style={{
            maxWidth: 620,
            maxHeight: "min(86dvh, 720px)",
          }}
        >
          <header className={styles.headerBlock}>
            <div className="flex items-center justify-between gap-3">
              <span style={eyebrowStyle}>
                {copy.settingsTitle}
                {vaultPath ? ` · ${copy.vaultTitle}` : ""}
              </span>
              {!required ? (
                <Button
                  aria-label={copy.close}
                  onClick={onClose}
                  size="icon-sm"
                  style={{ marginTop: -4, marginRight: -8 }}
                  type="button"
                  variant="ghost"
                >
                  <XIcon aria-hidden="true" />
                  <span className="sr-only">{copy.close}</span>
                </Button>
              ) : null}
            </div>
            <DialogTitle
              style={{
                marginTop: "var(--shard-space-1)",
                fontSize: 18,
                lineHeight: "24px",
                fontWeight: 600,
                textWrap: "balance",
              }}
            >
              {vaultPath ? folderName : copy.vaultTitle}
            </DialogTitle>
            {vaultPath ? (
              <DialogDescription style={monoPathStyle}>
                {vaultPath}
              </DialogDescription>
            ) : (
              <DialogDescription
                style={{
                  marginTop: "var(--shard-space-2)",
                  fontSize: 14,
                  lineHeight: "24px",
                  textWrap: "pretty",
                  color: "var(--muted-foreground)",
                }}
              >
                {copy.headlineDefault}
              </DialogDescription>
            )}
          </header>

          <main className={styles.mainScroll}>
            {railSection}
            {gitSetupSections}
            {directorySection}
          </main>
        </DialogContent>
      </Dialog>
    )
  }

  const navItems: { icon: typeof FolderOpenIcon; id: SettingsSection; label: string }[] = [
    { icon: FolderOpenIcon, id: "vault", label: copy.vaultTitle },
    { icon: PaletteIcon, id: "appearance", label: copy.navAppearance },
    { icon: GitBranchIcon, id: "git", label: copy.navGit },
    { icon: KeyboardIcon, id: "shortcuts", label: copy.navShortcuts },
  ]
  const sectionTitle =
    section === "appearance"
      ? copy.navAppearance
      : section === "git"
        ? copy.navGit
        : section === "shortcuts"
          ? copy.navShortcuts
          : copy.vaultTitle

  return (
    <Dialog open={isOpen} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent
        className={`${styles.panelBase} ${styles.panelFull} gap-0 p-0 ring-0`}
        finalFocus={getUtilityMenuTrigger}
        ref={dialogRef}
        showCloseButton={false}
        style={{
          maxWidth: 760,
          maxHeight: "min(84dvh, 640px)",
          minHeight: "min(84dvh, 520px)",
        }}
      >
        <DialogDescription className="sr-only">
          配置 Shard 的目录、外观、Git 同步与快捷键。
        </DialogDescription>
        <nav className={styles.navRail}>
          <div className={styles.navEyebrow}>{copy.settingsTitle}</div>
          {navItems.map(({ icon: Icon, id, label }) => {
            const isActive = section === id
            return (
              <button
                className={styles.navButton}
                key={id}
                onClick={() => setSection(id)}
                style={
                  isActive
                    ? {
                        background: "var(--sidebar-accent)",
                        color: "var(--sidebar-accent-foreground)",
                      }
                    : undefined
                }
                type="button"
              >
                <Icon size={16} strokeWidth={1.75} style={{ flexShrink: 0 }} />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </span>
              </button>
            )
          })}
        </nav>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            minWidth: 0,
            flexGrow: 1,
            flexShrink: 1,
            flexBasis: 0,
          }}
        >
          <header
            className="flex items-center justify-between gap-3"
            style={{
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
              paddingBlock: "var(--shard-space-3)",
              paddingInline: "var(--shard-space-6)",
            }}
          >
            <DialogTitle
              style={{ fontSize: 16, lineHeight: "24px", fontWeight: 600 }}
            >
              {sectionTitle}
            </DialogTitle>
            <Button
              aria-label={copy.close}
              onClick={onClose}
              size="icon-sm"
              style={{ marginRight: -8 }}
              type="button"
              variant="ghost"
            >
              <XIcon aria-hidden="true" />
              <span className="sr-only">{copy.close}</span>
            </Button>
          </header>

          <main className={styles.mainScroll}>
            {section === "appearance" ? appearanceSection : null}

            {section === "vault" ? (
              <>
                <section className={styles.sectionPad}>
                  <div style={eyebrowStyle}>{copy.sideCurrent}</div>
                  <div
                    style={{
                      marginTop: "var(--shard-space-1)",
                      fontSize: 16,
                      lineHeight: "24px",
                      fontWeight: 600,
                      textWrap: "balance",
                    }}
                  >
                    {folderName}
                  </div>
                  <p style={monoPathStyle}>{vaultPath}</p>
                </section>
                {directorySection}
              </>
            ) : null}

            {section === "git" ? (
              <>
                {railSection}
                {gitSetupSections}
                <section className={styles.sectionPad}>
                  <div className="flex items-start justify-between gap-4">
                    <div style={{ minWidth: 0 }}>
                      <h3 style={sectionTitleStyle}>{copy.autoSyncTitle}</h3>
                      <p style={sectionDescriptionStyle}>
                        {copy.autoSyncDescription}
                      </p>
                    </div>
                    <Switch
                      aria-label={copy.autoSyncEnableLabel}
                      checked={autoSyncEnabled}
                      disabled={!git?.hasRemote}
                      onCheckedChange={(next) =>
                        onAutoSyncChange({ autoSyncEnabled: next })
                      }
                    />
                  </div>
                  {git?.hasRemote ? (
                    <div
                      className="flex flex-wrap items-center gap-3"
                      style={{ marginTop: "var(--shard-space-4)" }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          lineHeight: "20px",
                          fontWeight: 500,
                          color: "var(--muted-foreground)",
                        }}
                      >
                        {copy.autoSyncIntervalLabel}
                      </span>
                      <div className="flex gap-1">
                        {AUTO_SYNC_INTERVAL_OPTIONS.map((minutes) => {
                          const isSelected =
                            minutes === autoSyncIntervalMinutes
                          return (
                            <button
                              className={styles.intervalButton}
                              disabled={!autoSyncEnabled}
                              key={minutes}
                              onClick={() =>
                                onAutoSyncChange({
                                  autoSyncIntervalMinutes: minutes,
                                })
                              }
                              style={
                                isSelected
                                  ? {
                                      borderColor: "var(--shard-sapphire)",
                                      background: "var(--shard-sapphire-soft)",
                                      color: "var(--shard-sapphire-text)",
                                    }
                                  : undefined
                              }
                              type="button"
                            >
                              {copy.autoSyncMinutes(minutes)}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ) : (
                    <p
                      style={{
                        ...sectionDescriptionStyle,
                        marginTop: "var(--shard-space-3)",
                      }}
                    >
                      {copy.autoSyncNeedsRemote}
                    </p>
                  )}
                  <div style={{ marginTop: "var(--shard-space-4)" }}>
                    <Button
                      disabled={isSyncing || !git?.hasRemote}
                      onClick={onSync}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      {isSyncing ? (
                        <Loader2Icon
                          aria-hidden="true"
                          className={styles.spin}
                        />
                      ) : (
                        <RefreshCwIcon aria-hidden="true" />
                      )}
                      {isSyncing ? copy.syncNowBusy : copy.syncNow}
                    </Button>
                  </div>
                </section>
              </>
            ) : null}

            {section === "shortcuts" ? (
              <section className={styles.sectionPadCompact}>
                <div>
                  {shortcutRows[locale].map((row, index) => (
                    <div
                      className="flex items-center justify-between gap-4"
                      key={row.label}
                      style={{
                        borderTop:
                          index === 0 ? "none" : "1px solid var(--border)",
                        paddingBlock: "var(--shard-space-3)",
                      }}
                    >
                      <span style={{ fontSize: 14, lineHeight: "20px" }}>
                        {row.label}
                      </span>
                      <div
                        className="flex items-center gap-1"
                        style={{ flexShrink: 0 }}
                      >
                        {row.keys.map((key) => (
                          <kbd className={styles.kbdKey} key={key}>
                            {key}
                          </kbd>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </main>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function defaultRepoName(vaultPath: string) {
  const name = vaultPath.split(/[\\/]/).filter(Boolean).pop() || "ShardVault"
  return (
    name
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "shard-vault"
  )
}

function getUtilityMenuTrigger() {
  return (
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "[data-shard-utility-menu-trigger]"
      )
    ).find((trigger) => trigger.getClientRects().length > 0) ?? null
  )
}

function getGitStatusLabel(git: GitInfo | null, copy: SettingsCopy) {
  if (!git) return copy.noVault

  switch (git.status) {
    case "ready":
      return git.hasRemote ? copy.gitStatus.ready : copy.gitStatus.local
    case "dirty":
      return copy.gitStatus.dirty
    case "syncing":
      return copy.gitStatus.syncing
    case "error":
      return copy.gitStatus.error
    case "no_git":
    default:
      return copy.gitStatus.none
  }
}

function getGithubStatusText(
  githubStatus: GithubCliInfo | null,
  isCheckingGithub: boolean,
  copy: SettingsCopy
) {
  if (isCheckingGithub) return copy.githubChecking
  if (!githubStatus) return copy.githubIdle
  if (!githubStatus.installed) return copy.githubMissing
  if (!githubStatus.authenticated) {
    return githubStatus.error ?? copy.githubNotAuthenticated
  }

  const account = githubStatus.login
    ? `@${githubStatus.login}`
    : copy.githubCurrentAccount
  const protocol = githubStatus.protocol
    ? copy.githubProtocol(githubStatus.protocol)
    : ""
  return copy.githubAuthenticated(account, protocol)
}

type StationTone = "amber" | "emerald" | "empty" | "info" | "ruby"

const stationToneStyle: Record<StationTone, CSSProperties> = {
  amber: {
    background: "var(--shard-amber)",
    boxShadow: "0 0 0 3px rgb(var(--shard-amber-rgb) / var(--shard-alpha-13))",
  },
  emerald: {
    background: "var(--shard-emerald)",
    boxShadow:
      "0 0 0 3px rgb(var(--shard-emerald-rgb) / var(--shard-alpha-13))",
  },
  empty: {
    border:
      "1.5px solid color-mix(in srgb, var(--muted-foreground) 55%, transparent)",
  },
  info: {
    background: "var(--shard-info)",
    boxShadow: "0 0 0 3px rgb(var(--shard-info-rgb) / var(--shard-alpha-13))",
  },
  ruby: {
    background: "var(--shard-ruby)",
    boxShadow: "0 0 0 3px rgb(var(--shard-ruby-rgb) / var(--shard-alpha-13))",
  },
}

function RailConnector() {
  return <span aria-hidden="true" className={styles.railConnector} />
}

interface RailStationProps {
  detail?: string
  label: string
  tone: StationTone
  value: string
}

function RailStation({ detail, label, tone, value }: RailStationProps) {
  return (
    <div className={styles.railStation}>
      <span
        aria-hidden="true"
        className={tone === "info" ? styles.pulseDot : undefined}
        style={{
          marginTop: 3,
          width: 10,
          height: 10,
          flexShrink: 0,
          borderRadius: "9999px",
          ...stationToneStyle[tone],
        }}
      />
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 11,
            lineHeight: "16px",
            fontWeight: 600,
            color: "var(--muted-foreground)",
          }}
        >
          {label}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 14,
            lineHeight: "20px",
            fontWeight: 600,
          }}
        >
          {value}
        </span>
        {detail ? (
          <span
            style={{
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              fontSize: 12,
              lineHeight: "16px",
              color: "var(--muted-foreground)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {detail}
          </span>
        ) : null}
      </span>
    </div>
  )
}

interface VaultActionButtonProps {
  active: boolean
  disabled?: boolean
  description: string
  icon: typeof FolderOpenIcon
  label: string
  onClick: () => void
}

function VaultActionButton({
  active,
  disabled = false,
  description,
  icon: Icon,
  label,
  onClick,
}: VaultActionButtonProps) {
  return (
    <button
      className={styles.actionButton}
      disabled={disabled || active}
      onClick={onClick}
      type="button"
    >
      <span
        style={{
          display: "flex",
          width: 32,
          height: 32,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "var(--shard-radius-control)",
          background: "var(--muted)",
          color: "var(--muted-foreground)",
        }}
      >
        {active ? (
          <Loader2Icon className={styles.spin} size={16} />
        ) : (
          <Icon size={16} />
        )}
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 14,
            lineHeight: "20px",
            fontWeight: 600,
            textWrap: "balance",
          }}
        >
          {label}
        </span>
        <span
          style={{
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 12,
            lineHeight: "16px",
            color: "var(--muted-foreground)",
          }}
        >
          {description}
        </span>
      </span>
    </button>
  )
}
