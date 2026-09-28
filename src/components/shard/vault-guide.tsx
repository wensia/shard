import { open } from "@tauri-apps/plugin-dialog"
import {
  CheckIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GitBranchIcon,
  KeyboardIcon,
  Loader2Icon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  RefreshCwIcon,
  SquareTerminalIcon,
  SunIcon,
  XIcon,
} from "@/components/icons"
import { useEffect, useRef, useState, type CSSProperties } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { SelectControl } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  AUTO_SYNC_INTERVAL_OPTIONS,
  type AppSettings,
} from "@/lib/app-settings"
import {
  ACCENT_THEMES,
  COLOR_MODES,
  applyAccentTheme,
  applyColorMode,
  getStoredAccentTheme,
  getStoredColorMode,
  type AccentTheme,
  type ColorMode,
} from "@/lib/theme"
import {
  createGithubVaultRepo,
  getCliInstallStatus,
  getGithubCliStatus,
  getApiErrorMessage,
  initializeVaultGit,
  installCli,
  setVaultPath,
  setVaultRemote,
  uninstallCli,
} from "@/lib/api"
import { notify } from "@/lib/notify"
import type {
  CliInstallStatus,
  GithubCliInfo,
  GitInfo,
  VaultState,
} from "@/types"

import {
  SettingsBlock,
  SettingsGroup,
  SettingsGroupItem,
  SettingsMono,
  SettingsRow,
  SettingsSegmented,
} from "./settings-controls"
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

export type SettingsSection = "appearance" | "cli" | "git" | "shortcuts" | "vault"

/** 设置单页里的分区顺序，也是左侧锚点导航的顺序。 */
const SETTINGS_SECTIONS: SettingsSection[] = ["vault", "git", "appearance", "cli", "shortcuts"]

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
type CliAction = "install" | "uninstall" | null
type SettingsLocale = "en" | "zh"

interface SettingsCopy {
  autoSyncDescription: string
  autoSyncEnableLabel: string
  autoSyncIntervalDescription: string
  autoSyncIntervalLabel: string
  autoSyncNeedsRemote: string
  autoSyncTitle: string
  close: string
  cliActionFailed: string
  cliCommandLabel: string
  cliStatusRowLabel: string
  cliConflict: string
  cliConflictShort: string
  cliDescription: string
  cliInstall: string
  cliInstallBusy: string
  cliInstalled: string
  cliInstalledToast: string
  cliNeedsShellConfig: string
  cliNotInstalled: string
  cliStatusChecking: string
  cliStatusFailed: string
  cliTitle: string
  cliUnavailable: string
  cliUninstall: string
  cliUninstallBusy: string
  cliUninstalledToast: string
  cliUsage: string
  connectRemote: string
  connectRemoteBusy: string
  createRepo: string
  createRepoBusy: string
  createVaultAction: string
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
  currentVaultLabel: string
  initGitAction: string
  initGitDescription: string
  initGitLabel: string
  manualDividerLabel: string
  manualRemoteLabel: string
  manualRemoteHint: string
  navAppearance: string
  navLabel: string
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
  syncNowDescription: string
  syncSetupTitle: string
  colorModeDescription: string
  colorModeTitle: string
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
  vaultMoveHint: string
  vaultTitle: string
  autoSyncMinutes(minutes: number): string
  githubAuthenticated(account: string, protocol: string): string
  githubProtocol(protocol: string): string
  cliLinkPath(path: string): string
  cliShellConfigPath(path: string): string
}

const COLOR_MODE_ICONS: Record<ColorMode, typeof SunIcon> = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
}

