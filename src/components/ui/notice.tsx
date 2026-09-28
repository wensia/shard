import { useId, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"

import "./notice.css"

interface NoticeBodyProps {
  noticeId: string | number
  description?: string
  detail?: string
  detailExpanded: boolean
  onToggleDetail: () => void
  action?: { label: string; onClick: () => void }
  cancel?: { label: string; onClick: () => void }
}

/** 通知标题下方的内容：一句后果、一个动作、可折叠的技术详情。由 notify 组装，不单独使用。 */
export function NoticeBody({
  noticeId,
  description,
  detail,
  detailExpanded: expanded,
  onToggleDetail,
  action,
  cancel,
}: NoticeBodyProps) {
  const [copied, setCopied] = useState(false)
  const detailId = useId()

  async function copyDetail() {
    if (!detail) return
    try {
      await navigator.clipboard.writeText(detail)
      setCopied(true)
    } catch {
      // 剪贴板不可用时详情仍可手动选中复制。
    }
  }

  return (
    <div className="kiln-notice-body">
      {description ? <p className="kiln-notice-description">{description}</p> : null}
      {action || cancel || detail ? (
        <div className="kiln-notice-actions">
          {action ? (
            <Button
              onClick={() => {
                toast.dismiss(noticeId)
                action.onClick()
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {action.label}
            </Button>
          ) : null}
          {cancel ? (
            <button
              className="kiln-notice-link"
              onClick={() => {
                toast.dismiss(noticeId)
                cancel.onClick()
              }}
              type="button"
            >
              {cancel.label}
            </button>
          ) : null}
          {detail ? (
            <button
              aria-controls={detailId}
              aria-expanded={expanded}
              className="kiln-notice-link"
              onClick={onToggleDetail}
              type="button"
            >
              {expanded ? "收起详情" : "详情"}
            </button>
          ) : null}
        </div>
      ) : null}
      {detail && expanded ? (
        <div className="kiln-notice-detail" id={detailId}>
          <pre>{detail}</pre>
          <button className="kiln-notice-link" onClick={() => void copyDetail()} type="button">
            {copied ? "已复制" : "复制详情"}
          </button>
        </div>
      ) : null}
    </div>
  )
}
