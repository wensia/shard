import {
  Compartment,
  EditorState,
  Transaction,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state"
import {
  EditorView,
  placeholder as placeholderExtension,
} from "@codemirror/view"
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type MutableRefObject,
} from "react"

import type { TextEdit } from "@/lib/editor-format"
import { createShardEditorClipboard } from "@/editor/extensions/clipboard"
import { createShardLivePreview } from "@/editor/extensions/live-preview"
import { createShardMarkdown } from "@/editor/extensions/markdown"
import { createShardEditorTheme } from "@/editor/extensions/theme"
import { createShardEditorKeymap } from "@/editor/extensions/keymap"
import { createShardSelectionLayer } from "@/editor/extensions/selection"
import { textEditToTransaction } from "@/editor/text-edit"
import { registerShardEditorTestView } from "@/editor/test-bridge"

export interface ShardEditorProps {
  editorId: string
  value: string
  documentKey: string
  variant: "composer" | "inline" | "zen"
  placeholder?: string
  ariaLabel?: string
  autoFocus?: boolean
  readOnly?: boolean
  onChange: (value: string) => void
  onSelectionChange?: (start: number, end: number) => void
  onSubmit?: () => void
  onToggleZen?: () => void
  onPasteFiles?: (files: File[]) => void
  onDropFiles?: (files: File[]) => void
  onHeightChange?: (height: number) => void
  onFocus?: () => void
  extensions?: Extension[]
}

export interface ShardEditorHandle {
  focus(): void
  getSelection(): { start: number; end: number }
  applyTextEdit(edit: TextEdit): void
  replaceDocument(value: string): void
  view: EditorView | null
}

interface CallbackRefs {
  onChange: MutableRefObject<ShardEditorProps["onChange"]>
  onSelectionChange: MutableRefObject<ShardEditorProps["onSelectionChange"]>
  onHeightChange: MutableRefObject<ShardEditorProps["onHeightChange"]>
  onFocus: MutableRefObject<ShardEditorProps["onFocus"]>
  onSubmit: MutableRefObject<ShardEditorProps["onSubmit"]>
  onToggleZen: MutableRefObject<ShardEditorProps["onToggleZen"]>
  onPasteFiles: MutableRefObject<ShardEditorProps["onPasteFiles"]>
  onDropFiles: MutableRefObject<ShardEditorProps["onDropFiles"]>
}

// 默认值必须是稳定引用：写成 `extensions = []` 会让每次渲染都拿到新数组，
// 进而每次都 dispatch 一轮 Compartment reconfigure。
const EMPTY_EXTENSIONS: Extension[] = []

function minimalDocumentChange(current: string, next: string): TransactionSpec["changes"] {
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
    from: prefix,
    to: currentSuffix,
    insert: next.slice(prefix, nextSuffix),
  }
}

function reportHeight(view: EditorView, callbacks: CallbackRefs) {
  if (!callbacks.onHeightChange.current) return
  view.requestMeasure({
    read: () => view.contentDOM.getBoundingClientRect().height,
    write: (height) => callbacks.onHeightChange.current?.(height),
  })
}

