/**
 * 编辑器测试桥：`window.__shardEditorTest`，只在开发构建或注入了
 * `__SHARD_TEST_COMMANDS__` 的测试环境里挂载。
 *
 * 契约（`list/get/set/select/type/focus/snapshot`）沿用 CodeMirror 时期的形状，
 * `tests/ui/editor-helpers.ts` 的辅助函数直接调用它。
 */
export interface ShardEditorTestSnapshot {
  composing: boolean
  value: string
  selectionStart: number
  selectionEnd: number
}

export interface ShardEditorTestBridge {
  list(): string[]
  get(id: string): ShardEditorTestSnapshot
  set(id: string, value: string): void
  /**
   * 位置是 ProseMirror 文档坐标，不是 Markdown 文本偏移：按坐标设置选区并聚焦，
   * 固定返回 false，提醒调用方旧的「文本偏移」语义不成立。
   */
  select(id: string, from: number, to: number): boolean
  type(id: string, text: string): void
  focus(id: string): void
  snapshot(id: string): { composing: boolean; value: string }
}

/** 富文本编辑器注册进测试桥时提供的最小能力面。 */
export interface ShardRichEditorTestTarget {
  focus(): void
  getMarkdown(): string
  isComposing(): boolean
  /** ProseMirror 文档坐标，不是 Markdown 文本偏移。 */
  selection(): { from: number; to: number }
  setMarkdown(value: string): void
  setSelection(from: number, to: number): void
  typeText(text: string): void
}

type ShardEditorTestGlobal = typeof globalThis & {
  __SHARD_TEST_COMMANDS__?: unknown
  __shardEditorTest?: ShardEditorTestBridge
}

const mountedEditors = new Map<string, ShardRichEditorTestTarget>()

function getTestGlobal() {
  return globalThis as ShardEditorTestGlobal
}

function getEditor(id: string) {
  const target = mountedEditors.get(id)
  if (!target) throw new Error(`未找到 Shard 编辑器：${id}`)
  return target
}

function ensureTestBridge() {
  const testGlobal = getTestGlobal()
  if (!import.meta.env.DEV && testGlobal.__SHARD_TEST_COMMANDS__ === undefined) {
    return false
  }
  if (testGlobal.__shardEditorTest) return true

  testGlobal.__shardEditorTest = {
    list: () => [...mountedEditors.keys()],
    get(id) {
      const editor = getEditor(id)
      const selection = editor.selection()
      return {
        composing: editor.isComposing(),
        value: editor.getMarkdown(),
        selectionStart: selection.from,
        selectionEnd: selection.to,
      }
    },
    set(id, value) {
      getEditor(id).setMarkdown(value)
    },
    select(id, from, to) {
      getEditor(id).setSelection(from, to)
      return false
    },
    type(id, text) {
      getEditor(id).typeText(text)
    },
    focus(id) {
      getEditor(id).focus()
    },
    snapshot(id) {
      const editor = getEditor(id)
      return { composing: editor.isComposing(), value: editor.getMarkdown() }
    },
  }
  return true
}

export function registerShardRichEditorTest(id: string, target: ShardRichEditorTestTarget) {
  if (!ensureTestBridge()) return () => undefined
  mountedEditors.set(id, target)
  return () => {
    if (mountedEditors.get(id) === target) mountedEditors.delete(id)
  }
}
