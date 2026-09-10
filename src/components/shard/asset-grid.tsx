import { Fragment, type KeyboardEvent, type ReactElement, type ReactNode, useEffect, useRef, useState } from "react"
import {
  ArrowLeftIcon,
  FolderOpenIcon,
  ImageIcon,
} from "@/components/icons"
import { toast } from "sonner"

import { LibraryFileIcon } from "@/components/shard/library-file-icon"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { getApiErrorMessage, revealFragmentImageInDir } from "@/lib/api"
import { formatBytes, formatModifiedAt } from "@/lib/file-metadata"
import { libraryEntryName, libraryEntryTypeLabel } from "@/lib/library-entry"
import { loadFragmentImageSrc } from "@/lib/fragment-images"
import {
  loadLibraryPreview,
  type LibraryPreview,
} from "@/lib/library-preview"
import {
  parseMarkdownPreview,
  type MarkdownPreviewBlock,
} from "@/lib/markdown-preview"
import type { LibraryAssetEntry } from "@/types"

import styles from "./asset-grid.module.css"

interface AssetGridProps {
  assets: LibraryAssetEntry[]
  onSelectAsset: (path: string) => void
}

export interface LibraryGridItem {
  content?: string
  kind: "csv" | "directory" | "file" | "image" | "markdown" | "mindmap" | "table" | "canvas" | "flowchart"
  mindMapId?: string
  modifiedAt: string
  name: string
  path: string
  secondary?: string
  size: number
}

interface LibraryItemGridProps {
  bottomInset?: number
  ariaLabel: string
  busy?: boolean
  emptyMessage: string
  items: LibraryGridItem[]
  onSelectItem: (item: LibraryGridItem) => void
  isItemOpenable?: (item: LibraryGridItem) => boolean
  renderItemActions?: (item: LibraryGridItem) => ReactNode
  renderItemContainer?: (item: LibraryGridItem, element: ReactElement) => ReactNode
  renderItemRename?: (item: LibraryGridItem) => ReactNode
  selection?: {
    active: boolean
    paths: ReadonlySet<string>
    onToggle: (item: LibraryGridItem, modifiers?: LibrarySelectionModifiers) => void
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  }
}

export interface LibrarySelectionModifiers {
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
}

interface AssetViewerProps {
  asset: LibraryAssetEntry
  onBack: () => void
}

// 走 loadFragmentImageSrc 而非 resolveFragmentImageSrc 的自定义协议：
// `shard-attachment` 从未在 Tauri 端 register_uri_scheme_protocol 注册，
// 它只是 resolve_vault_asset_path 认的内部引用格式。convertFileSrc 拼出的
// 地址指向不存在的协议，真机上缩略图会全部裂图（曾在第十一批真机验证时踩到）。
// loadFragmentImageSrc 内部有 imageSrcCache，同一路径不会重复走 IPC。
function AssetThumbnail({
  alt,
  className,
  path,
}: {
  alt: string
  className: string
  path: string
}) {
  const [src, setSrc] = useState("")

  useEffect(() => {
    let cancelled = false
    void loadFragmentImageSrc(path)
      .then((next) => {
        if (!cancelled) setSrc(next)
      })
      .catch(() => {
        if (!cancelled) setSrc("")
      })

    return () => {
      cancelled = true
    }
  }, [path])

  if (!src) return null

  return <img alt={alt} className={className} loading="lazy" src={src} />
}

function assetLabel(path: string) {
  const fileName = path.split("/").pop() ?? path
  const extension = fileName.match(/\.([a-z0-9]+)$/iu)?.[1]?.toUpperCase()

  return extension ?? "图片"
}

function LibraryItemFallback({ kind }: Pick<LibraryGridItem, "kind">) {
  return (
    <span className={styles.fileIcon} data-kind={kind}>
      <LibraryFileIcon kind={kind} />
    </span>
  )
}

