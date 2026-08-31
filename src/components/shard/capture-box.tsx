import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Loader2Icon, LockKeyholeIcon, SendHorizontalIcon } from "lucide-react"
import { startCompletion } from "@codemirror/autocomplete"
import { isTauri } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"

import { EditorToolbar } from "@/components/shard/editor-toolbar"
import { FragmentImageAttachment } from "@/components/shard/fragment-content"
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
  type InlineFormat,
  type LineFormat,
  type TextEdit,
} from "@/lib/editor-format"
import {
  convertTableDocumentToMarkdown,
  getApiErrorMessage,
  saveFragmentImage,
} from "@/lib/api"
import { wantsLockbox } from "@/lib/lockbox"
import {
  getFirstEditableTableOffset,
  hasOversizedTable,
  MAX_EDITABLE_TABLE_CELLS,
} from "@/lib/markdown-table"
import {
  TABLE_DOCUMENT_FILTER,
  useTableDocumentDrop,
} from "@/lib/use-table-document-drop"
import {
  buildCsvWikilinkCandidates,
  buildMindMapWikilinkCandidates,
  buildWikilinkCandidates,
} from "@/lib/wikilink"
import type { CsvFileSummary, Fragment, MindMapSummary } from "@/types"

import styles from "./capture-box.module.css"

interface CaptureBoxProps {
  collapseSignal: number
  csvFiles?: CsvFileSummary[]
  fragments: Fragment[]
  isCreating: boolean
  knownTags: string[]
  mindMaps?: MindMapSummary[]
  onCreate: (content: string, tags: string[]) => void | Promise<void>
  onNavigateToFragment?: (fragmentId: string) => void
  onOpenMindMap?: (map: MindMapSummary) => void
  onOpenZen?: (content: string) => void
}

interface PendingImage {
  alt: string
  bytes: number[]
  fileName: string
  id: string
  previewUrl: string
}

