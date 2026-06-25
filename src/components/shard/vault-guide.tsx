import { open } from "@tauri-apps/plugin-dialog"
import {
  FolderOpenIcon,
  FolderPlusIcon,
  GitBranchIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  createGithubVaultRepo,
  getGithubCliStatus,
  getApiErrorMessage,
  initializeVaultGit,
  setVaultPath,
  setVaultRemote,
} from "@/lib/api"
import type { GithubCliInfo, GitInfo, VaultState } from "@/types"

interface VaultGuideProps {
  git: GitInfo | null
  onClose: () => void
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
  githubBusy: string
  githubChecking: string
  githubCurrentAccount: string
  githubIdle: string
  githubMissing: string
  githubNotAuthenticated: string
  gitDescription: string
  gitEmptyDetail: string
  gitStatus: Record<"dirty" | "error" | "local" | "none" | "ready" | "syncing", string>
  gitTitle: string
  headlineDefault: string
  headlineNeedsRemote: string
  initGitDescription: string
  initGitLabel: string
  manualRemoteHint: string
  noVault: string
  openVaultDescription: string
  openVaultLabel: string
  remoteAlreadyConnected: string
  remoteBusy: string
  remoteIdle: string
  remoteStatus: Record<"connected" | "connecting" | "creating" | "missing" | "pending", string>
  remoteTitle: string
  remoteNeeds: string
  remoteReady: string
  settingsTitle: string
  sideCurrent: string
  sideGit: string
  sideRemote: string
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
  githubAuthenticated(account: string, protocol: string): string
  githubProtocol(protocol: string): string
}

