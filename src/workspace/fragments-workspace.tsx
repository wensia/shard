import { useCallback, useRef, type ComponentProps, type ComponentPropsWithoutRef, type ReactNode } from "react"

import appStyles from "@/App.module.css"
import { CaptureBox, type CaptureBoxHandle } from "@/components/shard/capture-box"
import {
  FragmentSearchWorkspace,
  SearchContextBar,
} from "@/components/shard/fragment-search-workspace"
import { FragmentTimeline } from "@/components/shard/fragment-timeline"
import { MindMapPanel } from "@/components/shard/mind-map-panel"

interface FragmentsWorkspaceProps {
  capture: ComponentPropsWithoutRef<typeof CaptureBox>
  isMindMapViewActive: boolean
  isSearchModeActive: boolean
  mindMapPanel: ComponentProps<typeof MindMapPanel>
  search: ComponentProps<typeof FragmentSearchWorkspace>
  searchContextBar: ComponentProps<typeof SearchContextBar> | null
  timeline: Omit<ComponentProps<typeof FragmentTimeline>, "onScrollDown">
  filterContext?: ReactNode
}

export function FragmentsWorkspace({
  capture,
  isMindMapViewActive,
  isSearchModeActive,
  mindMapPanel,
  search,
  searchContextBar,
  timeline,
  filterContext,
}: FragmentsWorkspaceProps) {
  const isInboxView = !isMindMapViewActive
  const captureRef = useRef<CaptureBoxHandle>(null)
  const handleScrollDown = useCallback(() => captureRef.current?.collapse(), [])

  return (
    <section className={appStyles.workspaceColumn}>
      {isInboxView ? (
        <div className={appStyles.composerPadding} data-tauri-drag-region>
          <CaptureBox {...capture} ref={captureRef} />
        </div>
      ) : null}

      <div className={appStyles.workAreaStage}>
        <div
          aria-hidden={isSearchModeActive ? true : undefined}
          className={appStyles.normalWorkArea}
          data-search-hidden={isSearchModeActive ? "true" : undefined}
        >
          {searchContextBar && !isMindMapViewActive ? (
            <SearchContextBar {...searchContextBar} />
          ) : null}
          {!isMindMapViewActive ? filterContext : null}
          {isMindMapViewActive ? (
            <MindMapPanel {...mindMapPanel} />
          ) : (
            <FragmentTimeline {...timeline} onScrollDown={handleScrollDown} />
          )}
        </div>

        {isSearchModeActive ? (
          <div className={appStyles.searchWorkArea}>
            <FragmentSearchWorkspace {...search} />
          </div>
        ) : null}
      </div>
    </section>
  )
}
