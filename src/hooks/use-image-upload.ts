import { useCallback, useRef } from "react"

import {
  extractTags,
  getMarkdownImageAlt,
  normalizeTagList,
} from "@/lib/editor-format"
import { saveFragmentImage, saveImageAttachmentFromPath } from "@/lib/api"
import { wantsLockbox } from "@/lib/lockbox"
import { notify } from "@/lib/notify"

export interface UploadedImage {
  alt: string
  fileName: string
  path: string
  previewUrl: string
}

interface UseImageUploadOptions {
  canUpload?: () => boolean
  getContent: () => string
  isLockbox?: boolean
  /** uploadImage/uploadPastedImages 存好后回调；只用 saveImage 原位插图的宿主不传。 */
  onUploaded?: (image: UploadedImage) => void
}

export function useImageUpload({
  canUpload,
  getContent,
  isLockbox = false,
  onUploaded,
}: UseImageUploadOptions) {
  const canUploadRef = useRef(canUpload)
  const getContentRef = useRef(getContent)
  const isLockboxRef = useRef(isLockbox)
  const onUploadedRef = useRef(onUploaded)

  canUploadRef.current = canUpload
  getContentRef.current = getContent
  isLockboxRef.current = isLockbox
  onUploadedRef.current = onUploaded

  const uploadImage = useCallback(async (file: File) => {
    if (canUploadRef.current && !canUploadRef.current()) return

    const content = getContentRef.current()
    const tags = normalizeTagList(["inbox", ...extractTags(content)])
    if (isLockboxRef.current || wantsLockbox(content, tags)) {
      notify.error("密匣暂不支持图片", {
        description: "请先移除 #密匣，或在公开笔记中上传图片。",
      })
      return
    }

    const previewUrl = URL.createObjectURL(file)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const path = await saveFragmentImage(file.name, bytes)
      onUploadedRef.current?.({
        alt: getMarkdownImageAlt(file.name),
        fileName: file.name,
        path,
        previewUrl,
      })
    } catch (error) {
      URL.revokeObjectURL(previewUrl)
      notify.failure("图片上传失败", error)
    }
  }, [])

  /**
   * 原位插图用：存好返回 vault 相对路径与 alt，被拒（密匣）或失败时提示并返回 null。
   * 由编辑器自己在光标或落点插入，不经 onUploaded。
   */
  const saveImage = useCallback(
    async (source: File | string): Promise<{ alt: string; path: string } | null> => {
      if (canUploadRef.current && !canUploadRef.current()) return null
      const content = getContentRef.current()
      const tags = normalizeTagList(["inbox", ...extractTags(content)])
      if (isLockboxRef.current || wantsLockbox(content, tags)) {
        notify.error("密匣暂不支持图片", {
          description: "请先移除 #密匣，或在公开笔记中上传图片。",
        })
        return null
      }
      const fileName = typeof source === "string" ? source.split(/[\\/]/u).pop() ?? "" : source.name
      try {
        const path = typeof source === "string"
          ? await saveImageAttachmentFromPath(source)
          : await saveFragmentImage(source.name, new Uint8Array(await source.arrayBuffer()))
        return { alt: getMarkdownImageAlt(fileName), path }
      } catch (error) {
        notify.failure("图片上传失败", error)
        return null
      }
    },
    []
  )

  const uploadPastedImages = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        await uploadImage(file)
      }
    },
    [uploadImage]
  )

  return { saveImage, uploadImage, uploadPastedImages }
}
