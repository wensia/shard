import { useCallback, useRef, type ComponentProps, type ComponentPropsWithoutRef, type ReactNode } from "react"

import appStyles from "@/App.module.css"
import { CaptureBox, type CaptureBoxHandle } from "@/components/shard/capture-box"
import { SearchContextBar } from "@/components/shard/fragment-search-workspace"
import { FragmentTimeline } from "@/components/shard/fragment-timeline"

interface FragmentsWorkspaceProps {
  capture: ComponentPropsWithoutRef<typeof CaptureBox>
  searchContextBar: ComponentProps<typeof SearchContextBar> | null
  timeline: Omit<ComponentProps<typeof FragmentTimeline>, "onScrollDown">
  filterContext?: ReactNode
}

export function FragmentsWorkspace({
  capture,
  searchContextBar,
  timeline,
  filterContext,
}: FragmentsWorkspaceProps) {
  const captureRef = useRef<CaptureBoxHandle>(null)
  const handleScrollDown = useCallback(() => captureRef.current?.collapse(), [])

  return (
    <section className={appStyles.workspaceColumn}>
      <div className={appStyles.composerPadding} data-tauri-drag-region>
        <CaptureBox {...capture} ref={captureRef} />
      </div>

      <div className={appStyles.workAreaStage}>
        <div className={appStyles.normalWorkArea}>
          {searchContextBar ? <SearchContextBar {...searchContextBar} /> : null}
          {filterContext}
          <FragmentTimeline {...timeline} onScrollDown={handleScrollDown} />
        </div>
      </div>
    </section>
  )
}
