import { open } from "@tauri-apps/plugin-dialog"
import {
  FolderOpenIcon,
  FolderPlusIcon,
  GitBranchIcon,
  KeyboardIcon,
  Loader2Icon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button } from "@astryxdesign/core/Button"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import {
  AUTO_SYNC_INTERVAL_OPTIONS,
  type AppSettings,
} from "@/lib/app-settings"
import {
  createGithubVaultRepo,
  getGithubCliStatus,
  getApiErrorMessage,
  initializeVaultGit,
  setVaultPath,
  setVaultRemote,
} from "@/lib/api"
import type { GithubCliInfo, GitInfo, VaultState } from "@/types"

export type SettingsSection = "git" | "shortcuts" | "vault"

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
    { keys: ["⌘", "⇧", "F"], label: "Zen mode (in composer)" },
    { keys: ["Enter"], label: "New line" },
    { keys: ["Esc"], label: "Exit editing" },
  ],
  zh: [
    { keys: ["⌘", "Enter"], label: "保存片段" },
    { keys: ["⌘", "K"], label: "搜索" },
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
  const dialogRef = useRef<HTMLDivElement>(null)
  const toast = useToast()
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
      toast({
        body: initializeGit ? copy.toastVaultCreated : copy.toastVaultSwitched,
      })
    } catch (error) {
      toast({
        body: `${copy.toastVaultFailed}: ${getApiErrorMessage(error)}`,
        type: "error",
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
      toast({ body: copy.toastGitInitialized })
    } catch (error) {
      toast({
        body: `${copy.toastGitInitializeFailed}: ${getApiErrorMessage(error)}`,
        type: "error",
      })
    } finally {
      setActiveAction(null)
    }
  }

  async function configureRemote() {
    const nextRemoteUrl = remoteUrl.trim()
    if (!nextRemoteUrl) {
      toast({ body: copy.toastRemoteRequired, type: "error" })
      return
    }

    setActiveAction("remote")

    try {
      const state = await setVaultRemote(nextRemoteUrl)
      onVaultState(state)
      setRemoteUrl("")
      toast({ body: copy.toastRemoteConfigured })
    } catch (error) {
      toast({
        body: `${copy.toastRemoteFailed}: ${getApiErrorMessage(error)}`,
        type: "error",
      })
    } finally {
      setActiveAction(null)
    }
  }

  async function createGithubRepo() {
    const nextRepoName = repoName.trim()
    if (!nextRepoName) {
      toast({ body: copy.toastRepoRequired, type: "error" })
      return
    }

    setActiveAction("github")

    try {
      const state = await createGithubVaultRepo(nextRepoName)
      onVaultState(state)
      toast({
        body: `${copy.toastGithubCreated}: ${copy.toastGithubCreatedDescription}`,
      })
    } catch (error) {
      toast({
        body: `${copy.toastGithubFailed}: ${getApiErrorMessage(error)}`,
        type: "error",
      })
    } finally {
      setActiveAction(null)
    }
  }

  const railSection = (
    <section className="border-b border-border px-[var(--shard-space-6)] py-[var(--shard-space-5)]">
      <div className="flex flex-col gap-[var(--shard-space-3)] sm:flex-row sm:items-start">
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
      <p className="mt-[var(--shard-space-4)] text-xs leading-5 text-pretty text-muted-foreground">
        {git?.hasRemote ? copy.remoteAlreadyConnected : copy.gitDescription}
      </p>
    </section>
  )

  const gitSetupSections = (
    <>
      {vaultPath && git?.status === "no_git" ? (
        <section className="border-b border-border px-[var(--shard-space-6)] py-[var(--shard-space-5)]">
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
        <section
          aria-busy={isRemoteBusy}
          className="border-b border-border px-[var(--shard-space-6)] py-[var(--shard-space-5)]"
        >
          <h3 className="text-sm leading-5 font-semibold">
            {copy.syncSetupTitle}
          </h3>
          <p className="mt-[var(--shard-space-1)] text-xs leading-5 text-pretty text-muted-foreground">
            {copy.headlineNeedsRemote}
          </p>

          {isRemoteBusy ? (
            <div className="mt-[var(--shard-space-3)] flex items-center gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] border border-border bg-background px-[var(--shard-space-3)] py-[var(--shard-space-2)] text-sm leading-5 text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              <span>
                {isCreatingGithubRepo ? copy.githubBusy : copy.remoteBusy}
              </span>
            </div>
          ) : null}

          <div className="mt-[var(--shard-space-4)]">
            <div className="flex items-center gap-[var(--shard-space-2)] text-sm leading-5 font-semibold">
              <GitBranchIcon className="size-4" />
              GitHub
            </div>
            <p className="mt-1 text-xs leading-5 text-pretty text-muted-foreground">
              {getGithubStatusText(githubStatus, isCheckingGithub, copy)}
            </p>
            <form
              className="mt-[var(--shard-space-2)] grid gap-[var(--shard-space-2)] sm:grid-cols-[minmax(0,1fr)_max-content]"
              onSubmit={(event) => {
                event.preventDefault()
                void createGithubRepo()
              }}
            >
              <TextInput
                isDisabled={
                  isRemoteBusy ||
                  isCheckingGithub ||
                  !githubStatus?.authenticated
                }
                isLabelHidden
                label={copy.repoNameLabel}
                onChange={(value) => setRepoName(value)}
                value={repoName}
              />
              <Button
                isDisabled={
                  isRemoteBusy ||
                  isCheckingGithub ||
                  !githubStatus?.authenticated
                }
                label={isCreatingGithubRepo ? copy.createRepoBusy : copy.createRepo}
                type="submit"
                variant="primary"
              />
            </form>
          </div>

          <div className="mt-[var(--shard-space-4)] flex items-center gap-[var(--shard-space-3)]">
            <span
              aria-hidden="true"
              className="h-px flex-1 rounded-full bg-border-visible opacity-[var(--shard-alpha-55)]"
            />
            <span className="text-[11px] leading-4 font-medium text-muted-foreground">
              {copy.manualDividerLabel}
            </span>
            <span
              aria-hidden="true"
              className="h-px flex-1 rounded-full bg-border-visible opacity-[var(--shard-alpha-55)]"
            />
          </div>

          <form
            className="mt-[var(--shard-space-3)] grid gap-[var(--shard-space-2)] sm:grid-cols-[minmax(0,1fr)_max-content]"
            onSubmit={(event) => {
              event.preventDefault()
              void configureRemote()
            }}
          >
            <TextInput
              isDisabled={isRemoteBusy}
              isLabelHidden
              label={copy.remoteUrlLabel}
              onChange={(value) => setRemoteUrl(value)}
              placeholder="git@github.com:you/shard-vault.git"
              value={remoteUrl}
            />
            <Button
              isDisabled={isRemoteBusy}
              label={
                isConfiguringRemote ? copy.connectRemoteBusy : copy.connectRemote
              }
              type="submit"
              variant="primary"
            />
          </form>
          <p className="mt-[var(--shard-space-2)] text-xs leading-5 text-pretty text-muted-foreground">
            {copy.manualRemoteHint}
          </p>
        </section>
      ) : null}
    </>
  )

  const directorySection = (
    <section className="border-b border-border px-[var(--shard-space-6)] py-[var(--shard-space-5)]">
      <h3 className="text-sm leading-5 font-semibold">
        {copy.directoryTitle}
      </h3>
      <p className="mt-[var(--shard-space-1)] text-xs leading-5 text-pretty text-muted-foreground">
        {copy.directoryDescription}
      </p>
      <div className="mt-[var(--shard-space-3)] grid gap-[var(--shard-space-2)] sm:grid-cols-2">
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
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/[var(--shard-alpha-89)] px-[var(--shard-content-inset)] py-[var(--shard-space-4)] backdrop-blur-sm md:py-[var(--shard-space-5)]">
        <div
          aria-labelledby="vault-guide-title"
          aria-modal="true"
          className="flex max-h-[min(86dvh,720px)] w-full max-w-[620px] flex-col overflow-hidden rounded-[var(--shard-radius-panel)] border border-border bg-card shadow-[var(--shard-shadow-popover)] outline-none"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !required) {
              event.preventDefault()
              onClose()
            }
          }}
          ref={dialogRef}
          role="dialog"
          tabIndex={-1}
        >
          <header className="shrink-0 border-b border-border px-[var(--shard-space-6)] pt-[var(--shard-space-5)] pb-[var(--shard-space-4)]">
            <div className="flex items-center justify-between gap-[var(--shard-space-3)]">
              <span className="text-[11px] leading-4 font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                {copy.settingsTitle}
                {vaultPath ? ` · ${copy.vaultTitle}` : ""}
              </span>
              {!required ? (
                <Button
                  className="-mt-1 -mr-2"
                  icon={<XIcon data-icon="inline-start" />}
                  isIconOnly
                  label={copy.close}
                  onClick={onClose}
                  size="sm"
                  type="button"
                  variant="ghost"
                />
              ) : null}
            </div>
            <h2
              className="mt-[var(--shard-space-1)] text-lg leading-6 font-semibold text-balance"
              id="vault-guide-title"
            >
              {vaultPath ? folderName : copy.vaultTitle}
            </h2>
            {vaultPath ? (
              <p className="mt-[var(--shard-space-1)] font-mono text-xs leading-5 break-all text-muted-foreground select-all">
                {vaultPath}
              </p>
            ) : (
              <p className="mt-[var(--shard-space-2)] text-sm leading-6 text-pretty text-muted-foreground">
                {copy.headlineDefault}
              </p>
            )}
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto [&>section:last-child]:border-b-0">
            {railSection}
            {gitSetupSections}
            {directorySection}
          </main>
        </div>
      </div>
    )
  }

  const navItems: { icon: typeof FolderOpenIcon; id: SettingsSection; label: string }[] = [
    { icon: FolderOpenIcon, id: "vault", label: copy.vaultTitle },
    { icon: GitBranchIcon, id: "git", label: copy.navGit },
    { icon: KeyboardIcon, id: "shortcuts", label: copy.navShortcuts },
  ]
  const sectionTitle =
    section === "git"
      ? copy.navGit
      : section === "shortcuts"
        ? copy.navShortcuts
        : copy.vaultTitle

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/[var(--shard-alpha-89)] px-[var(--shard-content-inset)] py-[var(--shard-space-4)] backdrop-blur-sm md:py-[var(--shard-space-5)]">
      <div
        aria-labelledby="vault-guide-title"
        aria-modal="true"
        className="flex max-h-[min(84dvh,640px)] min-h-[min(84dvh,520px)] w-full max-w-[760px] flex-col overflow-hidden rounded-[var(--shard-radius-panel)] border border-border bg-card shadow-[var(--shard-shadow-popover)] outline-none md:grid md:grid-cols-[168px_minmax(0,1fr)]"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            onClose()
          }
        }}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <nav className="flex shrink-0 gap-[var(--shard-space-1)] overflow-x-auto border-b border-border bg-sidebar p-[var(--shard-space-2)] md:flex-col md:overflow-visible md:border-r md:border-b-0 md:p-[var(--shard-space-3)]">
          <div className="hidden px-[var(--shard-space-3)] pt-[var(--shard-space-1)] pb-[var(--shard-space-2)] text-[11px] leading-4 font-semibold tracking-[0.08em] text-muted-foreground uppercase md:block">
            {copy.settingsTitle}
          </div>
          {navItems.map(({ icon: Icon, id, label }) => (
            <button
              className={[
                "flex h-9 shrink-0 items-center gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] px-[var(--shard-space-3)] text-sm font-medium transition-colors duration-150",
                section === id
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/[var(--shard-alpha-55)] hover:text-sidebar-foreground",
              ].join(" ")}
              key={id}
              onClick={() => setSection(id)}
              type="button"
            >
              <Icon className="size-4 shrink-0 stroke-[1.75]" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center justify-between gap-[var(--shard-space-3)] border-b border-border px-[var(--shard-space-6)] py-[var(--shard-space-3)]">
            <h2
              className="text-base leading-6 font-semibold"
              id="vault-guide-title"
            >
              {sectionTitle}
            </h2>
            <Button
              className="-mr-2"
              icon={<XIcon data-icon="inline-start" />}
              isIconOnly
              label={copy.close}
              onClick={onClose}
              size="sm"
              type="button"
              variant="ghost"
            />
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto [&>section:last-child]:border-b-0">
            {section === "vault" ? (
              <>
                <section className="border-b border-border px-[var(--shard-space-6)] py-[var(--shard-space-5)]">
                  <div className="text-[11px] leading-4 font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                    {copy.sideCurrent}
                  </div>
                  <div className="mt-[var(--shard-space-1)] text-base leading-6 font-semibold text-balance">
                    {folderName}
                  </div>
                  <p className="mt-[var(--shard-space-1)] font-mono text-xs leading-5 break-all text-muted-foreground select-all">
                    {vaultPath}
                  </p>
                </section>
                {directorySection}
              </>
            ) : null}

            {section === "git" ? (
              <>
                {railSection}
                {gitSetupSections}
                <section className="border-b border-border px-[var(--shard-space-6)] py-[var(--shard-space-5)]">
                  <div className="flex items-start justify-between gap-[var(--shard-space-4)]">
                    <div className="min-w-0">
                      <h3 className="text-sm leading-5 font-semibold">
                        {copy.autoSyncTitle}
                      </h3>
                      <p className="mt-[var(--shard-space-1)] text-xs leading-5 text-pretty text-muted-foreground">
                        {copy.autoSyncDescription}
                      </p>
                    </div>
                    <SwitchToggle
                      checked={autoSyncEnabled}
                      disabled={!git?.hasRemote}
                      label={copy.autoSyncEnableLabel}
                      onChange={(next) =>
                        onAutoSyncChange({ autoSyncEnabled: next })
                      }
                    />
                  </div>
                  {git?.hasRemote ? (
                    <div className="mt-[var(--shard-space-4)] flex flex-wrap items-center gap-[var(--shard-space-3)]">
                      <span className="text-xs leading-5 font-medium text-muted-foreground">
                        {copy.autoSyncIntervalLabel}
                      </span>
                      <div className="flex gap-[var(--shard-space-1)]">
                        {AUTO_SYNC_INTERVAL_OPTIONS.map((minutes) => (
                          <button
                            className={[
                              "h-8 rounded-[var(--shard-radius-control)] border px-[var(--shard-space-3)] text-xs font-medium transition-colors duration-150",
                              minutes === autoSyncIntervalMinutes
                                ? "border-[color:var(--shard-sapphire)] bg-[color:var(--shard-sapphire-soft)] text-[color:var(--shard-sapphire-text)]"
                                : "border-border text-muted-foreground hover:border-ring hover:text-foreground",
                              !autoSyncEnabled
                                ? "pointer-events-none opacity-[var(--shard-alpha-55)]"
                                : "",
                            ].join(" ")}
                            disabled={!autoSyncEnabled}
                            key={minutes}
                            onClick={() =>
                              onAutoSyncChange({
                                autoSyncIntervalMinutes: minutes,
                              })
                            }
                            type="button"
                          >
                            {copy.autoSyncMinutes(minutes)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="mt-[var(--shard-space-3)] text-xs leading-5 text-pretty text-muted-foreground">
                      {copy.autoSyncNeedsRemote}
                    </p>
                  )}
                  <div className="mt-[var(--shard-space-4)]">
                    <Button
                      icon={
                        isSyncing ? (
                          <Loader2Icon className="animate-spin" />
                        ) : (
                          <RefreshCwIcon />
                        )
                      }
                      isDisabled={isSyncing || !git?.hasRemote}
                      label={isSyncing ? copy.syncNowBusy : copy.syncNow}
                      onClick={onSync}
                      size="sm"
                      type="button"
                      variant="secondary"
                    />
                  </div>
                </section>
              </>
            ) : null}

            {section === "shortcuts" ? (
              <section className="border-b border-border px-[var(--shard-space-6)] py-[var(--shard-space-3)]">
                <div className="divide-y divide-border">
                  {shortcutRows[locale].map((row) => (
                    <div
                      className="flex items-center justify-between gap-[var(--shard-space-4)] py-[var(--shard-space-3)]"
                      key={row.label}
                    >
                      <span className="text-sm leading-5">{row.label}</span>
                      <span className="flex shrink-0 items-center gap-[var(--shard-space-1)]">
                        {row.keys.map((key) => (
                          <kbd
                            className="rounded-[4px] border border-border bg-muted px-1.5 text-[10px] leading-4 font-semibold text-muted-foreground"
                            key={key}
                          >
                            {key}
                          </kbd>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </main>
        </div>
      </div>
    </div>
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

const stationDotClass: Record<StationTone, string> = {
  amber:
    "bg-[color:var(--shard-amber)] shadow-[0_0_0_3px_rgb(var(--shard-amber-rgb)/var(--shard-alpha-13))]",
  emerald:
    "bg-[color:var(--shard-emerald)] shadow-[0_0_0_3px_rgb(var(--shard-emerald-rgb)/var(--shard-alpha-13))]",
  empty: "border-[1.5px] border-muted-foreground/[var(--shard-alpha-55)]",
  info: "animate-pulse bg-[color:var(--shard-info)] shadow-[0_0_0_3px_rgb(var(--shard-info-rgb)/var(--shard-alpha-13))] motion-reduce:animate-none",
  ruby: "bg-[color:var(--shard-ruby)] shadow-[0_0_0_3px_rgb(var(--shard-ruby-rgb)/var(--shard-alpha-13))]",
}

function RailConnector() {
  return (
    <span
      aria-hidden="true"
      className="mt-2 hidden h-px min-w-[16px] flex-1 rounded-full bg-border-visible opacity-[var(--shard-alpha-55)] sm:block"
    />
  )
}

interface RailStationProps {
  detail?: string
  label: string
  tone: StationTone
  value: string
}

function RailStation({ detail, label, tone, value }: RailStationProps) {
  return (
    <div className="flex min-w-0 shrink-0 items-start gap-[var(--shard-space-2)] sm:max-w-[200px] sm:shrink">
      <span
        aria-hidden="true"
        className={`mt-[3px] size-2.5 shrink-0 rounded-full ${stationDotClass[tone]}`}
      />
      <span className="min-w-0">
        <span className="block text-[11px] leading-4 font-semibold text-muted-foreground">
          {label}
        </span>
        <span className="block text-sm leading-5 font-semibold">{value}</span>
        {detail ? (
          <span className="block truncate font-mono text-xs leading-4 text-muted-foreground tabular-nums">
            {detail}
          </span>
        ) : null}
      </span>
    </div>
  )
}

interface SwitchToggleProps {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
}

function SwitchToggle({
  checked,
  disabled = false,
  label,
  onChange,
}: SwitchToggleProps) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={[
        "relative h-6 w-10 shrink-0 rounded-full transition-colors duration-150 ease-out",
        "after:absolute after:-inset-2 after:content-['']",
        checked ? "bg-[color:var(--shard-sapphire)]" : "bg-[color:var(--input)]",
        disabled ? "pointer-events-none opacity-[var(--shard-alpha-55)]" : "",
      ].join(" ")}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        className={[
          "absolute top-[2px] left-[2px] block size-5 rounded-full bg-white",
          "shadow-xs",
          "transition-transform duration-150 ease-out",
          checked ? "translate-x-[16px]" : "translate-x-0",
        ].join(" ")}
      />
    </button>
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
      className="grid min-h-[56px] grid-cols-[32px_minmax(0,1fr)] items-center gap-[var(--shard-space-3)] rounded-[var(--shard-radius-control)] border border-border bg-background px-[var(--shard-space-3)] text-left transition-[background-color,border-color,scale] duration-150 ease-out hover:border-[color:var(--shard-sapphire)] hover:bg-[color:var(--shard-sapphire-soft)] active:scale-[0.96] disabled:pointer-events-none disabled:opacity-[var(--shard-alpha-55)]"
      disabled={disabled || active}
      onClick={onClick}
      type="button"
    >
      <span className="flex size-8 items-center justify-center rounded-[var(--shard-radius-control)] bg-muted text-muted-foreground">
        {active ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <Icon className="size-4" />
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-sm leading-5 font-semibold text-balance">
          {label}
        </span>
        <span className="block truncate text-xs leading-4 text-pretty text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  )
}
