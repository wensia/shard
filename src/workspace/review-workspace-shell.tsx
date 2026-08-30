import type { ComponentProps } from "react"

import { ReviewWorkspace } from "@/components/shard/review-workspace"
import type { ReviewRoute } from "@/workspace/route"

type ReviewMode = ReviewRoute["params"]["mode"]

interface ReviewWorkspaceShellProps
  extends Omit<ComponentProps<typeof ReviewWorkspace>, "mode"> {
  mode: ReviewMode
  onModeChange: (mode: ReviewMode) => void
}

const REVIEW_TABS: ReadonlyArray<{ label: string; mode: ReviewMode }> = [
  { label: "每日回顾", mode: "dailyReview" },
  { label: "洞察视角", mode: "insight" },
  { label: "随机漫步", mode: "walk" },
]

export function ReviewWorkspaceShell({
  mode,
  onModeChange,
  ...workspaceProps
}: ReviewWorkspaceShellProps) {
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <nav
        aria-label="回顾视角"
        className="shard-content-inset shrink-0 border-b border-border bg-background"
        style={{ paddingBlock: "var(--space-2)" }}
      >
        <div
          className="shard-content-measure flex items-center gap-1 rounded-md border border-border bg-muted/40 p-1"
          style={{ width: "fit-content" }}
        >
          {REVIEW_TABS.map((tab) => {
            const active = tab.mode === mode

            return (
              <button
                aria-current={active ? "page" : undefined}
                className={[
                  "h-[var(--control-height-sm)] rounded-md px-3 text-[length:var(--text-body)] transition-colors",
                  active
                    ? "bg-card font-medium text-primary shadow-card"
                    : "font-normal text-muted-foreground hover:bg-muted hover:text-foreground",
                ].join(" ")}
                key={tab.mode}
                onClick={() => onModeChange(tab.mode)}
                type="button"
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <ReviewWorkspace mode={mode} {...workspaceProps} />
      </div>
    </section>
  )
}
