import { useMemo } from "react"

import { MindMapPreview } from "@/components/shard/mind-map-preview"
import {
  MAX_MIND_MAP_OUTLINE_NODES,
  parseMindMapOutline,
} from "@/lib/mind-map-outline"

import styles from "./mind-map-fence-embed.module.css"

const PREVIEW_HEIGHT = 180

interface MindMapFenceEmbedProps {
  code: string
}

/** 碎片正文里 ```mindmap 围栏的只读预览；解析按 code memo，滚动时不重复布局。 */
export function MindMapFenceEmbed({ code }: MindMapFenceEmbedProps) {
  const outline = useMemo(() => parseMindMapOutline(code), [code])

  if (!outline.file) {
    return (
      <span className={styles.empty} data-mind-map-fence="empty">
        空的大纲导图
      </span>
    )
  }

  return (
    <section className={styles.preview} data-mind-map-fence="preview">
      <MindMapPreview file={outline.file} height={PREVIEW_HEIGHT} />
      {outline.truncated ? (
        <p className={styles.notice}>
          仅预览前 {MAX_MIND_MAP_OUTLINE_NODES} 个节点
        </p>
      ) : null}
    </section>
  )
}
