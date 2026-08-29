import { Transaction, type Extension } from "@codemirror/state"
import { keymap, type EditorView, type KeyBinding } from "@codemirror/view"
import {
  defaultKeymap,
  deleteCharBackward,
  deleteCharForward,
  history,
  historyKeymap,
  insertNewline,
} from "@codemirror/commands"

import { textEditToTransaction } from "@/editor/text-edit"
import {
  applyTaskLineBreak,
  applyTaskMarkerDeletion,
  type TaskMarkerDeletionKey,
} from "@/lib/editor-format"

interface ShardEditorKeymapOptions {
  onSubmit?: () => void
  onToggleZen?: () => void
}

const DEFAULT_KEY_ALLOWLIST = new Set([
  "Alt-ArrowLeft",
  "Alt-ArrowRight",
  "Alt-Backspace",
  "Alt-Delete",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Ctrl-ArrowLeft",
  "Ctrl-ArrowRight",
  "Ctrl-Backspace",
  "Ctrl-d",
  "Ctrl-Delete",
  "Ctrl-End",
  "Ctrl-h",
  "Ctrl-Home",
  "End",
  "Home",
  "Mod-a",
  "Mod-ArrowDown",
  "Mod-ArrowLeft",
  "Mod-ArrowRight",
  "Mod-ArrowUp",
  "Mod-Backspace",
  "Mod-Delete",
  "Mod-End",
  "Mod-Home",
  "PageDown",
  "PageUp",
])

const movementDeletionSelectionKeymap = defaultKeymap.filter(
  (binding) => binding.key && DEFAULT_KEY_ALLOWLIST.has(binding.key),
)

function dispatchTaskEdit(
  view: EditorView,
  edit: ReturnType<typeof applyTaskLineBreak>,
) {
  if (!edit) return false
  view.dispatch({
    ...textEditToTransaction(view.state, edit),
    annotations: Transaction.userEvent.of("input"),
  })
  return true
}

function handleTaskLineBreak(view: EditorView) {
  if (view.composing) return false
  const selection = view.state.selection.main
  const edit = applyTaskLineBreak(
    view.state.doc.toString(),
    selection.from,
    selection.to,
  )
  return dispatchTaskEdit(view, edit) || insertNewline(view)
}

function handleTaskMarkerDeletion(
  view: EditorView,
  key: TaskMarkerDeletionKey,
) {
  if (view.composing) return false
  const selection = view.state.selection.main
  const edit = applyTaskMarkerDeletion(
    view.state.doc.toString(),
    selection.from,
    selection.to,
    key,
  )
  if (dispatchTaskEdit(view, edit)) return true
  return key === "Backspace" ? deleteCharBackward(view) : deleteCharForward(view)
}

export function createShardEditorKeymap(
  options: ShardEditorKeymapOptions,
): Extension {
  const submit = (view: EditorView) => {
    if (view.composing || !options.onSubmit) return false
    options.onSubmit()
    return true
  }

  const shardBindings: KeyBinding[] = [
    // 旧 textarea 实现里 metaKey 与 ctrlKey 都能提交；Mac 上 Mod 只映射 Cmd，
    // 所以 Ctrl-Enter 要单独绑一次，现有 Playwright 用例也是按 Control+Enter 写的。
    { key: "Mod-Enter", run: submit },
    { key: "Ctrl-Enter", run: submit },
    {
      key: "Mod-Shift-f",
      run: (view) => {
        if (view.composing || !options.onToggleZen) return false
        options.onToggleZen()
        return true
      },
    },
    {
      key: "Ctrl-Shift-f",
      run: (view) => {
        if (view.composing || !options.onToggleZen) return false
        options.onToggleZen()
        return true
      },
    },
    { key: "Enter", run: handleTaskLineBreak },
    {
      key: "Backspace",
      run: (view) => handleTaskMarkerDeletion(view, "Backspace"),
    },
    {
      key: "Delete",
      run: (view) => handleTaskMarkerDeletion(view, "Delete"),
    },
  ]

  return [
    history(),
    keymap.of([
      ...shardBindings,
      ...historyKeymap,
      ...movementDeletionSelectionKeymap,
    ]),
  ]
}
