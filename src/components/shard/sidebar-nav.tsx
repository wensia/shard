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
import { Fragment as ReactFragment, useState } from "react"

import { Button } from "@astryxdesign/core/Button"
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu"
import { Tooltip } from "@astryxdesign/core/Tooltip"
import shardAppIconUrl from "@/assets/shard-app-icon.png"
import { dailyReviewCount, insightReviewCount } from "@/lib/review-workflows"
import { useAppVersion } from "@/lib/use-app-version"
import type { Fragment, FragmentFilter, GitInfo } from "@/types"

interface SidebarNavProps {
  activeFilter: FragmentFilter
  fragments: Fragment[]
  git: GitInfo | null
  isSyncing: boolean
  mindMapCount: number
  mindMapViewActive: boolean
  debtCount: number
  debtViewActive: boolean
  onOpenDebts: () => void
  onFilterChange: (filter: FragmentFilter) => void
  onHelp: () => void
  onOpenMindMaps: () => void
  onOpenSearch: () => void
  onOpenSettings: () => void
  onRestoreWindow: () => void
  onShortcuts: () => void
  onSync: () => void
  vaultPath: string
}

const navItems: Array<{
  id: FragmentFilter
  icon: typeof InboxIcon
}> = [
  { id: "inbox", icon: InboxIcon },
  { id: "tagged", icon: TagIcon },
  { id: "insight", icon: SparklesIcon },
  { id: "archive", icon: ArchiveIcon },
]

type SidebarLanguage = "en" | "zh"

const SIDEBAR_COPY: Record<
  SidebarLanguage,
  {
    aria: {
      filters: string
      heatmap: string
      utilityMenu: string
      stats: string
    }
    gitState: {
      error: string
      noGit: string
      noRemote: string
      noVault: string
      pending: string
      synced: string
    }
    debts: string
    help: string
    mindMaps: string
    noCommit: string
    nav: Record<FragmentFilter, string>
    restoreWindow: string
    search: string
    searchPlaceholder: string
    searchShortcut: string
    settings: string
    shortcuts: string
    stats: {
      days: string
      fragments: string
      tags: string
    }
    syncGitVault: string
    syncing: string
    vaultNotLoaded: string
  }
> = {
  zh: {
    aria: {
      filters: "片段筛选",
      heatmap: "片段热力图",
      stats: "资料库统计",
      utilityMenu: "打开帮助与设置菜单",
    },
    gitState: {
      error: "错误",
      noGit: "未初始化 Git",
      noRemote: "未配置远端",
      noVault: "无资料库",
      pending: "待同步",
      synced: "已同步",
    },
    debts: "债务",
    help: "帮助",
    mindMaps: "思维导图",
    noCommit: "无提交",
    nav: {
      archive: "归档",
      dailyReview: "每日回顾",
      inbox: "收件箱",
      insight: "洞察视角",
      lockbox: "密匣",
      tagged: "标签",
      walk: "随机漫步",
    },
    restoreWindow: "还原窗口尺寸",
    search: "搜索笔记",
    searchPlaceholder: "搜索正文或标签",
    searchShortcut: "⌘K",
    settings: "设置",
    shortcuts: "快捷键",
    stats: {
      days: "天",
      fragments: "片段",
      tags: "标签",
    },
    syncGitVault: "同步 Git 资料库",
    syncing: "同步中",
    vaultNotLoaded: "资料库未加载",
  },
  en: {
    aria: {
      filters: "Fragment filters",
      heatmap: "Fragment heatmap",
      stats: "Vault stats",
      utilityMenu: "Open help and settings menu",
    },
    gitState: {
      error: "Error",
      noGit: "No Git",
      noRemote: "No Remote",
      noVault: "No Vault",
      pending: "Pending",
      synced: "Synced",
    },
    debts: "Debts",
    help: "Help",
    mindMaps: "Mind maps",
    noCommit: "no commit",
    nav: {
      archive: "Archive",
      dailyReview: "Daily Review",
      inbox: "Inbox",
      insight: "Insight Lenses",
      lockbox: "Lockbox",
      tagged: "Tagged",
      walk: "Random Walk",
    },
    restoreWindow: "Restore Window Size",
    search: "Search notes",
    searchPlaceholder: "Search body or tags",
    searchShortcut: "⌘K",
    settings: "Settings",
    shortcuts: "Shortcuts",
    stats: {
      days: "Days",
      fragments: "Fragments",
      tags: "Tags",
    },
    syncGitVault: "Sync Git vault",
    syncing: "Syncing",
    vaultNotLoaded: "Vault not loaded",
  },
}