function CanvasThumbnail({ preview }: { preview: LibraryPreview }) {
  if (preview.kind !== "canvas" || preview.nodes.length === 0) return null
  const nodes = new Map(preview.nodes.map(node => [node.id, node]))
  const left = Math.min(...preview.nodes.map(node => node.x)) - 20
  const top = Math.min(...preview.nodes.map(node => node.y)) - 20
  const width = Math.max(...preview.nodes.map(node => node.x + node.width)) - left + 20
  const height = Math.max(...preview.nodes.map(node => node.y + node.height)) - top + 20
  return <svg aria-hidden="true" className={styles.mindMapPreview} data-library-preview="canvas" viewBox={`${left} ${top} ${width} ${height}`}>
    <g className={styles.mindMapEdges}>{preview.edges.map((edge, index) => {
      const source = nodes.get(edge.source), target = nodes.get(edge.target)
      return source && target ? <line key={index} x1={source.x + source.width / 2} y1={source.y + source.height / 2} x2={target.x + target.width / 2} y2={target.y + target.height / 2} /> : null
    })}</g>
    <g className={styles.mindMapNodes}>{preview.nodes.map(node => <rect key={node.id} x={node.x} y={node.y} width={node.width} height={node.height} />)}</g>
  </svg>
}

function MindMapThumbnail({ preview }: { preview: LibraryPreview }) {
  if (preview.kind !== "mindmap" || preview.layout.nodes.length === 0) {
    return null
  }

  const { bounds, edges, nodes } = preview.layout

  return (
    <svg
      aria-hidden="true"
      className={styles.mindMapPreview}
      data-library-preview="mindmap"
      preserveAspectRatio="xMidYMid meet"
      viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
    >
      <g className={styles.mindMapEdges}>
        {edges.map((edge) => (
          <line
            key={edge.id}
            x1={edge.x1}
            x2={edge.x2}
            y1={edge.y1}
            y2={edge.y2}
          />
        ))}
      </g>
      <g className={styles.mindMapNodes}>
        {nodes.map((node) => (
          <rect
            height={node.height}
            key={node.id}
            width={node.width}
            x={node.x}
            y={node.y}
          />
        ))}
      </g>
    </svg>
  )
}

