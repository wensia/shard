import { useEffect, useState } from "react"
import {
  ArrowLeftIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  ImageIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { getApiErrorMessage, revealFragmentImageInDir } from "@/lib/api"
import { formatBytes, formatModifiedAt } from "@/lib/file-metadata"
import { loadFragmentImageSrc } from "@/lib/fragment-images"
import type { LibraryAssetEntry } from "@/types"

import styles from "./asset-grid.module.css"

interface AssetGridProps {
  assets: LibraryAssetEntry[]
  onSelectAsset: (path: string) => void
}

export interface LibraryGridItem {
  kind: "csv" | "directory" | "image" | "markdown" | "mindmap"
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

export function LibraryItemGrid({
  ariaLabel,
  emptyMessage,
  items,
  onSelectItem,
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

        return (
          <li className={styles.cardItem} key={item.path}>
            <button
              aria-label={`打开${item.kind === "directory" ? "目录" : "文件"} ${item.name}`}
              className={styles.card}
              onClick={() => onSelectItem(item)}
              type="button"
            >
              <span className={styles.thumbnail}>
                {item.kind === "image" ? (
                  <AssetThumbnail
                    alt=""
                    className={styles.image}
                    path={item.path}
                  />
                ) : (
                  <span className={styles.fileIcon} data-kind={item.kind}>
                    <LibraryItemIcon kind={item.kind} />
                  </span>
                )}
              </span>
              <span className={styles.meta}>
                <span className={styles.metaPrimary}>{item.name}</span>
                {secondary ? (
                  <span className={styles.metaSecondary}>{secondary}</span>
                ) : null}
              </span>
            </button>
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
