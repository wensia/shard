import {
  ArchiveIcon,
  CalendarDaysIcon,
  GitBranchIcon,
  HelpCircleIcon,
  InboxIcon,
  KeyboardIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  RouteIcon,
  SettingsIcon,
  SparklesIcon,
  TagIcon,
} from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import shardAppIconUrl from "@/assets/shard-app-icon.png"
import type { Fragment, FragmentFilter, GitInfo } from "@/types"

interface BottomTabsProps {
  activeFilter: FragmentFilter
  fragments: Fragment[]
  git: GitInfo | null
  isSyncing: boolean
  onFilterChange: (filter: FragmentFilter) => void
  onHelp: () => void
  onOpenSettings: () => void
  onRestoreWindow: () => void
  onShortcuts: () => void
  onSync: () => void
  vaultPath: string
}

const tabItems: Array<{
  id: FragmentFilter
  label: string
  fullLabel: string
  icon: typeof InboxIcon
}> = [
  { id: "inbox", label: "Inbox", fullLabel: "Inbox", icon: InboxIcon },
  { id: "tagged", label: "Tagged", fullLabel: "Tagged", icon: TagIcon },
  { id: "dailyReview", label: "回顾", fullLabel: "每日回顾", icon: CalendarDaysIcon },
  { id: "insight", label: "洞察", fullLabel: "AI 洞察", icon: SparklesIcon },
  { id: "walk", label: "漫步", fullLabel: "随机漫步", icon: RouteIcon },
  { id: "archive", label: "Archive", fullLabel: "Archive", icon: ArchiveIcon },
]

const utilityMenuItemClass =
  "grid h-8 grid-cols-[16px_1fr] gap-2 px-2 text-[13px] font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:stroke-[1.65]"

