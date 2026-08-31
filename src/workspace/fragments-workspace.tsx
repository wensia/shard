import type { ComponentProps } from "react"

import appStyles from "@/App.module.css"
import { CaptureBox } from "@/components/shard/capture-box"
import {
  FragmentSearchWorkspace,
  SearchContextBar,
} from "@/components/shard/fragment-search-workspace"
import { FragmentTimeline } from "@/components/shard/fragment-timeline"
import { MindMapPanel } from "@/components/shard/mind-map-panel"

interface FragmentsWorkspaceProps {
  capture: ComponentProps<typeof CaptureBox>
  isMindMapViewActive: boolean
  isSearchModeActive: boolean
  mindMapPanel: ComponentProps<typeof MindMapPanel>
  search: ComponentProps<typeof FragmentSearchWorkspace>
  searchContextBar: ComponentProps<typeof SearchContextBar> | null
  timeline: ComponentProps<typeof FragmentTimeline>
}

export function FragmentsWorkspace({
  capture,
  isMindMapViewActive,
  isSearchModeActive,
  mindMapPanel,
  search,
  searchContextBar,
  timeline,
}: FragmentsWorkspaceProps) {
  const isInboxView = !isMindMapViewActive

  return (
    <section className={appStyles.workspaceColumn}>
      {isInboxView ? (
        <div className={appStyles.composerPadding} data-tauri-drag-region>
          <CaptureBox {...capture} />
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
          {isMindMapViewActive ? (
            <MindMapPanel {...mindMapPanel} />
          ) : (
            <FragmentTimeline {...timeline} />
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
