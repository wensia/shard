import type { EditorView } from "@codemirror/view"
import { useSyncExternalStore } from "react"
import { createPortal } from "react-dom"

import { EditorTable } from "@/components/shard/editor-table"
import { parseMarkdownTable } from "@/lib/markdown-table"
import type {
  TableWidgetHostApi,
  TableWidgetProps,
} from "@/editor/extensions/table-widget"

interface TableWidgetStore extends TableWidgetHostApi {
  getSnapshot(): Map<HTMLElement, TableWidgetProps>
  subscribe(listener: () => void): () => void
}

const hosts = new WeakMap<EditorView, TableWidgetStore>()
const containerKeys = new WeakMap<HTMLElement, string>()
let nextContainerKey = 0

function getContainerKey(container: HTMLElement) {
  const existing = containerKeys.get(container)
  if (existing) return existing

  nextContainerKey += 1
  const key = `shard-cm-table-${nextContainerKey}`
  containerKeys.set(container, key)
  return key
}

function createStore(): TableWidgetStore {
  let snapshot = new Map<HTMLElement, TableWidgetProps>()
  const listeners = new Set<() => void>()

  function publish(next: Map<HTMLElement, TableWidgetProps>) {
    snapshot = next
    for (const listener of listeners) listener()
  }

  function set(container: HTMLElement, props: TableWidgetProps) {
    const next = new Map(snapshot)
    next.set(container, props)
    publish(next)
  }

  return {
    mount: set,
    update: set,
    unmount(container) {
      if (!snapshot.has(container)) return
      const next = new Map(snapshot)
      next.delete(container)
      publish(next)
    },
    focusCell(from, cell) {
      const entry = Array.from(snapshot).find(
        ([, props]) => props.sourceStart === from,
      )
      const focus = () => {
        const input = entry?.[0].querySelector<HTMLInputElement>(
          `[data-cell="${cell}"]`,
        )
        if (!input) return false
        input.focus()
        input.setSelectionRange(input.value.length, input.value.length)
        return true
      }

      // requestMeasure 的 write 通常已经晚于 portal commit；首帧尚未落地时只补一次。
      if (!focus()) requestAnimationFrame(focus)
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function getTableWidgetHost(view: EditorView): TableWidgetHostApi {
  let host = hosts.get(view)
  if (!host) {
    host = createStore()
    hosts.set(view, host)
  }
  return host
}

export function unregisterTableWidgetHost(view: EditorView) {
  hosts.delete(view)
}

export function focusTableWidgetCell(
  view: EditorView,
  from: number,
  cell: string,
) {
  // 插入表格后 CM 选区还停在源码范围内。先把它挪到表格块之后再失焦：
  // 之后单元格写回的每个事务，其 startState 选区都在表格外，Cmd+Z 撤回时
  // CM 恢复的选区也就落在表格外，不会触发「光标在源码范围内」的让位规则
  // 把 widget 换成源码。
  const firstLine = view.state.doc.lineAt(from)
  const lines = view.state.doc.toString().split("\n")
  const table = parseMarkdownTable(lines, firstLine.number - 1)
  const lastLine = view.state.doc.line(
    Math.min(firstLine.number + (table?.lineCount ?? 1) - 1, view.state.doc.lines),
  )
  const anchor = Math.min(lastLine.to + 1, view.state.doc.length)
  if (view.state.selection.main.anchor !== anchor) {
    view.dispatch({ selection: { anchor } })
  }
  // 让 contentDOM 失焦，StateField 才会恢复 widget 装饰，随后在测量 write
  // 阶段把焦点交给 portal input。
  if (document.activeElement === view.contentDOM) view.contentDOM.blur()
  view.requestMeasure({
    read: () => null,
    write: () => getTableWidgetHost(view).focusCell(from, cell),
  })
}

export function TableWidgetHost({ view }: { view: EditorView }) {
  const store = getTableWidgetHost(view) as TableWidgetStore
  const entries = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )

  return Array.from(entries, ([container, props]) =>
    createPortal(
      <EditorTable {...props} />,
      container,
      getContainerKey(container),
    ),
  )
}
