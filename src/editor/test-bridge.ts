import { Transaction } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"

export interface ShardEditorTestSnapshot {
  value: string
  selectionStart: number
  selectionEnd: number
}

export interface ShardEditorTestBridge {
  list(): string[]
  get(id: string): ShardEditorTestSnapshot
  set(id: string, value: string): void
  select(id: string, from: number, to: number): void
  type(id: string, text: string): void
}

type ShardEditorTestGlobal = typeof globalThis & {
  __SHARD_TEST_COMMANDS__?: unknown
  __shardEditorTest?: ShardEditorTestBridge
}

const mountedEditors = new Map<string, EditorView>()

function getTestGlobal() {
  return globalThis as ShardEditorTestGlobal
}

function getView(id: string) {
  const view = mountedEditors.get(id)
  if (!view) throw new Error(`未找到 Shard 编辑器：${id}`)
  return view
}

function clampPosition(view: EditorView, position: number) {
  return Math.max(0, Math.min(position, view.state.doc.length))
}

function ensureTestBridge() {
  const testGlobal = getTestGlobal()
  if (!import.meta.env.DEV && testGlobal.__SHARD_TEST_COMMANDS__ === undefined) {
    return false
  }
  if (testGlobal.__shardEditorTest) return true

  testGlobal.__shardEditorTest = {
    list: () => Array.from(mountedEditors.keys()),
    get(id) {
      const view = getView(id)
      const selection = view.state.selection.main
      return {
        value: view.state.doc.toString(),
        selectionStart: selection.from,
        selectionEnd: selection.to,
      }
    },
    set(id, value) {
      const view = getView(id)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: { anchor: value.length },
        annotations: [
          Transaction.userEvent.of("shard.test.set"),
          Transaction.addToHistory.of(false),
        ],
      })
    },
    select(id, from, to) {
      const view = getView(id)
      view.dispatch({
        selection: {
          anchor: clampPosition(view, from),
          head: clampPosition(view, to),
        },
      })
      view.focus()
    },
    type(id, text) {
      const view = getView(id)
      const selection = view.state.selection.main
      const cursor = selection.from + text.length
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: text },
        selection: { anchor: cursor },
        annotations: Transaction.userEvent.of("input.type"),
      })
      view.focus()
    },
  }
  return true
}

export function registerShardEditorTestView(id: string, view: EditorView) {
  if (!ensureTestBridge()) return () => undefined
  mountedEditors.set(id, view)
  return () => {
    if (mountedEditors.get(id) === view) mountedEditors.delete(id)
  }
}
