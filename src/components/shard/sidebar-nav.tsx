import {
  ArchiveIcon,
  BotIcon,
  HelpCircleIcon,
  InboxIcon,
  KeyboardIcon,
  RefreshCwIcon,
  SettingsIcon,
  TagIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import shardAppIconUrl from "@/assets/shard-app-icon.png"
import type { Fragment, FragmentFilter, GitInfo } from "@/types"

interface SidebarNavProps {
  activeFilter: FragmentFilter
  fragments: Fragment[]
  git: GitInfo | null
  isSyncing: boolean
  onFilterChange: (filter: FragmentFilter) => void
  onOpenSettings: () => void
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
  onOpenSettings,
  onSync,
  vaultPath,
}: SidebarNavProps) {
  const activeFragments = fragments.filter((fragment) => !fragment.archived)
  const archivedFragments = fragments.filter((fragment) => fragment.archived)
  const counts: Record<FragmentFilter, number> = {
    inbox: activeFragments.filter((fragment) => fragment.tags.includes("inbox")).length,
    tagged: activeFragments.filter((fragment) =>
      fragment.tags.some((tag) => tag !== "inbox")
    ).length,
    ai: activeFragments.filter((fragment) => fragment.aiStatus === "suggested").length,
    archive: archivedFragments.length,
  }
  const gitStateLabel = getGitStateLabel(git)
  const gitSummary = `${git?.branch || "main"} · ${git?.shortCommit || "no commit"}`
  const vaultLabel = vaultPath || "Vault not loaded"
  const isMissingRemote = Boolean(
    git && git.status !== "no_git" && !git.hasRemote
  )
  const heatmap = buildSidebarHeatmap(activeFragments)

  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-border bg-sidebar">
      <div className="flex items-center gap-[var(--shard-space-3)] px-[var(--shard-sidebar-inset)] pt-[var(--shard-space-8)] pb-[var(--shard-space-6)]">
        <img
          alt=""
          aria-hidden="true"
          className="size-8 shrink-0 rounded-[8px] object-contain"
          draggable={false}
          src={shardAppIconUrl}
        />
        <div className="min-w-0">
          <div className="text-xl leading-6 font-bold">Shard</div>
          <div className="text-xs font-medium text-muted-foreground">v0.1.0</div>
        </div>
      </div>

      <div className="px-[var(--shard-sidebar-inset)] pb-[var(--shard-space-5)]">
        <div className="grid grid-cols-3 gap-[var(--shard-space-3)]">
          <SidebarStat label="片段" value={activeFragments.length} />
          <SidebarStat label="标签" value={heatmap.tagCount} />
          <SidebarStat label="天" value={heatmap.daySpan} />
        </div>

        <div
          aria-label="片段热力图"
          className="mt-[var(--shard-space-4)]"
          role="img"
        >
          <div className="shard-heatmap-grid">
            {heatmap.cells.map((cell) => (
              <span
                aria-label={`${cell.label}: ${cell.count} 条片段`}
                className={[
                  "size-[var(--shard-heatmap-cell)] rounded-[calc(var(--shard-radius-control)/2)]",
                  HEATMAP_LEVEL_CLASSES[cell.level],
                  cell.isToday
                    ? "ring-1 ring-[rgb(0_0_0/var(--shard-alpha-21))]"
                    : "",
                ].join(" ")}
                key={cell.key}
                title={`${cell.label}: ${cell.count} 条片段`}
              />
            ))}
          </div>

          <div className="relative mt-[var(--shard-space-2)] h-3 text-[10px] leading-3 font-medium text-muted-foreground">
            {heatmap.monthLabels.map((month) => (
              <span
                className="absolute whitespace-nowrap"
                key={`${month.column}-${month.label}`}
                style={{
                  left: `calc(${month.column} * (var(--shard-heatmap-cell) + var(--shard-heatmap-column-gap)))`,
                }}
              >
                {month.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      <nav
        aria-label="Fragment filters"
        className="flex flex-col gap-[var(--shard-space-1)] px-[var(--shard-space-3)]"
      >
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = item.id === activeFilter

          return (
            <button
              aria-current={isActive ? "page" : undefined}
              className={[
                "relative flex h-10 items-center gap-[var(--shard-space-3)] rounded-[var(--shard-radius-control)] px-[var(--shard-space-3)] text-left text-sm font-semibold transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/[var(--shard-alpha-55)]",
              ].join(" ")}
              key={item.id}
              onClick={() => onFilterChange(item.id)}
              type="button"
            >
              {isActive ? (
                <span
                  aria-hidden="true"
                  className="absolute top-[var(--shard-space-2)] bottom-[var(--shard-space-2)] left-[var(--shard-space-1)] w-0.5 rounded-full bg-[color:var(--shard-sapphire)]"
                />
              ) : null}
              <Icon className="size-4 shrink-0 stroke-[1.75]" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className="min-w-7 rounded-md bg-muted px-2 py-0.5 text-center text-xs font-semibold text-muted-foreground">
                {counts[item.id]}
              </span>
            </button>
          )
        })}
      </nav>

      <div className="mt-auto px-[var(--shard-sidebar-inset)] pt-[var(--shard-space-6)] pb-[var(--shard-space-5)]">
        <div className="flex items-center justify-between">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  className="relative"
                  disabled={isSyncing}
                  onClick={onSync}
                  size="icon"
                  variant="ghost"
                />
              }
            >
              <RefreshCwIcon
                className={isSyncing ? "animate-spin" : ""}
                data-icon="inline-start"
              />
              <span
                aria-hidden="true"
                className={[
                  "absolute top-2 right-2 size-1.5 rounded-full ring-1 ring-sidebar",
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
              <span className="sr-only">同步 Git vault</span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <div className="flex flex-col gap-1">
                <span>{isSyncing ? "同步中" : `Git ${gitStateLabel}`}</span>
                <span className="text-background/[var(--shard-alpha-55)]">{gitSummary}</span>
                <span className="max-w-64 truncate text-background/[var(--shard-alpha-55)]">
                  {vaultLabel}
                </span>
              </div>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button onClick={onOpenSettings} size="icon" variant="ghost" />
              }
            >
              <SettingsIcon data-icon="inline-start" />
              <span className="sr-only">设置</span>
            </TooltipTrigger>
            <TooltipContent side="top">设置</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button size="icon" variant="ghost" />}>
              <KeyboardIcon data-icon="inline-start" />
              <span className="sr-only">快捷键</span>
            </TooltipTrigger>
            <TooltipContent side="top">快捷键</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button size="icon" variant="ghost" />}>
              <HelpCircleIcon data-icon="inline-start" />
              <span className="sr-only">帮助</span>
            </TooltipTrigger>
            <TooltipContent side="top">帮助</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </aside>
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

