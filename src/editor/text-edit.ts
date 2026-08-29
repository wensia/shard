import {
  EditorSelection,
  type EditorState,
  type TransactionSpec,
} from "@codemirror/state"

import type { TextEdit } from "@/lib/editor-format"

export function textEditToTransaction(
  state: EditorState,
  edit: TextEdit,
): TransactionSpec {
  const current = state.doc.toString()
  const next = edit.content
  let prefix = 0
  const sharedLength = Math.min(current.length, next.length)

  while (prefix < sharedLength && current.charCodeAt(prefix) === next.charCodeAt(prefix)) {
    prefix += 1
  }

  let currentSuffix = current.length
  let nextSuffix = next.length
  while (
    currentSuffix > prefix &&
    nextSuffix > prefix &&
    current.charCodeAt(currentSuffix - 1) === next.charCodeAt(nextSuffix - 1)
  ) {
    currentSuffix -= 1
    nextSuffix -= 1
  }

  return {
    changes: {
      from: prefix,
      to: currentSuffix,
      insert: next.slice(prefix, nextSuffix),
    },
    selection: EditorSelection.range(edit.selectionStart, edit.selectionEnd),
  }
}
