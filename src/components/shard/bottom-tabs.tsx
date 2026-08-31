import {
  BookOpenIcon,
  GitBranchIcon,
  HelpCircleIcon,
  HistoryIcon,
  InboxIcon,
  KeyboardIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
} from "lucide-react"
import { useState } from "react"

import shardAppIconUrl from "@/assets/shard-app-icon.png"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { dailyReviewCount, insightReviewCount } from "@/lib/review-workflows"
import { useAppVersion } from "@/lib/use-app-version"
import type { Fragment } from "@/types"
import type {
  ReviewWorkspaceMode,
  WorkspaceRoute,
} from "@/workspace/route"

import styles from "./bottom-tabs.module.css"

interface BottomTabsProps {
  fragments: Fragment[]
  onHelp: () => void
  onOpenMindMaps: () => void
  onOpenSearch: () => void
  onOpenSettings: () => void
  onRestoreWindow: () => void
  onRouteChange: (route: WorkspaceRoute) => void
  onShortcuts: () => void
  route: WorkspaceRoute
  vaultPath: string
}

const SPACE_TABS: Array<{
  id: WorkspaceRoute["space"]
  label: string
  icon: typeof InboxIcon
  route: WorkspaceRoute
}> = [
  {
    id: "fragments",
    label: "碎片",
    icon: InboxIcon,
    route: { space: "fragments", params: {} },
  },
  {
    id: "library",
    label: "资料库",
    icon: BookOpenIcon,
    route: { space: "library", params: {} },
  },
  {
    id: "review",
    label: "回顾",
    icon: HistoryIcon,
    route: { space: "review", params: { mode: "dailyReview" } },
  },
]

const REVIEW_TABS: Array<{
  id: ReviewWorkspaceMode
  label: string
  icon: typeof InboxIcon
}> = [
  { id: "dailyReview", label: "每日回顾", icon: HistoryIcon },
  { id: "insight", label: "洞察", icon: SparklesIcon },
  { id: "walk", label: "漫步", icon: GitBranchIcon },
]

export function BottomTabs({
  fragments,
  onHelp,
  onOpenMindMaps,
  onOpenSearch,
  onOpenSettings,
  onRestoreWindow,
  onRouteChange,
  onShortcuts,
  route,
  vaultPath,
}: BottomTabsProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const appVersion = useAppVersion()
  const activeFragments = fragments.filter((fragment) => !fragment.archived)
  const counts: Record<ReviewWorkspaceMode, number> = {
    dailyReview: dailyReviewCount(fragments),
    insight: insightReviewCount(fragments),
    walk: activeFragments.length,
  }

  return (
    <footer
      style={{
        flexShrink: 0,
        borderTop: "1px solid var(--border)",
        background: "var(--sidebar)",
        paddingInline: "var(--shard-space-4)",
        paddingTop: "10px",
        paddingBottom: "var(--shard-space-3)",
      }}
    >
      <div
        style={{
          display: "flex",
          width: "100%",
          maxWidth: 720,
          marginInline: "auto",
          flexDirection: "column",
          gap: "var(--shard-space-2)",
        }}
      >
        <div
          style={{ height: 28, minWidth: 0, fontSize: "var(--font-size-sm)" }}
          className="flex items-center justify-between gap-3"
        >
          <div
            className="flex items-center gap-2"
            style={{ minWidth: 0, color: "var(--sidebar-foreground)" }}
          >
            <img
              alt=""
              aria-hidden="true"
              draggable={false}
              src={shardAppIconUrl}
              style={{
                width: 16,
                height: 16,
                flexShrink: 0,
                borderRadius: "var(--shard-radius-control)",
                objectFit: "contain",
              }}
            />
            <span style={{ fontWeight: 700 }}>Shard</span>
            {appVersion ? (
              <span style={{ color: "var(--muted-foreground)" }}>
                v{appVersion}
              </span>
            ) : null}
          </div>

          <div
            className="flex items-center justify-end gap-2"
            style={{ minWidth: 0, color: "var(--muted-foreground)" }}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className={`${styles.vaultPath} ${styles.truncate}`} />
                }
              >
                {vaultPath || "Vault not loaded"}
              </TooltipTrigger>
              <TooltipContent side="top">
                {vaultPath || "Vault not loaded"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="flex items-end gap-2">
          <div className={styles.navigationStack}>
            <nav aria-label="工作台" className={styles.primaryTabs}>
              {SPACE_TABS.map((item) => {
                const Icon = item.icon
                const isActive = item.id === route.space

                return (
                  <button
                    aria-current={isActive ? "page" : undefined}
                    className={`${styles.tab} ${
                      isActive ? styles.tabActive : styles.tabInactive
                    }`}
                    key={item.id}
                    onClick={() => onRouteChange(item.route)}
                    type="button"
                  >
                    <Icon aria-hidden="true" size={18} strokeWidth={1.75} />
                    <span className={styles.truncate}>{item.label}</span>
                  </button>
                )
              })}
            </nav>

            {route.space === "review" ? (
              <nav aria-label="回顾空间" className={styles.secondaryTabs}>
                {REVIEW_TABS.map((item) => {
                  const Icon = item.icon
                  const isActive = route.params.mode === item.id
                  return (
                    <button
                      aria-current={isActive ? "page" : undefined}
                      className={`${styles.secondaryTab} ${
                        isActive
                          ? styles.secondaryTabActive
                          : styles.secondaryTabInactive
                      }`}
                      key={item.id}
                      onClick={() =>
                        onRouteChange({
                          space: "review",
                          params: { mode: item.id },
                        })
                      }
                      type="button"
                    >
                      <Icon aria-hidden="true" size={14} strokeWidth={1.75} />
                      <span className={styles.truncate}>{item.label}</span>
                      <span className={styles.count}>{counts[item.id]}</span>
                    </button>
                  )
                })}
              </nav>
            ) : null}
          </div>

          <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label="更多操作"
                  data-shard-utility-menu-trigger
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <MoreHorizontalIcon aria-hidden="true" />
              <span className="sr-only">更多操作</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" style={{ width: 160 }}>
              <BottomMenuItem
                icon={SearchIcon}
                label="搜索笔记"
                onSelect={onOpenSearch}
              />
              <BottomMenuItem
                icon={GitBranchIcon}
                label="思维导图"
                onSelect={onOpenMindMaps}
              />
              <DropdownMenuSeparator />
              <BottomMenuItem
                icon={Maximize2Icon}
                label="还原窗口尺寸"
                onSelect={onRestoreWindow}
              />
              <DropdownMenuSeparator />
              <BottomMenuItem
                icon={SettingsIcon}
                label="设置"
                onSelect={onOpenSettings}
              />
              <BottomMenuItem
                icon={KeyboardIcon}
                label="快捷键"
                onSelect={onShortcuts}
              />
              <BottomMenuItem
                icon={HelpCircleIcon}
                label="帮助"
                onSelect={onHelp}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </footer>
  )
}

function BottomMenuItem({
  icon: Icon,
  label,
  onSelect,
}: {
  icon: typeof SearchIcon
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