interface SidebarStatProps {
  label: string
  value: number
}

function SidebarStat({ label, value }: SidebarStatProps) {
  return (
    <div className="min-w-0">
      <div className="text-xl leading-6 font-semibold text-muted-foreground">
        {value}
      </div>
      <div className="mt-1 text-xs leading-none font-medium text-muted-foreground">
        {label}
      </div>
    </div>
  )
}

interface HeatmapCell {
  count: number
  isToday: boolean
  key: string
  label: string
  level: 0 | 1 | 2 | 3
}

interface HeatmapMonthLabel {
  column: number
  label: string
}

interface SidebarHeatmap {
  cells: HeatmapCell[]
  daySpan: number
  monthLabels: HeatmapMonthLabel[]
  tagCount: number
}

const HEATMAP_COLUMNS = 12
const HEATMAP_ROWS = 7
const HEATMAP_LEVEL_CLASSES = [
  "bg-[#ecefef]",
  "bg-[color-mix(in_srgb,var(--shard-sapphire)_24%,transparent)]",
  "bg-[color-mix(in_srgb,var(--shard-sapphire)_52%,transparent)]",
  "bg-[color-mix(in_srgb,var(--shard-sapphire)_82%,transparent)]",
] as const
const MONTH_LABELS = [
  "一月",
  "二月",
  "三月",
  "四月",
  "五月",
  "六月",
  "七月",
  "八月",
  "九月",
  "十月",
  "十一月",
  "十二月",
] as const

function buildSidebarHeatmap(fragments: Fragment[]): SidebarHeatmap {
  const today = startOfLocalDay(new Date())
  const todayKey = formatDateKey(today)
  const currentWeekStart = startOfWeek(today)
  const gridStart = addDays(
    currentWeekStart,
    -(HEATMAP_COLUMNS - 1) * HEATMAP_ROWS
  )
  const countsByDate = new Map<string, number>()
  const tagSet = new Set<string>()
  let earliestDate: Date | null = null

  for (const fragment of fragments) {
    const fragmentDate = startOfLocalDay(new Date(fragment.createdAt))
    if (Number.isNaN(fragmentDate.getTime())) continue

    const key = formatDateKey(fragmentDate)
    countsByDate.set(key, (countsByDate.get(key) ?? 0) + 1)

    if (!earliestDate || fragmentDate < earliestDate) {
      earliestDate = fragmentDate
    }

    for (const tag of fragment.tags) {
      if (tag !== "inbox") {
        tagSet.add(tag)
      }
    }
  }

  const cells: HeatmapCell[] = []
  const monthLabels: HeatmapMonthLabel[] = []
  const labeledMonths = new Set<string>()

  for (let column = 0; column < HEATMAP_COLUMNS; column += 1) {
    for (let row = 0; row < HEATMAP_ROWS; row += 1) {
      const date = addDays(gridStart, column * HEATMAP_ROWS + row)
      const key = formatDateKey(date)
      const isFuture = date > today
      const count = isFuture ? 0 : countsByDate.get(key) ?? 0
      const monthKey = `${date.getFullYear()}-${date.getMonth()}`

      if (
        (column === 0 && row === 0) ||
        (date.getDate() === 1 && !labeledMonths.has(monthKey))
      ) {
        monthLabels.push({
          column,
          label: MONTH_LABELS[date.getMonth()],
        })
        labeledMonths.add(monthKey)
      }

      cells.push({
        count,
        isToday: key === todayKey,
        key,
        label: formatHeatmapDateLabel(date),
        level: getHeatmapLevel(count),
      })
    }
  }

  return {
    cells,
    daySpan: earliestDate ? daysBetween(earliestDate, today) + 1 : 0,
    monthLabels,
    tagCount: tagSet.size,
  }
}

function getHeatmapLevel(count: number): 0 | 1 | 2 | 3 {
  if (count <= 0) return 0
  if (count === 1) return 1
  if (count <= 3) return 2
  return 3
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function startOfWeek(date: Date) {
  const weekday = (date.getDay() + 6) % 7
  return addDays(date, -weekday)
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function daysBetween(start: Date, end: Date) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000
  return Math.round((end.getTime() - start.getTime()) / millisecondsPerDay)
}

function formatDateKey(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

function formatHeatmapDateLabel(date: Date) {
  return `${date.getMonth() + 1}月${date.getDate()}日`
}
