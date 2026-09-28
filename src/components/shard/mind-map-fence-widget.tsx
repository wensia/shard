import { useEffect, useRef, useState } from "react"

import { MindMapFenceEmbed } from "@/components/shard/mind-map-fence-embed"
import { MindMapOutlineEditor } from "@/components/shard/mind-map-outline-editor"
import {
  createEmptyMindMapOutline,
  parseMindMapOutline,
  serializeMindMapOutline,
} from "@/lib/mind-map-outline"
import type { ShardMapFile } from "@/types"

import styles from "./mind-map-fence-widget.module.css"

export interface MindMapFenceWidgetProps {
  /** 围栏正文（不含 ``` 标记行）。 */
  code: string
  onChange: (code: string) => void
  onFileChange?: (file: ShardMapFile) => void
  onExit: () => void
  readOnly: boolean
  /** 围栏在文档里的起点，宿主据此定位要聚焦的 widget。 */
  sourceStart: number
}

/** 编辑器内 ```mindmap 围栏的替身：可编辑时是幕布式大纲，只读时退回导图预览。 */
export function MindMapFenceWidget({
  code,
  onChange,
  onFileChange,
  onExit,
  readOnly,
}: MindMapFenceWidgetProps) {
  if (readOnly) {
    return (
      <div className={styles.widget} data-mind-map-fence-widget="readonly">
        <MindMapFenceEmbed code={code} />
      </div>
    )
  }

  return <MindMapFenceOutline code={code} onChange={onChange} onExit={onExit} onFileChange={onFileChange} />
}

function parseOutlineSession(code: string): ShardMapFile {
  return parseMindMapOutline(code).file ?? createEmptyMindMapOutline()
}

function MindMapFenceOutline({
  code,
  onChange,
  onFileChange,
  onExit,
}: Pick<MindMapFenceWidgetProps, "code" | "onChange" | "onFileChange" | "onExit">) {
  // 会话树长期存活：树操作生成的节点 id 与 parseMindMapOutline 的 n0/n1 不同源，
  // 每次文档变更都重新解析会让输入框重建、丢掉焦点与组合态。
  const [session, setSession] = useState(() => parseOutlineSession(code))
  /** 最近一次从 props 看到的围栏正文。 */
  const lastCodeRef = useRef(code)
  /**
   * 最近一次自己写出去的正文。
   *
   * 富文本 NodeView 里「写回 → 宿主 → props」不是同步的：中间会插进一次
   * 「会话已更新、code 还是上一版」的渲染，照旧重建会话会把刚建出来的节点 id
   * 换掉，新节点的焦点随之丢失（CM6 宿主是同步回流，看不到这一拍）。
   *
   * 用「写出去的那串文本」判断回流，而不是一个布尔 pending 位：布尔位在
   * 「写回途中来了一次撤销」时会永远卡住——外部改动既不等于会话序列化，
   * 也不等于自己写出的文本，此时必须重建会话，pending 随之清掉。
   */
  const lastWrittenRef = useRef<string | null>(null)

  useEffect(() => {
    onFileChange?.(session)
  }, [onFileChange, session])

  if (lastCodeRef.current !== code) {
    lastCodeRef.current = code
    if (serializeMindMapOutline(session) === code || code === lastWrittenRef.current) {
      // 宿主跟上了自己的写回：不重建会话，清掉待回流标记。
      lastWrittenRef.current = null
    } else {
      // 外部改动（撤销、外部替换）：重建会话，并放弃等待自己的写回。
      setSession(parseOutlineSession(code))
      lastWrittenRef.current = null
    }
  }

  function handleChange(nextFile: ShardMapFile) {
    setSession(nextFile)
    onFileChange?.(nextFile)
    const nextCode = serializeMindMapOutline(nextFile)
    if (nextCode === lastCodeRef.current) {
      lastWrittenRef.current = null
      return
    }
    lastWrittenRef.current = nextCode
    onChange(nextCode)
  }

  return (
    <div className={styles.widget} data-mind-map-fence-widget="editor">
      <MindMapOutlineEditor
        compact
        file={session}
        onChange={handleChange}
        onExit={onExit}
      />
    </div>
  )
}