export function BottomTabs({
  activeFilter,
  fragments,
  git,
  isSyncing,
  onFilterChange,
  onHelp,
  onOpenSettings,
  onRestoreWindow,
  onShortcuts,
  onSync,
  vaultPath,
}: BottomTabsProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const activeFragments = fragments.filter((fragment) => !fragment.archived)
  const archivedFragments = fragments.filter((fragment) => fragment.archived)
  const counts: Record<FragmentFilter, number> = {
    inbox: activeFragments.filter((fragment) => fragment.tags.includes("inbox")).length,
    tagged: activeFragments.filter((fragment) =>
      fragment.tags.some((tag) => tag !== "inbox")
    ).length,
    dailyReview: activeFragments.length,
    insight: activeFragments.length,
    walk: activeFragments.length,
    archive: archivedFragments.length,
  }

  const gitStateLabel = getGitStateLabel(git)
  const isMissingRemote = Boolean(
    git && git.status !== "no_git" && !git.hasRemote
  )

  return (
    <footer className="shrink-0 border-t border-border bg-sidebar px-4 pt-2.5 pb-3">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-2">
        <div className="flex h-7 min-w-0 items-center justify-between gap-3 text-xs">
          <div className="flex min-w-0 items-center gap-2 text-sidebar-foreground">
            <img
              alt=""
              aria-hidden="true"
              className="size-4 shrink-0 rounded-[4px] object-contain"
              draggable={false}
              src={shardAppIconUrl}
            />
            <span className="font-bold">Shard</span>
            <span className="text-muted-foreground">v0.1.0</span>
          </div>

          <div className="flex min-w-0 items-center justify-end gap-2 text-muted-foreground">
            <div className="flex shrink-0 items-center gap-1.5 font-semibold text-sidebar-foreground">
              <span
                className={[
                  "size-2 rounded-full",
                  git?.status === "error" ? "bg-[color:var(--shard-ruby)]" : "",
                  git?.status === "dirty" || isMissingRemote
                    ? "bg-[color:var(--shard-amber)]"
                    : "",
                  !git || (git.status === "ready" && git.hasRemote)
                    ? "bg-[color:var(--shard-emerald)]"
                    : "",
                  git?.status === "no_git"
                    ? "bg-muted-foreground/[var(--shard-alpha-55)]"
                    : "",
                ].join(" ")}
              />
              {gitStateLabel}
            </div>

            <div className="hidden min-w-0 items-center gap-1.5 sm:flex">
              <GitBranchIcon className="size-3.5 shrink-0" />
              <span className="truncate">{git?.branch || "main"}</span>
              <span>·</span>
              <span className="truncate">{git?.shortCommit || "no commit"}</span>
            </div>

            <Tooltip>
              <TooltipTrigger className="hidden max-w-[180px] truncate text-left sm:block">
                {vaultPath || "Vault not loaded"}
              </TooltipTrigger>
              <TooltipContent side="top">
                {vaultPath || "Vault not loaded"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 overflow-x-auto rounded-[8px] bg-muted p-1">
            <nav
              aria-label="Fragment filters"
              className="grid min-w-[456px] grid-cols-6 gap-1"
            >
              {tabItems.map((item) => {
                const Icon = item.icon
                const isActive = item.id === activeFilter

                return (
                  <button
                    aria-label={item.fullLabel}
                    className={[
                      "relative flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-[6px] px-1.5 text-[11px] leading-none font-semibold transition-colors",
                      isActive
                        ? "bg-card text-foreground shadow-[0_1px_2px_rgb(17_19_21/var(--shard-alpha-8))]"
                        : "text-muted-foreground hover:bg-card/[var(--shard-alpha-55)] hover:text-foreground",
                    ].join(" ")}
                    key={item.id}
                    onClick={() => onFilterChange(item.id)}
                    type="button"
                  >
                    {isActive ? (
                      <span
                        aria-hidden="true"
                        className="absolute inset-x-3 top-1 h-0.5 rounded-full bg-[color:var(--shard-sapphire)]"
                      />
                    ) : null}
                    <Icon className="size-4 shrink-0" />
                    <span className="max-w-full truncate">{item.label}</span>
                    <span className="absolute top-1 right-1 min-w-4 rounded-full bg-background px-1 text-[10px] leading-4 font-bold text-muted-foreground">
                      {counts[item.id]}
                    </span>
                  </button>
                )
              })}
            </nav>
          </div>

          <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
            <DropdownMenuTrigger render={<Button size="icon" variant="ghost" />}>
              <MoreHorizontalIcon data-icon="inline-start" />
              <span className="sr-only">更多操作</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-40 rounded-md p-1 shadow-[0_8px_20px_rgb(0_0_0/var(--shard-alpha-8))] ring-[rgb(0_0_0/var(--shard-alpha-13))]"
              side="top"
              sideOffset={8}
            >
              <DropdownMenuGroup>
                <DropdownMenuItem
                  className={utilityMenuItemClass}
                  disabled={isSyncing}
                  onClick={() => {
                    setIsMenuOpen(false)
                    window.setTimeout(onSync, 0)
                  }}
                >
                  <RefreshCwIcon className={isSyncing ? "animate-spin" : ""} />
                  {isSyncing ? "同步中" : "同步 Git vault"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={utilityMenuItemClass}
                  onClick={() => {
                    setIsMenuOpen(false)
                    window.setTimeout(onRestoreWindow, 0)
                  }}
                >
                  <Maximize2Icon />
                  还原窗口尺寸
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className={utilityMenuItemClass}
                  onClick={() => {
                    setIsMenuOpen(false)
                    window.setTimeout(onOpenSettings, 0)
                  }}
                >
                  <SettingsIcon />
                  设置
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={utilityMenuItemClass}
                  onClick={() => {
                    setIsMenuOpen(false)
                    window.setTimeout(onShortcuts, 0)
                  }}
                >
                  <KeyboardIcon />
                  快捷键
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={utilityMenuItemClass}
                  onClick={() => {
                    setIsMenuOpen(false)
                    window.setTimeout(onHelp, 0)
                  }}
                >
                  <HelpCircleIcon />
                  帮助
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </footer>
  )
}

function getGitStateLabel(git: GitInfo | null) {
  if (!git) return "No Vault"
  if (git.status === "no_git") return "No Git"
  if (!git.hasRemote) return "No Remote"
  if (git.status === "dirty") return "Pending"
  if (git.status === "error") return "Error"
  return "Synced"
}
