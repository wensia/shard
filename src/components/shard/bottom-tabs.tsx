import {
  ArchiveIcon,
  GitBranchIcon,
  HelpCircleIcon,
  InboxIcon,
  KeyboardIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  TagIcon,
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
import type { Fragment, FragmentFilter } from "@/types"

import styles from "./bottom-tabs.module.css"

interface BottomTabsProps {
  activeFilter: FragmentFilter
  fragments: Fragment[]
  onFilterChange: (filter: FragmentFilter) => void
  onHelp: () => void
  onOpenMindMaps: () => void
  onOpenSearch: () => void
  onOpenSettings: () => void
  onRestoreWindow: () => void
  onShortcuts: () => void
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
  onFilterChange,
  onHelp,
  onOpenMindMaps,
  onOpenSearch,
  onOpenSettings,
  onRestoreWindow,
  onShortcuts,
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

        <div className="flex items-center gap-2">
          <div
            style={{
              minWidth: 0,
              flex: "1 1 0%",
              overflowX: "auto",
              borderRadius: 8,
              background: "var(--muted)",
              padding: "var(--shard-space-1)",
            }}
          >
            <nav
              aria-label="Fragment filters"
              style={{
                display: "grid",
                minWidth: 304,
                gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                gap: "var(--shard-space-1)",
              }}
            >
              {tabItems.map((item) => {
                const Icon = item.icon
                const isActive = item.id === activeFilter

                return (
                  <button
                    aria-label={item.fullLabel}
                    className={`${styles.tab} ${
                      isActive ? styles.tabActive : styles.tabInactive
                    }`}
                    key={item.id}
                    onClick={() => onFilterChange(item.id)}
                    type="button"
                  >
                    {isActive ? (
                      <span
                        aria-hidden="true"
                        style={{
                          position: "absolute",
                          insetInline: "var(--shard-space-3)",
                          top: "var(--shard-space-1)",
                          height: 2,
                          borderRadius: 9999,
                          background: "var(--shard-sapphire)",
                        }}
                      />
                    ) : null}
                    <Icon style={{ width: 16, height: 16, flexShrink: 0 }} />
                    <span
                      className={styles.truncate}
                      style={{ maxWidth: "100%" }}
                    >
                      {item.label}
                    </span>
                    <span
                      style={{
                        position: "absolute",
                        top: "var(--shard-space-1)",
                        right: "var(--shard-space-1)",
                        minWidth: 16,
                        borderRadius: 9999,
                        background: "var(--background)",
                        paddingInline: "var(--shard-space-1)",
                        fontSize: 10,
                        lineHeight: "16px",
                        fontWeight: 700,
                        color: "var(--muted-foreground)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {counts[item.id]}
                    </span>
                  </button>
                )
              })}
            </nav>
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
