import {
  BookOpenIcon,
  HelpCircleIcon,
  InboxIcon,
  KeyboardIcon,
  MoreHorizontalIcon,
  SearchIcon,
  SettingsIcon,
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

import { TabLabel } from "@/components/ui/tabs"
import styles from "./bottom-tabs.module.css"
import { isWebRuntime } from "@/lib/transport"

interface BottomTabsProps {
  fragments: Fragment[]
  onHelp: () => void
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
  id: Extract<FragmentsView, "all">
  label: string
  icon: typeof InboxIcon
}> = [
  { id: "all", label: "全部", icon: InboxIcon },
]

export function BottomTabs({
  fragments,
  onHelp,
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
  const counts = {
    all: activeFragments.length,
  }
  const menuContent = (
    <DropdownMenuContent align="end" side="top" style={{ width: 160 }}>
      <BottomMenuItem
        icon={SearchIcon}
        label="搜索笔记"
        onSelect={onOpenSearch}
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
  )
  const spaceTabs = SPACE_TABS.map((item) => {
    const Icon = item.icon
    const isActive = item.id === route.space

    return (
      <button
        aria-current={isActive ? "page" : undefined}
        className="shard-tab"
        key={item.id}
        onClick={() => onRouteChange(item.route)}
        type="button"
      >
        <Icon aria-hidden="true" />
        <TabLabel>{item.label}</TabLabel>
      </button>
    )
  })

  // 网页手机端（kiln Mobile Shell）：底部只有一行导航。品牌行（版本、资料库路径都没有可看的）
  // 与只有「全部」一项的二级页签不进底栏；「更多」做成同高的第三个页签，整行都是 44px 触控区。
  if (isWebRuntime()) {
    return (
      <footer className={styles.webBar}>
        <nav aria-label="工作台" className={`shard-tabs ${styles.webNav}`} data-size="nav">
          {spaceTabs}
          <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
            <DropdownMenuTrigger
              render={
                <button
                  aria-label="更多操作"
                  className="shard-tab"
                  data-shard-utility-menu-trigger
                  type="button"
                />
              }
            >
              <MoreHorizontalIcon aria-hidden="true" />
              <TabLabel>更多</TabLabel>
            </DropdownMenuTrigger>
            {menuContent}
          </DropdownMenu>
        </nav>
      </footer>
    )
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
            <nav aria-label="工作台" className="shard-tabs" data-size="nav">
              {spaceTabs}
            </nav>

            {route.space === "fragments" ? (
              <nav
                aria-label="碎片视图"
                className={`shard-tabs ${styles.secondaryTabs}`}
                data-size="sub"
              >
                {FRAGMENT_TABS.map((item) => {
                  const Icon = item.icon
                  const isActive = (route.params.view ?? "all") === item.id
                  return (
                    <button
                      aria-current={isActive ? "page" : undefined}
                      className="shard-tab"
                      key={item.id}
                      onClick={() =>
                        onRouteChange({
                          space: "fragments",
                          params: { view: item.id },
                        })
                      }
                      type="button"
                    >
                      <Icon aria-hidden="true" />
                      <TabLabel>{item.label}</TabLabel>
                      <span className="shard-tab-count">{counts[item.id]}</span>
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
            {menuContent}
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
