import {
  BookOpenIcon,
  CalendarDaysIcon,
  InboxIcon,
  PanelLeftIcon,
  SearchIcon,
  type LucideIcon,
} from "@/components/icons"
import {
  type CSSProperties,
  type ReactNode,
} from "react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { Fragment } from "@/types"
import { addDays, daysBetween, formatDateKey, startOfLocalDay } from "@/lib/local-date"
import type {
  FragmentsView,
  WorkspaceRoute,
} from "@/workspace/route"

import styles from "./sidebar-nav.module.css"

interface SidebarNavProps {
  fragments: Fragment[]
  /** 钉在侧栏底部、不随导航滚动的一块（网页端的个人中心）。 */
  footer?: ReactNode
  isCollapsed: boolean
  onOpenSearch: () => void
  onRouteChange: (route: WorkspaceRoute) => void
  onToggleCollapsed: () => void
  route: WorkspaceRoute
}

export const SPACE_ITEMS = [
  {
    id: "fragments",
    icon: InboxIcon,
    route: { space: "fragments", params: {} },
    shortcut: "1",
  },
  { id: "calendar", icon: CalendarDaysIcon, route: { space: "calendar", params: {} }, shortcut: "2" },
  { id: "library", icon: BookOpenIcon, route: { space: "library", params: {} }, shortcut: "3" },
] as const satisfies ReadonlyArray<{
  id: Exclude<WorkspaceRoute["space"], "lockbox">
  icon: typeof InboxIcon
  route: WorkspaceRoute
  shortcut: "1" | "2" | "3"
}>

const FRAGMENT_ITEMS: Array<{
  id: Extract<FragmentsView, "all">
  icon: typeof InboxIcon
}> = [
  { id: "all", icon: InboxIcon },
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
      stats: string
    }
    groups: {
      fragments: string
      workbench: string
    }
    nav: Record<Extract<FragmentsView, "all">, string>
    spaces: Record<WorkspaceRoute["space"], string>
    search: string
    searchPlaceholder: string
    searchShortcut: string
    stats: {
      tags: string
      daySpan: string
    }
    vaultNotLoaded: string
  }