export function CaptureBox({
  collapseSignal,
  csvFiles = [],
  fragments,
  isCreating,
  knownTags,
  mindMaps = [],
  onCreate,
  onNavigateToFragment,
  onOpenMindMap,
  onOpenZen,
}: CaptureBoxProps) {
  const [content, setContent] = useState("")
  const [isEditorExpanded, setIsEditorExpanded] = useState(false)
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [selectionStart, setSelectionStart] = useState(0)
  const [selectionEnd, setSelectionEnd] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const editorFrameRef = useRef<HTMLDivElement>(null)
  const codeMirrorViewportRef = useRef<HTMLDivElement>(null)
  const codeMirrorContentHeightRef = useRef(0)
  const [isImportingTable, setIsImportingTable] = useState(false)
  const shardEditorRef = useRef<ShardEditorHandle>(null)
  const hasSkippedInitialFocusRef = useRef(false)
  const pendingImagesRef = useRef<PendingImage[]>([])

  const normalizedKnownTags = useMemo(
    () => normalizeTagList(knownTags.filter((tag) => tag !== "inbox")),
    [knownTags]
  )
  const willSaveToLockbox = useMemo(() => wantsLockbox(content, []), [content])
  const knownTagsRef = useRef(normalizedKnownTags)
  knownTagsRef.current = normalizedKnownTags
  const wikilinkCandidates = useMemo(
    () => [
      ...buildWikilinkCandidates(fragments),
      ...buildCsvWikilinkCandidates(csvFiles),
      ...buildMindMapWikilinkCandidates(mindMaps),
    ],
    [csvFiles, fragments, mindMaps]
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
        maxCsvRows: 10,
        onMissingTarget: (target) =>
          toast(`待建链接「${target}」尚不存在，可在资料库新建笔记`),
        onNavigate: (fragmentId) =>
          wikilinkNavigateRef.current?.(fragmentId),
        onNavigateToMindMap: (path) => {
          const map = mindMaps.find((candidate) => candidate.path === path)
          if (map) onOpenMindMap?.(map)
        },
      }),
    [mindMaps, onOpenMindMap, wikilinkCandidates]
  )
  const codeMirrorExtensionSet = useMemo(
    () => [tagAutocompleteExtension, wikilinkExtension],
    [tagAutocompleteExtension, wikilinkExtension]
  )
  const canSubmit =
    (content.trim().length > 0 || pendingImages.length > 0) && !isCreating

  function getCurrentSelection() {
    return (
      shardEditorRef.current?.getSelection() ?? {
        start: selectionStart,
        end: selectionEnd,
      }
    )
  }

  function getCurrentEditorValue() {
    return shardEditorRef.current?.view?.state.doc.toString() ?? content
  }

  function focusActiveEditor() {
    shardEditorRef.current?.focus()
  }

  const syncCodeMirrorGeometry = useCallback(() => {
    if (codeMirrorContentHeightRef.current <= 0) return
    resizeCodeMirrorEditor(
      codeMirrorViewportRef.current,
      codeMirrorContentHeightRef.current,
      isEditorExpanded,
      containerRef.current,
      editorFrameRef.current
    )
  }, [isEditorExpanded])

  function handleCodeMirrorHeightChange(height: number) {
    codeMirrorContentHeightRef.current = height
    resizeCodeMirrorEditor(
      codeMirrorViewportRef.current,
      height,
      isEditorExpanded,
      containerRef.current,
      editorFrameRef.current
    )
  }

  function handleEditorFocus() {
    if (!hasSkippedInitialFocusRef.current) {
      hasSkippedInitialFocusRef.current = true
      return
    }

    setIsEditorExpanded(true)
  }

  useEffect(() => {
    pendingImagesRef.current = pendingImages
  }, [pendingImages])

  useEffect(() => {
    return () => {
      pendingImagesRef.current.forEach((image) => {
        URL.revokeObjectURL(image.previewUrl)
      })
    }
  }, [])

  useEffect(() => {
    if (collapseSignal === 0) return

    setIsEditorExpanded(false)
  }, [collapseSignal])

  useLayoutEffect(() => {
    syncCodeMirrorGeometry()
  }, [content, pendingImages.length, syncCodeMirrorGeometry])

  useEffect(() => {
    function handleViewportResize() {
      syncCodeMirrorGeometry()
    }

    window.addEventListener("resize", handleViewportResize)
    window.visualViewport?.addEventListener("resize", handleViewportResize)

    return () => {
      window.removeEventListener("resize", handleViewportResize)
      window.visualViewport?.removeEventListener(
        "resize",
        handleViewportResize
      )
    }
  }, [syncCodeMirrorGeometry])

  async function submit() {
    if (isCreating) return

    const draftTags = normalizeTagList(["inbox", ...extractTags(content)])
    if (wantsLockbox(content, draftTags) && pendingImages.length > 0) {
      toast.error("密匣暂不支持图片附件：请先移除图片，再保存到密匣，避免附件写入公开 assets 目录。", { duration: Infinity })
      setIsEditorExpanded(true)
      return
    }

    try {
      const savedImages = []
      for (const image of pendingImages) {
        const path = await saveFragmentImage(image.fileName, image.bytes).catch(
          (error) => {
            toast.error(`图片保存失败：${getApiErrorMessage(error)}`, { duration: Infinity })
            throw error
          }
        )
        savedImages.push({ alt: image.alt, path })
      }
      const next = buildContentWithPendingImages(content, savedImages)
      if (!next) return

      await onCreate(next, normalizeTagList(["inbox", ...extractTags(next)]))
      pendingImages.forEach((image) => {
        URL.revokeObjectURL(image.previewUrl)
      })
      setContent("")
      setPendingImages([])
      setIsEditorExpanded(false)
      setSelectionStart(0)
      setSelectionEnd(0)
      requestAnimationFrame(() => {
        shardEditorRef.current?.replaceDocument("")
      })
    } catch {
      setIsEditorExpanded(true)
      requestAnimationFrame(() => {
        focusActiveEditor()
      })
    }
  }

  function insertTag() {
    const cursor = getCurrentSelection().start
    const nextEdit = insertTagMarker(getCurrentEditorValue(), cursor)
    setIsEditorExpanded(true)
    applyTextEdit(nextEdit)
    const view = shardEditorRef.current?.view
    if (view) startCompletion(view)
  }

  function formatLines(format: LineFormat) {
    const selection = getCurrentSelection()

    const nextEdit = applyLineFormat(
      content,
      selection.start,
      selection.end,
      format
    )

    setIsEditorExpanded(true)
    applyTextEdit(nextEdit)
  }

  function formatInline(format: InlineFormat) {
    const selection = getCurrentSelection()

    const nextEdit = applyInlineFormat(
      content,
      selection.start,
      selection.end,
      format
    )

    setIsEditorExpanded(true)
    applyTextEdit(nextEdit)
  }

  function insertDivider() {
    const selection = getCurrentSelection()

    setIsEditorExpanded(true)
    applyTextEdit(
      insertHorizontalRule(
        content,
        selection.start,
        selection.end
      )
    )
  }

  function insertTable(columns: number, rows: number) {
    const selection = getCurrentSelection()

    setIsEditorExpanded(true)
    const nextEdit = insertMarkdownTable(
      content,
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

  /**
   * 表格文档导入：转成 Markdown 表格插进正文，原文件不进 vault。
   * 数据留在正文里，搜索、标签、git diff 才都还能用上。
   */
  const { isDropTarget: isTableDropTarget } = useTableDocumentDrop({
    frameRef: editorFrameRef,
    onDrop: (paths) => insertTableDocuments(paths),
  })

  async function insertTableDocuments(paths: string[]) {
    if (paths.length === 0 || isImportingTable) return

    setIsEditorExpanded(true)
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
      const selection = getCurrentSelection()
      const nextEdit = insertMarkdownBlock(
        getCurrentEditorValue(),
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

  function openZenEditor() {
    if (!onOpenZen) return

    if (pendingImages.length > 0) {
      toast.error("带图片的草稿暂不能切换到禅模式：请先保存当前片段，或移除图片后再进入禅模式。", { duration: Infinity })
      return
    }

    const draftContent = getCurrentEditorValue()
    onOpenZen(draftContent)
    setContent("")
    setIsEditorExpanded(false)
    setSelectionStart(0)
    setSelectionEnd(0)
    requestAnimationFrame(() => {
      shardEditorRef.current?.replaceDocument("")
    })
  }

  async function uploadImage(file: File) {
    const previewUrl = URL.createObjectURL(file)

    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
      setIsEditorExpanded(true)
      setPendingImages((current) => [
        ...current,
        {
          alt: getMarkdownImageAlt(file.name),
          bytes,
          fileName: file.name,
          id: `${Date.now()}-${file.name}`,
          previewUrl,
        },
      ])
      requestAnimationFrame(() => {
        focusActiveEditor()
      })
    } catch (error) {
      toast.error(`图片上传失败：${getApiErrorMessage(error)}`, { duration: Infinity })
      URL.revokeObjectURL(previewUrl)
    }
  }

  async function uploadPastedImages(files: File[]) {
    for (const file of files) {
      await uploadImage(file)
    }
  }

  function applyTextEdit(nextEdit: TextEdit) {
    setContent(nextEdit.content)
    setSelectionStart(nextEdit.selectionStart)
    setSelectionEnd(nextEdit.selectionEnd)
    shardEditorRef.current?.applyTextEdit(nextEdit)
  }

  function removePendingImage(id: string) {
    setPendingImages((current) => {
      const removedImage = current.find((image) => image.id === id)
      if (removedImage) {
        URL.revokeObjectURL(removedImage.previewUrl)
      }

      return current.filter((image) => image.id !== id)
    })
    requestAnimationFrame(() => {
      focusActiveEditor()
    })
  }

  return (
    <div
      className={`shard-content-measure ${styles.composer}`}
      ref={containerRef}
    >
      <div ref={editorFrameRef} style={{ position: "relative" }}>
        <div
          className={styles.codeMirrorViewport}
          data-expanded={isEditorExpanded ? "true" : undefined}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsEditorExpanded(true)
              shardEditorRef.current?.focus()
            }
          }}
          ref={codeMirrorViewportRef}
        >
          <ShardEditor
            ariaLabel="快速记录"
            autoFocus
            documentKey="composer"
            editorId="composer"
            extensions={codeMirrorExtensionSet}
            onChange={(nextContent) => {
              setIsEditorExpanded(true)
              setContent(nextContent)
            }}
            onDropFiles={(files) => void uploadPastedImages(files)}
            onFocus={handleEditorFocus}
            onHeightChange={handleCodeMirrorHeightChange}
            onPasteFiles={(files) => void uploadPastedImages(files)}
            onSelectionChange={(start, end) => {
              setSelectionStart(start)
              setSelectionEnd(end)
            }}
            onSubmit={() => void submit()}
            onToggleZen={onOpenZen && !isCreating ? openZenEditor : undefined}
            placeholder="想到什么，写什么..."
            ref={shardEditorRef}
            value={content}
            variant="composer"
          />
        </div>
        {isTableDropTarget || isImportingTable ? (
          <div className="shard-editor-drop-hint">
            {isImportingTable ? "正在导入表格…" : "松手导入为表格"}
          </div>
        ) : null}
      </div>
      {pendingImages.length > 0 ? (
        <div
          className="shard-image-attachment-row"
          style={{
            paddingInline: "var(--shard-composer-padding)",
            paddingBottom: "var(--shard-space-3)",
          }}
        >
          {pendingImages.map((image) => (
            <FragmentImageAttachment
              alt={image.alt}
              key={image.id}
              onRemove={() => removePendingImage(image.id)}
              path={image.fileName}
              src={image.previewUrl}
              wrapped={false}
            />
          ))}
        </div>
      ) : null}

      <div
        className="shard-edge-action-row"
        style={{
          borderRadius:
            "0 0 var(--shard-surface-radius) var(--shard-surface-radius)",
          background: "var(--card)",
        }}
      >
        <div style={{ minWidth: 0, flex: "1 1 0%" }}>
          <EditorToolbar
            disabled={isCreating}
            onImageUpload={uploadImage}
            onImportTable={isTauri() ? pickTableDocument : undefined}
            onInlineFormat={formatInline}
            onInsertHorizontalRule={insertDivider}
            onInsertTable={insertTable}
            onInsertTag={insertTag}
            onLineFormat={formatLines}
            onOpenZen={onOpenZen ? openZenEditor : undefined}
            trailing={
              <>
                {willSaveToLockbox ? (
                  <span
                    className="shard-tag shard-tag-lockbox"
                    style={{ flexShrink: 0, fontWeight: 500 }}
                  >
                    <LockKeyholeIcon strokeWidth={1.75} />
                    将保存到密匣
                  </span>
                ) : null}
                <ToolbarIconButton
                  className="shard-edge-action"
                  disabled={!canSubmit}
                  label={isCreating ? "保存中" : "保存片段"}
                  onClick={() => void submit()}
                  type="button"
                  variant="primary"
                >
                  {isCreating ? (
                    <Loader2Icon className={styles.spin} />
                  ) : (
                    <SendHorizontalIcon />
                  )}
                </ToolbarIconButton>
              </>
            }
          />
        </div>
      </div>
      {isCreating ? (
        <div
          style={{
            display: "flex",
            position: "absolute",
            top: "var(--shard-space-4)",
            right: "var(--shard-space-4)",
            alignItems: "center",
            gap: "var(--shard-space-micro)",
            pointerEvents: "none",
            fontSize: 12,
            fontWeight: 400,
            color: "var(--muted-foreground)",
          }}
        >
          <Loader2Icon className={styles.spin} size={14} />
          <span>保存中</span>
        </div>
      ) : null}
    </div>
  )
}

