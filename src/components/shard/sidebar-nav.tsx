import {
  BookOpenIcon,
  GitBranchIcon,
  HelpCircleIcon,
  HistoryIcon,
  InboxIcon,
  KeyboardIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  PanelLeftIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  RouteIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react"
import {
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { dailyReviewCount, insightReviewCount } from "@/lib/review-workflows"
import type { Fragment, FragmentFilter, GitInfo } from "@/types"
import type {
  ReviewWorkspaceMode,
  WorkspaceRoute,
} from "@/workspace/route"

import styles from "./sidebar-nav.module.css"

interface SidebarNavProps {
  fragments: Fragment[]
  git: GitInfo | null
  isCollapsed: boolean
  isSyncing: boolean
  mindMapCount: number
  mindMapViewActive: boolean
  onHelp: () => void
  onOpenMindMaps: () => void
  onOpenSearch: () => void
  onOpenSettings: () => void
  onRestoreWindow: () => void
  onRouteChange: (route: WorkspaceRoute) => void
  onShortcuts: () => void
  onSync: () => void
  onToggleCollapsed: () => void
  route: WorkspaceRoute
}

const SPACE_ITEMS: Array<{
  id: WorkspaceRoute["space"]
  icon: typeof InboxIcon
  route: WorkspaceRoute
}> = [
  {
    id: "fragments",
    icon: InboxIcon,
    route: { space: "fragments", params: {} },
  },
  { id: "library", icon: BookOpenIcon, route: { space: "library", params: {} } },
  {
    id: "review",
    icon: HistoryIcon,
    route: { space: "review", params: { mode: "dailyReview" } },
  },
]

const REVIEW_ITEMS: Array<{
  id: ReviewWorkspaceMode
  icon: typeof InboxIcon
}> = [
  { id: "dailyReview", icon: HistoryIcon },
  { id: "insight", icon: SparklesIcon },
  { id: "walk", icon: RouteIcon },
]

type SidebarLanguage = "en" | "zh"

const SIDEBAR_COPY: Record<
  SidebarLanguage,
  {
    aria: {
      collapse: string
      expand: string
      navigation: string
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
    help: string
    groups: {
      fragments: string
      review: string
      tools: string
      workbench: string
    }
    mindMaps: string
    noCommit: string
    nav: Record<FragmentFilter, string>
    spaces: Record<WorkspaceRoute["space"], string>
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
      collapse: "折叠侧边栏",
      expand: "展开侧边栏",
      navigation: "工作台导航",
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
    help: "帮助",
    groups: {
      fragments: "碎片",
      review: "回顾",
      tools: "工具",
      workbench: "工作台",
    },
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
    spaces: {
      fragments: "碎片",
      library: "资料库",
      lockbox: "密匣",
      review: "回顾",
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
      collapse: "Collapse sidebar",
      expand: "Expand sidebar",
      navigation: "Workspace navigation",
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
    help: "Help",
    groups: {
      fragments: "Items",
      review: "Review",
      tools: "Tools",
      workbench: "Main",
    },
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
    spaces: {
      fragments: "Fragments",
      library: "Library",
      lockbox: "Lockbox",
      review: "Review",
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

const TOOLTIP_DIM_COLOR =
  "color-mix(in oklab, var(--background) calc(var(--shard-alpha-55) * 100%), transparent)"

const NAV_LABEL_STYLE: CSSProperties = {
  minWidth: 0,
  flex: "1 1 auto",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
}

export function SidebarNav({
  fragments,
  git,
  isCollapsed,
  isSyncing,
  mindMapCount,
  mindMapViewActive,
  onHelp,
  onOpenMindMaps,
  onOpenSearch,
  onOpenSettings,
  onRestoreWindow,
  onRouteChange,
  onShortcuts,
  onSync,
  onToggleCollapsed,
  route,
}: SidebarNavProps) {
  const [isUtilityMenuOpen, setIsUtilityMenuOpen] = useState(false)
  const language = getSidebarLanguage()
  const copy = SIDEBAR_COPY[language]
  const activeFragments = fragments.filter((fragment) => !fragment.archived)
  const counts: Record<ReviewWorkspaceMode, number> = {
    dailyReview: dailyReviewCount(fragments),
    insight: insightReviewCount(fragments),
    walk: activeFragments.length,
  }
  const gitStateLabel = getGitStateLabel(git, copy)
  const gitSummary = `${git?.branch || "main"} · ${
    git?.shortCommit || copy.noCommit
  }`
  const gitDivergence =
    git && (git.ahead > 0 || git.behind > 0)
      ? `↑${git.ahead} ↓${git.behind}`
      : null
  const isSyncDisabled =
    isSyncing || !git || git.status === "no_git" || !git.hasRemote
  const heatmap = buildSidebarHeatmap(activeFragments, language)

  return (
    <aside
      aria-label={language === "zh" ? "Shard 侧边栏" : "Shard sidebar"}
      data-collapsed={isCollapsed}
      className={styles.sidebar}
      style={{
        display: "flex",
        height: "100%",
        minHeight: 0,
        flexDirection: "column",
        background: "var(--sidebar)",
      }}
    >
      <div
        data-sidebar-titlebar
        data-tauri-drag-region="true"
        className={styles.brandRow}
      >
        <SidebarToggleButton
          isCollapsed={isCollapsed}
          onToggleCollapsed={onToggleCollapsed}
        />
      </div>

      <div
        className={styles.searchSection}
        style={{
          paddingInline: isCollapsed
            ? "var(--space-2)"
            : "var(--shard-sidebar-inset)",
          paddingBottom: "var(--shard-space-4)",
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-label={copy.search}
                className={styles.searchButton}
                onClick={onOpenSearch}
                type="button"
              />
            }
          >
            <SearchIcon
              aria-hidden="true"
              size={16}
              strokeWidth={1.75}
              style={{ flexShrink: 0 }}
            />
            {isCollapsed ? null : (
              <>
                <span style={NAV_LABEL_STYLE}>{copy.searchPlaceholder}</span>
                <kbd className={styles.searchShortcut}>
                  {copy.searchShortcut}
                </kbd>
              </>
            )}
          </TooltipTrigger>
          {isCollapsed ? (
            <TooltipContent side="right">{copy.search}</TooltipContent>
          ) : null}
        </Tooltip>
      </div>

      {isCollapsed ? null : (
        <div
          style={{
            paddingInline: "var(--shard-sidebar-inset)",
            paddingBottom: "var(--shard-space-5)",
          }}
        >
          <div
            aria-label={copy.aria.stats}
            className="grid grid-cols-3 gap-2"
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
            role="img"
            style={{ marginTop: "var(--shard-space-4)" }}
          >
            <div className="shard-heatmap-grid">
              {heatmap.cells.map((cell) => (
                <span
                  aria-label={formatHeatmapCellLabel(cell, language)}
                  key={cell.key}
                  style={{
                    width: "var(--shard-heatmap-cell)",
                    height: "var(--shard-heatmap-cell)",
                    borderRadius: "calc(var(--shard-radius-control) / 2)",
                    background: HEATMAP_LEVEL_BACKGROUNDS[cell.level],
                    boxShadow: cell.isToday
                      ? "0 0 0 1px rgb(0 0 0 / var(--shard-alpha-21))"
                      : undefined,
                  }}
                  title={formatHeatmapCellLabel(cell, language)}
                />
              ))}
            </div>

            <div
              style={{
                position: "relative",
                marginTop: "var(--shard-space-2)",
                height: 12,
                fontSize: 10,
                lineHeight: "12px",
                fontWeight: 500,
                color: "var(--muted-foreground)",
              }}
            >
              {heatmap.monthLabels.map((month) => (
                <span
                  key={`${month.column}-${month.label}`}
                  style={{
                    position: "absolute",
                    whiteSpace: "nowrap",
                    left: `calc(${month.column} * (var(--shard-heatmap-cell) + var(--shard-heatmap-column-gap)))`,
                  }}
                >
                  {month.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <nav
        aria-label={copy.aria.navigation}
        className={styles.navigation}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-1)",
          paddingInline: isCollapsed ? "var(--space-2)" : "var(--space-3)",
        }}
      >
        {isCollapsed ? (
          <CollapsedGroupMarker label={copy.groups.workbench} />
        ) : null}
        {SPACE_ITEMS.map((item) => {
          const Icon = item.icon
          const isActive = item.id === route.space && !mindMapViewActive

          return (
            <div className={styles.navGroup} key={item.id}>
              <SidebarNavigationButton
                className={`${styles.navItem} ${
                  isActive ? styles.navItemActive : styles.navItemInactive
                }`}
                group={copy.groups.workbench}
                icon={Icon}
                isActive={isActive}
                isCollapsed={isCollapsed}
                label={copy.spaces[item.id]}
                onClick={() => onRouteChange(item.route)}
              />

              {item.id === "review" && route.space === "review" ? (
                <>
                  {isCollapsed ? (
                    <CollapsedGroupMarker label={copy.groups.review} />
                  ) : null}
                  <div
                    className={styles.navSubGroup}
                    data-sidebar-subgroup="review"
                  >
                    {REVIEW_ITEMS.map((subItem) => {
                      const SubIcon = subItem.icon
                      const isSubItemActive = route.params.mode === subItem.id
                      return (
                        <SidebarNavigationButton
                          className={`${styles.navSubItem} ${
                            isSubItemActive
                              ? styles.navSubItemActive
                              : styles.navSubItemInactive
                          }`}
                          group={copy.groups.review}
                          icon={SubIcon}
                          isActive={isSubItemActive}
                          isCollapsed={isCollapsed}
                          key={subItem.id}
                          label={copy.nav[subItem.id]}
                          level="secondary"
                          onClick={() =>
                            onRouteChange({
                              space: "review",
                              params: { mode: subItem.id },
                            })
                          }
                          trailing={
                            <span className={styles.navCount}>
                              {counts[subItem.id]}
                            </span>
                          }
                        />
                      )
                    })}
                  </div>
                </>
              ) : null}
            </div>
          )
        })}

        <div className={styles.navActionBoundary}>
          {isCollapsed ? (
            <CollapsedGroupMarker label={copy.groups.tools} />
          ) : null}
          <SidebarNavigationButton
            ariaPressed={mindMapViewActive}
            className={`${styles.navItem} ${
              mindMapViewActive ? styles.navItemActive : styles.navItemInactive
            }`}
            group={copy.groups.tools}
            icon={GitBranchIcon}
            isActive={mindMapViewActive}
            isCollapsed={isCollapsed}
            label={copy.mindMaps}
            onClick={onOpenMindMaps}
            trailing={<span className={styles.navCount}>{mindMapCount}</span>}
          />
        </div>
      </nav>

      <div
        className={styles.utilitySection}
        style={{
          marginTop: "auto",
          paddingInline: isCollapsed
            ? "var(--space-2)"
            : "var(--shard-sidebar-inset)",
          paddingTop: "var(--shard-space-6)",
          paddingBottom: "var(--shard-space-5)",
        }}
      >
        <div className={styles.utilityActions}>
          <Tooltip>
            <TooltipTrigger
              render={<div style={{ position: "relative" }} />}
            >
              <Button
                aria-label={copy.syncGitVault}
                disabled={isSyncDisabled}
                onClick={onSync}
                size="icon-sm"
                variant="ghost"
              >
                <RefreshCwIcon
                  aria-hidden="true"
                  className={isSyncing ? styles.spin : undefined}
                />
                <span className="sr-only">{copy.syncGitVault}</span>
              </Button>
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  width: 6,
                  height: 6,
                  borderRadius: 9999,
                  background: getGitStatusDotColor(git),
                  boxShadow: "0 0 0 1px var(--sidebar)",
                  pointerEvents: "none",
                }}
              />
            </TooltipTrigger>
            <TooltipContent side="top">
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--shard-space-1)",
                }}
              >
                <span>
                  {isSyncing ? copy.syncing : `Git ${gitStateLabel}`}
                </span>
                <span style={{ color: TOOLTIP_DIM_COLOR }}>
                  {gitSummary}
                  {gitDivergence ? ` · ${gitDivergence}` : ""}
                </span>
                {git?.error ? (
                  <span
                    style={{
                      maxWidth: 256,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: TOOLTIP_DIM_COLOR,
                    }}
                  >
                    {git.error}
                  </span>
                ) : null}
              </div>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={copy.restoreWindow}
                  onClick={onRestoreWindow}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <Maximize2Icon aria-hidden="true" />
              <span className="sr-only">{copy.restoreWindow}</span>
            </TooltipTrigger>
            <TooltipContent side="top">{copy.restoreWindow}</TooltipContent>
          </Tooltip>
          <DropdownMenu
            open={isUtilityMenuOpen}
            onOpenChange={setIsUtilityMenuOpen}
          >
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label={copy.aria.utilityMenu}
                  data-shard-utility-menu-trigger
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <MoreHorizontalIcon aria-hidden="true" />
              <span className="sr-only">{copy.aria.utilityMenu}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" style={{ width: 160 }}>
              <SidebarMenuItem
                icon={SettingsIcon}
                label={copy.settings}
                onSelect={onOpenSettings}
              />
              <SidebarMenuItem
                icon={KeyboardIcon}
                label={copy.shortcuts}
                onSelect={onShortcuts}
              />
              <SidebarMenuItem
                icon={HelpCircleIcon}
                label={copy.help}
                onSelect={onHelp}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </aside>
  )
}

export function SidebarToggleButton({
  isCollapsed,
  onToggleCollapsed,
}: Pick<SidebarNavProps, "isCollapsed" | "onToggleCollapsed">) {
  const copy = SIDEBAR_COPY[getSidebarLanguage()]

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={isCollapsed ? copy.aria.expand : copy.aria.collapse}
            onClick={onToggleCollapsed}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <PanelLeftIcon aria-hidden="true" className="size-4" />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {isCollapsed ? copy.aria.expand : copy.aria.collapse}
      </TooltipContent>
    </Tooltip>
  )
}

function SidebarNavigationButton({
  ariaPressed,
  className,
  group,
  icon: Icon,
  isActive,
  isCollapsed,
  label,
  level = "primary",
  onClick,
  trailing,
}: {
  ariaPressed?: boolean
  className: string
  group?: string
  icon: LucideIcon
  isActive: boolean
  isCollapsed: boolean
  label: string
  level?: "primary" | "secondary"
  onClick: () => void
  trailing?: ReactNode
}) {
  const content = (
    <>
      <Icon
        aria-hidden="true"
        size={18}
        strokeWidth={1.75}
        style={{ flexShrink: 0 }}
      />
      {isCollapsed ? null : (
        <>
          <span style={NAV_LABEL_STYLE}>{label}</span>
          {trailing}
        </>
      )}
    </>
  )
  const renderButton = (children?: ReactNode) => (
    <button
      aria-current={isActive ? "page" : undefined}
      aria-label={
        isCollapsed ? formatNavAccessibleName(group, label) : undefined
      }
      aria-pressed={ariaPressed}
      className={className}
      data-sidebar-level={level}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  )

  if (!isCollapsed) {
    return renderButton(content)
  }

  return (
    <Tooltip>
      <TooltipTrigger render={renderButton(content)} />
      <TooltipContent
        align="start"
        className={styles.navTooltip}
        side="right"
      >
        <span>{label}</span>
        <span className={styles.navTooltipGroup}>{group ?? "\u00A0"}</span>
      </TooltipContent>
    </Tooltip>
  )
}

function CollapsedGroupMarker({ label }: { label: string }) {
  return (
    <div aria-hidden="true" className={styles.collapsedGroupMarker}>
      <span>{label}</span>
    </div>
  )
}

function formatNavAccessibleName(group: string | undefined, label: string) {
  return group ? `${group}：${label}` : label
}

function SidebarMenuItem({
  icon: Icon,
  label,
  onSelect,
}: {
  icon: typeof SettingsIcon
  label: string
  onSelect: () => void
}) {
  return (
    <DropdownMenuItem onClick={() => window.setTimeout(onSelect, 0)}>
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </DropdownMenuItem>
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
  if (git.status === "error") return copy.gitState.error
  if (!git.hasRemote) return copy.gitState.noRemote
  if (
    git.status === "dirty" ||
    git.status === "syncing" ||
    git.ahead > 0 ||
    git.behind > 0
  ) {
    return copy.gitState.pending
  }
  return copy.gitState.synced
}

function getGitStatusDotColor(git: GitInfo | null) {
  if (git?.status === "error") return "var(--shard-danger)"
  if (
    git &&
    (git.status === "dirty" ||
      git.status === "syncing" ||
      git.ahead > 0 ||
      git.behind > 0 ||
      !git.hasRemote)
  ) {
    return "var(--shard-warning)"
  }
  if (git?.status === "ready" && git.hasRemote) {
    return "var(--shard-success)"
  }
  return "color-mix(in oklab, var(--muted-foreground) calc(var(--shard-alpha-55) * 100%), transparent)"
}

interface SidebarStatProps {
  label: string
  value: number
}

function SidebarStat({ label, value }: SidebarStatProps) {
  return (
    <div
      style={{
        minWidth: 0,
        paddingInline: "var(--shard-space-1)",
        paddingBlock: "var(--shard-space-2)",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 21,
          lineHeight: "24px",
          fontWeight: 500,
          color: "var(--sidebar-foreground)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div
        style={{
          marginTop: "var(--shard-space-1)",
          fontSize: 11,
          lineHeight: "12px",
          fontWeight: 500,
          color: "var(--muted-foreground)",
        }}
      >
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
const HEATMAP_LEVEL_BACKGROUNDS = [
  "var(--border)",
  "color-mix(in srgb, var(--shard-sapphire) 24%, transparent)",
  "color-mix(in srgb, var(--shard-sapphire) 52%, transparent)",
  "color-mix(in srgb, var(--shard-sapphire) 82%, transparent)",
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
