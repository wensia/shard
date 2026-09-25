import type { CSSProperties } from "react"

import { FragmentContent } from "@/components/shard/fragment-content"
import { containsMarkdownBlocks } from "@shard/markdown"
import { hasBlockUI } from "@/editor-rich/blocks/registry-ui"
import { cn } from "@/lib/utils"
import { parseWikilinks } from "@/lib/wikilink"

const FENCE_OPEN_PATTERN = /^```(\S*)\s*$/

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
      vaultPath={vaultPath}
    />
  )
  const bodyClassName = cn("shard-memo-body", className)
  const bodyStyle: CSSProperties = { whiteSpace: "pre-wrap" }
  // <table> 不能合法嵌在 <p> 里，含表格时容器降级为 div；
  // 注册过的围栏块渲染成 <section>，同理；其余情况保持原有的段落语义。
  const hasBlockContent = containsMarkdownBlocks(content, (line) => {
    const fence = FENCE_OPEN_PATTERN.exec(line)
    if (fence && hasBlockUI(fence[1])) return true
    const trimmed = line.trim()
    const links = parseWikilinks(trimmed)
    return links.length === 1 && Boolean(links[0].embed) && links[0].to === trimmed.length
  })

  if (as === "div" || hasBlockContent) {
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
