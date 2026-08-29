import type { Page } from "@playwright/test"

interface ShardEditorTestSnapshot {
  value: string
  selectionStart: number
  selectionEnd: number
}

interface ShardEditorTestBridge {
  get(id: string): ShardEditorTestSnapshot
  select(id: string, from: number, to: number): void
  set(id: string, value: string): void
}

export async function fillEditor(page: Page, id: string, text: string) {
  await page.evaluate(
    ({ editorId, value }) => {
      const bridge = (
        window as typeof window & {
          __shardEditorTest?: ShardEditorTestBridge
        }
      ).__shardEditorTest
      if (!bridge) throw new Error("Shard 编辑器测试桥尚未挂载")
      bridge.set(editorId, value)
    },
    { editorId: id, value: text }
  )
}

export async function readEditor(page: Page, id: string) {
  return page.evaluate((editorId) => {
    const bridge = (
      window as typeof window & {
        __shardEditorTest?: ShardEditorTestBridge
      }
    ).__shardEditorTest
    if (!bridge) throw new Error("Shard 编辑器测试桥尚未挂载")
    return bridge.get(editorId).value
  }, id)
}

export async function selectRange(
  page: Page,
  id: string,
  from: number,
  to: number
) {
  await page.evaluate(
    ({ editorId, selectionEnd, selectionStart }) => {
      const bridge = (
        window as typeof window & {
          __shardEditorTest?: ShardEditorTestBridge
        }
      ).__shardEditorTest
      if (!bridge) throw new Error("Shard 编辑器测试桥尚未挂载")
      bridge.select(editorId, selectionStart, selectionEnd)
    },
    {
      editorId: id,
      selectionEnd: to,
      selectionStart: from,
    }
  )
}

export async function focusEditor(page: Page, id: string) {
  await page.evaluate((editorId) => {
    const bridge = (
      window as typeof window & {
        __shardEditorTest?: ShardEditorTestBridge
      }
    ).__shardEditorTest
    if (!bridge) throw new Error("Shard 编辑器测试桥尚未挂载")
    const selection = bridge.get(editorId)
    bridge.select(editorId, selection.selectionStart, selection.selectionEnd)
  }, id)
}
