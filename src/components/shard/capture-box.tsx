import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  FileTextIcon,
  GitBranchIcon,
  Loader2Icon,
  LockKeyholeIcon,
  SendHorizontalIcon,
} from "@/components/icons"

import { EditorToolbar } from "@/components/shard/editor-toolbar"
import { FragmentImageAttachment } from "@/components/shard/fragment-content"
import { OutlineComposer } from "@/components/shard/outline-composer"
import { Button } from "@/components/ui/button"
import { ToolbarIconButton } from "@/components/ui/toolbar-icon-button"
import {
  ShardRichEditor,
  type ShardRichEditorHandle,
} from "@/editor-rich/ShardRichEditor"
import {
  extractTags,
  getMarkdownImageAlt,
  normalizeTagList,
} from "@/lib/editor-format"
import {
  openCsvFile,
  saveFragmentImage,
} from "@/lib/api"
import {
  applyTypeTag,
  CONTENT_KIND_LABELS,
  DOCUMENT_TYPE_TAG,
  OUTLINE_TYPE_TAG,
} from "@/lib/content-kind"
import { wantsLockbox } from "@/lib/lockbox"
import { notify } from "@/lib/notify"
import {
  EMPTY_MIND_MAP_OUTLINE_SOURCE,
  parseMindMapOutline,
  serializeMindMapOutline,
} from "@/lib/mind-map-outline"
import { useTableDocumentDrop } from "@/lib/use-table-document-drop"
import {
  buildCsvWikilinkCandidates,
  buildMindMapWikilinkCandidates,
  buildWikilinkCandidates,
  isCsvWikilinkTarget,
  resolveWikilinkTarget,
} from "@/lib/wikilink"
import type { CsvFileSummary, Fragment, MindMapSummary } from "@/types"

import styles from "./capture-box.module.css"

export interface CaptureBoxHandle {
  collapse: () => void
}

interface CaptureBoxProps {
  secondarySubmit?: boolean
  csvFiles?: CsvFileSummary[]
  fragments: Fragment[]
  isCreating: boolean
  knownTags: string[]
  mindMaps?: MindMapSummary[]
  /** 返回创建后的碎片，`/文档` 提交后据此直接进禅模式（产品框架 §2）。 */
  onCreate: (content: string, tags: string[]) => Promise<Fragment | void>
  onNavigateToFragment?: (fragmentId: string) => void
  onOpenMindMap?: (map: MindMapSummary) => void
  /** 用创建好的碎片打开禅模式；两套编辑器共用这一条路径。 */
  onOpenFragmentZen?: (fragment: Fragment) => void
  onOpenZen?: (content: string) => void
}

interface PendingImage {
  alt: string
  bytes: number[]
  fileName: string
  id: string
  previewUrl: string
}