const settingsCopy: Record<SettingsLocale, SettingsCopy> = {
  en: {
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
      "Open an existing ShardVault, or choose a new folder as the local root.",
    directoryTitle: "Folder",
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
    gitEmptyDetail: "No commit status is available yet.",
    gitStatus: {
      dirty: "Unsynced",
      error: "Git error",
      local: "Local only",
      none: "No Git",
      ready: "Ready",
      syncing: "Syncing",
    },
    gitTitle: "Git",
    headlineDefault:
      "Choose an existing Shard folder, or create a new one as the local root for Markdown and Git.",
    headlineNeedsRemote:
      "The current folder is usable, but sync is not configured yet. Auto configure GitHub sync, or enter any Git remote URL manually.",
    initGitDescription: "Enable local commit history for the current folder.",
    initGitLabel: "Initialize Git",
    manualRemoteHint:
      "The manual URL is saved as origin. You can also run git remote add origin <url> in the current folder.",
    noVault: "No folder selected",
    openVaultDescription: "Open an existing ShardVault or Git repository.",
    openVaultLabel: "Choose folder",
    remoteAlreadyConnected:
      "The current vault already has a Git remote. Use the sidebar sync action when needed.",
    remoteBusy: "Connecting Git remote.",
    remoteIdle: "Choose or create a vault before connecting a Git remote.",
    remoteStatus: {
      connected: "Connected",
      connecting: "Connecting",
      creating: "Creating",
      missing: "Not configured",
      pending: "Pending",
    },
    remoteTitle: "Git remote",
    remoteNeeds:
      "Use GitHub CLI to initialize Git if needed, create a private repository, connect origin, and push local commits automatically.",
    remoteReady:
      "The remote is saved as origin and used to sync the local ShardVault to a cloud repository.",
    settingsTitle: "Settings",
    sideCurrent: "Folder",
    sideGit: "Git",
    sideRemote: "Remote",
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
    githubAuthenticated: (account, protocol) =>
      `Signed in as ${account}${protocol}. Shard can configure GitHub sync automatically.`,
    githubProtocol: (protocol) => `, Git protocol ${protocol}`,
  },
  zh: {
    close: "关闭",
    connectRemote: "连接远端",
    connectRemoteBusy: "连接中",
    createRepo: "自动配置同步",
    createRepoBusy: "配置中",
    createVaultDescription: "选择一个空目录，并为它初始化 Git。",
    createVaultLabel: "创建新目录",
    dialogTitleCreate: "选择或新建 Shard vault 目录",
    dialogTitleOpen: "选择已有 vault 目录",
    directoryDescription: "打开已有 ShardVault，或选择一个新目录作为本地根目录。",
    directoryTitle: "目录",
    githubBusy: "正在初始化 Git、创建 GitHub 私有仓库、连接 origin，并推送当前提交。",
    githubChecking: "正在检查 GitHub CLI 登录状态...",
    githubCurrentAccount: "当前账号",
    githubIdle: "可用时会自动初始化 Git、创建私有仓库、连接 origin，并推送本地提交。",
    githubMissing: "未检测到 gh。可以继续手动填写远端 URL。",
    githubNotAuthenticated: "gh 尚未登录。请先运行 gh auth login。",
    gitDescription: "Shard 用本地 Git 保存片段历史，remote 只负责云端同步。",
    gitEmptyDetail: "还没有可显示的提交状态。",
    gitStatus: {
      dirty: "未同步",
      error: "Git 错误",
      local: "仅本地",
      none: "未初始化",
      ready: "已就绪",
      syncing: "同步中",
    },
    gitTitle: "Git",
    headlineDefault:
      "选择已有 Shard 目录，或创建一个新目录作为 Markdown 与 Git 的本地根目录。",
    headlineNeedsRemote:
      "当前目录已经可用，但还没有完成同步配置。可以自动配置 GitHub 同步，也可以手动填写任意 Git 远端。",
    initGitDescription: "为当前目录开启本地提交历史。",
    initGitLabel: "初始化 Git",
    manualRemoteHint:
      "手动 URL 会保存为 origin。也可以在当前目录运行 git remote add origin <url>。",
    noVault: "未选择目录",
    openVaultDescription: "打开已有 ShardVault 或 Git 仓库。",
    openVaultLabel: "选择已有目录",
    remoteAlreadyConnected: "当前 vault 已有 Git 远端，可以从侧栏执行同步。",
    remoteBusy: "正在连接 Git 远端。",
    remoteIdle: "选择或创建 vault 后，可以在这里连接 Git 远端。",
    remoteStatus: {
      connected: "已连接",
      connecting: "连接中",
      creating: "创建中",
      missing: "未配置",
      pending: "待配置",
    },
    remoteTitle: "Git 远端",
    remoteNeeds:
      "可以用 GitHub CLI 自动初始化 Git、创建私有仓库、连接 origin，并推送本地提交。",
    remoteReady:
      "远端保存为 origin，用于把本地 ShardVault 同步到云端仓库。",
    settingsTitle: "设置",
    sideCurrent: "当前目录",
    sideGit: "Git 状态",
    sideRemote: "远端",
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
    githubAuthenticated: (account, protocol) =>
      `已登录 ${account}${protocol}。Shard 可以自动配置 GitHub 同步。`,
    githubProtocol: (protocol) => `，Git 协议 ${protocol}`,
  },
}

function getPreferredSettingsLocale(): SettingsLocale {
  const language =
    typeof navigator === "undefined"
      ? ""
      : navigator.languages?.[0] || navigator.language || ""

  return language.toLowerCase().startsWith("zh") ? "zh" : "en"
}

