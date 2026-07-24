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
import { HStack } from "@astryxdesign/core/HStack"
import { Stack } from "@astryxdesign/core/Stack"
import { Tooltip } from "@astryxdesign/core/Tooltip"
import shardAppIconUrl from "@/assets/shard-app-icon.png"
import { dailyReviewCount, insightReviewCount } from "@/lib/review-workflows"
import { useAppVersion } from "@/lib/use-app-version"
import type { Fragment, FragmentFilter, GitInfo } from "@/types"

import styles from "./bottom-tabs.module.css"

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
  const gitDotColor = getGitStatusDotColor(git, isMissingRemote)

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
      <Stack gap={2} width="100%" maxWidth={720} style={{ marginInline: "auto" }}>
        <HStack
          gap={3}
          hAlign="between"
          vAlign="center"
          style={{ height: 28, minWidth: 0, fontSize: "var(--font-size-sm)" }}
        >
          <HStack
            gap={2}
            vAlign="center"
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
          </HStack>

          <HStack
            gap={2}
            hAlign="end"
            vAlign="center"
            style={{ minWidth: 0, color: "var(--muted-foreground)" }}
          >
            <HStack
              gap={1.5}
              vAlign="center"
              style={{
                flexShrink: 0,
                fontWeight: 600,
                color: "var(--sidebar-foreground)",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 9999,
                  background: gitDotColor,
                }}
              />
              {gitStateLabel}
            </HStack>

            <div className={styles.branchInfo}>
              <GitBranchIcon style={{ width: 14, height: 14, flexShrink: 0 }} />
              <span className={styles.truncate}>{git?.branch || "main"}</span>
              <span>·</span>
              <span className={styles.truncate}>
                {git?.shortCommit || "no commit"}
              </span>
            </div>

            <Tooltip
              content={vaultPath || "Vault not loaded"}
              placement="above"
            >
              <span className={`${styles.vaultPath} ${styles.truncate}`}>
                {vaultPath || "Vault not loaded"}
              </span>
            </Tooltip>
          </HStack>
        </HStack>

        <HStack gap={2} vAlign="center">
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
                  <RefreshCwIcon className={isSyncing ? styles.spin : undefined} />
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
        </HStack>
      </Stack>
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

function getGitStatusDotColor(git: GitInfo | null, isMissingRemote: boolean) {
  if (git?.status === "error") return "var(--shard-ruby)"
  if (git?.status === "dirty" || isMissingRemote) return "var(--shard-amber)"
  if (!git || (git.status === "ready" && git.hasRemote)) {
    return "var(--shard-emerald)"
  }
  if (git.status === "no_git") {
    return "color-mix(in oklab, var(--muted-foreground) calc(var(--shard-alpha-55) * 100%), transparent)"
  }
  return "var(--shard-emerald)"
}
