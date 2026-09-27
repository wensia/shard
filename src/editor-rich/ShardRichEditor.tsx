import Placeholder from "@tiptap/extension-placeholder"
import { EditorContent, useEditor } from "@tiptap/react"
import type { AnyExtension, Editor, JSONContent } from "@tiptap/core"
import { undoDepth } from "@tiptap/pm/history"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"

import type { SlashCommandId } from "@/lib/slash-commands"
import type { SearchRevealHandle } from "@/lib/search-contract"
import type { WikilinkCandidate } from "@/lib/wikilink"
import type { ShardDocumentLink } from "@/types"
import { registerShardRichEditorTest } from "./test-bridge"

import {
  applyRichHeading,
  applyRichInlineFormat,
  applyRichLineFormat,
  insertRichHorizontalRule,
  insertRichTable,
  runRichSlashCommand,
  toggleRichBlockquote,
  toggleRichCodeBlock,
  type ShardRichHeadingLevel,
  type ShardRichInlineFormat,
  type ShardRichLineFormat,
} from "./commands"
import {
  SKIP_INLINE_CONVERGE,
  ShardInlineConverge,
  convergeShardInlineAtoms,
  previewConvergedDoc,
} from "./extensions/inline-converge"
import { ShardCaret } from "./extensions/shard-caret"
import { ShardSelectionBand } from "./extensions/shard-selection-band"
import { ShardMemoGuard } from "./extensions/memo-guard"
import {
  createSearchRevealHandle,
  getSearchHighlightState,
  ShardSearchHighlight,
} from "./extensions/search-highlight"
import { ShardRichHost } from "./extensions/shard-host"
import { ShardSlashSuggestion } from "./extensions/slash-suggestion"
import { ShardTagSuggestion } from "./extensions/tag-suggestion"
import { ShardWikilinkSuggestion } from "./extensions/wikilink-suggestion"
import { looksLikeShardMarkdown } from "./markdown/dialect-signals"
import { splitFrontmatter } from "./markdown/frontmatter"
import { parseShardMarkdown, serializeShardMarkdown } from "./markdown"
import { shardEditorExtensions } from "./schema"
import { getWikilinkHost } from "./schema/wikilink"
import { SuggestionMenuHost, type SuggestionMenuState } from "./suggestion/menu-host"
import { SuggestionMenu } from "./suggestion/suggestion-menu"
import { SelectionToolbar } from "./selection-toolbar"

import "./rich-editor.css"

/**
 * 类型专属功能集合（产品框架 §2、§3）。
 *
 * `fragment` 是碎片与大纲共用的基础档：只认列表与行内格式的输入前缀，
 * 标题、引用、代码块仍然正确解析与保存，但没有输入入口。
 * `document` 是文档档：额外开放标题 1–4、引用、代码块的输入规则与 `/` 命令。
 */
export type ShardRichEditorTier = "fragment" | "document"

/**
 * 编辑面几何变体。`library` 是资料库编辑器：内边距由 library-shell 的
 * `editorViewport` / `zenNoteViewport` 给（沿用旧 CodeMirror 编辑器 contentPadding=0
 * 的几何），正文自己不再加留白。
 */
export type ShardRichEditorVariant = "composer" | "inline" | "zen" | "library"

export interface ShardRichEditorProps {
  editorId: string
  variant: ShardRichEditorVariant
  /** 功能集合档位，默认碎片基础档。 */
  tier?: ShardRichEditorTier
  /** Markdown 正文；宿主的 content state 语义与旧编辑器一致。 */
  value: string
  onChange: (markdown: string) => void
  placeholder?: string
  ariaLabel?: string
  readOnly?: boolean
  autoFocus?: boolean
  onSubmit?: () => void
  onToggleZen?: () => void
  /** Escape：宿主收尾（禅模式退出）。行内与速记框不传。 */
  onEscape?: () => void
  onHeightChange?: (height: number) => void
  onFocus?: () => void
  onPasteFiles?: (files: File[]) => void
  onDropFiles?: (files: File[]) => void
  getKnownTags?: () => string[]
  onImageFiles?: (files: File[]) => void
  /** `/大纲`：宿主把整个速记框切成幕布式大纲态。不传即不提供该命令。 */
  onEnterOutline?: () => void
  /** `/流程图`：宿主立即创建空流程图。不传即不提供该命令。 */
  onCreateFlowchart?: () => void
  /** `/文档`：宿主把当前草稿标记为文档类型。不传即不提供该命令。 */
  onMarkDocument?: () => void
  /** `[[` 建议的候选，也是双链芯片判断断链的依据。 */
  getWikilinkCandidates?: () => readonly WikilinkCandidate[]
  /** 点击双链芯片：碎片 / 笔记 / 导图 / CSV / 待建的分派规则留在宿主一侧。 */
  onNavigateWikilink?: (target: string) => void
  /** 点击正文里的图文档链接（`shard://map|flow/<id>`），宿主负责保存与跳转。 */
  onOpenDocumentLink?: (link: ShardDocumentLink) => void
}

