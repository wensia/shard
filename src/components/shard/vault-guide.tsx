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
  initializeVaultGit,
  setVaultPath,
  setVaultRemote,
} from "@/lib/api"
import type { GithubCliInfo, GitInfo, VaultState } from "@/types"

interface VaultGuideProps {
  git: GitInfo | null
  onClose: () => void
  onVaultState: (state: VaultState) => void
  open: boolean
  required: boolean
  vaultPath: string
}

type VaultAction = "create" | "github" | "git" | "open" | "remote" | null
type SettingSectionId = "directory" | "git" | "overview" | "remote"

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
  const [activeSection, setActiveSection] =
    useState<SettingSectionId>("overview")
  const detailsRef = useRef<HTMLDivElement>(null)
  const requestedSectionRef = useRef<SettingSectionId | null>(null)
  const scrollSyncTimerRef = useRef<number | null>(null)
  const sectionRefs = useRef<Record<SettingSectionId, HTMLElement | null>>({
    directory: null,
    git: null,
    overview: null,
    remote: null,
  })

  const needsRemote = Boolean(
    vaultPath && git && git.status !== "no_git" && !git.hasRemote
  )

  useEffect(() => {
    setRepoName(defaultRepoName(vaultPath))
  }, [vaultPath])

  useEffect(() => {
    if (!isOpen || !needsRemote) return

    let cancelled = false
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
            error: String(error),
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

    return () => {
      cancelled = true
    }
  }, [isOpen, needsRemote])

  useEffect(() => {
    if (isOpen) {
      setActiveSection("overview")
      detailsRef.current?.scrollTo({ top: 0 })
    }
  }, [isOpen])

  if (!isOpen) return null

  const gitLabel = getGitStatusLabel(git)
  const settingsNav: Array<{
    description: string
    id: SettingSectionId
    label: string
  }> = [
    {
      description: vaultPath ? "路径与状态" : "开始配置",
      id: "overview",
      label: "Vault",
    },
    {
      description: needsRemote ? "需要连接" : "同步目标",
      id: "remote",
      label: "Remote",
    },
    {
      description: "打开或创建",
      id: "directory",
      label: "Directory",
    },
    {
      description: gitLabel,
      id: "git",
      label: "Git",
    },
  ]

  function scrollToSection(sectionId: SettingSectionId) {
    const container = detailsRef.current
    const section = sectionRefs.current[sectionId]
    if (!container || !section) return

    requestedSectionRef.current = sectionId
    setActiveSection(sectionId)
    if (scrollSyncTimerRef.current !== null) {
      window.clearTimeout(scrollSyncTimerRef.current)
    }
    scrollSyncTimerRef.current = window.setTimeout(() => {
      requestedSectionRef.current = null
      scrollSyncTimerRef.current = null
    }, 450)
    container.scrollTo({
      top: section.offsetTop - 20,
      behavior: "smooth",
    })
  }

  function syncActiveSection() {
    const container = detailsRef.current
    if (!container) return

    if (requestedSectionRef.current) {
      setActiveSection(requestedSectionRef.current)
      return
    }

    if (container.scrollTop <= 4) {
      setActiveSection("overview")
      return
    }

    const containerRect = container.getBoundingClientRect()
    const anchorTop = containerRect.top + containerRect.height * 0.55
    let nextActive: SettingSectionId = "overview"

    for (const item of settingsNav) {
      const section = sectionRefs.current[item.id]
      if (section && section.getBoundingClientRect().top <= anchorTop) {
        nextActive = item.id
      }
    }

    setActiveSection((current) =>
      current === nextActive ? current : nextActive
    )
  }

  async function chooseVault(initializeGit: boolean) {
    setActiveAction(initializeGit ? "create" : "open")

    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: initializeGit ? "选择或新建 Shard vault 目录" : "选择已有 vault 目录",
      })

      const path = Array.isArray(selected) ? selected[0] : selected
      if (!path) return

      const state = await setVaultPath(path, initializeGit)
      onVaultState(state)
      toast.success(initializeGit ? "Vault 已创建" : "Vault 已切换")
    } catch (error) {
      toast.error("Vault 设置失败", {
        description: String(error),
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
      toast.success("Git 已初始化")
    } catch (error) {
      toast.error("Git 初始化失败", {
        description: String(error),
      })
    } finally {
      setActiveAction(null)
    }
  }

  async function configureRemote() {
    const nextRemoteUrl = remoteUrl.trim()
    if (!nextRemoteUrl) {
      toast.error("Git remote URL 不能为空")
      return
    }

    setActiveAction("remote")

    try {
      const state = await setVaultRemote(nextRemoteUrl)
      onVaultState(state)
      setRemoteUrl("")
      toast.success("Git remote 已配置")
    } catch (error) {
      toast.error("Git remote 配置失败", {
        description: String(error),
      })
    } finally {
      setActiveAction(null)
    }
  }

  async function createGithubRepo() {
    const nextRepoName = repoName.trim()
    if (!nextRepoName) {
      toast.error("GitHub 仓库名不能为空")
      return
    }

    setActiveAction("github")

    try {
      const state = await createGithubVaultRepo(nextRepoName)
      onVaultState(state)
      toast.success("GitHub 仓库已创建并连接")
    } catch (error) {
      toast.error("自动配置 GitHub 失败", {
        description: String(error),
      })
    } finally {
      setActiveAction(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/[var(--shard-alpha-89)] px-[var(--shard-content-inset)] py-[var(--shard-space-5)] backdrop-blur-sm">
      <div className="relative flex h-[min(82vh,760px)] w-full max-w-[980px] flex-col overflow-hidden rounded-[var(--shard-surface-radius)] border border-border bg-card shadow-[0_18px_48px_rgb(17_19_21/var(--shard-alpha-13))] md:grid md:grid-cols-[196px_minmax(0,1fr)]">
        {!required ? (
          <Button
            className="absolute top-[var(--shard-space-3)] right-[var(--shard-space-3)] z-20"
            onClick={onClose}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon data-icon="inline-start" />
            <span className="sr-only">关闭</span>
          </Button>
        ) : null}

        <aside className="shrink-0 border-b border-border bg-muted/[var(--shard-alpha-55)] px-[var(--shard-space-3)] py-[var(--shard-space-3)] md:border-r md:border-b-0">
          <div className="md:sticky md:top-0">
            <div className="px-[var(--shard-space-2)] pb-[var(--shard-space-2)] pr-[var(--shard-space-8)]">
              <div className="text-[11px] leading-4 font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                Settings
              </div>
              <h2 className="mt-1 text-lg leading-6 font-semibold">Vault</h2>
            </div>
            <nav
              aria-label="Vault 设置分组"
              className="grid grid-cols-2 gap-[var(--shard-space-1)] md:grid-cols-1"
            >
              {settingsNav.map((item) => (
                <button
                  aria-current={activeSection === item.id ? "page" : undefined}
                  className={`min-w-0 rounded-[var(--shard-radius-control)] px-[var(--shard-space-2)] py-[var(--shard-space-2)] text-left transition-colors ${
                    activeSection === item.id
                      ? "bg-card text-foreground shadow-[inset_3px_0_0_var(--shard-sapphire)]"
                      : "text-muted-foreground hover:bg-card/[var(--shard-alpha-55)] hover:text-foreground"
                  }`}
                  key={item.id}
                  onClick={() => scrollToSection(item.id)}
                  type="button"
                >
                  <span className="block text-sm leading-5 font-medium">
                    {item.label}
                  </span>
                  <span className="block truncate text-xs leading-4">
                    {item.description}
                  </span>
                </button>
              ))}
            </nav>
          </div>
        </aside>

        <div
          className="min-h-0 overflow-y-auto scroll-smooth px-[var(--shard-space-5)] py-[var(--shard-space-5)] pr-[var(--shard-space-6)]"
          onScroll={syncActiveSection}
          ref={detailsRef}
        >
          <div className="grid gap-[var(--shard-space-5)] pb-[var(--shard-space-8)]">
            <section
              className="scroll-mt-[var(--shard-space-5)]"
              ref={(node) => {
                sectionRefs.current.overview = node
              }}
            >
              <div className="pr-[var(--shard-space-8)]">
                <h3 className="text-lg leading-6 font-semibold">Vault</h3>
                <p className="mt-[var(--shard-space-2)] max-w-[640px] text-sm leading-6 text-muted-foreground">
                  {needsRemote
                    ? "当前目录已经可用，但还没有连接 Git 远端。配置 remote 后才能同步到云端仓库。"
                    : "选择已有 Shard 目录，或创建一个新目录作为 Markdown 与 Git 的本地根目录。"}
                </p>
              </div>

              <div className="mt-[var(--shard-space-4)] grid gap-[var(--shard-space-3)] md:grid-cols-[minmax(0,1fr)_180px]">
                <div className="rounded-[var(--shard-radius-control)] bg-muted px-[var(--shard-space-3)] py-[var(--shard-space-2)]">
                  <div className="text-[11px] leading-4 font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                    Current
                  </div>
                  <div className="mt-1 truncate text-sm leading-5 font-medium">
                    {vaultPath || "未选择目录"}
                  </div>
                </div>
                <div className="rounded-[var(--shard-radius-control)] border border-border px-[var(--shard-space-3)] py-[var(--shard-space-2)]">
                  <div className="text-[11px] leading-4 font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                    Git
                  </div>
                  <div className="mt-1 text-sm leading-5 font-medium">
                    {gitLabel}
                  </div>
                </div>
              </div>
            </section>

            <section
              className="scroll-mt-[var(--shard-space-5)] rounded-[var(--shard-surface-radius)] border border-[rgb(var(--shard-amber-rgb)/var(--shard-alpha-34))] bg-muted/[var(--shard-alpha-55)] px-[var(--shard-space-4)] py-[var(--shard-space-4)]"
              ref={(node) => {
                sectionRefs.current.remote = node
              }}
            >
              <div className="flex items-start justify-between gap-[var(--shard-space-4)]">
                <div>
                  <h3 className="text-base leading-6 font-semibold">
                    Git remote
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {needsRemote
                      ? "可以用 GitHub CLI 自动创建私有仓库，也可以手动填写任意 Git 仓库 URL。"
                      : "Remote 保存为 origin，用于把本地 ShardVault 同步到云端仓库。"}
                  </p>
                </div>
                <span className="shard-chip bg-card text-muted-foreground">
                  {needsRemote ? "未配置" : git?.hasRemote ? "已连接" : "待配置"}
                </span>
              </div>

              {needsRemote ? (
                <div className="mt-[var(--shard-space-4)] grid gap-[var(--shard-space-3)]">
                  <div className="rounded-[var(--shard-radius-control)] border border-border bg-background px-[var(--shard-space-3)] py-[var(--shard-space-3)]">
                    <div className="flex items-center gap-[var(--shard-space-2)] text-sm leading-5 font-semibold">
                      <GitBranchIcon className="size-4" />
                      GitHub
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {getGithubStatusText(githubStatus, isCheckingGithub)}
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
                          activeAction === "github" ||
                          isCheckingGithub ||
                          !githubStatus?.authenticated
                        }
                        onChange={(event) => setRepoName(event.target.value)}
                        spellCheck={false}
                        value={repoName}
                      />
                      <Button
                        disabled={
                          activeAction === "github" ||
                          isCheckingGithub ||
                          !githubStatus?.authenticated
                        }
                        type="submit"
                        variant="default"
                      >
                        {activeAction === "github" ? (
                          <Loader2Icon
                            className="animate-spin"
                            data-icon="inline-start"
                          />
                        ) : (
                          <GitBranchIcon data-icon="inline-start" />
                        )}
                        创建私有仓库
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
                      disabled={activeAction === "remote"}
                      onChange={(event) => setRemoteUrl(event.target.value)}
                      placeholder="git@github.com:you/shard-vault.git"
                      spellCheck={false}
                      value={remoteUrl}
                    />
                    <Button
                      disabled={activeAction === "remote"}
                      type="submit"
                      variant="default"
                    >
                      {activeAction === "remote" ? (
                        <Loader2Icon
                          className="animate-spin"
                          data-icon="inline-start"
                        />
                      ) : (
                        <GitBranchIcon data-icon="inline-start" />
                      )}
                      连接远端
                    </Button>
                  </form>
                  <p className="text-xs leading-5 text-muted-foreground">
                    手动 URL 会保存为 origin。也可以在当前目录运行 git remote
                    add origin &lt;url&gt;。
                  </p>
                </div>
              ) : (
                <div className="mt-[var(--shard-space-4)] rounded-[var(--shard-radius-control)] border border-border bg-background px-[var(--shard-space-3)] py-[var(--shard-space-3)] text-sm leading-6 text-muted-foreground">
                  {vaultPath
                    ? git?.hasRemote
                      ? "当前 vault 已有 Git remote，可以从侧栏执行同步。"
                      : "当前状态暂时不需要配置 remote。"
                    : "选择或创建 vault 后，可以在这里连接 Git remote。"}
                </div>
              )}
            </section>

            <section
              className="scroll-mt-[var(--shard-space-5)]"
              ref={(node) => {
                sectionRefs.current.directory = node
              }}
            >
              <div>
                <h3 className="text-base leading-6 font-semibold">
                  Directory
                </h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  打开已有 ShardVault，或选择一个新目录作为本地根目录。
                </p>
              </div>
              <div className="mt-[var(--shard-space-3)] grid gap-[var(--shard-space-2)]">
                <VaultActionButton
                  active={activeAction === "open"}
                  description="打开已有 ShardVault 或 Git 仓库。"
                  icon={FolderOpenIcon}
                  label="选择已有目录"
                  onClick={() => void chooseVault(false)}
                />
                <VaultActionButton
                  active={activeAction === "create"}
                  description="选择一个空目录，并为它初始化 Git。"
                  icon={FolderPlusIcon}
                  label="创建新目录"
                  onClick={() => void chooseVault(true)}
                />
              </div>
            </section>

            <section
              className="scroll-mt-[var(--shard-space-5)]"
              ref={(node) => {
                sectionRefs.current.git = node
              }}
            >
              <div>
                <h3 className="text-base leading-6 font-semibold">Git</h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  Shard 用本地 Git 保存片段历史，remote 只负责云端同步。
                </p>
              </div>
              <div className="mt-[var(--shard-space-3)] grid gap-[var(--shard-space-2)]">
                <div className="grid min-h-[64px] grid-cols-[32px_minmax(0,1fr)] items-center gap-[var(--shard-space-3)] rounded-[var(--shard-radius-control)] border border-border bg-background px-[var(--shard-space-3)]">
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
                        : git?.error || "还没有可显示的提交状态。"}
                    </span>
                  </span>
                </div>
                {vaultPath && git?.status === "no_git" ? (
                  <VaultActionButton
                    active={activeAction === "git"}
                    description="为当前目录开启本地提交历史。"
                    icon={GitBranchIcon}
                    label="初始化 Git"
                    onClick={() => void initializeGit()}
                  />
                ) : null}
              </div>
            </section>
          </div>
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

function getGitStatusLabel(git: GitInfo | null) {
  if (!git) return "No Vault"

  switch (git.status) {
    case "ready":
      return git.hasRemote ? "Ready" : "Local only"
    case "dirty":
      return "Unsynced"
    case "syncing":
      return "Syncing"
    case "error":
      return "Git error"
    case "no_git":
    default:
      return "No Git"
  }
}

function getGithubStatusText(
  githubStatus: GithubCliInfo | null,
  isCheckingGithub: boolean
) {
  if (isCheckingGithub) return "正在检查 GitHub CLI 登录状态..."
  if (!githubStatus) return "可用时会创建私有仓库、连接 origin，并推送本地提交。"
  if (!githubStatus.installed) return "未检测到 gh。可以继续手动填写 remote URL。"
  if (!githubStatus.authenticated) {
    return githubStatus.error ?? "gh 尚未登录。请先运行 gh auth login。"
  }

  const account = githubStatus.login ? `@${githubStatus.login}` : "当前账号"
  const protocol = githubStatus.protocol ? `，Git 协议 ${githubStatus.protocol}` : ""
  return `已登录 ${account}${protocol}。将创建私有仓库并连接 origin。`
}

interface VaultActionButtonProps {
  active: boolean
  description: string
  icon: typeof FolderOpenIcon
  label: string
  onClick: () => void
}

function VaultActionButton({
  active,
  description,
  icon: Icon,
  label,
  onClick,
}: VaultActionButtonProps) {
  return (
    <button
      className="grid min-h-[64px] grid-cols-[32px_minmax(0,1fr)] items-center gap-[var(--shard-space-3)] rounded-[var(--shard-radius-control)] border border-border bg-background px-[var(--shard-space-3)] text-left transition-colors hover:border-[color:var(--shard-sapphire)] hover:bg-[color:var(--shard-sapphire-soft)] disabled:pointer-events-none disabled:opacity-[var(--shard-alpha-55)]"
      disabled={active}
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
