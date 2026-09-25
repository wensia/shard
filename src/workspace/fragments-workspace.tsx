import { useCallback, useRef, type ComponentProps, type ComponentPropsWithoutRef, type ReactNode } from "react"

import appStyles from "@/App.module.css"
import { CaptureBox, type CaptureBoxHandle } from "@/components/shard/capture-box"
import { SearchContextBar } from "@/components/shard/fragment-search-workspace"
import { FragmentTimeline } from "@/components/shard/fragment-timeline"
import { MindMapPanel } from "@/components/shard/mind-map-panel"

interface FragmentsWorkspaceProps {
  capture: ComponentPropsWithoutRef<typeof CaptureBox>
  isMindMapViewActive: boolean
  mindMapPanel: ComponentProps<typeof MindMapPanel>
  searchContextBar: ComponentProps<typeof SearchContextBar> | null
  timeline: Omit<ComponentProps<typeof FragmentTimeline>, "onScrollDown">
  filterContext?: ReactNode
}

export function FragmentsWorkspace({
  capture,
  isMindMapViewActive,
  mindMapPanel,
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
        <div className={appStyles.normalWorkArea}>
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
      </div>
    </section>
  )
}
