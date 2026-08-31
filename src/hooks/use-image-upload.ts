import { useCallback, useRef } from "react"
import { toast } from "sonner"

import {
  extractTags,
  getMarkdownImageAlt,
  normalizeTagList,
} from "@/lib/editor-format"
import { getApiErrorMessage, saveFragmentImage } from "@/lib/api"
import { wantsLockbox } from "@/lib/lockbox"

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
  onUploaded: (image: UploadedImage) => void
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
      toast.error(
        "密匣暂不支持图片附件：请先移除 #密匣，或在公开笔记中上传图片。",
        { duration: Infinity }
      )
      return
    }

    const previewUrl = URL.createObjectURL(file)
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
      const path = await saveFragmentImage(file.name, bytes)
      onUploadedRef.current({
        alt: getMarkdownImageAlt(file.name),
        fileName: file.name,
        path,
        previewUrl,
      })
    } catch (error) {
      URL.revokeObjectURL(previewUrl)
      toast.error(`图片上传失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    }
  }, [])

  const uploadPastedImages = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        await uploadImage(file)
      }
    },
    [uploadImage]
  )

  return { uploadImage, uploadPastedImages }
}
