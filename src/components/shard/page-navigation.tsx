import { ChevronRightIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { SidebarToggleButton } from "@/components/shard/sidebar-nav"
import { ServerConnectionStatus, WorkbenchMenu } from "@/components/shard/status-bar"
import { formatSaveState, type SaveState } from "@/lib/save-state"
import type { WorkspaceRoute } from "@/workspace/route"

import styles from "./page-navigation.module.css"

interface PageNavigationProps {
  route: WorkspaceRoute
  isSidebarCollapsed: boolean
  isCreating: boolean
  saveState: SaveState | null
  onRouteChange: (route: WorkspaceRoute) => void
  onToggleSidebar: () => void
  onOpenSettings: () => void
  onHelp: () => void
  onShortcuts: () => void
}

const SPACE_LABELS = { fragments: "碎片", calendar: "日历", library: "资料库", lockbox: "密匣" }

/** 网页外壳的当前位置与全局操作，内容区单独滚动。 */
export function PageNavigation({
  route,
  isSidebarCollapsed,
  isCreating,
  saveState,
  onRouteChange,
  onToggleSidebar,
  onOpenSettings,
  onHelp,
  onShortcuts,
}: PageNavigationProps) {
  const spaceLabel = SPACE_LABELS[route.space]
  const detail = route.space !== "fragments" ? null
    : route.params.view === "tag" ? `#${route.params.tag}`
    : route.params.view === "trash" ? "回收站" : "全部碎片"
  const hasAncestor = route.space === "fragments" &&
    (route.params.view === "tag" || route.params.view === "trash")
  const saveLabel = isCreating ? "保存中…" : saveState ? formatSaveState(saveState) : null

  return (
    <nav aria-label="页面导航" className={styles.navigation} data-focus-region="page-navigation">
      <div className={styles.location}>
        {isSidebarCollapsed ? (
          <div className={styles.sidebarToggle}>
            <SidebarToggleButton isCollapsed onToggleCollapsed={onToggleSidebar} />
          </div>
        ) : null}
        {hasAncestor ? (
          <>
            <Button className={styles.ancestor} onClick={() => onRouteChange({ space: route.space, params: {} })} size="sm" variant="ghost">
              {spaceLabel}
            </Button>
            <ChevronRightIcon aria-hidden="true" className={styles.chevron} />
          </>
        ) : null}
        <h1 aria-current="page" className={styles.title} title={detail ?? spaceLabel}>{detail ?? spaceLabel}</h1>
      </div>
      <div className={styles.actions}>
        {saveLabel ? <span aria-live="polite" className={styles.saveState} data-state={saveState ?? "saving"}>{saveLabel}</span> : null}
        <div className={styles.connection}><ServerConnectionStatus onOpenSettings={onOpenSettings} /></div>
        <div className={styles.tools}>
          <WorkbenchMenu onHelp={onHelp} onOpenSettings={onOpenSettings} onShortcuts={onShortcuts} side="bottom" size="icon" />
        </div>
      </div>
    </nav>
  )
}
