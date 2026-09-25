import type { Locator, Page } from "@playwright/test"

/**
 * 编辑器测试辅助：经 `window.__shardEditorTest`（`src/editor-rich/test-bridge.ts`）
 * 读写 `ShardRichEditor`。D2b 起 CodeMirror 与富文本开关已删除，
 * 所有编辑面只有富文本一条路径，用例不再需要打开或关闭任何开关。
 */

/**
 * 编辑器测试快照。
 *
 * `value` 是序列化后的 Markdown；`selectionStart`/`selectionEnd` 是 ProseMirror
 * 文档坐标（段落、列表项等节点边界各占位置），**不是** Markdown 文本下标。
 * 只拿它做「选区前后是否不变」这类相等比较，或配合 `selectDocRange` 回放；
 * 需要按正文定位时用 `selectEditorText`，需要落到行首行尾时用键盘导航。
 */
interface ShardEditorTestSnapshot {
  composing: boolean
  value: string
  selectionStart: number
  selectionEnd: number
}

interface ShardEditorTestBridge {
  focus(id: string): void
  get(id: string): ShardEditorTestSnapshot
  select(id: string, from: number, to: number): void
  set(id: string, value: string): void
  type(id: string, text: string): void
}

/** 选中正文后出现在选区上方的行内格式浮动条（`src/editor-rich/selection-toolbar.tsx`）。 */
export function selectionToolbar(page: Page): Locator {
  return page.getByRole("toolbar", { name: "文本格式", exact: true })
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
  return (await readEditorSnapshot(page, id)).value
}

export async function readEditorSnapshot(page: Page, id: string) {
  return page.evaluate((editorId) => {
    const bridge = (
      window as typeof window & {
        __shardEditorTest?: ShardEditorTestBridge
      }
    ).__shardEditorTest
    if (!bridge) throw new Error("Shard 编辑器测试桥尚未挂载")
    return bridge.get(editorId)
  }, id)
}

export async function typeEditor(page: Page, id: string, text: string) {
  await page.evaluate(
    ({ editorId, value }) => {
      const bridge = (
        window as typeof window & {
          __shardEditorTest?: ShardEditorTestBridge
        }
      ).__shardEditorTest
      if (!bridge) throw new Error("Shard 编辑器测试桥尚未挂载")
      bridge.type(editorId, value)
    },
    { editorId: id, value: text }
  )
}

/**
 * 按 ProseMirror 文档坐标设置选区并聚焦编辑器。
 *
 * 坐标来自 `readEditorSnapshot` 或按文档结构推算（首段正文从 1 开始），
 * 不是 Markdown 文本下标；按正文内容定位请用 `selectEditorText`。
 */
export async function selectDocRange(
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

/**
 * 在编辑区可见正文里查找 `text`（第 `occurrence` 次出现，从 0 计），
 * 用原生 DOM 选区选中它；`collapse` 为 `"start"`/`"end"` 时把光标落在它前/后。
 *
 * 只在单个文本节点内查找：跨标签芯片、跨段落的文本请拆成两次定位或改用键盘。
 * 设完后稳定约 60ms 再核对 DOM 选区仍在目标处，被编辑器覆盖就重放，最多重试 40 次。
 */
export async function selectEditorText(
  page: Page,
  id: string,
  text: string,
  options: { collapse?: "start" | "end"; occurrence?: number } = {}
) {
  const args = {
    collapse: options.collapse,
    editorId: id,
    needle: text,
    occurrence: options.occurrence ?? 0,
  }
  // 编辑器刚载入正文或刚获得焦点的一小段时间里，ProseMirror 可能把自己的
  // 选区写回 DOM、覆盖掉这里设的选区；所以设完后稳定一会儿再核对，不对就重放。
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.evaluate(
      ({ collapse, editorId, needle, occurrence }) => {
        const root = document.querySelector(
          `[data-shard-editor="${CSS.escape(editorId)}"] .ProseMirror`
        )
        if (!(root instanceof HTMLElement)) {
          throw new Error(`未找到富文本编辑区：${editorId}`)
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let seen = 0
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const content = node.textContent ?? ""
          let index = content.indexOf(needle)
          while (index >= 0) {
            if (seen === occurrence) {
              root.focus()
              const start = collapse === "end" ? index + needle.length : index
              const end = collapse === "start" ? index : index + needle.length
              const range = document.createRange()
              range.setStart(node, start)
              range.setEnd(node, end)
              const selection = window.getSelection()
              selection?.removeAllRanges()
              selection?.addRange(range)
              ;(window as typeof window & { __shardSelectTarget?: unknown }).__shardSelectTarget = {
                end,
                node,
                start,
              }
              return
            }
            seen += 1
            index = content.indexOf(needle, index + 1)
          }
        }
        throw new Error(`编辑区 ${editorId} 里找不到第 ${occurrence + 1} 处「${needle}」`)
      },
      args
    )
    await page.waitForTimeout(60)
    const settled = await page.evaluate(() => {
      const target = (
        window as typeof window & {
          __shardSelectTarget?: { end: number; node: Node; start: number }
        }
      ).__shardSelectTarget
      const selection = window.getSelection()
      if (!target || !selection || selection.rangeCount === 0) return false
      const range = selection.getRangeAt(0)
      return (
        range.startContainer === target.node &&
        range.startOffset === target.start &&
        range.endContainer === target.node &&
        range.endOffset === target.end
      )
    })
    if (settled) return
  }
  throw new Error(`编辑区 ${id} 的选区没能稳定落在「${text}」上`)
}

/** 聚焦编辑器，保留它当前的选区。 */
export async function focusEditor(page: Page, id: string) {
  await page.evaluate((editorId) => {
    const bridge = (
      window as typeof window & {
        __shardEditorTest?: ShardEditorTestBridge
      }
    ).__shardEditorTest
    if (!bridge) throw new Error("Shard 编辑器测试桥尚未挂载")
    bridge.focus(editorId)
  }, id)
}