export function VaultGuide({
  git,
  onClose,
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
  const dialogRef = useRef<HTMLDivElement>(null)
  const copy = settingsCopy[getPreferredSettingsLocale()]

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
  const remoteToneClass = isRemoteBusy
    ? "bg-muted text-muted-foreground"
    : needsRemote
    ? "bg-[rgb(var(--shard-amber-rgb)/var(--shard-alpha-13))] text-[color:var(--shard-amber)]"
    : git?.hasRemote
      ? "bg-[rgb(var(--shard-emerald-rgb)/var(--shard-alpha-13))] text-[color:var(--shard-emerald)]"
      : "bg-muted text-muted-foreground"

  useEffect(() => {
    setRepoName(defaultRepoName(vaultPath))
  }, [vaultPath])

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
      toast.success(initializeGit ? copy.toastVaultCreated : copy.toastVaultSwitched)
    } catch (error) {
      toast.error(copy.toastVaultFailed, {
        description: getApiErrorMessage(error),
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
      toast.success(copy.toastGitInitialized)
    } catch (error) {
      toast.error(copy.toastGitInitializeFailed, {
        description: getApiErrorMessage(error),
      })
    } finally {
      setActiveAction(null)
    }
  }

  async function configureRemote() {
    const nextRemoteUrl = remoteUrl.trim()
    if (!nextRemoteUrl) {
      toast.error(copy.toastRemoteRequired)
      return
    }

    setActiveAction("remote")

    try {
      const state = await setVaultRemote(nextRemoteUrl)
      onVaultState(state)
      setRemoteUrl("")
      toast.success(copy.toastRemoteConfigured)
    } catch (error) {
      toast.error(copy.toastRemoteFailed, {
        description: getApiErrorMessage(error),
      })
    } finally {
      setActiveAction(null)
    }
  }

  async function createGithubRepo() {
    const nextRepoName = repoName.trim()
    if (!nextRepoName) {
      toast.error(copy.toastRepoRequired)
      return
    }

    setActiveAction("github")

    try {
      const state = await createGithubVaultRepo(nextRepoName)
      onVaultState(state)
      toast.success(copy.toastGithubCreated, {
        description: copy.toastGithubCreatedDescription,
      })
    } catch (error) {
      toast.error(copy.toastGithubFailed, {
        description: getApiErrorMessage(error),
      })
    } finally {
      setActiveAction(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/[var(--shard-alpha-89)] px-[var(--shard-content-inset)] py-[var(--shard-space-4)] backdrop-blur-sm md:py-[var(--shard-space-5)]">
      <div
        aria-labelledby="vault-guide-title"
        aria-modal="true"
        className="relative flex h-[min(78dvh,640px)] max-h-[calc(100dvh-32px)] w-full max-w-[960px] flex-col overflow-hidden rounded-[var(--shard-surface-radius)] border border-border bg-card shadow-[0_18px_48px_rgb(17_19_21/var(--shard-alpha-13))] outline-none md:grid md:grid-cols-[176px_minmax(0,1fr)]"
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
        {!required ? (
          <Button
            className="absolute top-[var(--shard-space-3)] right-[var(--shard-space-3)] z-20"
            onClick={onClose}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon data-icon="inline-start" />
            <span className="sr-only">{copy.close}</span>
          </Button>
        ) : null}

        <aside className="grid shrink-0 grid-cols-3 gap-[var(--shard-space-2)] border-b border-border bg-sidebar px-[var(--shard-space-3)] py-[var(--shard-space-3)] md:grid-cols-1 md:grid-rows-[auto_1fr] md:border-r md:border-b-0">
          <div className="col-span-3 px-[var(--shard-space-2)] pr-[var(--shard-space-8)] md:col-span-1">
            <div className="text-[11px] leading-4 font-semibold text-muted-foreground uppercase">
              {copy.settingsTitle}
            </div>
            <h2
              className="mt-1 text-lg leading-6 font-semibold"
              id="vault-guide-title"
            >
              {copy.vaultTitle}
            </h2>
          </div>

          <div className="col-span-3 grid min-h-0 grid-cols-3 gap-[var(--shard-space-2)] md:col-span-1 md:grid-cols-1 md:self-start">
            <div className="min-w-0 rounded-[var(--shard-radius-control)] bg-sidebar-accent px-[var(--shard-space-3)] py-[var(--shard-space-2)]">
              <div className="text-[11px] leading-4 font-semibold text-muted-foreground">
                {copy.sideCurrent}
              </div>
              <div className="mt-1 truncate text-xs leading-4 font-semibold">
                {vaultPath || copy.noVault}
              </div>
            </div>
            <div className="min-w-0 rounded-[var(--shard-radius-control)] bg-sidebar-accent px-[var(--shard-space-3)] py-[var(--shard-space-2)]">
              <div className="text-[11px] leading-4 font-semibold text-muted-foreground">
                {copy.sideGit}
              </div>
              <div className="mt-1 truncate text-xs leading-4 font-semibold">
                {gitLabel}
              </div>
            </div>
            <div className="min-w-0 rounded-[var(--shard-radius-control)] bg-sidebar-accent px-[var(--shard-space-3)] py-[var(--shard-space-2)]">
              <div className="text-[11px] leading-4 font-semibold text-muted-foreground">
                {copy.sideRemote}
              </div>
              <div className="mt-1 truncate text-xs leading-4 font-semibold">
                {remoteLabel}
              </div>
            </div>
          </div>
        </aside>

        <main className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
          <section className="border-b border-border px-[var(--shard-space-5)] py-[var(--shard-space-4)] pr-[calc(var(--shard-space-8)+32px)]">
            <h3 className="text-lg leading-6 font-semibold">{copy.vaultTitle}</h3>
            <p className="mt-[var(--shard-space-2)] max-w-[620px] text-sm leading-6 text-muted-foreground">
              {needsRemote
                ? copy.headlineNeedsRemote
                : copy.headlineDefault}
            </p>
          </section>

          <section className="grid min-h-0 gap-[var(--shard-space-4)] p-[var(--shard-space-5)] lg:grid-cols-[minmax(0,8fr)_minmax(240px,5fr)]">
            <div
              aria-busy={isRemoteBusy}
              className="flex min-h-0 flex-col rounded-[var(--shard-surface-radius)] border border-border bg-card px-[var(--shard-space-4)] py-[var(--shard-space-4)]"
            >
              <div className="flex items-start justify-between gap-[var(--shard-space-4)]">
                <div className="min-w-0">
                  <h3 className="text-base leading-6 font-semibold">
                    {copy.remoteTitle}
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {needsRemote
                      ? copy.remoteNeeds
                      : copy.remoteReady}
                  </p>
                </div>
                <span className={`shard-chip shrink-0 whitespace-nowrap ${remoteToneClass}`}>
                  {remoteLabel}
                </span>
              </div>

              {isRemoteBusy ? (
                <div className="mt-[var(--shard-space-3)] flex items-center gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] border border-border bg-background px-[var(--shard-space-3)] py-[var(--shard-space-2)] text-sm leading-5 text-muted-foreground">
                  <Loader2Icon className="size-4 animate-spin" />
                  <span>
                    {isCreatingGithubRepo
                      ? copy.githubBusy
                      : copy.remoteBusy}
                  </span>
                </div>
              ) : null}

              {needsRemote ? (
                <div className="mt-[var(--shard-space-4)] grid min-h-0 gap-[var(--shard-space-3)]">
                  <div className="rounded-[var(--shard-radius-control)] border border-border bg-background px-[var(--shard-space-3)] py-[var(--shard-space-3)]">
                    <div className="flex items-center gap-[var(--shard-space-2)] text-sm leading-5 font-semibold">
                      <GitBranchIcon className="size-4" />
                      GitHub
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {getGithubStatusText(githubStatus, isCheckingGithub, copy)}
                    </p>
                    <form
                      className="mt-[var(--shard-space-3)] grid gap-[var(--shard-space-2)] sm:grid-cols-[minmax(0,1fr)_max-content]"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void createGithubRepo()
                      }}
                    >
                      <Input
                        autoCapitalize="none"
                        autoCorrect="off"
                        disabled={
                          isRemoteBusy ||
                          isCheckingGithub ||
                          !githubStatus?.authenticated
                        }
                        onChange={(event) => setRepoName(event.target.value)}
                        spellCheck={false}
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

                  <form
                    className="grid gap-[var(--shard-space-2)] sm:grid-cols-[minmax(0,1fr)_max-content]"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void configureRemote()
                    }}
                  >
                    <Input
                      autoCapitalize="none"
                      autoCorrect="off"
                      disabled={isRemoteBusy}
                      onChange={(event) => setRemoteUrl(event.target.value)}
                      placeholder="git@github.com:you/shard-vault.git"
                      spellCheck={false}
                      value={remoteUrl}
                    />
                    <Button
                      disabled={isRemoteBusy}
                      type="submit"
                      variant="default"
                    >
                      {isConfiguringRemote ? copy.connectRemoteBusy : copy.connectRemote}
                    </Button>
                  </form>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {copy.manualRemoteHint}
                  </p>
                </div>
              ) : (
                <div className="mt-[var(--shard-space-4)] rounded-[var(--shard-radius-control)] border border-border bg-background px-[var(--shard-space-3)] py-[var(--shard-space-3)] text-sm leading-6 text-muted-foreground">
                  {vaultPath
                    ? git?.hasRemote
                      ? copy.remoteAlreadyConnected
                      : copy.remoteStatus.pending
                    : copy.remoteIdle}
                </div>
              )}
            </div>

            <div className="grid min-h-0 gap-[var(--shard-space-4)] lg:grid-rows-[minmax(0,1fr)_auto]">
              <section className="rounded-[var(--shard-surface-radius)] border border-border bg-card px-[var(--shard-space-4)] py-[var(--shard-space-4)]">
                <div>
                  <h3 className="text-base leading-6 font-semibold">
                    {copy.directoryTitle}
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {copy.directoryDescription}
                  </p>
                </div>
                <div className="mt-[var(--shard-space-3)] grid gap-[var(--shard-space-2)]">
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

              <section className="rounded-[var(--shard-surface-radius)] border border-border bg-card px-[var(--shard-space-4)] py-[var(--shard-space-4)]">
                <div>
                  <h3 className="text-base leading-6 font-semibold">{copy.gitTitle}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {copy.gitDescription}
                  </p>
                </div>
                <div className="mt-[var(--shard-space-3)] grid gap-[var(--shard-space-2)]">
                  <div className="grid min-h-[56px] grid-cols-[32px_minmax(0,1fr)] items-center gap-[var(--shard-space-3)] rounded-[var(--shard-radius-control)] border border-border bg-background px-[var(--shard-space-3)]">
                    <span className="flex size-8 items-center justify-center rounded-[var(--shard-radius-control)] bg-muted text-muted-foreground">
                      <GitBranchIcon className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm leading-5 font-semibold">
                        {gitLabel}
                      </span>
                      <span className="block truncate text-xs leading-4 text-muted-foreground">
                        {git?.shortCommit
                          ? `${git.branch} · ${git.shortCommit}`
                          : git?.error || copy.gitEmptyDetail}
                      </span>
                    </span>
                  </div>
                  {vaultPath && git?.status === "no_git" ? (
                    <VaultActionButton
                      active={activeAction === "git"}
                      disabled={isVaultActionBusy}
                      description={copy.initGitDescription}
                      icon={GitBranchIcon}
                      label={copy.initGitLabel}
                      onClick={() => void initializeGit()}
                    />
                  ) : null}
                </div>
              </section>
            </div>
          </section>
        </main>
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
      className="grid min-h-[56px] grid-cols-[32px_minmax(0,1fr)] items-center gap-[var(--shard-space-3)] rounded-[var(--shard-radius-control)] border border-border bg-background px-[var(--shard-space-3)] text-left transition-colors hover:border-[color:var(--shard-sapphire)] hover:bg-[color:var(--shard-sapphire-soft)] disabled:pointer-events-none disabled:opacity-[var(--shard-alpha-55)]"
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
        <span className="block text-sm leading-5 font-semibold">{label}</span>
        <span className="block truncate text-xs leading-4 text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  )
}
