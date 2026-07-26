import { convertFileSrc, isTauri } from "@tauri-apps/api/core"
import { save } from "@tauri-apps/plugin-dialog"

import { saveExportedImage } from "@/lib/api"

const ABSOLUTE_WINDOWS_PATH_PATTERN = /^[a-z]:[\\/]/i
const URL_LIKE_PATTERN = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i
export const ATTACHMENT_SCHEME = "shard-attachment:"
const ATTACHMENT_HASH_PATTERN = /^[a-f\d]{64}$/i

// 正文里的引用 → webview 能直接取的地址。
//
// 内容寻址的附件走自定义协议由 webview 自己取，不再经 base64-over-IPC——
// 那条路要为每张图付 33% 的编码膨胀，并把整张图常驻在 JS 堆里。
export function resolveFragmentImageSrc(path: string, vaultPath?: string) {
  const normalizedPath = path.trim()
  if (!normalizedPath) return ""

  const hash = attachmentHash(normalizedPath)
  if (hash) {
    return isTauri() ? convertFileSrc(hash, "shard-attachment") : ""
  }

  if (URL_LIKE_PATTERN.test(normalizedPath)) return normalizedPath

  return resolveFragmentImagePath(normalizedPath, vaultPath)
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
  vaultPath?: string
) {
  const source = resolveFragmentImageSrc(path, vaultPath)
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
        : [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
      title: "下载图片附件",
    })

    if (!targetPath) return false

    await saveExportedImage(targetPath, await blobToBytes(blob))
    return true
  }

  downloadBlob(blob, fileName)
  return true
}

function resolveFragmentImagePath(path: string, vaultPath?: string) {
  if (isAbsolutePath(path) || !vaultPath) {
    return path
  }

  const base = vaultPath.replace(/[\\/]+$/u, "")
  const relative = path.replace(/^\.?[\\/]+/u, "")
  return `${base}/${relative}`
}

function isAbsolutePath(path: string) {
  return path.startsWith("/") || ABSOLUTE_WINDOWS_PATH_PATTERN.test(path)
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
    case "image/gif":
      return "gif"
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
  return ["gif", "jpg", "jpeg", "png", "svg", "webp"].includes(extension)
}
