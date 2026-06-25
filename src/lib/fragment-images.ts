import { isTauri } from "@tauri-apps/api/core"
import { save } from "@tauri-apps/plugin-dialog"

import { readFragmentImage, saveExportedImage } from "@/lib/api"

const ABSOLUTE_WINDOWS_PATH_PATTERN = /^[a-z]:[\\/]/i
const URL_LIKE_PATTERN = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i
const imageSrcCache = new Map<string, string>()

export function resolveFragmentImageSrc(path: string, vaultPath?: string) {
  const normalizedPath = path.trim()
  if (!normalizedPath) return ""
  if (URL_LIKE_PATTERN.test(normalizedPath)) return normalizedPath

  return resolveFragmentImagePath(normalizedPath, vaultPath)
}

export async function loadFragmentImageSrc(path: string, vaultPath?: string) {
  const normalizedPath = path.trim()
  if (!normalizedPath) return ""
  if (URL_LIKE_PATTERN.test(normalizedPath)) return normalizedPath

  if (!isTauri()) {
    return resolveFragmentImageSrc(normalizedPath, vaultPath)
  }

  const cachedSrc = imageSrcCache.get(normalizedPath)
  if (cachedSrc) return cachedSrc

  const loadedSrc = await readFragmentImage(normalizedPath)
  imageSrcCache.set(normalizedPath, loadedSrc)
  return loadedSrc
}

export async function downloadFragmentImageAttachment(
  path: string,
  alt: string,
  vaultPath?: string
) {
  const source = await loadFragmentImageSrc(path, vaultPath)
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