const CAPTURE_COLLAPSED_ROWS = 2
const CAPTURE_EXPANDED_ROWS = 4

function buildContentWithPendingImages(
  value: string,
  pendingImages: Array<{ alt: string; path: string }>
) {
  const text = value.trim()
  const imageMarkdown = pendingImages
    .map((image) => `![${escapeMarkdownImageAlt(image.alt)}](${image.path})`)
    .join("\n")

  return [text, imageMarkdown].filter(Boolean).join("\n")
}

function escapeMarkdownImageAlt(alt: string) {
  return alt.replace(/\\/g, "\\\\").replace(/]/g, "\\]")
}

function resizeCodeMirrorEditor(
  viewport: HTMLDivElement | null,
  contentHeight: number,
  isExpanded: boolean,
  container: HTMLDivElement | null,
  editorFrame: HTMLDivElement | null
) {
  if (!viewport) return

  const targetRows = isExpanded
    ? CAPTURE_EXPANDED_ROWS
    : CAPTURE_COLLAPSED_ROWS
  const minimumHeight = getCodeMirrorRowsHeight(viewport, targetRows)
  const maximumHeight = getCaptureTextareaMaxHeight(
    container,
    editorFrame,
    contentHeight
  )
  const boundedMinimumHeight =
    maximumHeight === null
      ? minimumHeight
      : Math.min(minimumHeight, maximumHeight)
  const nextHeight =
    maximumHeight === null
      ? Math.max(contentHeight, minimumHeight)
      : Math.min(Math.max(contentHeight, boundedMinimumHeight), maximumHeight)
  const isScrollable = contentHeight > nextHeight + 1

  viewport.style.minHeight = `${boundedMinimumHeight}px`
  viewport.style.height = `${nextHeight}px`
  viewport.style.overflowY = isScrollable ? "auto" : "hidden"
  if (maximumHeight === null) viewport.style.removeProperty("max-height")
  else viewport.style.maxHeight = `${maximumHeight}px`

  if (!isScrollable && viewport.scrollTop !== 0) viewport.scrollTop = 0
}