> = {
  zh: {
    aria: {
      collapse: "折叠侧边栏",
      expand: "展开侧边栏",
      navigation: "工作台导航",
      heatmap: "碎片热力图",
      stats: "碎片统计",
    },
    groups: {
      fragments: "碎片",
      workbench: "工作台",
    },
    nav: {
      all: "全部碎片",
    },
    spaces: {
      fragments: "碎片",
      calendar: "日历",
      library: "资料库",
      lockbox: "密匣",
    },
    search: "搜索内容",
    searchPlaceholder: "搜索或打开…",
    searchShortcut: "⌘K",
    stats: {
      tags: "个标签",
      daySpan: "记录跨度",
    },
    vaultNotLoaded: "资料库未加载",
  },
  en: {
    aria: {
      collapse: "Collapse sidebar",
      expand: "Expand sidebar",
      navigation: "Workspace navigation",
      heatmap: "Fragment heatmap",
      stats: "Vault stats",
    },
    groups: {
      fragments: "Items",
      workbench: "Main",
    },
    nav: {
      all: "All fragments",
    },
    spaces: {
      fragments: "Fragments",
      calendar: "Calendar",
      library: "Library",
      lockbox: "Lockbox",
    },
    search: "Search notes",
    searchPlaceholder: "Search or open…",
    searchShortcut: "⌘K",
    stats: {
      tags: "tags",
      daySpan: "Record span",
    },
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

const NAV_LABEL_STYLE: CSSProperties = {
  minWidth: 0,
  flex: "1 1 auto",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
}

export function SidebarNav({
  fragments,
  footer,
  isCollapsed,
  onOpenSearch,
  onRouteChange,
  onToggleCollapsed,
  route,
}: SidebarNavProps) {
  const language = getSidebarLanguage()
  const copy = SIDEBAR_COPY[language]
  const ownedFragments = fragments.filter((fragment) => fragment.kind === "fragment" && !fragment.lockbox)
  const activeFragments = ownedFragments.filter((fragment) => !fragment.archived)
  const counts = {
    all: activeFragments.length,
  }
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
            : "var(--space-3)",
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
              className="size-(--shard-icon-size-md)"
              style={{ flexShrink: 0 }}
            />
            {isCollapsed ? null : (
              <>
                <span style={NAV_LABEL_STYLE}>{copy.searchPlaceholder}</span>
                <kbd aria-hidden="true" className={styles.shortcutHint}>
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

      <nav
        aria-label={copy.aria.navigation}
        className={styles.navigation}
        style={{
          display: "flex",
          flexDirection: "column",
          paddingInline: isCollapsed ? "var(--space-2)" : "var(--space-3)",
        }}
      >
        {isCollapsed ? (
          <CollapsedGroupMarker label={copy.groups.workbench} />
        ) : null}
        {SPACE_ITEMS.map((item) => {
          const Icon = item.icon
          const isActive = item.id === route.space && item.id !== "fragments"

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
                shortcut={item.shortcut}
              />

              {item.id === "fragments" ? (
                <>
                  {isCollapsed ? (
                    <CollapsedGroupMarker label={copy.groups.fragments} />
                  ) : null}
                  <div
                    className={styles.navSubGroup}
                    data-sidebar-subgroup="fragments"
                  >
                    {FRAGMENT_ITEMS.map((subItem) => {
                      const SubIcon = subItem.icon
                      const isSubItemActive = route.space === "fragments" &&
                        (route.params.view ?? "all") === subItem.id
                      return (
                        <SidebarNavigationButton
                          className={`${styles.navSubItem} ${
                            isSubItemActive
                              ? styles.navSubItemActive
                              : styles.navSubItemInactive
                          }`}
                          group={copy.groups.fragments}
                          icon={SubIcon}
                          isActive={isSubItemActive}
                          isCollapsed={isCollapsed}
                          key={subItem.id}
                          label={copy.nav[subItem.id]}
                          level="secondary"
                          onClick={() =>
                            onRouteChange({
                              space: "fragments",
                              params: { view: subItem.id },
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
        {isCollapsed ? null : (
          <div className={styles.overview}>
            <div aria-label={copy.aria.stats} className={styles.overviewSummary}>
              <span>{heatmap.tagCount} {copy.stats.tags}</span>
              <span>{copy.stats.daySpan} {heatmap.daySpan} {language === "zh" ? "天" : "days"}</span>
            </div>
            <div aria-label={copy.aria.heatmap} role="img">
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
                        ? "0 0 0 1px rgb(var(--shard-ink-rgb) / var(--shard-alpha-21))"
                        : undefined,
                    }}
                    title={formatHeatmapCellLabel(cell, language)}
                  />
                ))}
              </div>
              <div className={styles.heatmapMonths}>
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
      </nav>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
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
  className,
  group,
  icon: Icon,
  isActive,
  isCollapsed,
  label,
  level = "primary",
  onClick,
  shortcut,
  trailing,
}: {
  className: string
  group?: string
  icon: LucideIcon
  isActive: boolean
  isCollapsed: boolean
  label: string
  level?: "primary" | "secondary"
  onClick: () => void
  shortcut?: "1" | "2" | "3"
  trailing?: ReactNode
}) {
  const content = (
    <>
      <Icon
        aria-hidden="true"
        className="size-(--shard-icon-size-nav)"
        style={{ flexShrink: 0 }}
      />
      {isCollapsed ? null : (
        <>
          <span style={NAV_LABEL_STYLE}>{label}</span>
          {shortcut ? (
            <span aria-hidden="true" className={styles.shortcutHint}>
              ⌘{shortcut}
            </span>
          ) : trailing}
        </>
      )}
    </>
  )
  const renderButton = (children?: ReactNode) => (
    <button
      aria-current={isActive ? "page" : undefined}
      aria-keyshortcuts={shortcut ? `Meta+${shortcut}` : undefined}
      // 带快捷键提示的一级项显式命名：提示是 aria-hidden，但整棵侧栏被 inert / aria-hidden
      // 时（如关闭窗口期间）隐藏子树会被计入名称，变成「碎片⌘1」
      aria-label={
        isCollapsed ? formatNavAccessibleName(group, label) : shortcut ? label : undefined
      }
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


function getSidebarLanguage(): SidebarLanguage {
  if (typeof navigator === "undefined") return "zh"

  const preferredLanguage =
    navigator.languages?.find((language) => language) ?? navigator.language

  return preferredLanguage.toLowerCase().startsWith("zh") ? "zh" : "en"
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

function startOfWeek(date: Date) {
  const weekday = (date.getDay() + 6) % 7
  return addDays(date, -weekday)
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
    return `${cell.label}: ${cell.count} 条碎片`
  }

  const unit = cell.count === 1 ? "fragment" : "fragments"
  return `${cell.label}: ${cell.count} ${unit}`
}
