import { useEffect, useRef } from "react"

import { FragmentContent } from "@/components/shard/fragment-content"
import { cn } from "@/lib/utils"
import { attachSelectionBand } from "@/lib/selection-band"

interface FragmentBodyProps {
  className?: string
  content: string
  contentClassName?: string
  downloadableImages?: boolean
  hideTags?: boolean
  onTaskToggle?: (lineIndex: number) => void
  previewImages?: boolean
  renderImages?: boolean
  trimEnd?: boolean
  vaultPath?: string
}

export function FragmentBody({
  className,
  content,
  contentClassName,
  downloadableImages = false,
  hideTags = false,
  onTaskToggle,
  previewImages = true,
  renderImages = false,
  trimEnd = false,
  vaultPath,
}: FragmentBodyProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const body = (
    <FragmentContent
      className={contentClassName}
      content={trimEnd ? content.trimEnd() : content}
      downloadableImages={downloadableImages}
      hideTags={hideTags}
      onTaskToggle={onTaskToggle}
      previewImages={previewImages}
      renderImages={renderImages}
      vaultPath={vaultPath}
    />
  )
  const bodyClassName = cn("shard-memo-body", className)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const root = host.querySelector<HTMLElement>("[data-markdown-search-root]")
    return root ? attachSelectionBand(root, host) : undefined
  }, [])

  return (
    <div ref={hostRef} className={bodyClassName}>
      {body}
    </div>
  )
}
