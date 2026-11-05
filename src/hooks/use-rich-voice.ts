import { useRef, type RefObject } from "react"
import type { ShardRichEditorHandle } from "@/editor-rich/ShardRichEditor"
import { useVoiceDictation } from "@/features/voice"

/** The editor is locked by the host while this captured insertion is pending. */
export function useRichVoice(targetId: string, editorRef: RefObject<ShardRichEditorHandle | null>, disabled = false) {
  const insert = useRef<((text: string) => boolean) | null>(null)
  return useVoiceDictation({
    targetId,
    disabled,
    onBeforeStart() {
      insert.current = editorRef.current?.captureTextInsertion() ?? null
      if (!insert.current) throw new Error("请先结束输入法组词，再开始录音")
    },
    onInsert(text) {
      if (!insert.current?.(text)) throw new Error("文档已变化，无法插入识别文字")
      insert.current = null
    },
  })
}