export const ShardEditor = forwardRef<ShardEditorHandle, ShardEditorProps>(
  function ShardEditor(
    {
      value,
      editorId,
      documentKey,
      variant,
      placeholder,
      ariaLabel,
      autoFocus = false,
      readOnly = false,
      onChange,
      onSelectionChange,
      onSubmit,
      onToggleZen,
      onPasteFiles,
      onDropFiles,
      onHeightChange,
      onFocus,
      extensions = EMPTY_EXTENSIONS,
    },
    forwardedRef,
  ) {
    const hostRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const documentKeyRef = useRef(documentKey)
    const lastReportedValueRef = useRef(value)
    const pendingCompositionValueRef = useRef<string | null>(null)
    const callbacksRef = useRef<CallbackRefs>({
      onChange: { current: onChange },
      onSelectionChange: { current: onSelectionChange },
      onHeightChange: { current: onHeightChange },
      onFocus: { current: onFocus },
      onSubmit: { current: onSubmit },
      onToggleZen: { current: onToggleZen },
      onPasteFiles: { current: onPasteFiles },
      onDropFiles: { current: onDropFiles },
    })
    const readOnlyCompartmentRef = useRef(new Compartment())
    const hostExtensionsCompartmentRef = useRef(new Compartment())
    const placeholderCompartmentRef = useRef(new Compartment())
    const themeCompartmentRef = useRef(new Compartment())
    const attributesCompartmentRef = useRef(new Compartment())

    callbacksRef.current.onChange.current = onChange
    callbacksRef.current.onSelectionChange.current = onSelectionChange
    callbacksRef.current.onHeightChange.current = onHeightChange
    callbacksRef.current.onFocus.current = onFocus
    callbacksRef.current.onSubmit.current = onSubmit
    callbacksRef.current.onToggleZen.current = onToggleZen
    callbacksRef.current.onPasteFiles.current = onPasteFiles
    callbacksRef.current.onDropFiles.current = onDropFiles

    const createExtensions = () => [
      readOnlyCompartmentRef.current.of(EditorState.readOnly.of(readOnly)),
      hostExtensionsCompartmentRef.current.of(extensions),
      placeholderCompartmentRef.current.of(
        placeholder ? placeholderExtension(placeholder) : [],
      ),
      themeCompartmentRef.current.of(createShardEditorTheme(variant)),
      // 根元素只挂定位用的 data 属性；role / aria 放到 .cm-content 上，
      // 否则根元素和 contentDOM 会形成两个嵌套的 textbox。
      attributesCompartmentRef.current.of([
        EditorView.editorAttributes.of({ "data-shard-editor": editorId }),
        EditorView.contentAttributes.of({
          "aria-label": ariaLabel ?? placeholder ?? "编辑器",
          "aria-multiline": "true",
          "aria-placeholder": placeholder ?? "",
        }),
      ]),
      createShardEditorKeymap({
        onSubmit: () => callbacksRef.current.onSubmit.current?.(),
        onToggleZen: () => callbacksRef.current.onToggleZen.current?.(),
      }),
      createShardEditorClipboard({
        onPasteFiles: (files) => callbacksRef.current.onPasteFiles.current?.(files),
        onDropFiles: (files) => callbacksRef.current.onDropFiles.current?.(files),
      }),
      createShardMarkdown(),
      createShardLivePreview(),
      // 方案 §7 决策 C 复评：原生 ::selection 与 CM 自带的 drawSelection 都只盖到字符高度，
      // 换成按行盒绘制的自定义 layer（见 extensions/selection.ts）。
      createShardSelectionLayer(),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet) {
          const selection = update.state.selection.main
          callbacksRef.current.onSelectionChange.current?.(
            selection.from,
            selection.to,
          )
        }

        if (!update.docChanged) return

        const nextValue = update.state.doc.toString()
        if (update.view.composing) {
          pendingCompositionValueRef.current = nextValue
        } else if (nextValue !== lastReportedValueRef.current) {
          pendingCompositionValueRef.current = null
          lastReportedValueRef.current = nextValue
          callbacksRef.current.onChange.current(nextValue)
        }
        reportHeight(update.view, callbacksRef.current)
      }),
      EditorView.domEventHandlers({
        focus: () => {
          callbacksRef.current.onFocus.current?.()
          return false
        },
        compositionend: (_event, view) => {
          queueMicrotask(() => {
            const nextValue = pendingCompositionValueRef.current ?? view.state.doc.toString()
            pendingCompositionValueRef.current = null
            if (nextValue !== lastReportedValueRef.current) {
              lastReportedValueRef.current = nextValue
              callbacksRef.current.onChange.current(nextValue)
            }
          })
          return false
        },
      }),
    ]

    useEffect(() => {
      const host = hostRef.current
      if (!host) return

      const view = new EditorView({
        parent: host,
        state: EditorState.create({ doc: value, extensions: createExtensions() }),
      })
      viewRef.current = view
      reportHeight(view, callbacksRef.current)
      if (autoFocus) view.focus()

      return () => {
        view.destroy()
        viewRef.current = null
      }
      // EditorView 的生命周期只跟随宿主节点；其余参数通过 effect/refs 更新。
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      return registerShardEditorTestView(editorId, view)
    }, [editorId])

    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      view.dispatch({
        effects: [
          readOnlyCompartmentRef.current.reconfigure(EditorState.readOnly.of(readOnly)),
          hostExtensionsCompartmentRef.current.reconfigure(extensions),
          placeholderCompartmentRef.current.reconfigure(
            placeholder ? placeholderExtension(placeholder) : [],
          ),
          themeCompartmentRef.current.reconfigure(createShardEditorTheme(variant)),
          attributesCompartmentRef.current.reconfigure([
            EditorView.editorAttributes.of({ "data-shard-editor": editorId }),
            EditorView.contentAttributes.of({
              "aria-label": ariaLabel ?? placeholder ?? "编辑器",
              "aria-multiline": "true",
              "aria-placeholder": placeholder ?? "",
            }),
          ]),
        ],
      })
    }, [ariaLabel, editorId, extensions, placeholder, readOnly, variant])

    useEffect(() => {
      const view = viewRef.current
      if (!view) return

      if (documentKeyRef.current !== documentKey) {
        documentKeyRef.current = documentKey
        lastReportedValueRef.current = value
        pendingCompositionValueRef.current = null
        view.setState(EditorState.create({ doc: value, extensions: createExtensions() }))
        reportHeight(view, callbacksRef.current)
        return
      }

      const currentValue = view.state.doc.toString()
      if (currentValue === value) return

      lastReportedValueRef.current = value
      view.dispatch({
        changes: minimalDocumentChange(currentValue, value),
        annotations: [
          Transaction.userEvent.of("shard.external"),
          Transaction.addToHistory.of(false),
        ],
      })
    }, [documentKey, value])

    useEffect(() => {
      if (autoFocus) viewRef.current?.focus()
    }, [autoFocus])

    useImperativeHandle(
      forwardedRef,
      () => ({
        focus() {
          viewRef.current?.focus()
        },
        getSelection() {
          const selection = viewRef.current?.state.selection.main
          return selection
            ? { start: selection.from, end: selection.to }
            : { start: 0, end: 0 }
        },
        applyTextEdit(edit) {
          const view = viewRef.current
          if (!view) return
          view.dispatch({
            ...textEditToTransaction(view.state, edit),
            annotations: Transaction.userEvent.of("shard.text-edit"),
          })
          view.focus()
        },
        replaceDocument(nextValue) {
          const view = viewRef.current
          if (!view || view.state.doc.toString() === nextValue) return
          view.dispatch({
            changes: minimalDocumentChange(view.state.doc.toString(), nextValue),
            annotations: [
              Transaction.userEvent.of("shard.external"),
              Transaction.addToHistory.of(false),
            ],
          })
        },
        get view() {
          return viewRef.current
        },
      }),
      [],
    )

    return (
      <div
        ref={hostRef}
        className={`shard-editor shard-editor--${variant}`}
        data-shard-editor-variant={variant}
      />
    )
  },
)