export interface ShardRichEditorHandle extends SearchRevealHandle {
  focus(): void
  getMarkdown(): string
  /**
   * 自动保存取值：与 getMarkdown 同一套收敛口径，但只算不改——编辑器里的字面
   * `#词` 原样留着，用户还能接着打。
   *
   * `hostValue` 是宿主手里的正文。它与编辑器最近一次同步的值不同，说明宿主刚写入
   * 了编辑器还没接到的内容（如图片附件追加），此时原样返回 `hostValue`；
   * 组合输入期间同样返回它，拼音中间态不落盘。
   */
  peekMarkdown(hostValue: string): string
  setMarkdown(value: string): void
  /** 宿主与命令菜单共用的命令入口（技术方案 §5）。 */
  insertCommand(id: SlashCommandId): void
  isComposing(): boolean
  applyInlineFormat(format: ShardRichInlineFormat): void
  applyLineFormat(format: ShardRichLineFormat): void
  insertHorizontalRule(): void
  /** 文档档专属：标题、引用、代码块、GFM 表格。基础档的宿主不调这几个。 */
  applyHeading(level: ShardRichHeadingLevel): void
  toggleBlockquote(): void
  toggleCodeBlock(): void
  insertTable(): void
}

/**
 * 碎片基础档保留的输入前缀自动转换：`- `/`* `/`+ `、`1. `、`[] `/`[ ] `/`[x] `，
 * 以及行内标记。标题、引用、代码块、图片语法可解析可保存，但不提供输入入口——
 * `enableInputRules` 只认白名单，不在名单里的扩展不会注册 input rules。
 */
const FRAGMENT_TIER_INPUT_RULES = [
  "bold",
  "italic",
  "strike",
  "code",
  "highlight",
  "bulletList",
  "orderedList",
  "taskItem",
]

/**
 * 文档档额外开放的输入前缀：`# `–`#### `、`> `、```` ``` ````。
 * 表格没有输入前缀，只有 `/表格` 一个入口。
 */
const DOCUMENT_TIER_INPUT_RULES = [
  ...FRAGMENT_TIER_INPUT_RULES,
  "heading",
  "blockquote",
  "codeBlock",
]

const EMPTY_TAGS: string[] = []
const EMPTY_WIKILINK_CANDIDATES: readonly WikilinkCandidate[] = []

