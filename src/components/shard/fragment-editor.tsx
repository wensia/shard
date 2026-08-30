import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
} from "react"
import { isTauri } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { startCompletion } from "@codemirror/autocomplete"
import { keymap } from "@codemirror/view"
import { Loader2Icon, SendHorizontalIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { EditorToolbar } from "@/components/shard/editor-toolbar"
import { FragmentImageAttachment } from "@/components/shard/fragment-content"
import { Button } from "@/components/ui/button"
import { ToolbarIconButton } from "@/components/ui/toolbar-icon-button"
import {
  ShardEditor,
  type ShardEditorHandle,
} from "@/editor/shard-editor"
import { createShardTagAutocomplete } from "@/editor/extensions/tag-autocomplete"
import {
  applyInlineFormat,
  applyLineFormat,
  extractTags,
  getMarkdownImageAlt,
  insertHorizontalRule,
  insertMarkdownBlock,
  insertMarkdownTable,
  insertTagMarker,
  normalizeTagList,
  parseMarkdownImageLine,
  type InlineFormat,
  type LineFormat,
  type TextEdit,
} from "@/lib/editor-format"
import {
  convertTableDocumentToMarkdown,
  getApiErrorMessage,
  saveFragmentImage,
  setWindowControlsHidden,
} from "@/lib/api"
import { hasMarkdownImage, wantsLockbox } from "@/lib/lockbox"
import {
  getFirstEditableTableOffset,
  hasOversizedTable,
  MAX_EDITABLE_TABLE_CELLS,
} from "@/lib/markdown-table"
import {
  TABLE_DOCUMENT_FILTER,
  useTableDocumentDrop,
} from "@/lib/use-table-document-drop"
import type { Fragment } from "@/types"
import styles from "./fragment-editor.module.css"

export interface FragmentEditorDraft {
  content: string
  id: number
}

interface FragmentEditorProps {
  commitOnBlur?: boolean
  draft?: FragmentEditorDraft | null
  fragment: Fragment | null
  knownTags: string[]
  onClose: () => void
  onCreate?: (content: string, tags: string[]) => Promise<void>
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
  draft = null,
  fragment,
  knownTags,
  onClose,
  onCreate,
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
  const [isImportingTable, setIsImportingTable] = useState(false)
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
  const tagAutocompleteExtension = useMemo(
    () =>
      createShardTagAutocomplete({
        getKnownTags: () => knownTagsRef.current,
      }),
    []
  )
  const fragmentEditorExtensions = useMemo(
    () =>
      keymap.of([
        {
          key: "Escape",
          run: (view) => {
            if (view.composing) return false
            closeEditorRef.current()
            return true
          },
        },
      ]),
    []
  )
  const fragmentEditorExtensionSet = useMemo(
    () => [fragmentEditorExtensions, tagAutocompleteExtension],
    [fragmentEditorExtensions, tagAutocompleteExtension]
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

  /**
   * 表格文档导入：转成 Markdown 表格插进正文，原文件不进 vault。
   * 数据留在正文里，搜索、标签、git diff 才都还能用上。
   *
   * 必须放在下面的 `if (!isOpen) return null` 之前：hook 一旦排在提前
   * return 之后，编辑器从关闭到打开时 hooks 数量就会变化，React 会报
   * "Rendered more hooks than during the previous render" 并卸载整棵树
   * （禅模式白屏就是这么来的）。`insertTableDocuments` 是函数声明，提升后可用。
   */
  const { isDropTarget: isTableDropTarget } = useTableDocumentDrop({
    frameRef: editorFrameRef,
    onDrop: (paths) => insertTableDocuments(paths),
  })

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
    if (currentDraftContent === lastSavedContentRef.current) {
      onClose()
      return
    }

    const saved = await saveDraft(currentDraftContent)
    if (saved) {
      onClose()
    }
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

  async function saveDraft(nextContent: string) {
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

  function insertTable(columns: number, rows: number) {
    const selection = getEditorSelection()
    const currentContent = getEditorValue()

    const nextEdit = insertMarkdownTable(
      currentContent,
      selection.start,
      selection.end,
      columns,
      rows
    )
    applyTextEdit(nextEdit)
    focusInsertedTable(nextEdit.content, nextEdit.selectionStart)
  }

  /** 插完表格直接进第一个表头格，省得用户再点一下。 */
  function focusInsertedTable(nextContent: string, cursor: number) {
    const tableStart = nextContent.lastIndexOf("\n", cursor - 1) + 1

    requestAnimationFrame(() => {
      shardEditorRef.current?.focusTableCell(tableStart, "-1:0")
    })
  }

  async function insertTableDocuments(paths: string[]) {
    if (paths.length === 0 || isImportingTable) return

    setIsImportingTable(true)
    try {
      const blocks: string[] = []
      for (const path of paths) {
        blocks.push(await convertTableDocumentToMarkdown(path))
      }

      const markdown = blocks.join("\n\n")
      if (hasOversizedTable(markdown)) {
        toast.info(
          `表格较大，已作为纯文本插入：超过 ${MAX_EDITABLE_TABLE_CELLS} 个单元格不提供可视化编辑，源码照常可改。`
        )
      }

      const body = markdown.trim()
      const currentContent = getEditorValue()
      const selection = getEditorSelection()
      const nextEdit = insertMarkdownBlock(
        currentContent,
        selection.start,
        selection.end,
        markdown
      )
      applyTextEdit(nextEdit)

      const relativeTableStart = getFirstEditableTableOffset(body)
      if (relativeTableStart !== null) {
        const bodyStart = nextEdit.selectionStart - body.length
        shardEditorRef.current?.focusTableCell(
          bodyStart + relativeTableStart,
          "-1:0",
        )
      }
    } catch (error) {
      toast.error(`导入表格失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    } finally {
      setIsImportingTable(false)
    }
  }

  async function pickTableDocument() {
    try {
      const selected = await open({
        filters: [TABLE_DOCUMENT_FILTER],
        multiple: false,
        title: "选择表格文件",
      })
      const path = Array.isArray(selected) ? selected[0] : selected
      if (!path) return

      await insertTableDocuments([path])
    } catch (error) {
      toast.error(`选择文件失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    }
  }

  async function uploadImage(file: File) {
    if (!shardEditorRef.current?.view) return
    const currentDraftContent = getCurrentDraftContent()
    const tags = normalizeTagList([
      "inbox",
      ...extractTags(currentDraftContent),
    ])
    if (fragment?.lockbox || wantsLockbox(currentDraftContent, tags)) {
      toast.error("密匣暂不支持图片附件：请先移除 #密匣，或在公开笔记中上传图片。", { duration: Infinity })
      return
    }

    const previewUrl = URL.createObjectURL(file)
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
      const path = await saveFragmentImage(file.name, bytes)
      setImageAttachments((current) => [
        ...current,
        {
          alt: getMarkdownImageAlt(file.name),
          id: `${Date.now()}-${file.name}`,
          path,
          previewUrl,
        },
      ])
      requestAnimationFrame(() => {
        focusEditor()
      })
    } catch (error) {
      URL.revokeObjectURL(previewUrl)
      toast.error(`图片上传失败：${getApiErrorMessage(error)}`, { duration: Infinity })
    }
  }

  async function uploadPastedImages(files: File[]) {
    for (const file of files) {
      await uploadImage(file)
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
      {isTableDropTarget || isImportingTable ? (
        <div className="shard-editor-drop-hint">
          {isImportingTable ? "正在导入表格…" : "松手导入为表格"}
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
            onImportTable={isTauri() ? pickTableDocument : undefined}
            onInlineFormat={formatInline}
            onInsertHorizontalRule={insertDivider}
            onInsertTable={insertTable}
            onInsertTag={insertTag}
            onLineFormat={formatLines}
            trailing={
              <>
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
    <div
      className={styles.zenEditorShell}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "grid",
        gridTemplateRows: "minmax(0, 1fr) auto",
        background: "var(--background)",
        color: "var(--foreground)",
      }}
    >
      <div
        data-tauri-drag-region
        style={{ minHeight: 0, paddingTop: "var(--shard-top-inset)" }}
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
      </div>

      <footer
        className={`shard-content-inset ${styles.zenFooter}`}
      >
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
            onImportTable={isTauri() ? pickTableDocument : undefined}
            onInlineFormat={formatInline}
            onInsertHorizontalRule={insertDivider}
            onInsertTable={insertTable}
            onInsertTag={insertTag}
            onLineFormat={formatLines}
            trailing={
              <>
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
      </footer>
    </div>
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
