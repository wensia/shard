import { toast } from "sonner"

import { NoticeBody } from "@/components/ui/notice"
import { getApiErrorMessage } from "@/lib/api"

/**
 * 应用内唯一的消息通知入口。业务代码不直接调用 sonner。
 *
 * 文案约定（kiln Toast / Feedback）：
 * - title：对象 + 结果，用用户的话说，不带句号，不拼底层错误原文。
 * - description：可选的一句话，说后果、保留了什么或下一步；能从标题看懂就不写。
 * - detail：技术细节（错误原文、路径），折叠在「详情」里，可复制，给排查用。
 * - action：最多一个，只放真正能完成下一步的动作（重试、查看、撤销）；
 *   cancel 只用于需要用户表态的提示（如「不用了」），以文字链接呈现。
 *
 * 同一类型、同一标题默认合并为一条（刷新而不是堆叠）；需要更新同一条进度时显式传 id。
 */

export interface NotifyAction {
  label: string
  onClick: () => void
}

export interface NotifyOptions {
  id?: string | number
  description?: string
  detail?: string
  action?: NotifyAction
  /** 放弃/拒绝类的次要动作（如「不用了」），渲染为文字链接；只和 action 成对出现 */
  cancel?: NotifyAction
  /** 覆盖默认时长：true 为常驻，数字为毫秒 */
  persistent?: boolean | number
}

type NoticeKind = "success" | "info" | "warning" | "error" | "loading"

const DEFAULT_DURATION: Record<NoticeKind, number> = {
  success: 4000,
  info: 4000,
  warning: 8000,
  error: Number.POSITIVE_INFINITY,
  loading: Number.POSITIVE_INFINITY,
}

function show(kind: NoticeKind, title: string, options: NotifyOptions = {}, detailExpanded = false) {
  const { id = `${kind}:${title}`, description, detail, action, cancel, persistent } = options
  const duration =
    persistent === true
      ? Number.POSITIVE_INFINITY
      : typeof persistent === "number"
        ? persistent
        : DEFAULT_DURATION[kind]
  const body =
    description || detail || action || cancel ? (
      <NoticeBody
        action={action}
        cancel={cancel}
        description={description}
        detail={detail}
        detailExpanded={detailExpanded}
        noticeId={id}
        // sonner 只在 description 变化时重新测量高度；展开详情必须用同一 id 重新下发，
        // 否则堆叠位置不更新，详情会钻到下一条通知底下。
        onToggleDetail={() => show(kind, title, { ...options, id }, !detailExpanded)}
      />
    ) : undefined

  return toast[kind](title, { id, description: body, duration })
}

export const notify = {
  success: (title: string, options?: NotifyOptions) => show("success", title, options),
  info: (title: string, options?: NotifyOptions) => show("info", title, options),
  warning: (title: string, options?: NotifyOptions) => show("warning", title, options),
  error: (title: string, options?: NotifyOptions) => show("error", title, options),
  /** 失败且有底层错误：错误原文进「详情」，标题只说哪里失败 */
  failure: (title: string, error: unknown, options?: Omit<NotifyOptions, "detail">) =>
    show("error", title, { ...options, detail: getApiErrorMessage(error) }),
  /** 进行中：常驻，直到用同一个 id 调用 success / error 等替换它 */
  progress: (title: string, options: NotifyOptions & { id: string | number }) =>
    show("loading", title, options),
  dismiss: (id?: string | number) => toast.dismiss(id),
}
