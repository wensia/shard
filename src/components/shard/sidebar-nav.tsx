import {
  ArchiveIcon,
  BotIcon,
  BoxIcon,
  GitBranchIcon,
  HelpCircleIcon,
  InboxIcon,
  KeyboardIcon,
  RefreshCwIcon,
  SettingsIcon,
  TagIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { Fragment, FragmentFilter, GitInfo } from "@/types"

interface SidebarNavProps {
  activeFilter: FragmentFilter
  fragments: Fragment[]
  git: GitInfo | null
  isSyncing: boolean
  onFilterChange: (filter: FragmentFilter) => void
  onSync: () => void
  vaultPath: string
}

const navItems: Array<{
  id: FragmentFilter
  label: string
  icon: typeof InboxIcon
}> = [
  { id: "inbox", label: "Inbox", icon: InboxIcon },
  { id: "tagged", label: "Tagged", icon: TagIcon },
  { id: "ai", label: "AI Suggestions", icon: BotIcon },
  { id: "archive", label: "Archive", icon: ArchiveIcon },
]

export function SidebarNav({
  activeFilter,
  fragments,
  git,
  isSyncing,
  onFilterChange,
  onSync,
  vaultPath,
}: SidebarNavProps) {
  const counts: Record<FragmentFilter, number> = {
    inbox: fragments.filter((fragment) => fragment.tags.includes("inbox")).length,
    tagged: fragments.filter((fragment) =>
      fragment.tags.some((tag) => tag !== "inbox")
    ).length,
    ai: fragments.filter((fragment) => fragment.aiStatus === "suggested").length,
    archive: 0,
  }

  return (
    <aside className="flex min-h-0 flex-col border-r border-border bg-sidebar">
      <div className="flex items-center gap-3 px-6 pt-8 pb-7">
        <BoxIcon className="size-9 stroke-[1.8]" />
        <div className="min-w-0">
          <div className="text-[22px] leading-7 font-bold">Shard</div>
          <div className="text-xs font-medium text-muted-foreground">v0.1.0</div>
        </div>
      </div>

      <nav className="flex flex-col gap-1 px-3">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = item.id === activeFilter

          return (
            <button
              className={[
                "relative flex h-11 items-center gap-3 rounded-md px-3 text-left text-sm font-semibold transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/70",
              ].join(" ")}
              key={item.id}
              onClick={() => onFilterChange(item.id)}
              type="button"
            >
              {isActive ? (
                <span
                  aria-hidden="true"
                  className="absolute top-2 bottom-2 left-1 w-0.5 rounded-full bg-[color:var(--shard-sapphire)]"
                />
              ) : null}
              <Icon className="size-4" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                {counts[item.id]}
              </span>
            </button>
          )
        })}
      </nav>

      <div className="mt-auto px-5 pb-5">
        <Separator className="mb-4" />
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-semibold">
              <span
                className={[
                  "size-2 rounded-full",
                  git?.status === "error" ? "bg-[color:var(--shard-ruby)]" : "",
                  git?.status === "dirty" ? "bg-[color:var(--shard-amber)]" : "",
                  !git || git.status === "ready"
                    ? "bg-[color:var(--shard-emerald)]"
                    : "",
                ].join(" ")}
              />
              {git?.status === "dirty" ? "Pending" : "Synced"}
            </div>
            <Button
              disabled={isSyncing}
              onClick={onSync}
              size="icon-sm"
              variant="ghost"
            >
              <RefreshCwIcon
                className={isSyncing ? "animate-spin" : ""}
                data-icon="inline-start"
              />
              <span className="sr-only">同步 Git vault</span>
            </Button>
          </div>
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <GitBranchIcon className="size-3.5" />
            <span className="truncate">{git?.branch || "main"}</span>
            <span>·</span>
            <span className="truncate">{git?.shortCommit || "no commit"}</span>
          </div>
          <Tooltip>
            <TooltipTrigger className="truncate text-left text-xs text-muted-foreground">
              {vaultPath || "Vault not loaded"}
            </TooltipTrigger>
            <TooltipContent side="top">{vaultPath || "Vault not loaded"}</TooltipContent>
          </Tooltip>
        </div>

        <Separator className="my-4" />
        <div className="flex items-center justify-between">
          <Button size="icon" variant="ghost">
            <SettingsIcon data-icon="inline-start" />
            <span className="sr-only">设置</span>
          </Button>
          <Button size="icon" variant="ghost">
            <KeyboardIcon data-icon="inline-start" />
            <span className="sr-only">快捷键</span>
          </Button>
          <Button size="icon" variant="ghost">
            <HelpCircleIcon data-icon="inline-start" />
            <span className="sr-only">帮助</span>
          </Button>
        </div>
      </div>
    </aside>
  )
}