export const ShardRichEditor = forwardRef<ShardRichEditorHandle, ShardRichEditorProps>(
  function ShardRichEditor(
    {
      editorId,
      variant,
      tier = "fragment",
      value,
      onChange,
      placeholder,
      ariaLabel,
      readOnly = false,
      autoFocus = false,
      onSubmit,
      onToggleZen,
      onEscape,
      onHeightChange,
      onFocus,
      onPasteFiles,
      onDropFiles,
      getKnownTags,
      onImageFiles,
      onEnterOutline,
      onCreateFlowchart,
      onMarkDocument,
      getWikilinkCandidates,
      onNavigateWikilink,
      onOpenDocumentLink,
    },
    forwardedRef
  ) {
    const [menuState, setMenuState] = useState<SuggestionMenuState | null>(null)
    const menu = useMemo(() => new SuggestionMenuHost(setMenuState), [])

    // 回调走 ref：Tiptap 扩展在创建时固化闭包，扩展数组一变就重建整个
    // EditorView，草稿、撤销历史与输入法状态全部丢失。
    const callbacks = useRef({
      onChange,
      onFocus,
      onHeightChange,
      onSubmit,
      onToggleZen,
      onEscape,
      onPasteFiles,
      onDropFiles,
      onImageFiles,
      onEnterOutline,
      onCreateFlowchart,
      onMarkDocument,
      getKnownTags,
      getWikilinkCandidates,
      onNavigateWikilink,
      onOpenDocumentLink,
    })
    callbacks.current = {
      onChange,
      onFocus,
      onHeightChange,
      onSubmit,
      onToggleZen,
      onEscape,
      onPasteFiles,
      onDropFiles,
      onImageFiles,
      onEnterOutline,
      onCreateFlowchart,
      onMarkDocument,
      getKnownTags,
      getWikilinkCandidates,
      onNavigateWikilink,
      onOpenDocumentLink,
    }

    const editorRef = useRef<Editor | null>(null)
    const editorElementRef = useRef<HTMLDivElement>(null)
    const searchRevealHandle = useMemo(
      () =>
        createSearchRevealHandle(
          () => editorRef.current,
          () => findEditorScrollViewport(editorElementRef.current)
        ),
      []
    )
    /** 最近一次与宿主同步过的 Markdown，进出两个方向都以它为准。 */
    const lastMarkdownRef = useRef(value)
    // useEditor 每次渲染都会比较 options 的引用；content / editorProps 不稳定
    // 就会触发 setOptions → view.updateState，组合输入期间足以打断输入法。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const initialParse = useMemo(() => parseShardMarkdown(value), [])
    /** Frontmatter 不进文档模型，读时剥离、写时原样回写。 */
    const frontmatterRef = useRef<string | null>(initialParse.frontmatter)
    /**
     * 最近一次载入的文档与它的原文。ProseMirror 文档不可变：只要当前 doc 还是
     * 载入时那一个对象，用户就没编辑过，读正文一律返回磁盘原文，不做规范化——
     * 打开不规范的 Markdown 不标脏、不自动保存，关闭或失焦提交也不改写磁盘。
     */
    const loadedRef = useRef<{ doc: ProseMirrorNode | null; markdown: string }>({
      doc: null,
      markdown: value,
    })
    const placeholderRef = useRef(placeholder)
    placeholderRef.current = placeholder
    const tierRef = useRef(tier)
    tierRef.current = tier

    function hostCommands() {
      const {
        onCreateFlowchart: createFlowchart,
        onEnterOutline: enterOutline,
        onMarkDocument: markDocument,
      } = callbacks.current
      return {
        ...(createFlowchart ? { onCreateFlowchart: () => callbacks.current.onCreateFlowchart?.() } : {}),
        ...(enterOutline ? { onEnterOutline: () => callbacks.current.onEnterOutline?.() } : {}),
        ...(markDocument ? { onMarkDocument: () => callbacks.current.onMarkDocument?.() } : {}),
      }
    }

    function serializeDoc(doc: ProseMirrorNode) {
      if (doc === loadedRef.current.doc) return loadedRef.current.markdown
      return serializeShardMarkdown(doc.toJSON() as JSONContent, frontmatterRef.current)
    }

    function currentMarkdown() {
      const instance = editorRef.current
      if (!instance || instance.isDestroyed) return lastMarkdownRef.current
      return serializeDoc(instance.state.doc)
    }

    function emitChange() {
      const instance = editorRef.current
      if (!instance || instance.isDestroyed) return
      const markdown = currentMarkdown()
      if (markdown === lastMarkdownRef.current) return
      lastMarkdownRef.current = markdown
      callbacks.current.onChange(markdown)
    }

    function replaceMarkdown(next: string) {
      const instance = editorRef.current
      if (!instance || instance.isDestroyed) return
      const { doc, frontmatter } = parseShardMarkdown(next)
      frontmatterRef.current = frontmatter
      lastMarkdownRef.current = next
      // 载入的正文已经由转换层解析过，剩下的字面 `#词` 是源文件里的 `\#`：
      // 打上跳过标记，收敛不碰它，打开一篇文档不会悄悄改写用户的转义。
      instance
        .chain()
        .setContent(doc, { emitUpdate: false })
        .setMeta(SKIP_INLINE_CONVERGE, true)
        // 宿主载入的正文不是用户编辑，不进撤销栈：否则撤销会把刚打开的文档退成空白
        // （与旧编辑器外部写入 `addToHistory.of(false)` 一致）。
        .setMeta("addToHistory", false)
        .run()
      loadedRef.current = { doc: instance.state.doc, markdown: next }
      // 载入不报值：正文若不是规范形态（多余空格、`*` 列表），归一只发生在
      // 文档模型里，宿主的 content 仍是磁盘原文——打开文档既不标脏也不触发
      // 自动保存。lastMarkdownRef 留着原文，用户第一次真正编辑时 emitChange
      // 对比出差异，报上去的就是规范化后的全文。
    }

    const extensions = useMemo<AnyExtension[]>(
      () => [
        ...shardEditorExtensions,
        Placeholder.configure({
          // 提示语只挂在首个顶层文本块上，是否显示由 rich-editor.css 按
          // 「整篇只剩这一个空文本块」判定。不用 `editor.isEmpty`：它把空任务项
          // 加空段落也算作空文档，每个空文本块都会挂上主提示语；而且装饰在
          // state apply 里重建，那一拍 `editor.state` 还是旧文档。
          placeholder: ({ pos }) => (pos === 0 ? (placeholderRef.current ?? "") : ""),
          // 默认不下钻到列表、任务项里。备忘卡片的空标题段与空细节段要拿到
          // `is-empty`，占位文字由 rich-editor.css 按位置取（见备忘卡片一节）。
          includeChildren: true,
          showOnlyCurrent: false,
        }),
        ShardRichHost.configure({
          onSubmit: () => {
            // 提交是最后一道边界：手打的 `#词` 即使没跟空格也得先成节点。
            convergeShardInlineAtoms(editorRef.current)
            callbacks.current.onSubmit?.()
          },
          onToggleZen: () => callbacks.current.onToggleZen?.(),
          onEscape: () => callbacks.current.onEscape?.(),
          onPasteFiles: (files) => callbacks.current.onPasteFiles?.(files),
          onDropFiles: (files) => callbacks.current.onDropFiles?.(files),
          onCompositionEnd: () => emitChange(),
          onOpenDocumentLink: (link) => callbacks.current.onOpenDocumentLink?.(link),
        }),
        ShardTagSuggestion.configure({
          getKnownTags: () => callbacks.current.getKnownTags?.() ?? EMPTY_TAGS,
          menu,
        }),
        ShardSlashSuggestion.configure({
          menu,
          onImageFiles: (files) => callbacks.current.onImageFiles?.(files),
          // 宿主命令按「有没有传回调」进菜单：没接大纲/文档的编辑面不展示它们。
          getHostCommands: () => hostCommands(),
          isDocumentTier: () => tierRef.current === "document",
        }),
        ShardWikilinkSuggestion.configure({
          getCandidates: () =>
            callbacks.current.getWikilinkCandidates?.() ?? EMPTY_WIKILINK_CANDIDATES,
          menu,
        }),
        // 排在建议扩展之后：收敛要读它们的插件状态，菜单占着的一段先不动。
        ShardInlineConverge,
        ShardMemoGuard,
        ShardSearchHighlight,
        ShardCaret,
        ShardSelectionBand,
      ],
      // 扩展集一次成型：回调全部经 callbacks ref 取最新值。
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [menu]
    )

    const initialContent = initialParse.doc
    const editorProps = useMemo(
      () => ({
        attributes: {
          "aria-label": ariaLabel ?? placeholder ?? "编辑器",
          "aria-multiline": "true",
          "aria-placeholder": placeholder ?? "",
          role: "textbox",
        },
        handlePaste: (_view: unknown, event: ClipboardEvent) => {
          const instance = editorRef.current
          if (!instance || instance.isDestroyed) return false
          return pasteShardMarkdown(instance, event)
        },
      }),
      [ariaLabel, placeholder]
    )

    const editor = useEditor({
      content: initialContent,
      editorProps,
      enableInputRules:
        tier === "document" ? DOCUMENT_TIER_INPUT_RULES : FRAGMENT_TIER_INPUT_RULES,
      extensions,
      onCreate: ({ editor: instance }) => {
        loadedRef.current = { doc: instance.state.doc, markdown: loadedRef.current.markdown }
      },
      onFocus: () => callbacks.current.onFocus?.(),
      onUpdate: ({ editor: instance }) => {
        // 组合输入期间不报值：中间态拼音串不该写进宿主的 content，
        // compositionend 之后由 ShardRichHost 补发一次。
        if (instance.view.composing) return
        emitChange()
      },
    })

    editorRef.current = editor ?? null
    // 渲染期同步写入：初始正文的 CSV NodeView 挂载时就要读到本宿主的行数上限。
    if (editor) {
      editor.storage.csvEmbed.maxRows =
        variant === "zen" || variant === "library" ? 50 : 10
    }

    useEffect(() => {
      if (!editor) return
      // 双链芯片的候选与导航回调挂在实例自己的 storage 上：扩展集是模块级的
      // 一份，回调不能写进它的 options，否则多个编辑器会互相覆盖。
      const host = getWikilinkHost(editor)
      host.getCandidates = () =>
        callbacks.current.getWikilinkCandidates?.() ?? EMPTY_WIKILINK_CANDIDATES
      host.onNavigate = (target) => callbacks.current.onNavigateWikilink?.(target)
    }, [editor])

    useEffect(() => {
      if (!editor) return
      return registerShardRichEditorTest(editorId, {
        focus: () => editor.commands.focus(),
        getMarkdown: () =>
          serializeShardMarkdown(editor.getJSON() as JSONContent, frontmatterRef.current),
        isComposing: () => editor.view.composing,
        selection: () => {
          const { from, to } = editor.state.selection
          return { from, to }
        },
        setMarkdown: (next) => {
          replaceMarkdown(next)
          // 测试桥的 set 模拟的是「用户写入正文」：与宿主载入不同，它要让宿主的
          // content state 跟上，而且报的是规范化后的值（与真实编辑后报值一致）。
          // lastMarkdownRef 同步成规范值，value 回流时不会再触发一次 replace。
          const normalized = serializeShardMarkdown(
            editor.getJSON() as JSONContent,
            frontmatterRef.current
          )
          loadedRef.current = { doc: editor.state.doc, markdown: normalized }
          lastMarkdownRef.current = normalized
          callbacks.current.onChange(normalized)
        },
        setSelection: (from, to) => {
          editor.chain().focus().setTextSelection({ from, to }).run()
        },
        typeText: (text) => typeThroughInputRules(editor, text),
        revealTerms: searchRevealHandle.revealTerms,
        stepHit: searchRevealHandle.stepHit,
        clearHits: searchRevealHandle.clearHits,
        diagnostics: () => {
          const search = getSearchHighlightState(editor)
          const viewport = findEditorScrollViewport(editorElementRef.current)
          const { from, to } = editor.state.selection
          return {
            activeIndex: search.activeIndex,
            dirty: editor.state.doc !== loadedRef.current.doc,
            hitCount: search.matches.length,
            selection: { from, to },
            undoDepth: undoDepth(editor.state),
            value: serializeDoc(editor.state.doc),
            viewportScrollTop: viewport?.scrollTop ?? null,
            windowScrollY: window.scrollY,
          }
        },
      })
      // replaceMarkdown 只读 editorRef，无需进依赖表。
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor, editorId])

    useEffect(() => {
      if (!editor) return
      // 宿主换了正文（清空草稿、外部写入）才重建文档；自己报上去的值原样回来时不动。
      if (value === lastMarkdownRef.current) return
      replaceMarkdown(value)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor, value])

    useEffect(() => {
      // editable 不进 useEditor 的 options：那个字段参与引用比较，
      // 每次变化都会额外触发一次 view.updateState。
      if (!editor || editor.isDestroyed) return
      if (editor.isEditable === !readOnly) return
      editor.setEditable(!readOnly, false)
      // setEditable 不派发事务，React NodeView 不会重渲染；补一个不改文档、
      // 不进撤销栈的空事务，让 useNodeViewEditable 读到新值（大纲块退回只读预览等）。
      editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false))
    }, [editor, readOnly])

    useEffect(() => {
      if (!editor || !autoFocus) return
      editor.commands.focus("end")
    }, [autoFocus, editor])

    useEffect(() => {
      if (!editor) return
      const content = editor.view.dom
      const report = () => {
        callbacks.current.onHeightChange?.(content.getBoundingClientRect().height)
      }
      report()

      // NodeView 自己会长高，docChanged 报不出来；用 contentDOM 的尺寸兜底，
      // 与旧编辑器 shard-editor.tsx 的 ResizeObserver 做法一致。
      let lastHeight = 0
      const observer = new ResizeObserver((entries) => {
        const height = entries[0]?.contentRect.height ?? 0
        if (height === lastHeight) return
        lastHeight = height
        report()
      })
      observer.observe(content)
      return () => observer.disconnect()
    }, [editor])

    useImperativeHandle(
      forwardedRef,
      () => ({
        applyHeading(level) {
          const instance = editorRef.current
          if (instance) applyRichHeading(instance, level)
        },
        applyInlineFormat(format) {
          const instance = editorRef.current
          if (instance) applyRichInlineFormat(instance, format)
        },
        applyLineFormat(format) {
          const instance = editorRef.current
          if (instance) applyRichLineFormat(instance, format)
        },
        focus() {
          editorRef.current?.commands.focus()
        },
        getMarkdown() {
          // 宿主读正文即「要用这份内容了」：先把手打的标签与双链收敛成节点，
          // 序列化才不会把它们按字面转义。
          convergeShardInlineAtoms(editorRef.current)
          return currentMarkdown()
        },
        peekMarkdown(hostValue) {
          if (hostValue !== lastMarkdownRef.current) return hostValue
          const doc = previewConvergedDoc(editorRef.current)
          return doc ? serializeDoc(doc) : hostValue
        },
        insertCommand(id) {
          const instance = editorRef.current
          if (instance) {
            runRichSlashCommand(instance, id, callbacks.current.onImageFiles, hostCommands())
          }
        },
        insertHorizontalRule() {
          const instance = editorRef.current
          if (instance) insertRichHorizontalRule(instance)
        },
        insertTable() {
          const instance = editorRef.current
          if (instance) insertRichTable(instance)
        },
        toggleBlockquote() {
          const instance = editorRef.current
          if (instance) toggleRichBlockquote(instance)
        },
        toggleCodeBlock() {
          const instance = editorRef.current
          if (instance) toggleRichCodeBlock(instance)
        },
        isComposing() {
          return editorRef.current?.view.composing ?? false
        },
        clearHits: searchRevealHandle.clearHits,
        revealTerms: searchRevealHandle.revealTerms,
        setMarkdown: replaceMarkdown,
        stepHit: searchRevealHandle.stepHit,
      }),
      // 句柄方法全部从 editorRef 取实例，创建一次即可。
      // eslint-disable-next-line react-hooks/exhaustive-deps
      []
    )

    return (
      <>
        <div
          ref={editorElementRef}
          className={`shard-editor shard-rich-editor shard-rich-editor--${variant}`}
          data-shard-editor={editorId}
          data-shard-editor-tier={tier}
          data-shard-editor-variant={variant}
        >
          <EditorContent editor={editor} />
        </div>
        {menuState ? <SuggestionMenu host={menu} state={menuState} /> : null}
        {editor ? <SelectionToolbar editor={editor} suppressed={menuState !== null} /> : null}
      </>
    )
  }
)

