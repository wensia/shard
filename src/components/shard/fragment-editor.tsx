import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
} from "react"
import { isTauri } from "@tauri-apps/api/core"
import { startCompletion } from "@codemirror/autocomplete"
import { Loader2Icon, LockKeyholeIcon, SendHorizontalIcon, XIcon } from "@/components/icons"
import { toast } from "sonner"

import { EditorToolbar } from "@/components/shard/editor-toolbar"
import { FragmentImageAttachment } from "@/components/shard/fragment-content"
import { ZenSurface } from "@/components/shard/zen-surface"
import { Button } from "@/components/ui/button"
import { ToolbarIconButton } from "@/components/ui/toolbar-icon-button"
import {
  ShardEditor,
  type ShardEditorHandle,
} from "@/editor/shard-editor"
import { createShardTagAutocomplete } from "@/editor/extensions/tag-autocomplete"
import {
  createShardWikilinkCompletionSource,
  createShardWikilinkExtension,
} from "@/editor/extensions/wikilink"
import { useImageUpload } from "@/hooks/use-image-upload"
import {
  applyInlineFormat,
  applyLineFormat,
  extractTags,
  insertHorizontalRule,
  insertTagMarker,
  normalizeTagList,
  parseMarkdownImageLine,
  type InlineFormat,
  type LineFormat,
  type TextEdit,
} from "@/lib/editor-format"
import {
  getApiErrorMessage,
  setWindowControlsHidden,
} from "@/lib/api"
import { hasMarkdownImage, wantsLockbox } from "@/lib/lockbox"
import { useTableDocumentDrop } from "@/lib/use-table-document-drop"
import { buildCsvWikilinkCandidates, buildWikilinkCandidates } from "@/lib/wikilink"
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
  onCreate?: (content: string, tags: string[]) => Promise<void>
  onNavigateToFragment?: (fragmentId: string) => void
  onSave: (id: string, content: string, tags: string[]) => Promise<Fragment>
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
  onSave,
  variant = "zen",
  vaultPath,
}: FragmentEditorProps) {
  const [content, setContent] = useState("")
  const [imageAttachments, setImageAttachments] = useState<
    EditorImageAttachment[]
  >([])
  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [selectionEnd, setSelectionEnd] = useState(0)
  const [selectionStart, setSelectionStart] = useState(0)
  const imageAttachmentsRef = useRef<EditorImageAttachment[]>([])
  const lastSavedContentRef = useRef("")
  const onCreateRef = useRef(onCreate)
  const onSaveRef = useRef(onSave)
  const blurCommitTimerRef = useRef<number | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const editorFrameRef = useRef<HTMLDivElement>(null)
  const shardEditorRef = useRef<ShardEditorHandle>(null)
  const closeEditorRef = useRef<() => void>(() => undefined)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)
  const flushRef = useRef<() => Promise<boolean>>(async () => true)
  flushRef.current = handleSubmit
  const isZen = variant === "zen"
  const isDraft = fragment === null && draft !== null
  const isOpen = fragment !== null || draft !== null
  const editorDocumentKey = fragment?.id ?? `draft:${draft?.id ?? "closed"}`
  const editorId = isZen
    ? `zen:${fragment?.id ?? `draft:${draft?.id ?? "closed"}`}`
    : `fragment:${fragment?.id ?? "closed"}`
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
  const wikilinkCompletionSource = useMemo(
    () =>
      createShardWikilinkCompletionSource({
        getCandidates: () => wikilinkCandidatesRef.current,
      }),
    []
  )
  const tagAutocompleteExtension = useMemo(
    () =>
      createShardTagAutocomplete({
        additionalSources: [wikilinkCompletionSource],
        getKnownTags: () => knownTagsRef.current,
      }),
    [wikilinkCompletionSource]
  )
  const wikilinkExtension = useMemo(
    () =>
      createShardWikilinkExtension({
        getCandidates: () => wikilinkCandidatesRef.current,
        maxCsvRows: isZen ? 50 : 10,
        onMissingTarget: (target) =>
          toast(`待建链接「${target}」尚不存在，可在资料库新建文档`),
        onNavigate: (fragmentId) =>
          wikilinkNavigateRef.current?.(fragmentId),
      }),
    [isZen, wikilinkCandidates]
  )
  const fragmentEditorExtensionSet = useMemo(
    () => [tagAutocompleteExtension, wikilinkExtension],
    [tagAutocompleteExtension, wikilinkExtension]
  )

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
    if (!fragment && !draft) {
      revokeEditorImagePreviewUrls(imageAttachmentsRef.current)
      imageAttachmentsRef.current = []
      setContent("")
      setImageAttachments([])
      setSelectionEnd(0)
      setSelectionStart(0)
      setSaveState("saved")
      lastSavedContentRef.current = ""
      return
    }

    const sourceContent = fragment?.content ?? draft?.content ?? ""
    const nextDraft = splitContentImageAttachments(sourceContent)
    const cursor = nextDraft.content.length
    revokeEditorImagePreviewUrls(imageAttachmentsRef.current)
    imageAttachmentsRef.current = nextDraft.images
    setContent(nextDraft.content)
    setImageAttachments(nextDraft.images)
    setSelectionEnd(cursor)
    setSelectionStart(cursor)
    const initialContent = buildContentWithImageAttachments(
      nextDraft.content,
      nextDraft.images
    )
    lastSavedContentRef.current = fragment ? initialContent : ""
    setSaveState(fragment || !initialContent ? "saved" : "dirty")

    requestAnimationFrame(() => {
      const view = shardEditorRef.current?.view
      if (!view) return

      view.focus()
      view.dispatch({
        selection: { anchor: cursor },
        scrollIntoView: true,
      })
    })
  }, [draft?.id, fragment?.id])

  useEffect(() => {
    if (!isOpen) return

    clearSaveTimer()

    if (draftContent === lastSavedContentRef.current) {
      setSaveState("saved")
      return
    }

    setSaveState("dirty")

    if (!isZen || isDraft) return

    saveTimerRef.current = window.setTimeout(() => {
      void saveDraft(draftContent)
    }, 800)

    return clearSaveTimer
  }, [draft?.id, draftContent, fragment?.id, isDraft, isOpen, isZen])

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

  // 与其他 hooks 一样，必须位于关闭编辑器的提前 return 之前。
  const { isDropTarget: isTableDropTarget } = useTableDocumentDrop({
    enabled: isOpen,
    frameRef: editorFrameRef,
  })
  const { uploadImage, uploadPastedImages } = useImageUpload({
    canUpload: () => Boolean(shardEditorRef.current?.view),
    getContent: getCurrentDraftContent,
    isLockbox: Boolean(fragment?.lockbox),
    onUploaded: ({ alt, fileName, path, previewUrl }) => {
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

  if (!isOpen) return null

  async function handleClose() {
    clearBlurCommitTimer()
    clearSaveTimer()

    if (!isZen) {
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

  function handleEditorBlur(event: FocusEvent<HTMLElement>) {
    if (!commitOnBlur || isZen) return

    const editorElement = event.currentTarget
    const nextFocused = event.relatedTarget
    if (nextFocused instanceof Node && editorElement.contains(nextFocused)) return

    clearBlurCommitTimer()
    blurCommitTimerRef.current = window.setTimeout(() => {
      blurCommitTimerRef.current = null
      const activeElement = document.activeElement
      if (activeElement instanceof Node && editorElement.contains(activeElement)) {
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
    if (nextContent.trim().length === 0) {
      setSaveState("error")
      toast.error("片段内容不能为空", { duration: Infinity })
      return false
    }

    setSaveState("saving")

    try {
      const tags = normalizeTagList(["inbox", ...extractTags(nextContent)])
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
        await onSaveRef.current(fragment.id, nextContent, tags)
      } else {
        return false
      }
      lastSavedContentRef.current = nextContent
      setSaveState("saved")
      return true
    } catch (error) {
      setSaveState("error")
      toast.error(`${isDraft ? "保存失败" : "自动保存失败"}：${getApiErrorMessage(error)}`, { duration: Infinity })
      return false
    }
  }

  function insertTag() {
    const { start: cursor } = getEditorSelection()
    applyTextEdit(insertTagMarker(getEditorValue(), cursor))
    const view = shardEditorRef.current?.view
    if (view) startCompletion(view)
  }

  function formatLines(format: LineFormat) {
    const selection = getEditorSelection()
    const currentContent = getEditorValue()

    applyTextEdit(
      applyLineFormat(
        currentContent,
        selection.start,
        selection.end,
        format
      )
    )
  }

  function formatInline(format: InlineFormat) {
    const selection = getEditorSelection()
    const currentContent = getEditorValue()

    applyTextEdit(
      applyInlineFormat(
        currentContent,
        selection.start,
        selection.end,
        format
      )
    )
  }

  function insertDivider() {
    const selection = getEditorSelection()
    const currentContent = getEditorValue()

    applyTextEdit(
      insertHorizontalRule(
        currentContent,
        selection.start,
        selection.end
      )
    )
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

  function applyTextEdit(nextEdit: TextEdit) {
    shardEditorRef.current?.applyTextEdit(nextEdit)
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

  function getEditorSelection() {
    return shardEditorRef.current?.getSelection() ?? {
      start: selectionStart,
      end: selectionEnd,
    }
  }

  function getEditorValue() {
    return shardEditorRef.current?.view?.state.doc.toString() ?? content
  }

  function getCurrentDraftContent() {
    return buildContentWithImageAttachments(
      getEditorValue(),
      imageAttachmentsRef.current
    )
  }

  function focusEditor() {
    shardEditorRef.current?.focus()
  }

  // CM 编辑器与附件行使用同一组内边距，保持编辑内容和附件对齐。
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
  const codeMirrorFieldStyle: CSSProperties = {
    ...fieldStyle,
    overflowY: "auto",
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
            onRemove={() => removeImageAttachment(image.id)}
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
    !fragment?.lockbox && wantsLockbox(content, fragment?.tags ?? [])
  const lineCount = content.length > 0 ? content.split(/\r\n?|\n/).length : 0
  const editorFrame = (
    <div
      ref={editorFrameRef}
      style={{
        position: "relative",
        ...(isZen ? { minHeight: 0, flex: "1 1 auto" } : {}),
      }}
    >
      <div style={codeMirrorFieldStyle}>
        <ShardEditor
          ariaLabel={isZen ? "禅模式片段编辑器" : "片段编辑器"}
          autoFocus
          documentKey={editorDocumentKey}
          editorId={editorId}
          extensions={fragmentEditorExtensionSet}
          onChange={(nextContent) => {
            setContent(nextContent)
          }}
          onDropFiles={(files) => {
            void uploadPastedImages(files)
          }}
          onPasteFiles={(files) => {
            void uploadPastedImages(files)
          }}
          onSelectionChange={(start, end) => {
            setSelectionStart(start)
            setSelectionEnd(end)
          }}
          onSubmit={() => {
            void handleSubmit()
          }}
          ref={shardEditorRef}
          value={content}
          variant={isZen ? "zen" : "inline"}
        />
      </div>
      {isTableDropTarget ? (
        <div className="shard-editor-drop-hint">
          请在资料库中导入为多维表格
        </div>
      ) : null}
    </div>
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
          <EditorToolbar
            disabled={saveState === "saving"}
            onImageUpload={uploadImage}
            onInlineFormat={formatInline}
            onInsertHorizontalRule={insertDivider}
            onInsertTag={insertTag}
            onLineFormat={formatLines}
            trailing={
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
            }
          />
        </div>
      </article>
    )
  }

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
            <EditorToolbar
              disabled={saveState === "saving"}
              onImageUpload={uploadImage}
              onInlineFormat={formatInline}
              onInsertHorizontalRule={insertDivider}
              onInsertTag={insertTag}
              onLineFormat={formatLines}
              trailing={
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
              }
            />
          </div>
          <span
            aria-label={`${characterCount} 字，${lineCount} 行`}
            className={styles.zenStats}
            title="字数不计空格与换行"
          >
            {characterCount.toLocaleString("zh-CN")} 字 ·{" "}
            {lineCount.toLocaleString("zh-CN")} 行
          </span>
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