const MONTH_LABELS: Record<SidebarLanguage, readonly string[]> = {
  zh: [
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
  ],
  en: [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ],
}

export function SidebarNav({
  activeFilter,
  fragments,
  git,
  isSyncing,
  mindMapCount,
  mindMapViewActive,
  debtCount,
  debtViewActive,
  onOpenDebts,
  onFilterChange,
  onHelp,
  onOpenMindMaps,
  onOpenSearch,
  onOpenSettings,
  onRestoreWindow,
  onShortcuts,
  onSync,
  vaultPath,
}: SidebarNavProps) {
  const [isUtilityMenuOpen, setIsUtilityMenuOpen] = useState(false)
  const appVersion = useAppVersion()
  const language = getSidebarLanguage()
  const copy = SIDEBAR_COPY[language]
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
  const gitStateLabel = getGitStateLabel(git, copy)
  const gitSummary = `${git?.branch || "main"} · ${git?.shortCommit || copy.noCommit}`
  const vaultLabel = vaultPath || copy.vaultNotLoaded
  const isMissingRemote = Boolean(
    git && git.status !== "no_git" && !git.hasRemote
  )
  const heatmap = buildSidebarHeatmap(activeFragments, language)

  return (
    <aside className="flex h-full min-h-0 flex-col bg-sidebar">
      <div
        className="flex items-center gap-[var(--shard-space-3)] px-[var(--shard-sidebar-inset)] pt-[var(--shard-top-inset)] pb-[var(--shard-space-6)]"
        data-tauri-drag-region
      >
        <img
          alt=""
          aria-hidden="true"
          className="size-8 shrink-0 rounded-[var(--shard-radius-control)] object-contain"
          draggable={false}
          src={shardAppIconUrl}
        />
        <div className="min-w-0">
          <div className="text-xl leading-6 font-bold text-balance">Shard</div>
          <div className="text-xs font-medium text-muted-foreground">
            {appVersion ? `v${appVersion}` : "\u00A0"}
          </div>
        </div>
      </div>

      <div className="px-[var(--shard-sidebar-inset)] pb-[var(--shard-space-4)]">
        <button
          aria-label={copy.search}
          className="relative flex h-9 w-full items-center gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] border border-sidebar-border bg-card px-[var(--shard-space-3)] text-left text-sm text-muted-foreground transition-colors hover:border-ring hover:text-sidebar-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/[var(--shard-alpha-34)] focus-visible:outline-none"
          onClick={onOpenSearch}
          type="button"
        >
          <SearchIcon
            aria-hidden="true"
            className="size-4 shrink-0 stroke-[1.75]"
          />
          <span className="min-w-0 flex-1 truncate">
            {copy.searchPlaceholder}
          </span>
          <kbd className="rounded-[4px] border border-border bg-muted px-1.5 text-[10px] leading-4 font-semibold text-muted-foreground">
            {copy.searchShortcut}
          </kbd>
        </button>
      </div>

      <div className="px-[var(--shard-sidebar-inset)] pb-[var(--shard-space-5)]">
        <div
          aria-label={copy.aria.stats}
          className="grid grid-cols-3 gap-[var(--shard-space-2)]"
        >
          <SidebarStat
            label={copy.stats.fragments}
            value={activeFragments.length}
          />
          <SidebarStat label={copy.stats.tags} value={heatmap.tagCount} />
          <SidebarStat label={copy.stats.days} value={heatmap.daySpan} />
        </div>

        <div
          aria-label={copy.aria.heatmap}
          className="mt-[var(--shard-space-4)]"
          role="img"
        >
          <div className="shard-heatmap-grid">
            {heatmap.cells.map((cell) => (
              <span
                aria-label={formatHeatmapCellLabel(cell, language)}
                className={[
                  "size-[var(--shard-heatmap-cell)] rounded-[calc(var(--shard-radius-control)/2)]",
                  HEATMAP_LEVEL_CLASSES[cell.level],
                  cell.isToday
                    ? "ring-1 ring-[rgb(0_0_0/var(--shard-alpha-21))]"
                    : "",
                ].join(" ")}
                key={cell.key}
                title={formatHeatmapCellLabel(cell, language)}
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
        aria-label={copy.aria.filters}
        className="flex flex-col gap-[var(--shard-space-1)] px-[var(--shard-space-3)]"
      >
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive =
            item.id === activeFilter && !mindMapViewActive && !debtViewActive

          return (
            <ReactFragment key={item.id}>
              <button
                aria-current={isActive ? "page" : undefined}
                className={[
                  "relative flex h-10 items-center gap-[var(--shard-space-3)] rounded-[var(--shard-radius-control)] px-[var(--shard-space-3)] text-left text-sm font-semibold transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/[var(--shard-alpha-55)]",
                ].join(" ")}
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
                <span className="min-w-0 flex-1 truncate">
                  {copy.nav[item.id]}
                </span>
                <span className="min-w-7 rounded-md bg-muted px-2 py-0.5 text-center text-xs font-semibold text-muted-foreground tabular-nums">
                  {counts[item.id]}
                </span>
              </button>
              {item.id === "inbox" ? (
                <button
                  aria-current={mindMapViewActive ? "page" : undefined}
                  className={[
                    "relative flex h-9 items-center gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] pr-[var(--shard-space-3)] pl-[calc(var(--shard-space-3)+var(--shard-space-6))] text-left text-[13px] font-medium transition-colors",
                    mindMapViewActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/[var(--shard-alpha-55)]",
                  ].join(" ")}
                  onClick={onOpenMindMaps}
                  type="button"
                >
                  {mindMapViewActive ? (
                    <span
                      aria-hidden="true"
                      className="absolute top-[var(--shard-space-2)] bottom-[var(--shard-space-2)] left-[var(--shard-space-1)] w-0.5 rounded-full bg-[color:var(--shard-sapphire)]"
                    />
                  ) : null}
                  <GitBranchIcon className="size-3.5 shrink-0 stroke-[1.75]" />
                  <span className="min-w-0 flex-1 truncate">
                    {copy.mindMaps}
                  </span>
                  <span className="min-w-7 rounded-md bg-muted px-2 py-0.5 text-center text-xs font-semibold text-muted-foreground tabular-nums">
                    {mindMapCount}
                  </span>
                </button>
              ) : null}
            </ReactFragment>
          )
        })}

        <button
          aria-current={debtViewActive ? "page" : undefined}
          className={[
            "relative flex h-10 items-center gap-[var(--shard-space-3)] rounded-[var(--shard-radius-control)] px-[var(--shard-space-3)] text-left text-sm font-semibold transition-colors",
            debtViewActive
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground hover:bg-sidebar-accent/[var(--shard-alpha-55)]",
          ].join(" ")}
          onClick={onOpenDebts}
          type="button"
        >
          {debtViewActive ? (
            <span
              aria-hidden="true"
              className="absolute top-[var(--shard-space-2)] bottom-[var(--shard-space-2)] left-[var(--shard-space-1)] w-0.5 rounded-full bg-[color:var(--shard-sapphire)]"
            />
          ) : null}
          <HandCoinsIcon className="size-4 shrink-0 stroke-[1.75]" />
          <span className="min-w-0 flex-1 truncate">{copy.debts}</span>
          <span className="min-w-7 rounded-md bg-muted px-2 py-0.5 text-center text-xs font-semibold text-muted-foreground tabular-nums">
            {debtCount}
          </span>
        </button>
      </nav>

      <div className="mt-auto px-[var(--shard-sidebar-inset)] pt-[var(--shard-space-6)] pb-[var(--shard-space-5)]">
        <div className="flex items-center justify-between">
          <Tooltip
            content={
              <div className="flex flex-col gap-1">
                <span>
                  {isSyncing ? copy.syncing : `Git ${gitStateLabel}`}
                </span>
                <span className="text-background/[var(--shard-alpha-55)]">
                  {gitSummary}
                </span>
                <span className="max-w-64 truncate text-background/[var(--shard-alpha-55)]">
                  {vaultLabel}
                </span>
              </div>
            }
            placement="above"
          >
            <div className="relative">
              <Button
                icon={<RefreshCwIcon className={isSyncing ? "animate-spin" : ""} />}
                isDisabled={isSyncing}
                isIconOnly
                label={copy.syncGitVault}
                onClick={onSync}
                size="sm"
                variant="ghost"
              />
              <span
                aria-hidden="true"
                className={[
                  "pointer-events-none absolute top-2 right-2 size-1.5 rounded-full ring-1 ring-sidebar",
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
            </div>
          </Tooltip>
          <Tooltip content={copy.restoreWindow} placement="above">
            <Button
              icon={<Maximize2Icon />}
              isIconOnly
              label={copy.restoreWindow}
              onClick={onRestoreWindow}
              size="sm"
              variant="ghost"
            />
          </Tooltip>
          <DropdownMenu
            button={{
              icon: <MoreHorizontalIcon />,
              isIconOnly: true,
              label: copy.aria.utilityMenu,
              size: "sm",
              variant: "ghost",
            }}
            isMenuOpen={isUtilityMenuOpen}
            items={[
              {
                icon: <SettingsIcon />,
                label: copy.settings,
                onClick: () => window.setTimeout(onOpenSettings, 0),
              },
              {
                icon: <KeyboardIcon />,
                label: copy.shortcuts,
                onClick: () => window.setTimeout(onShortcuts, 0),
              },
              {
                icon: <HelpCircleIcon />,
                label: copy.help,
                onClick: () => window.setTimeout(onHelp, 0),
              },
            ]}
            menuWidth={160}
            onOpenChange={setIsUtilityMenuOpen}
            placement="above"
          />
        </div>
      </div>
    </aside>
  )
}

function getSidebarLanguage(): SidebarLanguage {
  if (typeof navigator === "undefined") return "zh"

  const preferredLanguage =
    navigator.languages?.find((language) => language) ?? navigator.language

  return preferredLanguage.toLowerCase().startsWith("zh") ? "zh" : "en"
}

function getGitStateLabel(
  git: GitInfo | null,
  copy: (typeof SIDEBAR_COPY)[SidebarLanguage]
) {
  if (!git) return copy.gitState.noVault
  if (git.status === "no_git") return copy.gitState.noGit
  if (!git.hasRemote) return copy.gitState.noRemote
  if (git.status === "dirty") return copy.gitState.pending
  if (git.status === "error") return copy.gitState.error
  return copy.gitState.synced
}

interface SidebarStatProps {
  label: string
  value: number
}

function SidebarStat({ label, value }: SidebarStatProps) {
  return (
    <div className="min-w-0 px-[var(--shard-space-1)] py-[var(--shard-space-2)] text-center">
      <div className="text-[21px] leading-6 font-medium tracking-normal text-sidebar-foreground tabular-nums">
        {value}
      </div>
      <div className="mt-[var(--shard-space-1)] text-[11px] leading-3 font-medium tracking-normal text-muted-foreground">
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
  "bg-border",
  "bg-[color-mix(in_srgb,var(--shard-sapphire)_24%,transparent)]",
  "bg-[color-mix(in_srgb,var(--shard-sapphire)_52%,transparent)]",
  "bg-[color-mix(in_srgb,var(--shard-sapphire)_82%,transparent)]",
] as const
function buildSidebarHeatmap(
  fragments: Fragment[],
  language: SidebarLanguage
): SidebarHeatmap {
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
          label: MONTH_LABELS[language][date.getMonth()],
        })
        labeledMonths.add(monthKey)
      }

      cells.push({
        count,
        isToday: key === todayKey,
        key,
        label: formatHeatmapDateLabel(date, language),
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

function formatHeatmapDateLabel(date: Date, language: SidebarLanguage) {
  if (language === "zh") {
    return `${date.getMonth() + 1}月${date.getDate()}日`
  }

  return `${MONTH_LABELS.en[date.getMonth()]} ${date.getDate()}`
}

function formatHeatmapCellLabel(
  cell: HeatmapCell,
  language: SidebarLanguage
) {
  if (language === "zh") {
    return `${cell.label}: ${cell.count} 条片段`
  }

  const unit = cell.count === 1 ? "fragment" : "fragments"
  return `${cell.label}: ${cell.count} ${unit}`
}
