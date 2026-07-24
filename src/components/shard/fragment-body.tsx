import type { CSSProperties } from "react"

import { FragmentContent } from "@/components/shard/fragment-content"
import { cn } from "@/lib/utils"

interface FragmentBodyProps {
  as?: "div" | "p"
  className?: string
  content: string
  contentClassName?: string
  downloadableImages?: boolean
  hideTags?: boolean
  onTaskToggle?: (lineIndex: number) => void
  previewImages?: boolean
  renderImages?: boolean
  selectionEnd?: number
  selectionStart?: number
  trimEnd?: boolean
  vaultPath?: string
}

export function FragmentBody({
  as = "p",
  className,
  content,
  contentClassName,
  downloadableImages = false,
  hideTags = false,
  onTaskToggle,
  previewImages = true,
  renderImages = false,
  selectionEnd,
  selectionStart,
  trimEnd = false,
  vaultPath,
}: FragmentBodyProps) {
  const body = (
    <FragmentContent
      className={contentClassName}
      content={trimEnd ? content.trimEnd() : content}
      downloadableImages={downloadableImages}
      hideTags={hideTags}
      onTaskToggle={onTaskToggle}
      previewImages={previewImages}
      renderImages={renderImages}
      selectionEnd={selectionEnd}
      selectionStart={selectionStart}
      vaultPath={vaultPath}
    />
  )
  const bodyClassName = cn("shard-memo-body", className)
  const bodyStyle: CSSProperties = { whiteSpace: "pre-wrap" }

  if (as === "div") {
    return (
      <div className={bodyClassName} style={bodyStyle}>
        {body}
      </div>
    )
  }

  return (
    <p className={bodyClassName} style={{ ...bodyStyle, margin: 0 }}>
      {body}
    </p>
  )
}
