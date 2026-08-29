import { EditorView } from "@codemirror/view"

import { getClipboardImageFiles } from "@/lib/clipboard-images"

interface ShardEditorClipboardOptions {
  onPasteFiles?: (files: File[]) => void
  onDropFiles?: (files: File[]) => void
}

function getDroppedImageFiles(event: DragEvent) {
  const dataTransfer = event.dataTransfer
  if (!dataTransfer) return []
  return Array.from(dataTransfer.files).filter((file) =>
    file.type.startsWith("image/"),
  )
}

export function createShardEditorClipboard(
  options: ShardEditorClipboardOptions,
) {
  return EditorView.domEventHandlers({
    paste: (event) => {
      const imageFiles = getClipboardImageFiles(event)
      if (imageFiles.length === 0 || !options.onPasteFiles) return false
      event.preventDefault()
      options.onPasteFiles(imageFiles)
      return true
    },
    drop: (event) => {
      const imageFiles = getDroppedImageFiles(event)
      if (imageFiles.length === 0 || !options.onDropFiles) return false
      event.preventDefault()
      options.onDropFiles(imageFiles)
      return true
    },
  })
}
