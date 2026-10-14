import type { Editor } from "@tiptap/core"
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"

import { ArrowDownIcon, ArrowUpIcon, XIcon } from "@/components/icons"
import { Input } from "@/components/ui/input"
import { ToolbarIconButton } from "@/components/ui/toolbar-icon-button"

import {
  DOCUMENT_FIND_QUERY_MAX_LENGTH,
  clearDocumentFind,
  getDocumentFindState,
  searchDocument,
  selectActiveDocumentFindMatch,
  stepDocumentFind,
} from "./extensions/document-find"

interface FindTarget {
  root: () => HTMLElement | null
  isOpen: () => boolean
  open: () => void
  step: (direction: 1 | -1) => void
}

/**
 * 同一时刻可能挂着多个可查找的编辑器（如禅模式切换的一瞬）。快捷键只挂一份在
 * window 上，由它挑目标：焦点所在的编辑器优先，否则取最后挂载、且看得见的那个；
 * 焦点在别的对话框里（搜索面板、确认框）时不抢。
 */
const findTargets: FindTarget[] = []

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform)

function pickFindTarget() {
  const active = document.activeElement
  const visible = findTargets.filter((target) => {
    const root = target.root()
    return Boolean(root?.isConnected && root.getClientRects().length > 0)
  })
  const dialog = active?.closest('[role="dialog"], [role="alertdialog"]') ?? null
  const candidates = dialog
    ? visible.filter((target) => {
        const root = target.root()
        return Boolean(root && dialog.contains(root))
      })
    : visible
  return (
    candidates.find((target) => Boolean(active && target.root()?.contains(active))) ??
    candidates[candidates.length - 1] ??
    null
  )
}

function handleFindShortcut(event: KeyboardEvent) {
  // macOS 上 Ctrl+F 是文本框的「前移一个字符」，只认 Cmd。
  const modifier = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!modifier || event.altKey || event.isComposing || event.keyCode === 229) return
  const key = event.key.toLowerCase()
  if (key !== "f" && key !== "g") return
  if (key === "f" && event.shiftKey) return
  const target = pickFindTarget()
  if (!target) return
  // Cmd+G 只在查找条开着时接管；否则留给全局搜索的文内命中跳转。
  if (key === "g" && !target.isOpen()) return
  event.preventDefault()
  event.stopPropagation()
  if (key === "f") target.open()
  else target.step(event.shiftKey ? -1 : 1)
}

function registerFindTarget(target: FindTarget) {
  if (findTargets.length === 0) window.addEventListener("keydown", handleFindShortcut, true)
  findTargets.push(target)
  return () => {
    const index = findTargets.indexOf(target)
    if (index >= 0) findTargets.splice(index, 1)
    if (findTargets.length === 0) window.removeEventListener("keydown", handleFindShortcut, true)
  }
}

/** 选中的一小段文字作为查找词；跨段、过长或空选区不算。 */
function selectionSeed(editor: Editor) {
  const { from, to, empty } = editor.state.selection
  if (empty || to - from > DOCUMENT_FIND_QUERY_MAX_LENGTH) return null
  const text = editor.state.doc.textBetween(from, to, "\n")
  if (!text.trim() || text.includes("\n")) return null
  return text
}

/** 当前命中不在可视区（或被查找条压着）时滚到视口上三分之一处。 */
function scrollActiveMatchIntoView(
  editor: Editor,
  viewport: HTMLElement | null,
  bar: HTMLElement | null
) {
  if (!viewport || editor.isDestroyed) return
  const state = getDocumentFindState(editor)
  const match = state.matches[state.activeIndex]
  if (!match) return
  let top: number
  let bottom: number
  if (match.node) {
    const element = editor.view.nodeDOM(match.from)
    if (!(element instanceof HTMLElement)) return
    const rect = element.getBoundingClientRect()
    top = rect.top
    bottom = rect.bottom
  } else {
    const start = editor.view.coordsAtPos(match.from)
    const end = editor.view.coordsAtPos(match.to, -1)
    top = start.top
    bottom = Math.max(start.bottom, end.bottom)
  }
  const viewportRect = viewport.getBoundingClientRect()
  const barBottom = bar ? bar.getBoundingClientRect().bottom : viewportRect.top
  const inset = 12
  const visibleTop = Math.max(viewportRect.top, barBottom) + inset
  const visibleBottom = viewportRect.bottom - inset
  if (top >= visibleTop && bottom <= visibleBottom) return
  viewport.scrollTop += top - viewportRect.top - viewport.clientHeight / 3
}

interface UseDocumentFindOptions {
  editor: Editor | null
  enabled: boolean
  rootRef: RefObject<HTMLElement | null>
  getViewport: () => HTMLElement | null
}

/**
 * 文档内查找（Cmd+F）：开着时在编辑面右上角浮一条查找条，随视口吸顶。
 * Enter / Shift+Enter、Cmd+G / Shift+Cmd+G 在命中间跳转；Esc 关闭并把选区
 * 落在当前命中上，回到正文可以直接改。
 */
