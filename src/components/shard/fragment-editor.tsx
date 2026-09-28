import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
} from "react"
import { isTauri } from "@tauri-apps/api/core"
import {
  GitBranchIcon,
  Loader2Icon,
  LockKeyholeIcon,
  SendHorizontalIcon,
  XIcon,
} from "@/components/icons"
import { toast } from "sonner"

import { EditorToolbar } from "@/components/shard/editor-toolbar"
import { FragmentImageAttachment } from "@/components/shard/fragment-content"
import { MindMapPreview } from "@/components/shard/mind-map-preview"
import { OutlineComposer } from "@/components/shard/outline-composer"
import { ZenSurface } from "@/components/shard/zen-surface"
import { Button } from "@/components/ui/button"
import { ToolbarIconButton } from "@/components/ui/toolbar-icon-button"
import {
  ShardRichEditor,
  type ShardRichEditorHandle,
} from "@/editor-rich/ShardRichEditor"
import { useImageUpload } from "@/hooks/use-image-upload"
import {
  extractTags,
  normalizeTagList,
  parseMarkdownImageLine,
} from "@/lib/editor-format"
import {
  getApiErrorMessage,
  openCsvFile,
  setWindowControlsHidden,
} from "@/lib/api"
import {
  applyTypeTag,
  CONTENT_KIND_LABELS,
  countPlainTextCharacters,
  deriveKind,
  stripProtectedTypeTags,
} from "@/lib/content-kind"
import { hasMarkdownImage, wantsLockbox } from "@/lib/lockbox"
import { readOutlineContent } from "@/lib/mind-map-outline"
import { useTableDocumentDrop } from "@/lib/use-table-document-drop"
import { CsvImportDialog } from "@/features/datasets/csv-import-dialog"
import {
  buildCsvWikilinkCandidates,
  buildWikilinkCandidates,
  isCsvWikilinkTarget,
  resolveWikilinkTarget,
} from "@/lib/wikilink"
import type { CsvFileSummary, Fragment } from "@/types"
import styles from "./fragment-editor.module.css"

export interface FragmentEditorDraft {
  content: string
  id: number
}

interface FragmentEditorProps {
  commitOnBlur?: boolean
  csvFiles?: CsvFileSummary[]
  draft?: FragmentEditorDraft | null
  fragment: Fragment | null
  fragments?: Fragment[]
  knownTags: string[]
  onClose: () => void
  onRegisterFlush?: (flush: (() => Promise<boolean>) | null) => void
  onCreate?: (content: string, tags: string[]) => Promise<Fragment | void>
  onNavigateToFragment?: (fragmentId: string) => void
  onReady?: (fragmentId: string) => void
  onRefreshFragments?: () => Promise<void> | void
  onRequestOutlineUpgrade?: (fragmentId: string) => Promise<void> | void
  /**
   * 行内编辑遇到文档类型时改开禅模式（产品框架 §2「文档……直接进入禅模式」）。
   * 不传就照常行内编辑。
   */
  onRequestZen?: () => void
  onSave: (
    id: string,
    content: string,
    tags: string[],
    expectedFileSha?: string
  ) => Promise<Fragment>
  readOnly?: boolean
  variant?: "inline" | "zen"
  vaultPath?: string
}

type SaveState = "dirty" | "error" | "saved" | "saving"

interface EditorImageAttachment {
  alt: string
  id: string
  path: string
  previewUrl?: string
}

const blurCommitPauseListeners = new Set<(paused: boolean) => void>()
let isBlurCommitPaused = false

/**
 * Search focus is not navigation. Pause only the inline blur commit before the
 * palette takes focus; normal content autosave remains active.
 */
export function setFragmentEditorBlurCommitPaused(paused: boolean) {
  isBlurCommitPaused = paused
  for (const listener of blurCommitPauseListeners) listener(paused)
}

/**
 * 焦点仍算在编辑器里：编辑器本身，或共享控件的浮层（kiln-control-positioner）。
 * 正文里的提醒对话框与共享 DatePicker / TimePicker 对话框挂在 body 上，
 * 焦点进去不是离开编辑，不能触发失焦提交把卡片收起来。
 */
function isInsideEditorSurface(editorElement: HTMLElement, target: EventTarget | null) {
  if (!(target instanceof Node)) return false
  if (editorElement.contains(target)) return true
  return target instanceof Element && target.closest(".kiln-control-positioner") !== null
}