/**
 * 纯文本粘贴：命中方言特征就按 Shard Markdown 解析成组件，编辑区里看不到语法。
 *
 * 只接管「只有 text/plain 且像方言」的情况：带 text/html 的富文本来源交给
 * ProseMirror 自己的 HTML 解析；带 Frontmatter 的文本原样粘贴，避免文件头
 * 在解析里被剥掉而丢内容。
 */
function pasteShardMarkdown(editor: Editor, event: ClipboardEvent) {
  const clipboard = event.clipboardData
  if (!clipboard) return false
  if (clipboard.getData("text/html")) return false

  const text = clipboard.getData("text/plain")
  if (!text || !looksLikeShardMarkdown(text)) return false
  if (splitFrontmatter(text).frontmatter !== null) return false

  const content = parseShardMarkdown(text).doc.content ?? []
  if (content.length === 0) return false

  event.preventDefault()
  // 同 replaceMarkdown：方言解析的结果就是最终形态，收敛不再插手。
  editor
    .chain()
    .focus()
    .insertContent(content)
    .setMeta(SKIP_INLINE_CONVERGE, true)
    .run()
  return true
}

function findEditorScrollViewport(editorElement: HTMLElement | null) {
  for (let current = editorElement?.parentElement ?? null; current; current = current.parentElement) {
    if (current === document.body || current === document.documentElement) return null
    const overflow = getComputedStyle(current).overflowY
    if ((overflow === "auto" || overflow === "scroll") && current.scrollHeight > current.clientHeight) {
      return current
    }
  }
  return null
}

/**
 * 按真实输入路径逐字符送进编辑器：先问 `handleTextInput`（input rules 挂在这里），
 * 没人处理再退回插入文本。测试桥用它模拟打字，`- ` 之类的前缀转换才会触发。
 */
function typeThroughInputRules(editor: Editor, text: string) {
  const { view } = editor
  for (const char of text) {
    const { from, to } = view.state.selection
    const fallback = () => view.state.tr.insertText(char, from, to)
    const handled = view.someProp("handleTextInput", (handler) =>
      handler(view, from, to, char, fallback)
    )
    if (!handled) view.dispatch(fallback())
  }
  view.focus()
}
