import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { useEffect, useState } from "react"

import { Trash2Icon } from "@/components/icons"
import { FragmentImageAttachment } from "@/components/shard/fragment-content"
import { Button } from "@/components/ui/button"
import { loadFragmentImageSrc } from "@/lib/fragment-images"

import { useNodeViewEditable } from "./node-view-utils"

type ImageLoadState = "loading" | "ready" | "failed"

/**
 * `![alt](path)` 的编辑态：缩略预览 + alt 文本 + 删除。
 *
 * 预览、原图对话框与右键菜单全部复用卡片渲染那一份 `FragmentImageAttachment`；
 * 这里只多做一件事——自己先把路径解析成可显示的地址，好在解析失败时显示占位
 * 与原始路径（组件内部的失败态只有一个无说明的占位方块）。
 *
 * 速记框的「待上传图片」仍走 `pendingImages` 预览区，提交时由
 * `buildContentWithPendingImages` 追加到正文尾；这个节点只服务正文里已经存在
 * 的图片引用。
 */
export function ImageNodeView({ deleteNode, editor, node, selected }: ReactNodeViewProps) {
  const editable = useNodeViewEditable(editor)
  const path = String(node.attrs.src ?? "")
  const alt = node.attrs.alt ? String(node.attrs.alt) : ""
  const [state, setState] = useState<ImageLoadState>("loading")
  const [src, setSrc] = useState("")

  useEffect(() => {
    let cancelled = false
    setState("loading")
    setSrc("")

    loadFragmentImageSrc(path)
      .then((loaded) => {
        if (cancelled) return
        setSrc(loaded)
        setState(loaded ? "ready" : "failed")
      })
      .catch(() => {
        if (!cancelled) setState("failed")
      })

    return () => {
      cancelled = true
    }
  }, [path])

  return (
    <NodeViewWrapper
      as="span"
      className="shard-rich-image"
      contentEditable={false}
      data-selected={selected ? "true" : undefined}
      data-shard-rich-inline="image"
    >
      {state === "ready" ? (
        <FragmentImageAttachment
          alt={alt}
          path={path}
          previewable
          src={src}
          wrapped={false}
        />
      ) : (
        <span aria-hidden="true" className="shard-image-attachment-placeholder" />
      )}
      <span className="shard-rich-image-meta">
        <span className="shard-rich-image-alt">{alt || "图片"}</span>
        {state === "failed" ? (
          <span className="shard-rich-image-path">图片载入失败：{path}</span>
        ) : null}
      </span>
      {editable ? (
        <Button
          aria-label="删除图片"
          className="shard-rich-image-action"
          onClick={() => deleteNode()}
          size="icon-sm"
          variant="ghost"
        >
          <Trash2Icon />
          <span className="sr-only">删除</span>
        </Button>
      ) : null}
    </NodeViewWrapper>
  )
}