export function useDocumentFind({ editor, enabled, rootRef, getViewport }: UseDocumentFindOptions) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [focusRequest, setFocusRequest] = useState(0)
  const openRef = useRef(false)
  const queryRef = useRef("")
  const barRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef(editor)
  editorRef.current = editor
  const getViewportRef = useRef(getViewport)
  getViewportRef.current = getViewport

  const reveal = useCallback(() => {
    const instance = editorRef.current
    if (instance) scrollActiveMatchIntoView(instance, getViewportRef.current(), barRef.current)
  }, [])

  const runSearch = useCallback((value: string) => {
    const instance = editorRef.current
    if (!instance || instance.isDestroyed) return
    const state = getDocumentFindState(instance)
    // 边打边找：从当前命中处往后找，命中不会因为多打一个字就跳回文首。
    const anchor = state.matches[state.activeIndex]?.from ?? instance.state.selection.from
    searchDocument(instance, value, anchor)
    reveal()
  }, [reveal])

  const openFind = useCallback(() => {
    const instance = editorRef.current
    if (!instance || instance.isDestroyed) return
    const seed = !openRef.current || instance.view.hasFocus() ? selectionSeed(instance) : null
    if (!openRef.current || seed !== null) {
      const next = seed ?? queryRef.current
      queryRef.current = next
      setQuery(next)
      searchDocument(instance, next, instance.state.selection.from)
      reveal()
    }
    openRef.current = true
    setOpen(true)
    setFocusRequest((current) => current + 1)
  }, [reveal])

  const step = useCallback((direction: 1 | -1) => {
    const instance = editorRef.current
    if (!instance || instance.isDestroyed || !queryRef.current) return
    stepDocumentFind(instance, direction)
    reveal()
  }, [reveal])

  const closeFind = useCallback(() => {
    const instance = editorRef.current
    openRef.current = false
    setOpen(false)
    if (!instance || instance.isDestroyed) return
    selectActiveDocumentFindMatch(instance)
    clearDocumentFind(instance)
    instance.view.focus()
  }, [])

  const changeQuery = useCallback((value: string, composing: boolean) => {
    queryRef.current = value
    setQuery(value)
    // 拼音还在候选里时不查：中间态字母串会让高亮来回闪。
    if (!composing) runSearch(value)
  }, [runSearch])

  useEffect(() => {
    if (!enabled) return
    return registerFindTarget({
      isOpen: () => openRef.current,
      open: openFind,
      root: () => rootRef.current,
      step,
    })
  }, [enabled, openFind, rootRef, step])

  // 换了编辑器实例（换文档）或关掉了查找能力：查找条随之收起。
  useEffect(() => {
    if (enabled) return
    openRef.current = false
    setOpen(false)
  }, [enabled])

  const bar: ReactNode =
    enabled && open && editor ? (
      <DocumentFindBar
        barRef={barRef}
        editor={editor}
        focusRequest={focusRequest}
        onClose={closeFind}
        onQueryChange={changeQuery}
        onStep={step}
        query={query}
      />
    ) : null

  return { bar, open }
}

interface DocumentFindBarProps {
  barRef: RefObject<HTMLDivElement | null>
  editor: Editor
  focusRequest: number
  query: string
  onClose: () => void
  onQueryChange: (value: string, composing: boolean) => void
  onStep: (direction: 1 | -1) => void
}

function DocumentFindBar({
  barRef,
  editor,
  focusRequest,
  query,
  onClose,
  onQueryChange,
  onStep,
}: DocumentFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const [status, setStatus] = useState(() => readStatus(editor))

  useEffect(() => {
    const update = () => setStatus(readStatus(editor))
    update()
    editor.on("transaction", update)
    return () => {
      editor.off("transaction", update)
    }
  }, [editor])

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus({ preventScroll: true })
    input.select()
  }, [focusRequest])

  const hasQuery = query.trim().length > 0
  const empty = hasQuery && status.count === 0

  return (
    <div className="shard-rich-find-dock">
      <div
        aria-label="文档内查找"
        className="shard-rich-find-bar"
        ref={barRef}
        role="search"
      >
        <Input
          aria-label="查找文档内容"
          autoComplete="off"
          className="shard-rich-find-input"
          enterKeyHint="search"
          maxLength={DOCUMENT_FIND_QUERY_MAX_LENGTH}
          onChange={(event) => {
            const native = event.nativeEvent as InputEvent
            onQueryChange(event.target.value, composingRef.current || native.isComposing === true)
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false
            onQueryChange(event.currentTarget.value, false)
          }}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === "Enter") {
              event.preventDefault()
              onStep(event.shiftKey ? -1 : 1)
            } else if (event.key === "Escape") {
              // 先占住 Esc：禅模式等外层的 window 监听看到 defaultPrevented 就不再退出。
              event.preventDefault()
              event.stopPropagation()
              onClose()
            }
          }}
          placeholder="查找"
          ref={inputRef}
          spellCheck={false}
          value={query}
        />
        <span
          aria-live="polite"
          className="shard-rich-find-count"
          data-empty={empty ? "true" : undefined}
        >
          {!hasQuery ? null : empty ? "无结果" : `${status.active + 1}/${status.count}`}
        </span>
        <ToolbarIconButton
          disabled={status.count === 0}
          label="上一处"
          onClick={() => onStep(-1)}
          onMouseDown={(event) => event.preventDefault()}
          variant="ghost"
        >
          <ArrowUpIcon />
        </ToolbarIconButton>
        <ToolbarIconButton
          disabled={status.count === 0}
          label="下一处"
          onClick={() => onStep(1)}
          onMouseDown={(event) => event.preventDefault()}
          variant="ghost"
        >
          <ArrowDownIcon />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="关闭查找"
          onClick={onClose}
          onMouseDown={(event) => event.preventDefault()}
          variant="ghost"
        >
          <XIcon />
        </ToolbarIconButton>
      </div>
    </div>
  )
}

function readStatus(editor: Editor) {
  const state = getDocumentFindState(editor)
  return { active: state.activeIndex, count: state.matches.length }
}