export const CaptureBox = forwardRef<CaptureBoxHandle, CaptureBoxProps>(function CaptureBox({
  secondarySubmit = false,
  csvFiles = [],
  fragments,
  isCreating,
  knownTags,
  mindMaps = [],
  onCreate,
  onNavigateToFragment,
  onOpenMindMap,
  onOpenFragmentZen,
  onOpenZen,
}, ref) {
  const [content, setContent] = useState("")
  /**
   * 大纲态的正文：非 null 即整个速记框切成幕布式大纲（产品框架 §2）。
   * 普通草稿留在 `content` 里原样不动，退出大纲态时按 value 恢复；
   * 两者互不转换，这样「进大纲、想想又退出来」的结果永远可预期。
   */
  const [outlineCode, setOutlineCode] = useState<string | null>(null)
  /** `/文档` 打下的类型标记：提交时写入文档 type 标签。 */
  const [isDocumentType, setIsDocumentType] = useState(false)
  const [isEditorExpanded, setIsEditorExpanded] = useState(false)
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const editorFrameRef = useRef<HTMLDivElement>(null)
  const codeMirrorViewportRef = useRef<HTMLDivElement>(null)
  const codeMirrorContentHeightRef = useRef(0)
  const richEditorRef = useRef<ShardRichEditorHandle>(null)
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
  const mindMapsRef = useRef(mindMaps)
  const openMindMapRef = useRef(onOpenMindMap)
  wikilinkCandidatesRef.current = wikilinkCandidates
  wikilinkNavigateRef.current = onNavigateToFragment
  mindMapsRef.current = mindMaps
  openMindMapRef.current = onOpenMindMap
  /**
   * 富文本编辑器点击双链芯片：目标解析与分派规则——
   * 碎片 / 笔记走时间线与资料库导航，导图打开导图，CSV 交给系统，待建只提示。
   */
  const navigateWikilink = useCallback((target: string) => {
    const candidate = resolveWikilinkTarget(target, wikilinkCandidatesRef.current)
    if (candidate?.kind === "mindmap" && candidate.path) {
      const map = mindMapsRef.current.find((item) => item.path === candidate.path)
      if (map) openMindMapRef.current?.(map)
      return
    }

    const csvPath =
      candidate?.kind === "csv"
        ? candidate.path
        : isCsvWikilinkTarget(target)
          ? target
          : undefined
    if (csvPath) {
      void openCsvFile(csvPath).catch((error) => {
        notify.failure("CSV 文件打开失败", error)
      })
      return
    }

    if (candidate?.fragmentId) {
      wikilinkNavigateRef.current?.(candidate.fragmentId)
      return
    }

    notify.info(`「${target}」还没有文档`, { description: "可在资料库新建同名文档。" })
  }, [])
  const isOutlineMode = outlineCode !== null
  const outlineFile = useMemo(
    () => (outlineCode === null ? null : parseMindMapOutline(outlineCode).file),
    [outlineCode]
  )
  /** 根节点为空的大纲没有中心主题，不允许提交。 */
  const hasOutlineRoot = Boolean(
    outlineFile && (outlineFile.nodes[outlineFile.rootId]?.text ?? "").trim()
  )
  const canSubmit = isOutlineMode
    ? hasOutlineRoot && !isCreating
    : (content.trim().length > 0 || pendingImages.length > 0) && !isCreating

  function getCurrentEditorValue() {
    return richEditorRef.current?.getMarkdown() ?? content
  }

  function focusActiveEditor() {
    richEditorRef.current?.focus()
  }

  function clearActiveEditor() {
    richEditorRef.current?.setMarkdown("")
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

  // Natural timeline scrolling only changes the composer, never the workbench.
  useImperativeHandle(ref, () => ({
    collapse() {
      if (isEditorExpanded) setIsEditorExpanded(false)
    },
  }), [isEditorExpanded])

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

  /**
   * 进入大纲态。已有草稿原样留在 `content` 里（编辑器随之卸载），
   * 退出时按 value 恢复；大纲内容与草稿之间不做任何转换。
   */
  function enterOutlineMode() {
    if (outlineCode !== null) return

    setContent(getCurrentEditorValue())
    setOutlineCode(EMPTY_MIND_MAP_OUTLINE_SOURCE)
    setIsEditorExpanded(true)
  }

  function exitOutlineMode() {
    if (outlineCode === null) return

    setOutlineCode(null)
    setIsEditorExpanded(true)
  }

  function markDocumentType() {
    setIsDocumentType(true)
    setIsEditorExpanded(true)
  }

  /**
   * 大纲提交：正文就是纯缩进列表，不加围栏（技术方案 §3「大纲文件」）。
   * 标签沿用普通提交的规则，再补上受保护的大纲 type 标签。
   */
  async function submitOutline() {
    if (isCreating) return
    if (!outlineFile || !hasOutlineRoot) {
      notify.warning("大纲还没有中心主题", { description: "先写下根节点，再保存。" })
      return
    }

    const draft = serializeMindMapOutline(outlineFile)
    const tags = applyTypeTag(
      normalizeTagList(["inbox", ...extractTags(draft)]),
      OUTLINE_TYPE_TAG
    )

    try {
      await onCreate(draft, tags)
      // 回到普通速记：进入大纲前的草稿原样还在 content 里。
      setOutlineCode(null)
      setIsEditorExpanded(false)
    } catch {
      // 创建失败时保持大纲态，用户刚写的树不能丢。
      setIsEditorExpanded(true)
    }
  }

  async function submit() {
    if (isCreating) return
    if (isOutlineMode) {
      await submitOutline()
      return
    }

    // 提交以编辑器当前值为准，不用 React state：富文本要在提交前把手打的
    // `#标签` / `[[双链]]` 收敛成节点（getMarkdown 负责），收敛产生的 onChange
    // 要等下一次渲染才回到 content 上，直接用 content 会漏掉这一步。
    const draft = getCurrentEditorValue()
    const draftTags = normalizeTagList(["inbox", ...extractTags(draft)])
    if (wantsLockbox(draft, draftTags) && pendingImages.length > 0) {
      notify.error("密匣暂不支持图片", { description: "请先移除图片，再保存到密匣。" })
      setIsEditorExpanded(true)
      return
    }

    try {
      const savedImages = []
      for (const image of pendingImages) {
        const path = await saveFragmentImage(image.fileName, image.bytes).catch(
          (error) => {
            notify.failure("图片保存失败", error)
            throw error
          }
        )
        savedImages.push({ alt: image.alt, path })
      }
      const next = buildContentWithPendingImages(draft, savedImages)
      if (!next) return

      const nextTags = normalizeTagList(["inbox", ...extractTags(next)])
      const wasDocumentType = isDocumentType
      const created = await onCreate(
        next,
        wasDocumentType ? applyTypeTag(nextTags, DOCUMENT_TYPE_TAG) : nextTags
      )
      pendingImages.forEach((image) => {
        URL.revokeObjectURL(image.previewUrl)
      })
      setContent("")
      setIsDocumentType(false)
      setPendingImages([])
      setIsEditorExpanded(false)
      requestAnimationFrame(() => {
        clearActiveEditor()
      })
      // `/文档` 提交后直接进禅模式接着写（产品框架 §2「`/文档` 直接进入禅模式新建」）。
      if (wasDocumentType && created) onOpenFragmentZen?.(created)
    } catch {
      setIsEditorExpanded(true)
      requestAnimationFrame(() => {
        focusActiveEditor()
      })
    }
  }

  const { isDropTarget: isTableDropTarget } = useTableDocumentDrop({
    frameRef: editorFrameRef,
  })

  function openZenEditor() {
    if (!onOpenZen) return

    if (pendingImages.length > 0) {
      notify.error("带图片的草稿不能进禅模式", { description: "请先保存片段，或移除图片。" })
      return
    }

    const draftContent = getCurrentEditorValue()
    onOpenZen(draftContent)
    setContent("")
    setIsEditorExpanded(false)
    requestAnimationFrame(() => {
      clearActiveEditor()
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
      notify.failure("图片上传失败", error)
      URL.revokeObjectURL(previewUrl)
    }
  }

  async function uploadPastedImages(files: File[]) {
    for (const file of files) {
      await uploadImage(file)
    }
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

  const submitButton = (
    <ToolbarIconButton
      className="shard-edge-action"
      disabled={!canSubmit}
      label={isCreating ? "保存中" : "保存片段"}
      onClick={() => void submit()}
      type="button"
      variant={secondarySubmit ? "default" : "primary"}
    >
      {isCreating ? (
        <Loader2Icon className={styles.spin} />
      ) : (
        <SendHorizontalIcon />
      )}
    </ToolbarIconButton>
  )

  return (
    <div
      className={`shard-content-measure ${styles.composer}`}
      ref={containerRef}
    >
      {isOutlineMode ? (
        <OutlineComposer
          code={outlineCode ?? ""}
          onChange={setOutlineCode}
          onExit={exitOutlineMode}
          onSubmit={() => void submit()}
        />
      ) : (
      <div ref={editorFrameRef} style={{ position: "relative" }}>
        <div
          className={styles.codeMirrorViewport}
          data-expanded={isEditorExpanded ? "true" : undefined}
          onMouseDown={(event) => {
            // Scrolling can collapse an editor that still owns focus. Clicking
            // its text must reopen it even when no new focus event is emitted.
            setIsEditorExpanded(true)
            if (event.target === event.currentTarget) {
              focusActiveEditor()
            }
          }}
          ref={codeMirrorViewportRef}
        >
          <ShardRichEditor
            ariaLabel="快速记录"
            autoFocus
            editorId="composer"
            getKnownTags={() => knownTagsRef.current}
            getWikilinkCandidates={() => wikilinkCandidatesRef.current}
            onChange={(nextContent) => {
              setIsEditorExpanded(true)
              setContent(nextContent)
            }}
            onDropFiles={(files) => void uploadPastedImages(files)}
            onFocus={handleEditorFocus}
            onHeightChange={handleCodeMirrorHeightChange}
            onEnterOutline={enterOutlineMode}
            onImageFiles={(files) => void uploadPastedImages(files)}
            onMarkDocument={markDocumentType}
            onNavigateWikilink={navigateWikilink}
            onPasteFiles={(files) => void uploadPastedImages(files)}
            onSubmit={() => void submit()}
            onToggleZen={onOpenZen && !isCreating ? openZenEditor : undefined}
            placeholder="想到什么，写什么..."
            ref={richEditorRef}
            value={content}
            variant="composer"
          />
        </div>
        {isTableDropTarget ? (
          <div className="shard-editor-drop-hint">
            请在资料库中导入为多维表格
          </div>
        ) : null}
      </div>
      )}
      {!isOutlineMode && pendingImages.length > 0 ? (
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
          {isOutlineMode ? (
            // 大纲态没有行内格式可用：工具条换成类型徽标 + 退出入口 + 提交。
            <div
              style={{
                display: "flex",
                minWidth: 0,
                alignItems: "center",
                justifyContent: "space-between",
                gap: "var(--shard-space-3)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  minWidth: 0,
                  alignItems: "center",
                  gap: "var(--shard-space-2)",
                }}
              >
                <span
                  className="shard-tag shard-tag-muted"
                  data-capture-type-badge="outline"
                  style={{ flexShrink: 0, fontWeight: 500 }}
                >
                  <GitBranchIcon />
                  {CONTENT_KIND_LABELS.outline}
                </span>
                <Button
                  disabled={isCreating}
                  onClick={exitOutlineMode}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  退出大纲
                </Button>
              </div>
              {submitButton}
            </div>
          ) : (
          <EditorToolbar
            disabled={isCreating}
            onOpenZen={onOpenZen ? openZenEditor : undefined}
            trailing={
              <>
                {isDocumentType ? (
                  <button
                    aria-label="取消文档类型"
                    className="shard-tag shard-tag-muted"
                    data-capture-type-badge="document"
                    onClick={() => setIsDocumentType(false)}
                    style={{ flexShrink: 0, fontWeight: 500 }}
                    type="button"
                  >
                    <FileTextIcon />
                    {CONTENT_KIND_LABELS.document}
                  </button>
                ) : null}
                {willSaveToLockbox ? (
                  <span
                    className="shard-tag shard-tag-lockbox"
                    style={{ flexShrink: 0, fontWeight: 500 }}
                  >
                    <LockKeyholeIcon />
                    将保存到密匣
                  </span>
                ) : null}
                {submitButton}
              </>
            }
          />
          )}
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
          <Loader2Icon className={`${styles.spin} size-(--shard-icon-size-sm)`} />
          <span>保存中</span>
        </div>
      ) : null}
    </div>
  )
})

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
  const content = viewport.querySelector<HTMLElement>(".ProseMirror")
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
