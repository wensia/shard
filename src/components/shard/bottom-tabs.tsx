import {
  ArchiveIcon,
  GitBranchIcon,
  HandCoinsIcon,
  HelpCircleIcon,
  InboxIcon,
  KeyboardIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  TagIcon,
} from "lucide-react"
import { useState } from "react"

import { DropdownMenu } from "@astryxdesign/core/DropdownMenu"
import { Tooltip } from "@astryxdesign/core/Tooltip"
import shardAppIconUrl from "@/assets/shard-app-icon.png"
import { dailyReviewCount, insightReviewCount } from "@/lib/review-workflows"
import { useAppVersion } from "@/lib/use-app-version"
import type { Fragment, FragmentFilter, GitInfo } from "@/types"

interface BottomTabsProps {
  activeFilter: FragmentFilter
  fragments: Fragment[]
  git: GitInfo | null
  isSyncing: boolean
  onFilterChange: (filter: FragmentFilter) => void
  onHelp: () => void
  onOpenDebts: () => void
  onOpenMindMaps: () => void
  onOpenSearch: () => void
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
  { id: "insight", label: "洞察", fullLabel: "洞察视角", icon: SparklesIcon },
  { id: "archive", label: "Archive", fullLabel: "Archive", icon: ArchiveIcon },
]

export function BottomTabs({
  activeFilter,
  fragments,
  git,
  isSyncing,
  onFilterChange,
  onHelp,
  onOpenDebts,
  onOpenMindMaps,
  onOpenSearch,
  onOpenSettings,
  onRestoreWindow,
  onShortcuts,
  onSync,
  vaultPath,
}: BottomTabsProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const appVersion = useAppVersion()
  const activeFragments = fragments.filter((fragment) => !fragment.archived)
  const archivedFragments = fragments.filter((fragment) => fragment.archived)
  const counts: Record<FragmentFilter, number> = {
    inbox: activeFragments.filter((fragment) => fragment.tags.includes("inbox")).length,
    tagged: activeFragments.filter((fragment) =>
      fragment.tags.some((tag) => tag !== "inbox")
    ).length,
    dailyReview: dailyReviewCount(fragments),
    insight: insightReviewCount(fragments),
    lockbox: 0,
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
              className="size-4 shrink-0 rounded-[var(--shard-radius-control)] object-contain"
              draggable={false}
              src={shardAppIconUrl}
            />
            <span className="font-bold">Shard</span>
            {appVersion ? (
              <span className="text-muted-foreground">v{appVersion}</span>
            ) : null}
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

            <Tooltip
              content={vaultPath || "Vault not loaded"}
              placement="above"
            >
              <span className="hidden max-w-[180px] truncate text-left sm:block">
                {vaultPath || "Vault not loaded"}
              </span>
            </Tooltip>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 overflow-x-auto rounded-[8px] bg-muted p-1">
            <nav
              aria-label="Fragment filters"
              className="grid min-w-[304px] grid-cols-4 gap-1"
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
                        ? "bg-card text-foreground shadow-card"
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
                    <span className="absolute top-1 right-1 min-w-4 rounded-full bg-background px-1 text-[10px] leading-4 font-bold text-muted-foreground tabular-nums">
                      {counts[item.id]}
                    </span>
                  </button>
                )
              })}
            </nav>
          </div>

          <DropdownMenu
            button={{
              icon: <MoreHorizontalIcon />,
              isIconOnly: true,
              label: "更多操作",
              size: "sm",
              variant: "ghost",
            }}
            isMenuOpen={isMenuOpen}
            items={[
              {
                icon: <SearchIcon />,
                label: "搜索笔记",
                onClick: () => window.setTimeout(onOpenSearch, 0),
              },
              {
                icon: <GitBranchIcon />,
                label: "思维导图",
                onClick: () => window.setTimeout(onOpenMindMaps, 0),
              },
              {
                icon: <HandCoinsIcon />,
                label: "债务",
                onClick: () => window.setTimeout(onOpenDebts, 0),
              },
              { type: "divider" },
              {
                icon: (
                  <RefreshCwIcon className={isSyncing ? "animate-spin" : ""} />
                ),
                isDisabled: isSyncing,
                label: isSyncing ? "同步中" : "同步 Git vault",
                onClick: () => window.setTimeout(onSync, 0),
              },
              {
                icon: <Maximize2Icon />,
                label: "还原窗口尺寸",
                onClick: () => window.setTimeout(onRestoreWindow, 0),
              },
              { type: "divider" },
              {
                icon: <SettingsIcon />,
                label: "设置",
                onClick: () => window.setTimeout(onOpenSettings, 0),
              },
              {
                icon: <KeyboardIcon />,
                label: "快捷键",
                onClick: () => window.setTimeout(onShortcuts, 0),
              },
              {
                icon: <HelpCircleIcon />,
                label: "帮助",
                onClick: () => window.setTimeout(onHelp, 0),
              },
            ]}
            menuWidth={160}
            onOpenChange={setIsMenuOpen}
            placement="above"
          />
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