export function FragmentEditor({
  commitOnBlur = false,
  csvFiles = [],
  draft = null,
  fragment,
  fragments = [],
  knownTags,
  onClose,
  onRegisterFlush,
  onCreate,
  onNavigateToFragment,
  onReady,
  onRefreshFragments,
  onRequestOutlineUpgrade,
  onRequestZen,
  onSave,
  readOnly = false,
  variant = "zen",
  vaultPath,
}: FragmentEditorProps) {
  const [content, setContent] = useState("")
  const [imageAttachments, setImageAttachments] = useState<
    EditorImageAttachment[]
  >([])
  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [importFile, setImportFile] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const imageAttachmentsRef = useRef<EditorImageAttachment[]>([])
  const lastSavedContentRef = useRef("")
  const baseFileShaRef = useRef<string | null>(null)
  const pendingDiskReloadRef = useRef(false)
  const onCreateRef = useRef(onCreate)
  const onSaveRef = useRef(onSave)
  const blurCommitTimerRef = useRef<number | null>(null)
  const blurCommitPausedRef = useRef(isBlurCommitPaused)
  const saveTimerRef = useRef<number | null>(null)
  const editorFrameRef = useRef<HTMLDivElement>(null)
  const richEditorRef = useRef<ShardRichEditorHandle>(null)
  const closeEditorRef = useRef<() => void>(() => undefined)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)
  const flushRef = useRef<() => Promise<boolean>>(async () => true)
  flushRef.current = flushWithoutClose
  const isZen = variant === "zen"
  const isDraft = fragment === null && draft !== null
  const isOpen = fragment !== null || draft !== null
  const editorId = isZen
    ? `zen:${fragment?.id ?? `draft:${draft?.id ?? "closed"}`}`
    : `fragment:${fragment?.id ?? "closed"}`
  /**
   * 类型专属功能集合（产品框架 §2、§3）。
   *
   * - 文档：禅模式开文档档工具集；行内编辑直接改开禅模式。
   * - 大纲：行内与禅模式都是幕布式大纲，禅模式另给导图视图。
   * - 碎片：基础档。
   */
  const kind = fragment ? deriveKind(fragment.tags) : "fragment"
  const isOutlineSurface = kind === "outline"
  const isDocumentSurface = kind === "document"
  const tier = isDocumentSurface ? "document" : "fragment"
  /** 禅模式下大纲的两个视图：幕布式大纲（默认）与只读导图。 */
  const [outlineView, setOutlineView] = useState<"outline" | "mindmap">("outline")
  const [mindMapViewHeight, setMindMapViewHeight] = useState(360)
  const mindMapViewRef = useRef<HTMLDivElement>(null)
  const requestZenRef = useRef(onRequestZen)
  requestZenRef.current = onRequestZen
  const redirectedZenIdRef = useRef<string | null>(null)
  const normalizedKnownTags = useMemo(
    () => normalizeTagList(knownTags.filter((tag) => tag !== "inbox")),
    [knownTags]
  )
  const knownTagsRef = useRef(normalizedKnownTags)
  knownTagsRef.current = normalizedKnownTags
  const wikilinkCandidates = useMemo(
    () => [
      ...buildWikilinkCandidates(fragments),
      ...buildCsvWikilinkCandidates(csvFiles),
    ],
    [csvFiles, fragments]
  )
  const wikilinkCandidatesRef = useRef(wikilinkCandidates)
  const wikilinkNavigateRef = useRef(onNavigateToFragment)
  wikilinkCandidatesRef.current = wikilinkCandidates
  wikilinkNavigateRef.current = onNavigateToFragment
  /**
   * 富文本双链芯片的点击：分派规则——
   * 碎片走时间线导航，CSV 交给系统，待建只提示。
   */
  function navigateWikilink(target: string) {
    const candidate = resolveWikilinkTarget(target, wikilinkCandidatesRef.current)
    const csvPath =
      candidate?.kind === "csv"
        ? candidate.path
        : isCsvWikilinkTarget(target)
          ? target
          : undefined
    if (csvPath) {
      void openCsvFile(csvPath).catch((error) => {
        toast.error(`打开 CSV 失败：${getApiErrorMessage(error)}`, { duration: Infinity })
      })
      return
    }

    if (candidate?.fragmentId) {
      wikilinkNavigateRef.current?.(candidate.fragmentId)
      return
    }

    toast(`待建链接「${target}」尚不存在，可在资料库新建文档`)
  }

  const draftContent = useMemo(
    () => buildContentWithImageAttachments(content, imageAttachments),
    [content, imageAttachments]
  )
  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])

  useEffect(() => {
    onCreateRef.current = onCreate
  }, [onCreate])

  useEffect(() => {
    imageAttachmentsRef.current = imageAttachments
  }, [imageAttachments])

  useEffect(() => {
    return () => {
      clearBlurCommitTimer()
      revokeEditorImagePreviewUrls(imageAttachmentsRef.current)
    }
  }, [])

  useEffect(() => {
    const handlePauseChange = (paused: boolean) => {
      blurCommitPausedRef.current = paused
      if (paused) clearBlurCommitTimer()
    }
    blurCommitPauseListeners.add(handlePauseChange)
    handlePauseChange(isBlurCommitPaused)
    return () => {
      blurCommitPauseListeners.delete(handlePauseChange)
    }
  }, [])

  useEffect(() => {
    if (!fragment && !draft) {
      revokeEditorImagePreviewUrls(imageAttachmentsRef.current)
      imageAttachmentsRef.current = []
      setContent("")
      setImageAttachments([])
      setSaveState("saved")
      lastSavedContentRef.current = ""
      baseFileShaRef.current = null
      pendingDiskReloadRef.current = false
      return
    }

    const sourceContent = fragment?.content ?? draft?.content ?? ""
    const nextDraft = splitContentImageAttachments(sourceContent)
    revokeEditorImagePreviewUrls(imageAttachmentsRef.current)
    imageAttachmentsRef.current = nextDraft.images
    setContent(nextDraft.content)
    setImageAttachments(nextDraft.images)
    const initialContent = buildContentWithImageAttachments(
      nextDraft.content,
      nextDraft.images
    )
    lastSavedContentRef.current = fragment ? initialContent : ""
    baseFileShaRef.current = fragment?.fileSha ?? null
    pendingDiskReloadRef.current = false
    setSaveState(fragment || !initialContent ? "saved" : "dirty")
  }, [draft?.id, fragment?.id])

  useEffect(() => {
    if (!isOpen) return

    clearSaveTimer()

    if (draftContent === lastSavedContentRef.current) {
      setSaveState("saved")
      return
    }

    setSaveState("dirty")

    if (!isZen || isDraft || readOnly) return

    saveTimerRef.current = window.setTimeout(() => {
      // 落盘取编辑器的收敛视图，而不是 onChange 缓存的字符串：手打的 `#标签`
      // 还没跟空格时，缓存里是字面转义 `\#标签`（见 getAutosaveContent）。
      void saveDraft(getAutosaveContent())
    }, 800)

    return clearSaveTimer
  }, [draft?.id, draftContent, fragment?.id, isDraft, isOpen, isZen, readOnly])

  // Navigation may re-read the same object ID at a newer revision. Refresh a
  // clean editor from that payload instead of relying on identity alone.
  useEffect(() => {
    if (!fragment) return
    const nextDraft = splitContentImageAttachments(fragment.content)
    const nextContent = buildContentWithImageAttachments(
      nextDraft.content,
      nextDraft.images
    )
    const clean =
      draftContent === lastSavedContentRef.current &&
      savePromiseRef.current === null
    const forceReload = pendingDiskReloadRef.current
    if (
      nextContent === lastSavedContentRef.current ||
      nextContent === draftContent
    ) {
      pendingDiskReloadRef.current = false
      if (clean || forceReload) baseFileShaRef.current = fragment.fileSha ?? null
      return
    }
    if (!clean && !forceReload) return

    pendingDiskReloadRef.current = false
    revokeEditorImagePreviewUrls(imageAttachmentsRef.current)
    imageAttachmentsRef.current = nextDraft.images
    setContent(nextDraft.content)
    setImageAttachments(nextDraft.images)
    lastSavedContentRef.current = nextContent
    baseFileShaRef.current = fragment.fileSha ?? null
    setSaveState("saved")
  }, [draftContent, fragment])

  useEffect(() => {
    if (!isOpen || !isZen || !isTauri()) return

    void setWindowControlsHidden(true).catch((error) => {
      console.warn("Unable to hide window controls for zen editor", error)
    })

    return () => {
      void setWindowControlsHidden(false).catch((error) => {
        console.warn("Unable to restore window controls", error)
      })
    }
  }, [draft?.id, fragment?.id, isOpen, isZen])

  /**
   * 文档类型不提供行内编辑：打开即换成禅模式（产品框架 §2）。
   * 每个碎片只转一次，宿主换上禅模式后这个组件实例随即卸载。
   */
  useEffect(() => {
    if (!isOpen || isZen || !isDocumentSurface || !fragment) return
    if (!requestZenRef.current) return
    if (redirectedZenIdRef.current === fragment.id) return

    redirectedZenIdRef.current = fragment.id
    requestZenRef.current()
    // fragment 只取 id：同一条碎片的内容变化不该再触发一次跳转。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fragment?.id, isDocumentSurface, isOpen, isZen])

  // 换一条内容就回到大纲视图，导图是当前这棵树的临时读法，不跨文档记忆。
  useEffect(() => {
    setOutlineView("outline")
  }, [draft?.id, fragment?.id])

  // 只读导图铺满禅模式的正文区：MindMapPreview 要一个具体高度才能算缩放。
  useEffect(() => {
    const element = mindMapViewRef.current
    if (!element) return

    const observer = new ResizeObserver(([entry]) => {
      setMindMapViewHeight(Math.max(1, Math.round(entry.contentRect.height)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [outlineView])

  // 与其他 hooks 一样，必须位于关闭编辑器的提前 return 之前。
  const onCsvDrop = useCallback((file: { name: string; bytes: Uint8Array }) => {
    if (fragment?.lockbox || wantsLockbox(richEditorRef.current?.getMarkdown() ?? content, fragment?.tags ?? [])) {
      toast.error("私密碎片不支持数据集")
      return
    }
    setImportFile(file)
  }, [content, fragment?.lockbox, fragment?.tags])
  const { dropKind } = useTableDocumentDrop({
    enabled: isOpen && !readOnly,
    allowCsv: !fragment?.lockbox && !wantsLockbox(content, fragment?.tags ?? []),
    frameRef: editorFrameRef,
    onCsv: onCsvDrop,
  })
  const { uploadPastedImages } = useImageUpload({
    getContent: getCurrentDraftContent,
    isLockbox: Boolean(fragment?.lockbox),
    onUploaded: ({ alt, fileName, path, previewUrl }) => {
      if (readOnly) return
      setImageAttachments((current) => [
        ...current,
        {
          alt,
          id: `${Date.now()}-${fileName}`,
          path,
          previewUrl,
        },
      ])
      requestAnimationFrame(() => {
        focusEditor()
      })
    },
  })

  useEffect(() => {
    if (!isOpen) return
    onRegisterFlush?.(() => flushRef.current())
    return () => onRegisterFlush?.(null)
  }, [isOpen, onRegisterFlush])

  useLayoutEffect(() => {
    if (!fragment || !isOpen) return
    onReady?.(fragment.id)
  }, [fragment, isOpen, onReady])

  if (!isOpen) return null
  // 文档类型的行内编辑已经转交禅模式，这一帧什么都不画。
  if (!isZen && isDocumentSurface && onRequestZen) return null

  async function handleClose() {
    clearBlurCommitTimer()
    clearSaveTimer()

    if (!isZen || readOnly) {
      onClose()
      return
    }

    const currentDraftContent = getCurrentDraftContent()
    if (currentDraftContent !== lastSavedContentRef.current) {
      const saved = await saveDraft(currentDraftContent)
      if (!saved) return
    }

    onClose()
  }

  closeEditorRef.current = () => {
    void handleClose()
  }

  async function handleSubmit() {
    clearBlurCommitTimer()
    clearSaveTimer()

    const currentDraftContent = getCurrentDraftContent()
    if (currentDraftContent === lastSavedContentRef.current && !savePromiseRef.current) {
      onClose()
      return true
    }

    const saved = await saveDraft(currentDraftContent)
    if (saved) onClose()
    return saved
  }

  async function flushWithoutClose() {
    clearBlurCommitTimer()
    clearSaveTimer()
    if (readOnly) return true

    const currentDraftContent = getCurrentDraftContent()
    if (currentDraftContent === lastSavedContentRef.current && !savePromiseRef.current) {
      return true
    }
    return saveDraft(currentDraftContent)
  }

  function handleEditorBlur(event: FocusEvent<HTMLElement>) {
    if (readOnly || !commitOnBlur || isZen || blurCommitPausedRef.current) return

    const editorElement = event.currentTarget
    const nextFocused = event.relatedTarget
    if (isInsideEditorSurface(editorElement, nextFocused)) return

    clearBlurCommitTimer()
    blurCommitTimerRef.current = window.setTimeout(() => {
      blurCommitTimerRef.current = null
      if (blurCommitPausedRef.current) return
      if (isInsideEditorSurface(editorElement, document.activeElement)) {
        return
      }

      void handleSubmit()
    }, 0)
  }

  async function saveDraft(nextContent: string): Promise<boolean> {
    if (savePromiseRef.current) {
      if (!(await savePromiseRef.current)) return false
      if (nextContent === lastSavedContentRef.current) return true
    }
    const pending = persistDraft(nextContent)
    savePromiseRef.current = pending
    try { return await pending } finally {
      if (savePromiseRef.current === pending) savePromiseRef.current = null
    }
  }

  async function persistDraft(nextContent: string) {
    if (readOnly) return true
    if (nextContent.trim().length === 0) {
      setSaveState("error")
      toast.error("片段内容不能为空", { duration: Infinity })
      return false
    }

    setSaveState("saving")

    try {
      // type 是受保护的单值标签，正文里没有它：保存时必须把碎片原有的 type
      // 原样带回去，否则一次行内编辑就会把大纲 / 文档 / 笔记降级成普通碎片。
      const extracted = stripProtectedTypeTags(
        normalizeTagList(["inbox", ...extractTags(nextContent)]),
        kind
      )
      const tags = kind === "fragment" ? extracted : applyTypeTag(extracted, kind)
      const editsLockbox = Boolean(fragment?.lockbox)
      if ((editsLockbox || wantsLockbox(nextContent, tags)) && hasMarkdownImage(nextContent)) {
        throw new Error("密匣暂不支持图片附件。请先移除图片，再保存到密匣。")
      }
      if (isDraft) {
        if (!onCreateRef.current) {
          throw new Error("当前编辑器缺少创建入口。")
        }
        await onCreateRef.current(nextContent, tags)
      } else if (fragment) {
        const updated = await onSaveRef.current(
          fragment.id,
          nextContent,
          tags,
          baseFileShaRef.current ?? undefined
        )
        baseFileShaRef.current = updated.fileSha ?? null
      } else {
        return false
      }
      lastSavedContentRef.current = nextContent
      setSaveState("saved")
      return true
    } catch (error) {
      const message = getApiErrorMessage(error)
      if (!isDraft && message.includes("STALE_BASE")) {
        const keepMine = window.confirm(
          "这篇文档的磁盘内容已被修改（可能来自同步或外部编辑）。\n\n「确定」：用当前草稿覆盖磁盘版本\n「取消」：放弃当前草稿，载入磁盘最新版本"
        )
        if (keepMine) {
          baseFileShaRef.current = null
          setSaveState("dirty")
          return persistDraft(nextContent)
        }
        pendingDiskReloadRef.current = true
        lastSavedContentRef.current = nextContent
        setSaveState("saved")
        await onRefreshFragments?.()
        return true
      }
      setSaveState("error")
      toast.error(`${isDraft ? "保存失败" : "自动保存失败"}：${message}`, { duration: Infinity })
      return false
    }
  }

  function removeImageAttachment(id: string) {
    setImageAttachments((current) => {
      const removedImage = current.find((image) => image.id === id)
      if (removedImage?.previewUrl) {
        URL.revokeObjectURL(removedImage.previewUrl)
      }

      return current.filter((image) => image.id !== id)
    })
    requestAnimationFrame(() => {
      focusEditor()
    })
  }

  function clearSaveTimer() {
    if (saveTimerRef.current === null) return
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
  }

  function clearBlurCommitTimer() {
    if (blurCommitTimerRef.current === null) return
    window.clearTimeout(blurCommitTimerRef.current)
    blurCommitTimerRef.current = null
  }

  function getEditorValue() {
    // 大纲态没有文本编辑器，正文就是 state 里的缩进列表。
    if (isOutlineSurface) return content
    // 富文本要在读值时把手打的 `#标签` / `[[双链]]` 收敛成节点（getMarkdown 负责）。
    return richEditorRef.current?.getMarkdown() ?? content
  }

  function getCurrentDraftContent() {
    return buildContentWithImageAttachments(
      getEditorValue(),
      imageAttachmentsRef.current
    )
  }

  /**
   * 自动保存的取值：与 getCurrentDraftContent 同一份收敛口径，但不改编辑器——
   * 用户停顿时 `#标签` 后面可能还要接着打字，不能就地把它变成芯片。
   * 组合输入期间 peekMarkdown 退回最近一次报给宿主的值，拼音中间态不落盘。
   */
  function getAutosaveContent() {
    const value = isOutlineSurface
      ? content
      : (richEditorRef.current?.peekMarkdown(content) ?? content)
    return buildContentWithImageAttachments(value, imageAttachmentsRef.current)
  }

  function focusEditor() {
    richEditorRef.current?.focus()
  }

  // 编辑器与附件行使用同一组内边距，保持编辑内容和附件对齐。
  const editorPadding: CSSProperties = isZen
    ? {
        paddingInline: "var(--zen-editor-inline-padding)",
        paddingBlock: "var(--shard-space-4)",
      }
    : {
        paddingInline: "var(--shard-composer-padding)",
        paddingBlock: "var(--shard-composer-padding)",
      }
  const fieldStyle: CSSProperties = isZen
    ? {
        height: "100%",
        minHeight: 0,
        overflowY: "auto",
        ...editorPadding,
      }
    : {
        minHeight: 144,
        maxHeight: "min(52dvh, 520px)",
        overflowY: "hidden",
        borderTopLeftRadius: "var(--shard-surface-radius)",
        borderTopRightRadius: "var(--shard-surface-radius)",
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
        ...editorPadding,
      }
  /**
   * 富文本的内边距挂在正文上（rich-editor.css 的 inline / zen 变体），
   * 滚动时上下留白跟着内容走；这里只留高度上限与滚动容器。
   */
  const richFieldStyle: CSSProperties = {
    ...fieldStyle,
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
    paddingInline: undefined,
    paddingBlock: undefined,
  }
  const imageRowStyle: CSSProperties = isZen
    ? {
        paddingInline: "var(--zen-editor-inline-padding)",
        paddingBottom: "var(--shard-space-4)",
      }
    : {
        paddingInline: "var(--shard-composer-padding)",
        paddingBottom: "var(--shard-space-3)",
      }
  const imageAttachmentRow =
    imageAttachments.length > 0 ? (
      <div className="shard-image-attachment-row" style={imageRowStyle}>
        {imageAttachments.map((image) => (
          <FragmentImageAttachment
            alt={image.alt}
            key={image.id}
            onRemove={readOnly ? undefined : () => removeImageAttachment(image.id)}
            path={image.path}
            src={image.previewUrl}
            vaultPath={vaultPath}
            wrapped={false}
          />
        ))}
      </div>
    ) : null
  const canSubmit = saveState !== "saving" && draftContent.trim().length > 0
  const characterCount = Array.from(content.replace(/\s/g, "")).length
  // 公开笔记里出现 #密匣 意味着保存时会加密搬家，提前亮出目的地
  const willRouteToLockbox =
    !fragment?.lockbox &&
    kind !== "outline" &&
    kind !== "flowchart" &&
    wantsLockbox(content, fragment?.tags ?? [])
  const lineCount = content.length > 0 ? content.split(/\r\n?|\n/).length : 0
  /** 大纲的只读导图视图：同一棵树的另一种读法，不是另一种文件。 */
  const outlineContent = isOutlineSurface ? readOutlineContent(content) : null
  const outlineFile = outlineContent?.file ?? null
  const isLegacyOutline = outlineContent?.format === "legacy"
  const isMindMapView = isOutlineSurface && isZen && outlineView === "mindmap"
  const documentCharacterCount = countPlainTextCharacters(content)

  const editorFrame = (
    <div
      ref={editorFrameRef}
      style={{
        position: "relative",
        ...(isZen ? { display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" } : {}),
      }}
    >
      {isLegacyOutline && fragment ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-[var(--shard-composer-padding)] py-2 text-[length:var(--text-meta)] text-muted-foreground">
          <span>旧格式大纲，升级后可用导图编辑</span>
          <Button
            disabled={saveState === "saving"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void onRequestOutlineUpgrade?.(fragment.id)}
            size="sm"
            type="button"
            variant="outline"
          >
            升级
          </Button>
        </div>
      ) : null}
      {isMindMapView ? (
        <div
          ref={mindMapViewRef}
          style={{
            minHeight: 0,
            flex: "1 1 auto",
            paddingInline: "var(--zen-editor-inline-padding)",
            paddingBlock: "var(--shard-space-4)",
          }}
        >
          {outlineFile ? (
            <MindMapPreview file={outlineFile} height={mindMapViewHeight} />
          ) : (
            <p style={{ color: "var(--muted-foreground)", fontSize: "var(--text-meta)" }}>
              空的大纲还没有可预览的导图。
            </p>
          )}
        </div>
      ) : isOutlineSurface ? (
        <div className={isZen ? styles.outlineSurfaceZen : undefined} style={richFieldStyle}>
          <OutlineComposer
            code={content}
            key={editorId}
            onChange={readOnly ? () => undefined : setContent}
            // 幕布式大纲里 Escape 是「离开这块编辑区」；整篇即大纲时没有外层
            // 正文可回，直接按当前编辑面的收尾语义走，用户刚写的树不会丢。
            onExit={() => {
              if (isZen) closeEditorRef.current()
              else void handleSubmit()
            }}
            onSubmit={readOnly ? () => undefined : () => {
              void handleSubmit()
            }}
            readOnly={readOnly}
          />
        </div>
      ) : (
        <div style={richFieldStyle}>
          <ShardRichEditor
            allowDatasetActions={!fragment?.lockbox && !willRouteToLockbox}
            ariaLabel={isZen ? "禅模式片段编辑器" : "片段编辑器"}
            autoFocus={!readOnly}
            editorId={editorId}
            getKnownTags={() => knownTagsRef.current}
            getWikilinkCandidates={() => wikilinkCandidatesRef.current}
            // 换一条内容就换一个编辑器实例：正文、撤销历史与档位一起重置。
            key={editorId}
            onChange={(nextContent) => {
              setContent(nextContent)
            }}
            onDropFiles={readOnly ? undefined : (files) => {
              void uploadPastedImages(files)
            }}
            // ProseMirror 对 Esc 一律 preventDefault，禅模式外壳的 window 监听
            // 因此等不到这个键；由编辑器把它转交回宿主（见 shard-host.ts）。
            onEscape={isZen ? () => closeEditorRef.current() : undefined}
            onImageFiles={readOnly ? undefined : (files) => {
              void uploadPastedImages(files)
            }}
            onNavigateWikilink={navigateWikilink}
            onPasteFiles={readOnly ? undefined : (files) => {
              void uploadPastedImages(files)
            }}
            onSubmit={readOnly ? undefined : () => {
              void handleSubmit()
            }}
            ref={richEditorRef}
            readOnly={readOnly}
            tier={tier}
            value={content}
            variant={isZen ? "zen" : "inline"}
          />
        </div>
      )}
      {dropKind ? (
        <div className="shard-editor-drop-hint">
          {dropKind === "csv" ? fragment?.lockbox || willRouteToLockbox ? "私密碎片不支持数据集" : "松开以导入为数据集" : "请先另存为 CSV 再导入"}
        </div>
      ) : null}
      <CsvImportDialog file={importFile} allowed={!fragment?.lockbox && !willRouteToLockbox} onClose={() => setImportFile(null)} onImported={(path) => richEditorRef.current?.insertDatasetReference(path)} />
    </div>
  )

  /** 大纲态没有行内格式可用：工具条换成类型徽标（与速记框同一套做法）。 */
  const outlineBadge = (
    <span
      className="shard-tag shard-tag-muted"
      data-editor-type-badge="outline"
      style={{ flexShrink: 0, fontWeight: 500 }}
    >
      <GitBranchIcon />
      {CONTENT_KIND_LABELS.outline}
    </span>
  )
  const inlineTrailing = (
    <>
      {willRouteToLockbox ? (
        <span
          className="shard-tag shard-tag-lockbox"
          style={{ flexShrink: 0, fontWeight: 500 }}
        >
          <LockKeyholeIcon />
          {fragment ? "将移入密匣" : "将保存到密匣"}
        </span>
      ) : null}
      <span
        aria-hidden="true"
        style={{
          marginInline: "var(--shard-space-1)",
          height: 20,
          width: 1,
          background: "var(--border)",
          opacity: "var(--shard-alpha-55)",
        }}
      />
      <span
        style={{
          paddingInline: "var(--shard-space-1)",
          fontSize: 14,
          fontWeight: 500,
          color: "var(--muted-foreground)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {content.trim().length}
      </span>
      <Button
        disabled={saveState === "saving"}
        style={{
          height: 32,
          borderRadius: "var(--shard-radius-control)",
          paddingInline: "var(--shard-space-2)",
          color: "var(--muted-foreground)",
        }}
        onMouseDown={(event) => {
          event.preventDefault()
          void handleClose()
        }}
        size="sm"
        type="button"
        variant="ghost"
      >
        取消
      </Button>
      <ToolbarIconButton
        className="shard-edge-action"
        disabled={!canSubmit}
        label={saveState === "saving" ? "保存中" : "保存修改"}
        onMouseDown={(event) => {
          event.preventDefault()
          void handleSubmit()
        }}
        type="button"
        variant="default"
      >
        {saveState === "saving" ? (
          <Loader2Icon className={styles.spin} />
        ) : (
          <SendHorizontalIcon />
        )}
      </ToolbarIconButton>
    </>
  )

  if (!isZen) {
    return (
      <article
        className={styles.composerFrame}
        onBlurCapture={handleEditorBlur}
      >
        {editorFrame}
        {imageAttachmentRow}
        <div
          className="shard-edge-action-row"
          style={{
            borderBottomLeftRadius: "var(--shard-surface-radius)",
            borderBottomRightRadius: "var(--shard-surface-radius)",
            background: "var(--card)",
          }}
        >
          {isOutlineSurface ? (
            <div
              style={{
                display: "flex",
                minWidth: 0,
                alignItems: "center",
                justifyContent: "space-between",
                gap: "var(--shard-space-3)",
              }}
            >
              {outlineBadge}
              <div
                style={{
                  display: "flex",
                  flexShrink: 0,
                  alignItems: "center",
                  gap: "var(--shard-space-2)",
                }}
              >
                {inlineTrailing}
              </div>
            </div>
          ) : (
            <EditorToolbar
              disabled={readOnly || saveState === "saving"}
              trailing={inlineTrailing}
            />
          )}
        </div>
      </article>
    )
  }

  const zenTrailing = (
    <>
      {willRouteToLockbox ? (
        <span
          className="shard-tag shard-tag-lockbox"
          style={{ flexShrink: 0, fontWeight: 500 }}
        >
          <LockKeyholeIcon />
          {fragment ? "将移入密匣" : "将保存到密匣"}
        </span>
      ) : null}
      <span
        aria-hidden="true"
        style={{
          marginInline: "var(--shard-space-1)",
          height: 20,
          width: 1,
          background: "var(--border)",
          opacity: "var(--shard-alpha-55)",
        }}
      />
      <ToolbarIconButton
        className="shard-edge-action"
        label="退出编辑"
        onMouseDown={(event) => {
          event.preventDefault()
          void handleClose()
        }}
        style={{
          borderRadius: "var(--shard-radius-control)",
          color: "var(--muted-foreground)",
        }}
        type="button"
        variant="ghost"
      >
        <XIcon />
      </ToolbarIconButton>
    </>
  )

  return (
    <ZenSurface
      ariaLabel="禅模式"
      footer={
        <div className={`shard-content-inset ${styles.zenFooter}`}>
          <div
            className={styles.zenToolbar}
            style={{
              width: "fit-content",
              maxWidth: "100%",
              borderRadius: "var(--shard-surface-radius)",
              background: "var(--card)",
              padding: "var(--shard-space-3)",
              boxShadow: "var(--shard-composer-shadow)",
            }}
          >
            {isOutlineSurface ? (
              <div
                style={{
                  display: "flex",
                  minWidth: 0,
                  alignItems: "center",
                  gap: "var(--shard-space-2)",
                }}
              >
                {outlineBadge}
                {/* 导图是同一棵树的另一个视图，不是另一种文件（产品框架 §2）。 */}
                <Button
                  onClick={() => setOutlineView("outline")}
                  size="sm"
                  type="button"
                  variant={outlineView === "outline" ? "secondary" : "ghost"}
                >
                  大纲
                </Button>
                <Button
                  onClick={() => setOutlineView("mindmap")}
                  size="sm"
                  type="button"
                  variant={outlineView === "mindmap" ? "secondary" : "ghost"}
                >
                  导图
                </Button>
                {zenTrailing}
              </div>
            ) : (
              <EditorToolbar
                disabled={readOnly || saveState === "saving"}
                trailing={zenTrailing}
              />
            )}
          </div>
          {isDocumentSurface ? (
            // 文档档的字数是正文纯文本字符数，语法标记与围栏源码都不计。
            <span
              aria-label={`${documentCharacterCount} 字`}
              className={styles.zenStats}
              data-zen-word-count="document"
              title="字数只计正文，不含语法标记、空格与换行"
            >
              {documentCharacterCount.toLocaleString("zh-CN")} 字
            </span>
          ) : (
            <span
              aria-label={`${characterCount} 字，${lineCount} 行`}
              className={styles.zenStats}
              title="字数不计空格与换行"
            >
              {characterCount.toLocaleString("zh-CN")} 字 ·{" "}
              {lineCount.toLocaleString("zh-CN")} 行
            </span>
          )}
        </div>
      }
      onRequestClose={() => closeEditorRef.current()}
    >
      <div
        style={{
          display: "flex",
          height: "100%",
          minHeight: 0,
          flexDirection: "column",
        }}
      >
        {editorFrame}
        {imageAttachmentRow}
      </div>
    </ZenSurface>
  )
}

function splitContentImageAttachments(value: string) {
  const contentLines: string[] = []
  const images: EditorImageAttachment[] = []

  value.split("\n").forEach((line, index) => {
    const image = parseMarkdownImageLine(line)
    if (!image) {
      contentLines.push(line)
      return
    }

    images.push({
      alt: image.alt,
      id: `${index}-${image.path}`,
      path: image.path,
    })
  })

  return {
    content: contentLines.join("\n").trim(),
    images,
  }
}

function buildContentWithImageAttachments(
  value: string,
  images: EditorImageAttachment[]
) {
  const text = value.trim()
  const imageMarkdown = images
    .map((image) => `![${escapeMarkdownImageAlt(image.alt)}](${image.path})`)
    .join("\n")

  return [text, imageMarkdown].filter(Boolean).join("\n")
}

function escapeMarkdownImageAlt(alt: string) {
  return alt.replace(/\\/g, "\\\\").replace(/]/g, "\\]")
}

function revokeEditorImagePreviewUrls(images: EditorImageAttachment[]) {
  images.forEach((image) => {
    if (image.previewUrl) {
      URL.revokeObjectURL(image.previewUrl)
    }
  })
}
