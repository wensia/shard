import {
  BookOpenIcon,
  GitBranchIcon,
  HelpCircleIcon,
  InboxIcon,
  KeyboardIcon,
  MoreHorizontalIcon,
  SearchIcon,
  SettingsIcon,
  Trash2Icon,
} from "@/components/icons"
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
import { useAppVersion } from "@/lib/use-app-version"
import type { Fragment } from "@/types"
import type {
  FragmentsView,
  WorkspaceRoute,
} from "@/workspace/route"

import styles from "./bottom-tabs.module.css"

interface BottomTabsProps {
  fragments: Fragment[]
  onHelp: () => void
  onOpenMindMaps: () => void
  onOpenSearch: () => void
  onOpenSettings: () => void
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
]

const FRAGMENT_TABS: Array<{
  id: FragmentsView
  label: string
  icon: typeof InboxIcon
}> = [
  { id: "all", label: "全部", icon: InboxIcon },
  { id: "trash", label: "回收站", icon: Trash2Icon },
]

export function BottomTabs({
  fragments,
  onHelp,
  onOpenMindMaps,
  onOpenSearch,
  onOpenSettings,
  onRouteChange,
  onShortcuts,
  route,
  vaultPath,
}: BottomTabsProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const appVersion = useAppVersion()
  const ownedFragments = fragments.filter((fragment) => fragment.kind === "fragment" && !fragment.lockbox)
  const activeFragments = ownedFragments.filter((fragment) => !fragment.archived)
  const counts: Record<FragmentsView, number> = {
    all: activeFragments.length,
    trash: ownedFragments.length - activeFragments.length,
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
                    <Icon aria-hidden="true" className="size-(--shard-icon-size-nav)" />
                    <span className={styles.truncate}>{item.label}</span>
                  </button>
                )
              })}
            </nav>

            {route.space === "fragments" ? (
              <nav aria-label="碎片视图" className={styles.secondaryTabs}>
                {FRAGMENT_TABS.map((item) => {
                  const Icon = item.icon
                  const isActive = (route.params.view ?? "all") === item.id
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
                          space: "fragments",
                          params: { view: item.id },
                        })
                      }
                      type="button"
                    >
                      <Icon aria-hidden="true" className="size-(--shard-icon-size-sm)" />
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