const settingsCopy: Record<SettingsLocale, SettingsCopy> = {
  en: {
    autoSyncDescription:
      "Sync to the remote on a fixed interval. Skipped while you are editing or a dialog is open.",
    autoSyncEnableLabel: "Enable auto sync",
    autoSyncIntervalDescription: "How often Shard syncs in the background.",
    autoSyncIntervalLabel: "Sync interval",
    autoSyncNeedsRemote: "Connect a Git remote to enable auto sync.",
    autoSyncTitle: "Auto sync",
    close: "Close",
    cliActionFailed: "Terminal command update failed",
    cliCommandLabel: "shard command",
    cliStatusRowLabel: "Status",
    cliConflict:
      "A non-Shard command named shard already exists. Shard will not overwrite it.",
    cliConflictShort: "Conflict",
    cliDescription:
      "Create a fragment directly from any terminal without opening the app.",
    cliInstall: "Install",
    cliInstallBusy: "Installing",
    cliInstalled: "Installed",
    cliInstalledToast: "The shard terminal command is installed",
    cliNeedsShellConfig: "Not installed",
    cliNotInstalled: "Not installed",
    cliStatusChecking: "Checking installation status...",
    cliStatusFailed: "Could not read the installation status",
    cliTitle: "Terminal command",
    cliUnavailable: "Unavailable in development builds",
    cliUninstall: "Uninstall",
    cliUninstallBusy: "Uninstalling",
    cliUninstalledToast: "The shard terminal command is uninstalled",
    cliUsage: "Example: shard #备忘 /任务列表 买咖啡",
    connectRemote: "Connect remote",
    connectRemoteBusy: "Connecting",
    createRepo: "Auto configure sync",
    createRepoBusy: "Configuring",
    createVaultAction: "Create",
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
    currentVaultLabel: "Current folder",
    initGitAction: "Initialize",
    initGitDescription: "Enable local commit history for the current folder.",
    initGitLabel: "Initialize Git",
    manualDividerLabel: "Or connect a remote manually",
    manualRemoteLabel: "Manual remote",
    manualRemoteHint:
      "The manual URL is saved as origin. You can also run git remote add origin <url> in the current folder.",
    navAppearance: "Appearance",
    navLabel: "Settings sections",
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
    syncNowDescription: "Pull from the remote and push local commits now.",
    syncSetupTitle: "Set up sync",
    colorModeDescription:
      "Follow the system appearance, or keep Shard light or dark.",
    colorModeTitle: "Appearance",
    themeDescription:
      "Choose the restrained accent used for focus, selection, links, and primary actions.",
    themeTitle: "Accent color",
    toastGithubCreated: "Git sync configured",
    toastGithubCreatedDescription:
      "Connected to a private GitHub repository. Sync from the sidebar.",
    toastGithubFailed: "GitHub sync setup failed",
    toastGitInitialized: "Git initialized",
    toastGitInitializeFailed: "Git initialization failed",
    toastRepoRequired: "GitHub repository name is required",
    toastRemoteConfigured: "Git remote configured",
    toastRemoteFailed: "Git remote setup failed",
    toastRemoteRequired: "Git remote URL is required",
    toastVaultCreated: "Vault created",
    toastVaultFailed: "Vault setup failed",
    toastVaultSwitched: "Vault switched",
    vaultMoveHint: "Switching folders never moves your files.",
    vaultTitle: "Vault",
    autoSyncMinutes: (minutes) => `${minutes} min`,
    githubAuthenticated: (account, protocol) =>
      `Signed in as ${account}${protocol}. Shard can configure GitHub sync automatically.`,
    githubProtocol: (protocol) => `, Git protocol ${protocol}`,
    cliLinkPath: (path) => `Link: ${path}`,
    cliShellConfigPath: (path) => `Installation will update: ${path}`,
  },
  zh: {
    autoSyncDescription:
      "按固定间隔在后台同步到远端；正在编辑或有弹窗时会自动跳过。",
    autoSyncEnableLabel: "启用自动同步",
    autoSyncIntervalDescription: "后台自动同步的频率。",
    autoSyncIntervalLabel: "同步间隔",
    autoSyncNeedsRemote: "连接 Git 远端后即可启用自动同步。",
    autoSyncTitle: "自动同步",
    close: "关闭",
    cliActionFailed: "终端命令操作失败",
    cliCommandLabel: "shard 命令",
    cliStatusRowLabel: "安装状态",
    cliConflict: "已存在非 Shard 的 shard 命令，Shard 不会覆盖它。",
    cliConflictShort: "有冲突",
    cliDescription: "无需打开 App，直接从任意终端创建碎片。",
    cliInstall: "安装",
    cliInstallBusy: "安装中",
    cliInstalled: "已安装",
    cliInstalledToast: "终端命令 shard 已安装",
    cliNeedsShellConfig: "未安装",
    cliNotInstalled: "未安装",
    cliStatusChecking: "正在检查安装状态…",
    cliStatusFailed: "无法读取安装状态",
    cliTitle: "终端命令",
    cliUnavailable: "开发版不可用",
    cliUninstall: "卸载",
    cliUninstallBusy: "卸载中",
    cliUninstalledToast: "终端命令 shard 已卸载",
    cliUsage: "示例：shard #备忘 /任务列表 买咖啡",
    connectRemote: "连接远端",
    connectRemoteBusy: "连接中",
    createRepo: "自动配置同步",
    createRepoBusy: "配置中",
    createVaultAction: "新建",
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
    currentVaultLabel: "当前目录",
    initGitAction: "初始化",
    initGitDescription: "为当前目录开启本地提交历史。",
    initGitLabel: "初始化 Git",
    manualDividerLabel: "或手动连接远端",
    manualRemoteLabel: "手动连接远端",
    manualRemoteHint:
      "手动 URL 会保存为 origin。也可以在当前目录运行 git remote add origin <url>。",
    navAppearance: "外观",
    navLabel: "设置分区",
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
    syncNowDescription: "马上拉取远端并推送本地提交。",
    syncSetupTitle: "配置同步",
    colorModeDescription: "跟随系统外观，或固定使用浅色、深色。",
    colorModeTitle: "明暗",
    themeDescription: "选择用于焦点、选中、链接和主要操作的克制强调色。",
    themeTitle: "主题色",
    toastGithubCreated: "Git 同步已配置",
    toastGithubCreatedDescription: "已连接私有 GitHub 仓库，之后可从侧栏同步。",
    toastGithubFailed: "GitHub 同步配置失败",
    toastGitInitialized: "Git 已初始化",
    toastGitInitializeFailed: "Git 初始化失败",
    toastRepoRequired: "GitHub 仓库名不能为空",
    toastRemoteConfigured: "Git 远端已配置",
    toastRemoteFailed: "Git 远端配置失败",
    toastRemoteRequired: "Git 远端地址不能为空",
    toastVaultCreated: "Vault 已创建",
    toastVaultFailed: "Vault 设置失败",
    toastVaultSwitched: "Vault 已切换",
    vaultMoveHint: "更换目录不会移动现有文件。",
    vaultTitle: "Vault",
    autoSyncMinutes: (minutes) => `${minutes} 分钟`,
    githubAuthenticated: (account, protocol) =>
      `已登录 ${account}${protocol}。Shard 可以自动配置 GitHub 同步。`,
    githubProtocol: (protocol) => `，Git 协议 ${protocol}`,
    cliLinkPath: (path) => `链接位置：${path}`,
    cliShellConfigPath: (path) => `安装时将修改：${path}`,
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
    { keys: ["⌘", "B"], label: "Collapse/expand sidebar" },
    { keys: ["⌘", "⇧", "F"], label: "Zen mode (in composer)" },
    { keys: ["Enter"], label: "New line" },
    { keys: ["Esc"], label: "Exit editing" },
    { keys: ["F6 / ⇧F6"], label: "Next / previous work area" },
  ],
  zh: [
    { keys: ["⌘", "Enter"], label: "保存片段" },
    { keys: ["⌘", "K"], label: "搜索" },
    { keys: ["⌘", "N"], label: "快速捕捉" },
    { keys: ["⌘", "B"], label: "折叠/展开侧边栏" },
    { keys: ["⌘", "⇧", "F"], label: "禅模式（输入框内）" },
    { keys: ["Enter"], label: "换行" },
    { keys: ["Esc"], label: "退出编辑" },
    { keys: ["F6 / ⇧F6"], label: "切换到下一/上一工作区域" },
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
  const [cliAction, setCliAction] = useState<CliAction>(null)
  const [cliError, setCliError] = useState<string | null>(null)
  const [cliStatus, setCliStatus] = useState<CliInstallStatus | null>(null)
  const [githubStatus, setGithubStatus] = useState<GithubCliInfo | null>(null)
  const [isCheckingGithub, setIsCheckingGithub] = useState(false)
  const [remoteUrl, setRemoteUrl] = useState("")
  const [repoName, setRepoName] = useState(defaultRepoName(vaultPath))
  const [activeSection, setActiveSection] =
    useState<SettingsSection>(initialSection)
  const [accentTheme, setAccentTheme] =
    useState<AccentTheme>(getStoredAccentTheme)
  const [colorMode, setColorMode] = useState<ColorMode>(getStoredColorMode)
  const dialogRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const spyFrameRef = useRef<number | null>(null)
  const spyTargetRef = useRef<{ top: number; until: number } | null>(null)
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

  const showsFullSettings = !required && Boolean(vaultPath)

  /** 只滚设置内容区自身：WKWebView 里 scrollIntoView 会连带滚动外层容器。 */
  function scrollToSection(id: SettingsSection, behavior: ScrollBehavior) {
    setActiveSection(id)
    const root = scrollRef.current
    const target = root?.querySelector<HTMLElement>(
      `[data-settings-section="${id}"]`
    )
    if (!root || !target) return
    const top = Math.max(
      0,
      target.getBoundingClientRect().top -
        root.getBoundingClientRect().top +
        root.scrollTop
    )
    // 平滑滚动途经的分区不抢高亮；滚到位（或滚到底）后再交还给滚动监听。
    spyTargetRef.current = { top, until: performance.now() + 1200 }
    root.scrollTo({ top, behavior })
  }

  function syncActiveSection() {
    spyFrameRef.current = null
    const root = scrollRef.current
    if (!root) return
    const pending = spyTargetRef.current
    if (pending) {
      const reachable = Math.min(pending.top, root.scrollHeight - root.clientHeight)
      if (
        Math.abs(root.scrollTop - reachable) < 2 ||
        performance.now() > pending.until
      ) {
        spyTargetRef.current = null
      }
      return
    }
    const sections = Array.from(
      root.querySelectorAll<HTMLElement>("[data-settings-section]")
    )
    if (sections.length === 0) return
    const rootTop = root.getBoundingClientRect().top
    // 滚到底时最后一个分区可能永远顶不到上沿，直接算它。
    let current = sections[sections.length - 1]
    if (root.scrollTop + root.clientHeight < root.scrollHeight - 2) {
      current = sections[0]
      for (const section of sections) {
        if (section.getBoundingClientRect().top - rootTop <= 24) current = section
      }
    }
    const id = current.dataset.settingsSection as SettingsSection | undefined
    if (id) setActiveSection(id)
  }

  function handleSettingsScroll() {
    if (spyFrameRef.current !== null) return
    spyFrameRef.current = requestAnimationFrame(syncActiveSection)
  }

  useEffect(() => {
    if (!isOpen || !showsFullSettings) return
    // 打开即落在目标分区（如状态栏的 Git 入口），不做平滑滚动。
    const frame = requestAnimationFrame(() =>
      scrollToSection(initialSection, "auto")
    )
    return () => cancelAnimationFrame(frame)
    // scrollToSection 只读 ref，不进依赖表。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSection, isOpen, showsFullSettings])

  useEffect(
    () => () => {
      if (spyFrameRef.current !== null) cancelAnimationFrame(spyFrameRef.current)
    },
    []
  )

  useEffect(() => {
    if (!isOpen || !showsFullSettings) return

    let cancelled = false
    setCliError(null)
    setCliStatus(null)

    void getCliInstallStatus()
      .then((status) => {
        if (!cancelled) setCliStatus(status)
      })
      .catch((error) => {
        if (!cancelled) setCliError(getApiErrorMessage(error))
      })

    return () => {
      cancelled = true
    }
  }, [isOpen, showsFullSettings])

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
      notify.success(initializeGit ? copy.toastVaultCreated : copy.toastVaultSwitched)
    } catch (error) {
      notify.failure(copy.toastVaultFailed, error)
    } finally {
      setActiveAction(null)
    }
  }

  async function initializeGit() {
    setActiveAction("git")

    try {
      const state = await initializeVaultGit()
      onVaultState(state)
      notify.success(copy.toastGitInitialized)
    } catch (error) {
      notify.failure(copy.toastGitInitializeFailed, error)
    } finally {
      setActiveAction(null)
    }
  }

  async function configureRemote() {
    const nextRemoteUrl = remoteUrl.trim()
    if (!nextRemoteUrl) {
      notify.error(copy.toastRemoteRequired)
      return
    }

    setActiveAction("remote")

    try {
      const state = await setVaultRemote(nextRemoteUrl)
      onVaultState(state)
      setRemoteUrl("")
      notify.success(copy.toastRemoteConfigured)
    } catch (error) {
      notify.failure(copy.toastRemoteFailed, error)
    } finally {
      setActiveAction(null)
    }
  }

  async function createGithubRepo() {
    const nextRepoName = repoName.trim()
    if (!nextRepoName) {
      notify.error(copy.toastRepoRequired)
      return
    }

    setActiveAction("github")

    try {
      const state = await createGithubVaultRepo(nextRepoName)
      onVaultState(state)
      notify.success(copy.toastGithubCreated, {
        description: copy.toastGithubCreatedDescription,
      })
    } catch (error) {
      notify.failure(copy.toastGithubFailed, error)
    } finally {
      setActiveAction(null)
    }
  }

  async function updateCliInstallation(action: Exclude<CliAction, null>) {
    setCliAction(action)
    setCliError(null)

    try {
      const status =
        action === "install" ? await installCli(true) : await uninstallCli()
      setCliStatus(status)

      if (action === "install" && status.state !== "installed") {
        throw new Error(status.message ?? copy.cliActionFailed)
      }
      if (action === "uninstall" && status.state === "installed") {
        throw new Error(status.message ?? copy.cliActionFailed)
      }

      notify.success(
        action === "install"
          ? copy.cliInstalledToast
          : copy.cliUninstalledToast
      )
    } catch (error) {
      const message = getApiErrorMessage(error)
      setCliError(message)
      notify.failure(copy.cliActionFailed, error)
    } finally {
      setCliAction(null)
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
                className={`${styles.spin} size-(--shard-icon-size-md)`}
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
              <GitBranchIcon className="size-(--shard-icon-size-md)" style={{ flexShrink: 0 }} />
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

  const cliStatusLabel = cliError
    ? copy.cliStatusFailed
    : !cliStatus
      ? copy.cliStatusChecking
      : cliStatus.state === "installed"
        ? copy.cliInstalled
        : cliStatus.state === "conflict"
          ? copy.cliConflictShort
          : cliStatus.state === "unavailable"
            ? copy.cliUnavailable
            : cliStatus.state === "needsShellConfig"
              ? copy.cliNeedsShellConfig
              : copy.cliNotInstalled
  const cliDetail = cliError
    ? cliError
    : cliStatus?.state === "needsShellConfig" && cliStatus.shellConfigPath
      ? copy.cliShellConfigPath(cliStatus.shellConfigPath)
      : cliStatus?.linkPath
        ? cliStatus.state === "installed"
          ? copy.cliLinkPath(cliStatus.linkPath)
          : cliStatus.linkPath
        : cliStatus?.state === "unavailable"
          ? null
          : cliStatus?.message ?? null
  const cliCanInstall =
    cliStatus?.state === "notInstalled" ||
    cliStatus?.state === "needsShellConfig"
  const cliTone: StationTone = cliError || cliStatus?.state === "conflict"
    ? "ruby"
    : !cliStatus
      ? "info"
      : cliStatus.state === "installed"
        ? "emerald"
        : cliStatus.state === "unavailable"
          ? "empty"
          : "amber"
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

  const navMeta: Record<SettingsSection, { icon: typeof FolderOpenIcon; label: string }> = {
    appearance: { icon: PaletteIcon, label: copy.navAppearance },
    cli: { icon: SquareTerminalIcon, label: copy.cliTitle },
    git: { icon: GitBranchIcon, label: copy.navGit },
    shortcuts: { icon: KeyboardIcon, label: copy.navShortcuts },
    vault: { icon: FolderOpenIcon, label: copy.vaultTitle },
  }
  const spinner = <Loader2Icon aria-hidden="true" className={styles.spin} />
  const cliStatusDescription = cliError ? (
    cliError
  ) : cliStatus?.state === "conflict" ? (
    <>
      {copy.cliConflict}
      {cliStatus.linkPath ? (
        <>
          <br />
          <SettingsMono>{cliStatus.linkPath}</SettingsMono>
        </>
      ) : null}
    </>
  ) : cliDetail ? (
    <SettingsMono>{cliDetail}</SettingsMono>
  ) : undefined

  return (
    <Dialog open={isOpen} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent
        className={`${styles.panelBase} ${styles.panelSettings} gap-0 p-0 ring-0`}
        finalFocus={getUtilityMenuTrigger}
        ref={dialogRef}
        showCloseButton={false}
        style={{
          maxWidth: "min(960px, calc(100vw - 48px))",
          height: "min(86dvh, 720px)",
        }}
      >
        <DialogDescription className="sr-only">
          配置 Shard 的目录、Git 同步、外观、终端命令与快捷键。
        </DialogDescription>
        <header className={styles.settingsHeader}>
          <DialogTitle className={styles.settingsTitle}>
            {copy.settingsTitle}
          </DialogTitle>
          <Button
            aria-label={copy.close}
            onClick={onClose}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" />
            <span className="sr-only">{copy.close}</span>
          </Button>
        </header>

        <div className={styles.settingsBody}>
          <nav
            aria-label={copy.navLabel}
            className={styles.navRail}
            data-focus-region="settings-nav"
          >
            {SETTINGS_SECTIONS.map((id) => {
              const { icon: Icon, label } = navMeta[id]
              return (
                <button
                  aria-current={activeSection === id ? "true" : undefined}
                  className={styles.navButton}
                  key={id}
                  onClick={() =>
                    scrollToSection(id, prefersReducedMotion() ? "auto" : "smooth")
                  }
                  type="button"
                >
                  <Icon className="size-(--shard-icon-size-md)" style={{ flexShrink: 0 }} />
                  <span className={styles.navLabel}>{label}</span>
                </button>
              )
            })}
          </nav>

          <main
            className={styles.settingsScroll}
            data-focus-region="settings-content"
            onScroll={handleSettingsScroll}
            ref={scrollRef}
          >
            <SettingsBlock id="vault" title={copy.vaultTitle}>
              <SettingsGroup busy={activeAction === "open" || activeAction === "create"}>
                <SettingsRow
                  controlWidth="auto"
                  description={
                    <>
                      <SettingsMono>{vaultPath}</SettingsMono>
                      <br />
                      {copy.vaultMoveHint}
                    </>
                  }
                  label={copy.currentVaultLabel}
                >
                  <Button
                    disabled={isVaultActionBusy}
                    onClick={() => void chooseVault(false)}
                    size="md"
                    type="button"
                    variant="outline"
                  >
                    {activeAction === "open" ? spinner : <FolderOpenIcon aria-hidden="true" />}
                    {copy.openVaultLabel}
                  </Button>
                </SettingsRow>
                <SettingsRow
                  controlWidth="auto"
                  description={copy.createVaultDescription}
                  label={copy.createVaultLabel}
                >
                  <Button
                    disabled={isVaultActionBusy}
                    onClick={() => void chooseVault(true)}
                    size="md"
                    type="button"
                    variant="outline"
                  >
                    {activeAction === "create" ? spinner : <FolderPlusIcon aria-hidden="true" />}
                    {copy.createVaultAction}
                  </Button>
                </SettingsRow>
              </SettingsGroup>
            </SettingsBlock>

            <SettingsBlock id="git" title={copy.navGit}>
              <SettingsGroup busy={isRemoteBusy || activeAction === "git"}>
                <SettingsRow
                  controlWidth="auto"
                  description={
                    git?.shortCommit ? (
                      <SettingsMono>{`${git.branch} · ${git.shortCommit}`}</SettingsMono>
                    ) : (
                      git?.error || copy.gitDescription
                    )
                  }
                  label={copy.sideGit}
                >
                  <StatusIndicator label={gitLabel} tone={gitTone} />
                </SettingsRow>
                {git?.status === "no_git" ? (
                  <SettingsRow
                    controlWidth="auto"
                    description={copy.initGitDescription}
                    label={copy.initGitLabel}
                  >
                    <Button
                      disabled={isVaultActionBusy}
                      onClick={() => void initializeGit()}
                      size="md"
                      type="button"
                      variant="outline"
                    >
                      {activeAction === "git" ? spinner : <GitBranchIcon aria-hidden="true" />}
                      {copy.initGitAction}
                    </Button>
                  </SettingsRow>
                ) : null}
                <SettingsRow
                  controlWidth="auto"
                  description={
                    git?.hasRemote
                      ? copy.remoteAlreadyConnected
                      : needsRemote
                        ? copy.headlineNeedsRemote
                        : copy.gitDescription
                  }
                  label={copy.sideRemote}
                >
                  <StatusIndicator label={remoteLabel} tone={remoteTone} />
                </SettingsRow>
                {needsRemote ? (
                  <>
                    {isRemoteBusy ? (
                      <SettingsGroupItem>
                        <div aria-live="polite" className={styles.busyLine}>
                          <Loader2Icon
                            aria-hidden="true"
                            className={`${styles.spin} size-(--shard-icon-size-md)`}
                            style={{ flexShrink: 0 }}
                          />
                          <span>
                            {isCreatingGithubRepo ? copy.githubBusy : copy.remoteBusy}
                          </span>
                        </div>
                      </SettingsGroupItem>
                    ) : null}
                    <SettingsRow
                      controlWidth="wide"
                      description={getGithubStatusText(githubStatus, isCheckingGithub, copy)}
                      label="GitHub"
                    >
                      <form
                        className={styles.inlineForm}
                        onSubmit={(event) => {
                          event.preventDefault()
                          void createGithubRepo()
                        }}
                      >
                        <Input
                          aria-label={copy.repoNameLabel}
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
                          size="md"
                          type="submit"
                          variant="default"
                        >
                          {isCreatingGithubRepo ? copy.createRepoBusy : copy.createRepo}
                        </Button>
                      </form>
                    </SettingsRow>
                    <SettingsRow
                      controlWidth="wide"
                      description={copy.manualRemoteHint}
                      label={copy.manualRemoteLabel}
                    >
                      <form
                        className={styles.inlineForm}
                        onSubmit={(event) => {
                          event.preventDefault()
                          void configureRemote()
                        }}
                      >
                        <Input
                          aria-label={copy.remoteUrlLabel}
                          disabled={isRemoteBusy}
                          id="vault-remote-url"
                          onChange={(event) => setRemoteUrl(event.target.value)}
                          placeholder="git@github.com:you/shard-vault.git"
                          value={remoteUrl}
                        />
                        <Button
                          disabled={isRemoteBusy}
                          size="md"
                          type="submit"
                          variant="outline"
                        >
                          {isConfiguringRemote ? copy.connectRemoteBusy : copy.connectRemote}
                        </Button>
                      </form>
                    </SettingsRow>
                  </>
                ) : null}
              </SettingsGroup>

              <SettingsGroup>
                <SettingsRow
                  controlWidth="auto"
                  description={
                    git?.hasRemote ? copy.autoSyncDescription : copy.autoSyncNeedsRemote
                  }
                  label={copy.autoSyncTitle}
                >
                  <Switch
                    aria-label={copy.autoSyncEnableLabel}
                    checked={autoSyncEnabled}
                    disabled={!git?.hasRemote}
                    onCheckedChange={(next) => onAutoSyncChange({ autoSyncEnabled: next })}
                  />
                </SettingsRow>
                <SettingsRow
                  controlWidth="compact"
                  description={copy.autoSyncIntervalDescription}
                  label={copy.autoSyncIntervalLabel}
                >
                  <SelectControl
                    aria-label={copy.autoSyncIntervalLabel}
                    className="w-full"
                    disabled={!git?.hasRemote || !autoSyncEnabled}
                    onValueChange={(value) =>
                      onAutoSyncChange({ autoSyncIntervalMinutes: Number(value) })
                    }
                    options={AUTO_SYNC_INTERVAL_OPTIONS.map((minutes) => ({
                      label: copy.autoSyncMinutes(minutes),
                      value: String(minutes),
                    }))}
                    value={String(autoSyncIntervalMinutes)}
                  />
                </SettingsRow>
                <SettingsRow
                  controlWidth="auto"
                  description={copy.syncNowDescription}
                  label={copy.syncNow}
                >
                  <Button
                    disabled={isSyncing || !git?.hasRemote}
                    onClick={onSync}
                    size="md"
                    type="button"
                    variant="outline"
                  >
                    {isSyncing ? spinner : <RefreshCwIcon aria-hidden="true" />}
                    {isSyncing ? copy.syncNowBusy : copy.syncNow}
                  </Button>
                </SettingsRow>
              </SettingsGroup>
            </SettingsBlock>

            <SettingsBlock id="appearance" title={copy.navAppearance}>
              <SettingsGroup>
                <SettingsRow
                  description={copy.colorModeDescription}
                  label={copy.colorModeTitle}
                >
                  <SettingsSegmented
                    ariaLabel={copy.colorModeTitle}
                    onChange={(mode) => {
                      applyColorMode(mode)
                      setColorMode(mode)
                    }}
                    options={COLOR_MODES.map((mode) => {
                      const ModeIcon = COLOR_MODE_ICONS[mode.id]
                      return {
                        icon: <ModeIcon aria-hidden="true" />,
                        label: locale === "zh" ? mode.labelZh : mode.labelEn,
                        value: mode.id,
                      }
                    })}
                    value={colorMode}
                  />
                </SettingsRow>
                <SettingsRow
                  controlWidth="wide"
                  description={copy.themeDescription}
                  label={copy.themeTitle}
                >
                  <div aria-label={copy.themeTitle} className={styles.themeGrid} role="group">
                    {ACCENT_THEMES.map((theme) => {
                      const isActive = accentTheme === theme.id
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
                            data-accent={theme.id}
                          />
                          <span className={styles.themeLabel}>
                            {locale === "zh" ? theme.labelZh : theme.labelEn}
                          </span>
                          {isActive ? (
                            <CheckIcon
                              aria-hidden="true"
                              className={`${styles.themeCheck} size-(--shard-icon-size-md)`}
                            />
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                </SettingsRow>
              </SettingsGroup>
            </SettingsBlock>

            <SettingsBlock id="cli" title={copy.cliTitle}>
              <SettingsGroup busy={cliAction !== null}>
                <SettingsRow
                  controlWidth="auto"
                  description={
                    <>
                      {copy.cliDescription}
                      <br />
                      <SettingsMono>{copy.cliUsage}</SettingsMono>
                    </>
                  }
                  label={copy.cliCommandLabel}
                >
                  {cliStatus?.state === "installed" ? (
                    <Button
                      disabled={cliAction !== null}
                      onClick={() => void updateCliInstallation("uninstall")}
                      size="md"
                      type="button"
                      variant="outline"
                    >
                      {cliAction === "uninstall" ? spinner : null}
                      {cliAction === "uninstall" ? copy.cliUninstallBusy : copy.cliUninstall}
                    </Button>
                  ) : cliCanInstall ? (
                    <Button
                      disabled={cliAction !== null}
                      onClick={() => void updateCliInstallation("install")}
                      size="md"
                      type="button"
                      variant="default"
                    >
                      {cliAction === "install" ? spinner : null}
                      {cliAction === "install" ? copy.cliInstallBusy : copy.cliInstall}
                    </Button>
                  ) : null}
                </SettingsRow>
                <SettingsRow
                  controlWidth="auto"
                  description={cliStatusDescription}
                  label={copy.cliStatusRowLabel}
                >
                  <span aria-live="polite">
                    <StatusIndicator label={cliStatusLabel} tone={cliTone} />
                  </span>
                </SettingsRow>
              </SettingsGroup>
            </SettingsBlock>

            <SettingsBlock id="shortcuts" title={copy.navShortcuts}>
              <SettingsGroup>
                {shortcutRows[locale].map((row) => (
                  <SettingsRow controlWidth="auto" key={row.label} label={row.label}>
                    <span className={styles.kbdGroup}>
                      {row.keys.map((key) => (
                        <kbd className={styles.kbdKey} key={key}>
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </SettingsRow>
                ))}
              </SettingsGroup>
            </SettingsBlock>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  )
}

function StatusIndicator({ label, tone }: { label: string; tone: StationTone }) {
  return (
    <span className={styles.statusIndicator}>
      <span
        aria-hidden="true"
        className={
          tone === "info" ? `${styles.statusDot} ${styles.pulseDot}` : styles.statusDot
        }
        style={stationToneStyle[tone]}
      />
      <span>{label}</span>
    </span>
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
          <Loader2Icon className={`${styles.spin} size-(--shard-icon-size-md)`} />
        ) : (
          <Icon className="size-(--shard-icon-size-md)" />
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
