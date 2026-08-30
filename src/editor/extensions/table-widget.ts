import {
  StateEffect,
  StateField,
  Transaction,
  type EditorState,
  type Extension,
} from "@codemirror/state"
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view"

import type { EditorTableProps } from "@/components/shard/editor-table"
import {
  getTableCellCount,
  MAX_EDITABLE_TABLE_CELLS,
  parseMarkdownTable,
  serializeMarkdownTable,
  type MarkdownTable,
} from "@/lib/markdown-table"

const MAX_WIDGET_DOCUMENT_LENGTH = 50_000
const FALLBACK_TABLE_ROW_HEIGHT = 40

export interface TableDescriptor {
  from: number
  to: number
  sourceText: string
  table: MarkdownTable
}

export type TableWidgetProps = Omit<EditorTableProps, "measure">

export interface TableWidgetHostApi {
  mount(container: HTMLElement, props: TableWidgetProps): void
  update(container: HTMLElement, props: TableWidgetProps): void
  unmount(container: HTMLElement): void
  focusCell(from: number, cell: string): void
}

export type ResolveTableWidgetHost = (
  view: EditorView,
) => TableWidgetHostApi | null

export const refreshTableEffect = StateEffect.define<null>()

const setTableCompositionEffect = StateEffect.define<boolean>()
const setTableContentFocusEffect = StateEffect.define<boolean>()

const tableCompositionField = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setTableCompositionEffect)) return effect.value
    }
    return value
  },
})

const tableContentFocusField = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setTableContentFocusEffect)) return effect.value
    }
    return value
  },
})

function transactionIsComposing(transaction: Transaction) {
  for (const effect of transaction.effects) {
    if (effect.is(setTableCompositionEffect)) return effect.value
  }

  return transaction.startState.field(tableCompositionField)
}

function selectionIntersects(
  selection: { from: number; to: number },
  from: number,
  to: number,
) {
  return selection.from <= to && selection.to >= from
}

function createTableDecorations(
  state: EditorState,
  resolveHost: ResolveTableWidgetHost,
) {
  if (state.doc.length > MAX_WIDGET_DOCUMENT_LENGTH) return Decoration.none

  const lines = Array.from({ length: state.doc.lines }, (_, index) =>
    state.doc.line(index + 1).text,
  )
  const contentHasFocus = state.field(tableContentFocusField)
  const selection = state.selection.main
  const decorations = []

  for (let index = 0; index < lines.length; index += 1) {
    const table = parseMarkdownTable(lines, index)
    if (!table) continue

    const firstLine = state.doc.line(index + 1)
    const lastLine = state.doc.line(index + table.lineCount)
    const from = firstLine.from
    const to = lastLine.to
    index += table.lineCount - 1

    if (getTableCellCount(table) > MAX_EDITABLE_TABLE_CELLS) continue
    if (contentHasFocus && selectionIntersects(selection, from, to)) continue

    const descriptor: TableDescriptor = {
      from,
      to,
      sourceText: state.doc.sliceString(from, to),
      table,
    }
    decorations.push(
      Decoration.replace({
        block: true,
        widget: new TableWidget(descriptor, resolveHost),
      }).range(from, to),
    )
  }

  return Decoration.set(decorations, true)
}

class TableWidget extends WidgetType {
  private rowHeight = FALLBACK_TABLE_ROW_HEIGHT
  private host: TableWidgetHostApi | null = null

  constructor(
    readonly descriptor: TableDescriptor,
    private readonly resolveHost: ResolveTableWidgetHost,
  ) {
    super()
  }

  eq(other: TableWidget) {
    return (
      this.descriptor.from === other.descriptor.from &&
      this.descriptor.sourceText === other.descriptor.sourceText
    )
  }

  get estimatedHeight() {
    return (this.descriptor.table.rows.length + 2) * this.rowHeight
  }

  private props(view: EditorView): TableWidgetProps {
    const { from, to, table } = this.descriptor

    return {
      table,
      onChange: (nextTable) => {
        view.dispatch({
          changes: {
            from,
            to,
            insert: serializeMarkdownTable(nextTable),
          },
          annotations: Transaction.userEvent.of("input"),
        })
      },
      onExit: () => {
        view.dispatch({ selection: { anchor: from } })
        view.focus()
      },
      sourceActive: false,
      sourceStart: from,
    }
  }

  toDOM(view: EditorView) {
    const container = document.createElement("div")
    container.className = "shard-cm-table-widget"
    container.dataset.tableStart = String(this.descriptor.from)

    // 自定义属性保存的是无单位倍率；读取 contentDOM 的计算值才能得到 px。
    const configuredLineHeight = Number.parseFloat(
      getComputedStyle(view.contentDOM).lineHeight,
    )
    if (Number.isFinite(configuredLineHeight) && configuredLineHeight > 0) {
      this.rowHeight = configuredLineHeight
    }

    this.host = this.resolveHost(view)
    this.host?.mount(container, this.props(view))
    return container
  }

  updateDOM(dom: HTMLElement, view: EditorView) {
    if (dom.dataset.tableStart !== String(this.descriptor.from)) return false

    this.host = this.resolveHost(view)
    this.host?.update(dom, this.props(view))
    return true
  }

  destroy(dom: HTMLElement) {
    this.host?.unmount(dom)
    this.host = null
  }

  ignoreEvent() {
    return true
  }
}

export function createTableWidgetExtension(
  resolveHost: ResolveTableWidgetHost,
): Extension {
  const tableDecorationField = StateField.define<DecorationSet>({
    create(state) {
      return createTableDecorations(state, resolveHost)
    },
    update(decorations, transaction) {
      if (transactionIsComposing(transaction)) {
        return decorations.map(transaction.changes)
      }

      const refreshRequested = transaction.effects.some((effect) =>
        effect.is(refreshTableEffect),
      )
      if (
        !transaction.docChanged &&
        !transaction.selection &&
        !refreshRequested
      ) {
        return decorations
      }

      return createTableDecorations(transaction.state, resolveHost)
    },
    provide: (field) => EditorView.decorations.from(field),
  })

  return [
    tableCompositionField,
    tableContentFocusField,
    tableDecorationField,
    EditorView.domEventHandlers({
      compositionstart: (_event, view) => {
        view.dispatch({ effects: setTableCompositionEffect.of(true) })
        return false
      },
      compositionend: (_event, view) => {
        view.dispatch({
          effects: [
            setTableCompositionEffect.of(false),
            refreshTableEffect.of(null),
          ],
        })
        return false
      },
      focus: (event, view) => {
        view.dispatch({
          effects: [
            setTableContentFocusEffect.of(event.target === view.contentDOM),
            refreshTableEffect.of(null),
          ],
        })
        return false
      },
      blur: (_event, view) => {
        view.dispatch({
          effects: [
            setTableContentFocusEffect.of(false),
            refreshTableEffect.of(null),
          ],
        })
        return false
      },
    }),
  ]
}
