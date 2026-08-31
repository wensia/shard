import type { ComponentProps } from "react"

import appStyles from "@/App.module.css"
import { CaptureBox } from "@/components/shard/capture-box"
import {
  FragmentSearchWorkspace,
  SearchContextBar,
} from "@/components/shard/fragment-search-workspace"
import { FragmentTimeline } from "@/components/shard/fragment-timeline"
import { InboxTagBar } from "@/components/shard/inbox-tag-bar"
import { MindMapPanel } from "@/components/shard/mind-map-panel"
import { TaggedPanel } from "@/components/shard/tagged-panel"
import type { FragmentFilter } from "@/types"

type FragmentWorkspaceFilter = Extract<
  FragmentFilter,
  "archive" | "inbox" | "tagged"
>

interface FragmentsWorkspaceProps {
  capture: ComponentProps<typeof CaptureBox>
  filter: FragmentWorkspaceFilter
  inboxTagBar: ComponentProps<typeof InboxTagBar>
  isMindMapViewActive: boolean
  isSearchModeActive: boolean
  mindMapPanel: ComponentProps<typeof MindMapPanel>
  search: ComponentProps<typeof FragmentSearchWorkspace>
  searchContextBar: ComponentProps<typeof SearchContextBar> | null
  taggedPanel: ComponentProps<typeof TaggedPanel>
  timeline: ComponentProps<typeof FragmentTimeline>
}

export function FragmentsWorkspace({
  capture,
  filter,
  inboxTagBar,
  isMindMapViewActive,
  isSearchModeActive,
  mindMapPanel,
  search,
  searchContextBar,
  taggedPanel,
  timeline,
}: FragmentsWorkspaceProps) {
  const isInboxView = filter === "inbox" && !isMindMapViewActive

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
          {isInboxView ? <InboxTagBar {...inboxTagBar} /> : null}
          {filter === "tagged" && !isMindMapViewActive ? (
            <TaggedPanel {...taggedPanel} />
          ) : null}
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
