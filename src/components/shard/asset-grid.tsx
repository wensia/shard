import { ArrowLeftIcon, FolderOpenIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { getApiErrorMessage, revealFragmentImageInDir } from "@/lib/api"
import {
  ATTACHMENT_SCHEME,
  resolveFragmentImageSrc,
} from "@/lib/fragment-images"
import type { LibraryAssetEntry } from "@/types"

import styles from "./asset-grid.module.css"

interface AssetGridProps {
  assets: LibraryAssetEntry[]
  onSelectAsset: (path: string) => void
}

interface AssetViewerProps {
  asset: LibraryAssetEntry
  onBack: () => void
}

// 内容寻址决定了文件名去掉扩展名就是 64 位 hash（save_fragment_image 写的是
// `{hash}.{extension}`），转成附件引用格式才能走 convertFileSrc 自定义协议——
// 直接把 assets/ 相对路径交给 loadFragmentImageSrc 会退回 base64-over-IPC。
function assetImageSrc(path: string) {
  const hash = path.split("/").pop()?.replace(/\.[^.]+$/u, "") ?? ""
  if (!hash) return ""

  return resolveFragmentImageSrc(`${ATTACHMENT_SCHEME}${hash}`)
}

function formatAssetSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`

  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function formatAssetDate(modifiedAt: string) {
  if (!modifiedAt) return ""

  const date = new Date(modifiedAt)
  if (Number.isNaN(date.getTime())) return ""

  return date.toLocaleDateString("zh-CN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })
}

function assetLabel(path: string) {
  const fileName = path.split("/").pop() ?? path
  const extension = fileName.match(/\.([a-z0-9]+)$/iu)?.[1]?.toUpperCase()

  return extension ?? "图片"
}

export function AssetGrid({ assets, onSelectAsset }: AssetGridProps) {
  if (assets.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyText}>还没有图片附件</p>
      </div>
    )
  }

  return (
    <ul aria-label="图片列表" className={styles.grid}>
      {assets.map((asset) => (
        <li className={styles.cardItem} key={asset.path}>
          <button
            aria-label={`打开图片 ${assetLabel(asset.path)} ${formatAssetSize(asset.size)}`}
            className={styles.card}
            onClick={() => onSelectAsset(asset.path)}
            type="button"
          >
            <span className={styles.thumbnail}>
              <img
                alt=""
                className={styles.image}
                loading="lazy"
                src={assetImageSrc(asset.path)}
              />
            </span>
            <span className={styles.meta}>
              <span className={styles.metaPrimary}>
                {assetLabel(asset.path)}
              </span>
              <span className={styles.metaSecondary}>
                {formatAssetSize(asset.size)}
                {formatAssetDate(asset.modifiedAt)
                  ? ` · ${formatAssetDate(asset.modifiedAt)}`
                  : ""}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
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
        <img
          alt={assetLabel(asset.path)}
          className={styles.viewerImage}
          src={assetImageSrc(asset.path)}
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
            {formatAssetSize(asset.size)}
          </dd>
        </div>
        <div className={styles.viewerMetaRow}>
          <dt className={styles.viewerMetaKey}>修改时间</dt>
          <dd className={styles.viewerMetaValue}>
            {formatAssetDate(asset.modifiedAt) || "未知"}
          </dd>
        </div>
      </dl>
    </div>
  )
}
