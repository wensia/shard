import { type ReactNode, useEffect, useRef, useState } from "react"
import {
  ArrowLeftIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  ImageIcon,
} from "@/components/icons"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { getApiErrorMessage, revealFragmentImageInDir } from "@/lib/api"
import { formatBytes, formatModifiedAt } from "@/lib/file-metadata"
import { loadFragmentImageSrc } from "@/lib/fragment-images"
import {
  extractTextPreview,
  loadLibraryPreview,
  type LibraryPreview,
} from "@/lib/library-preview"
import type { LibraryAssetEntry } from "@/types"

import styles from "./asset-grid.module.css"

interface AssetGridProps {
  assets: LibraryAssetEntry[]
  onSelectAsset: (path: string) => void
}

export interface LibraryGridItem {
  content?: string
  kind: "csv" | "directory" | "image" | "markdown" | "mindmap"
  mindMapId?: string
  modifiedAt: string
  name: string
  path: string
  secondary?: string
  size: number
}

interface LibraryItemGridProps {
  ariaLabel: string
  emptyMessage: string
  items: LibraryGridItem[]
  onSelectItem: (item: LibraryGridItem) => void
  renderItemActions?: (item: LibraryGridItem) => ReactNode
  renderItemRename?: (item: LibraryGridItem) => ReactNode
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

function LibraryItemIcon({ kind }: Pick<LibraryGridItem, "kind">) {
  if (kind === "directory") return <FolderIcon aria-hidden="true" />
  if (kind === "csv") return <FileSpreadsheetIcon aria-hidden="true" />
  if (kind === "mindmap") return <GitBranchIcon aria-hidden="true" />
  if (kind === "image") return <ImageIcon aria-hidden="true" />
  return <FileTextIcon aria-hidden="true" />
}

function LibraryItemFallback({ kind }: Pick<LibraryGridItem, "kind">) {
  return (
    <span className={styles.fileIcon} data-kind={kind}>
      <LibraryItemIcon kind={kind} />
    </span>
  )
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
    ? item.kind === "mindmap"
      ? <MindMapThumbnail preview={preview} />
      : <TableThumbnail preview={preview} />
    : null

  return (
    <span className={styles.asyncPreview} ref={targetRef}>
      {renderedPreview ?? <LibraryItemFallback kind={item.kind} />}
    </span>
  )
}

function LibraryItemThumbnail({ item }: { item: LibraryGridItem }) {
  if (item.kind === "image") {
    return (
      <AssetThumbnail alt="" className={styles.image} path={item.path} />
    )
  }

  if (item.kind === "markdown") {
    const lines = extractTextPreview(item.content ?? "")
    if (lines.length > 0) {
      return (
        <span
          className={styles.textPreview}
          data-library-preview="text"
        >
          {lines.map((line, index) => (
            <span className={styles.textPreviewLine} key={index}>
              {line}
            </span>
          ))}
        </span>
      )
    }
  }

  if (item.kind === "mindmap" || item.kind === "csv") {
    return <AsyncLibraryItemThumbnail item={item} />
  }

  return <LibraryItemFallback kind={item.kind} />
}

export function LibraryItemGrid({
  ariaLabel,
  emptyMessage,
  items,
  onSelectItem,
  renderItemActions,
  renderItemRename,
}: LibraryItemGridProps) {
  if (items.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyText}>{emptyMessage}</p>
      </div>
    )
  }

  return (
    <ul aria-label={ariaLabel} className={styles.grid}>
      {items.map((item) => {
        const formattedDate = formatModifiedAt(item.modifiedAt)
        const secondary =
          item.secondary ??
          [formatBytes(item.size), formattedDate].filter(Boolean).join(" · ")
        const renameInput = renderItemRename?.(item)

        return (
          <li className={styles.cardItem} key={item.path}>
            {renameInput ? (
              <div className={styles.card}>
                <span className={styles.thumbnail}>
                  <LibraryItemThumbnail item={item} />
                </span>
                <span className={styles.meta}>
                  {renameInput}
                  {secondary ? (
                    <span className={styles.metaSecondary}>{secondary}</span>
                  ) : null}
                </span>
              </div>
            ) : (
              <button
                aria-label={`打开${item.kind === "directory" ? "目录" : "文件"} ${item.name}`}
                className={styles.card}
                onClick={() => onSelectItem(item)}
                type="button"
              >
                <span className={styles.thumbnail}>
                  <LibraryItemThumbnail item={item} />
                </span>
                <span className={styles.meta}>
                  <span className={styles.metaPrimary}>{item.name}</span>
                  {secondary ? (
                    <span className={styles.metaSecondary}>{secondary}</span>
                  ) : null}
                </span>
              </button>
            )}
            {renderItemActions && !renameInput ? (
              <span className={styles.cardActions}>
                {renderItemActions(item)}
              </span>
            ) : null}
          </li>
        )
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
