import { isTauri } from "@tauri-apps/api/core"

import { readFragmentImage } from "@/lib/api"

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
