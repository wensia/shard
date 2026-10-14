import { convertFileSrc, isTauri } from "@tauri-apps/api/core"
import { save } from "@tauri-apps/plugin-dialog"

import { readFragmentImage, saveExportedImage } from "@/lib/api"

const URL_LIKE_PATTERN = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i
export const ATTACHMENT_SCHEME = "shard-attachment:"
const ATTACHMENT_HASH_PATTERN = /^[a-f\d]{64}$/i
/** Rust 端 `vault_asset_protocol` 注册的协议名。 */
export const VAULT_IMAGE_SCHEME = "shard-asset"

/**
 * 正文、表格里的图片引用 → `<img>` 能直接用的地址。
 *
 * vault 内的图片（`assets/…`、`notes/证件/营业执照.jpg`、`shard-attachment:<hash>`）走
 * `shard-asset` 协议由 webview 自己取，不经 base64 IPC、不在 JS 堆里常驻整张图；远程
 * 与 data/blob 地址原样返回。`version` 用于同名替换后让 WebKit 丢掉旧的内存缓存。
 */
export function vaultImageUrl(reference: string, version?: string | number | null) {
  const trimmed = reference.trim()
  if (!trimmed) return ""
  if (!attachmentHash(trimmed) && URL_LIKE_PATTERN.test(trimmed)) return trimmed
  if (!isTauri()) return ""

  const url = convertFileSrc(trimmed, VAULT_IMAGE_SCHEME)
  return version === undefined || version === null || version === ""
    ? url
    : `${url}?v=${encodeURIComponent(String(version))}`
}

/** 兼容旧调用：显示用地址现在可以同步算出。 */
export async function loadFragmentImageSrc(path: string, _vaultPath?: string) {
  return vaultImageUrl(path)
}

/**
 * 要读像素的场景（导出分享图、下载）用 data URL：不依赖跨 scheme 的 CORS 协商，
 * 画布不会被污染。
 */
export async function loadReadableImageSrc(path: string) {
  const trimmed = path.trim()
  if (!trimmed) return ""
  if (!attachmentHash(trimmed) && URL_LIKE_PATTERN.test(trimmed)) return trimmed
  if (!isTauri()) return ""
  return readFragmentImage(trimmed)
}

// 引用指向的附件 hash；不是附件引用时返回 null。
export function attachmentHash(path: string) {
  const trimmed = path.trim()
  if (!trimmed.startsWith(ATTACHMENT_SCHEME)) return null

  const hash = trimmed.slice(ATTACHMENT_SCHEME.length)
  return ATTACHMENT_HASH_PATTERN.test(hash) ? hash : null
}

// 把地址变成可以安全画进 canvas 的来源。
//
// 自定义协议与页面不同源，直接 drawImage 会污染画布让 toBlob 失败。取回字节
// 转成 blob: 就绕开了整个同源问题，也不必依赖 crossOrigin 协商。
export async function toDrawableImageSource(source: string) {
  if (source.startsWith("data:") || source.startsWith("blob:")) return source

  const blob = await imageSourceToBlob(source)
  return URL.createObjectURL(blob)
}

export async function downloadFragmentImageAttachment(
  path: string,
  alt: string,
  _vaultPath?: string
) {
  const source = await loadReadableImageSrc(path)
  if (!source) {
    throw new Error("图片附件无法载入。")
  }

  const blob = await imageSourceToBlob(source)
  const fileName = fragmentImageDownloadFileName(path, alt, blob.type)

  if (isTauri()) {
    const extension = imageExtensionForMimeType(blob.type)
    const targetPath = await save({
      defaultPath: fileName,
      filters: extension
        ? [{ name: extension.toUpperCase(), extensions: [extension] }]
        : [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "avif"] }],
      title: "下载图片附件",
    })

    if (!targetPath) return false

    await saveExportedImage(targetPath, await blobToBytes(blob))
    return true
  }

  downloadBlob(blob, fileName)
  return true
}

async function imageSourceToBlob(source: string) {
  const response = await fetch(source)
  if (!response.ok) {
    throw new Error("图片附件无法下载。")
  }

  return response.blob()
}

async function blobToBytes(blob: Blob) {
  const buffer = await blob.arrayBuffer()
  return Array.from(new Uint8Array(buffer))
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

function fragmentImageDownloadFileName(path: string, alt: string, mimeType: string) {
  const extension = imageExtensionForMimeType(mimeType) ?? imageExtensionFromPath(path)
  const sourceName = alt.trim() || imageBaseNameFromPath(path) || "image"
  const safeName = sanitizeDownloadFileName(sourceName)
  if (!extension || hasImageExtension(safeName)) {
    return safeName
  }

  return `${safeName}.${extension}`
}

function imageBaseNameFromPath(path: string) {
  // 附件引用的"文件名"是一串摘要，拿它当下载名毫无意义。
  if (attachmentHash(path)) return ""

  const normalized = path.trim().split(/[\\/]/u).filter(Boolean).pop() ?? ""
  return normalized.replace(/\.[^.]+$/u, "")
}

function sanitizeDownloadFileName(fileName: string) {
  const normalized = fileName
    .trim()
    .replace(/[\\/:*?"<>|]+/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/^[.\s]+|[.\s]+$/gu, "")

  return normalized || "image"
}

function imageExtensionForMimeType(mimeType: string) {
  switch (mimeType.toLowerCase()) {
    case "image/avif":
      return "avif"
    case "image/gif":
      return "gif"
    case "image/heic":
      return "heic"
    case "image/heif":
      return "heif"
    case "image/jpeg":
      return "jpg"
    case "image/png":
      return "png"
    case "image/svg+xml":
      return "svg"
    case "image/webp":
      return "webp"
    default:
      return null
  }
}

function imageExtensionFromPath(path: string) {
  const extension = path
    .split(/[\\/]/u)
    .filter(Boolean)
    .pop()
    ?.match(/\.([a-z0-9]+)$/iu)?.[1]
    ?.toLowerCase()

  return extension && hasSupportedImageExtension(extension) ? extension : null
}

function hasImageExtension(fileName: string) {
  const extension = fileName.match(/\.([a-z0-9]+)$/iu)?.[1]?.toLowerCase()
  return Boolean(extension && hasSupportedImageExtension(extension))
}

function hasSupportedImageExtension(extension: string) {
  return ["avif", "gif", "heic", "heif", "jpg", "jpeg", "png", "svg", "webp"].includes(extension)
}