function TableThumbnail({ preview }: { preview: LibraryPreview }) {
  if (
    preview.kind !== "table" ||
    !preview.rows.some((row) => row.some((cell) => cell.trim().length > 0))
  ) {
    return null
  }

  return (
    <table
      aria-hidden="true"
      className={styles.tablePreview}
      data-library-preview="table"
    >
      <tbody>
        {preview.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function AsyncLibraryItemThumbnail({ item }: { item: LibraryGridItem }) {
  const targetRef = useRef<HTMLSpanElement>(null)
  const [preview, setPreview] = useState<LibraryPreview | null>(null)

  useEffect(() => {
    const target = targetRef.current
    let cancelled = false

    setPreview(null)
    if (!target || typeof IntersectionObserver === "undefined") return

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      void loadLibraryPreview(item).then((next) => {
        if (!cancelled) setPreview(next)
      })
    })
    observer.observe(target)

    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [item.kind, item.mindMapId, item.modifiedAt, item.path])

  const renderedPreview = preview
    ? (item.kind === "canvas" || item.kind === "flowchart")
      ? <CanvasThumbnail preview={preview} />
      : item.kind === "mindmap"
      ? <MindMapThumbnail preview={preview} />
      : <TableThumbnail preview={preview} />
    : null

  return (
    <span className={styles.asyncPreview} ref={targetRef}>
      {renderedPreview ?? <LibraryItemFallback kind={item.kind} />}
    </span>
  )
}

function PreviewBlockLine({ block }: { block: MarkdownPreviewBlock }) {
  if (block.kind === "divider") {
    return <span className={styles.previewDivider} />
  }

  if (block.kind === "table") {
    return (
      <span className={styles.previewGlyphLine}>
        <span className={styles.previewTableGlyph} />
      </span>
    )
  }

  if (block.kind === "code") {
    return (
      <span className={styles.previewCode}>{block.label || "code"}</span>
    )
  }

  if (block.kind === "image") {
    return (
      <span className={styles.previewGlyphLine}>
        <ImageIcon className="size-(--shard-icon-size-xs)" />
        {block.alt ? <span>{block.alt}</span> : null}
      </span>
    )
  }

  if (block.kind === "heading") {
    return (
      <span
        className={styles.previewHeading}
        data-level={block.level > 2 ? 3 : block.level}
      >
        {block.text}
      </span>
    )
  }

  if (block.kind === "task") {
    return (
      <span className={styles.previewTask} data-checked={block.checked}>
        <span className={styles.previewCheckbox} />
        <span>{block.text}</span>
      </span>
    )
  }

  if (block.kind === "bullet") {
    return (
      <span className={styles.previewBullet}>
        <span className={styles.previewDot} />
        <span>{block.text}</span>
      </span>
    )
  }

  if (block.kind === "quote") {
    return <span className={styles.previewQuote}>{block.text}</span>
  }

  return <span className={styles.previewText}>{block.text}</span>
}

function LibraryItemThumbnail({ item }: { item: LibraryGridItem }) {
  if (item.kind === "image") {
    return (
      <AssetThumbnail alt="" className={styles.image} path={item.path} />
    )
  }

  if (item.kind === "markdown") {
    const blocks = parseMarkdownPreview(item.content ?? "", 7)
    if (blocks.length > 0) {
      return (
        <span className={styles.textPreview} data-library-preview="text">
          {blocks.map((block, index) => (
            <PreviewBlockLine block={block} key={index} />
          ))}
        </span>
      )
    }
  }

  if (item.kind === "mindmap" || item.kind === "csv" || (item.kind === "canvas" || item.kind === "flowchart")) {
    return <AsyncLibraryItemThumbnail item={item} />
  }

  return <LibraryItemFallback kind={item.kind} />
}

export function LibraryItemGrid({
  ariaLabel,
  bottomInset,
  busy = false,
  emptyMessage,
  items,
  isItemOpenable = () => true,
  onSelectItem,
  renderItemActions,
  renderItemContainer,
  renderItemRename,
  selection,
}: LibraryItemGridProps) {
  if (items.length === 0) {
    return (
      <div aria-busy={busy} className={styles.empty} onKeyDown={selection?.onKeyDown} tabIndex={selection ? 0 : undefined}>
        <p className={styles.emptyText}>{emptyMessage}</p>
      </div>
    )
  }

  return (
    <ul
      aria-busy={busy}
      aria-label={ariaLabel}
      className={styles.grid}
      style={bottomInset === undefined ? undefined : {
        paddingBottom: `calc(var(--shard-space-4) + ${bottomInset}px)`,
        scrollPaddingBottom: bottomInset,
        scrollbarGutter: "stable",
      }}
      data-selection-active={selection?.active || undefined}
      onKeyDown={selection?.onKeyDown}
      tabIndex={selection ? 0 : undefined}
    >
      {items.map((item) => {
        const formattedDate = formatModifiedAt(item.modifiedAt)
        const secondary =
          item.secondary ??
          [formatBytes(item.size), formattedDate].filter(Boolean).join(" · ")
        const renameInput = renderItemRename?.(item)
        const selected = selection?.paths.has(item.path) ?? false
        const openable = isItemOpenable(item)
        const typeLabel = libraryEntryTypeLabel(item.kind)
        const body = (
          <>
            <span className={styles.thumbnail} data-slot="library-card-preview">
              <LibraryItemThumbnail item={item} />
            </span>
            <span className={styles.meta}>
              <span className={styles.metaPrimary}>
                {renameInput ?? (
                  <span className={styles.fileName} data-slot="library-card-name" title={item.name}>
                    {libraryEntryName(item)}
                  </span>
                )}
              </span>
              {secondary ? <span className={styles.metaSecondary}>{secondary}</span> : null}
            </span>
          </>
        )

        const card = (
          <li className={styles.cardItem} data-path={item.path} data-selected={selected || undefined} key={item.path}>
            <div className={styles.cardHeader} data-slot="library-card-header">
              {selection ? (
                <span className={styles.cardSelection} onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    aria-label={`选择 ${item.name}`}
                    checked={selected}
                    disabled={busy || Boolean(renameInput)}
                    onCheckedChange={(_, { event }) => {
                      if (busy || renameInput) return
                      selection.onToggle(item, {
                        shiftKey: "shiftKey" in event && event.shiftKey === true,
                        metaKey: "metaKey" in event && event.metaKey === true,
                        ctrlKey: "ctrlKey" in event && event.ctrlKey === true,
                      })
                    }}
                  />
                </span>
              ) : null}
              <span className={styles.cardType} data-slot="library-card-type" title={typeLabel}>
                <LibraryFileIcon kind={item.kind} />
                <span>{typeLabel}</span>
              </span>
              {renderItemActions ? (
                <span className={styles.cardActions} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                  {renameInput ? null : renderItemActions(item)}
                </span>
              ) : null}
            </div>
            {renameInput ? (
              <div className={styles.cardBody} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                {body}
              </div>
            ) : openable || selection ? (
              <button
                aria-label={`${selection?.active || !openable ? "选择" : "打开"}${item.kind === "directory" ? "目录" : "文件"} ${item.name}`}
                aria-pressed={selection?.active ? selected : undefined}
                className={styles.cardBody}
                disabled={busy}
                onClick={(event) => {
                  if (busy) return
                  if (selection && (selection.active || event.shiftKey || event.metaKey || event.ctrlKey || !openable)) {
                    event.preventDefault()
                    selection.onToggle(item, event)
                  } else if (openable) {
                    onSelectItem(item)
                  }
                }}
                type="button"
              >
                {body}
              </button>
            ) : (
              <div className={styles.cardBody}>{body}</div>
            )}
          </li>
        )

        return <Fragment key={item.path}>{renderItemContainer ? renderItemContainer(item, card) : card}</Fragment>
      })}
    </ul>
  )
}

export function AssetGrid({ assets, onSelectAsset }: AssetGridProps) {
  return (
    <LibraryItemGrid
      ariaLabel="图片列表"
      emptyMessage="还没有图片附件"
      items={assets.map((asset) => ({
        kind: "image",
        modifiedAt: asset.modifiedAt,
        name: assetLabel(asset.path),
        path: asset.path,
        size: asset.size,
      }))}
      onSelectItem={(item) => onSelectAsset(item.path)}
    />
  )
}

export function AssetViewer({ asset, onBack }: AssetViewerProps) {
  async function revealInDir() {
    try {
      await revealFragmentImageInDir(asset.path)
    } catch (error) {
      toast.error(`打开所在目录失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    }
  }

  return (
    <div className={styles.viewer}>
      <div className={styles.viewerToolbar}>
        <Button
          aria-label="返回图片列表"
          onClick={onBack}
          size="sm"
          variant="ghost"
        >
          <ArrowLeftIcon aria-hidden="true" />
          返回图片列表
        </Button>
        <Button
          aria-label="在访达中显示"
          onClick={() => void revealInDir()}
          size="sm"
          variant="ghost"
        >
          <FolderOpenIcon aria-hidden="true" />
          在访达中显示
        </Button>
      </div>

      <div className={styles.viewerStage}>
        <AssetThumbnail
          alt={assetLabel(asset.path)}
          className={styles.viewerImage}
          path={asset.path}
        />
      </div>

      <dl className={styles.viewerMeta}>
        <div className={styles.viewerMetaRow}>
          <dt className={styles.viewerMetaKey}>路径</dt>
          <dd className={styles.viewerMetaValue}>{asset.path}</dd>
        </div>
        <div className={styles.viewerMetaRow}>
          <dt className={styles.viewerMetaKey}>大小</dt>
          <dd className={styles.viewerMetaValue}>
            {formatBytes(asset.size)}
          </dd>
        </div>
        <div className={styles.viewerMetaRow}>
          <dt className={styles.viewerMetaKey}>修改时间</dt>
          <dd className={styles.viewerMetaValue}>
            {formatModifiedAt(asset.modifiedAt) || "未知"}
          </dd>
        </div>
      </dl>
    </div>
  )
}