function getCodeMirrorRowsHeight(viewport: HTMLDivElement, rows: number) {
  const content = viewport.querySelector<HTMLElement>(".cm-content")
  if (!content) return 0

  const styles = window.getComputedStyle(content)
  const fontSize = toPixelValue(styles.fontSize, 14)
  const lineHeight = toPixelValue(styles.lineHeight, fontSize * 1.8)
  const paddingTop = toPixelValue(styles.paddingTop, 0)
  const paddingBottom = toPixelValue(styles.paddingBottom, 0)

  return Math.ceil(lineHeight * rows + paddingTop + paddingBottom)
}

function getCaptureTextareaMaxHeight(
  container: HTMLDivElement | null,
  editorFrame: HTMLDivElement | null,
  contentHeight: number
) {
  if (!container || !editorFrame) return null

  const containerRect = container.getBoundingClientRect()
  const editorFrameRect = editorFrame.getBoundingClientRect()
  const viewportBottom = getCaptureViewportBottom(container)
  const rootStyles = window.getComputedStyle(document.documentElement)
  const topGap = toPixelValue(
    rootStyles.getPropertyValue("--shard-composer-top-gap"),
    32
  )
  const bottomGap = toPixelValue(
    rootStyles.getPropertyValue("--shard-composer-bottom-gap"),
    16
  )
  const composerChromeHeight = Math.max(
    0,
    containerRect.height - editorFrameRect.height
  )
  const currentReclaim = toPixelValue(
    container.dataset.composerTopReclaim ?? "",
    0
  )
  const currentMaximumHeight = Math.max(
    1,
    Math.floor(
      viewportBottom - containerRect.top - bottomGap - composerChromeHeight
    )
  )
  const normalMaximumHeight = Math.max(
    1,
    currentMaximumHeight - currentReclaim
  )
  const reclaimLimit = window.matchMedia("(min-width: 64rem)").matches
    ? Math.max(0, topGap - bottomGap)
    : 0
  const nextReclaim = Math.min(
    Math.max(contentHeight - normalMaximumHeight, 0),
    reclaimLimit
  )

  container.dataset.composerTopReclaim = String(nextReclaim)
  if (reclaimLimit > 0 && nextReclaim >= reclaimLimit) {
    container.dataset.heightCapped = "true"
  } else {
    delete container.dataset.heightCapped
  }
  container.style.marginTop = nextReclaim > 0 ? `-${nextReclaim}px` : ""

  return normalMaximumHeight + nextReclaim
}

function getCaptureViewportBottom(container: HTMLDivElement) {
  const mainColumn = container.closest("section")
  if (mainColumn instanceof HTMLElement) {
    return mainColumn.getBoundingClientRect().bottom
  }

  return window.visualViewport?.height ?? window.innerHeight
}

function toPixelValue(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
