import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  Clock3Icon,
} from "lucide-react"

import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge"
import type { DebtUrgency } from "@/types"

const urgencyMeta: Record<
  Exclude<DebtUrgency, "normal">,
  {
    label: string
    variant: BadgeVariant
    icon: typeof CheckCircle2Icon
  }
> = {
  overdue: {
    label: "逾期",
    variant: "error",
    icon: CircleAlertIcon,
  },
  dueSoon: {
    label: "临近到期",
    variant: "warning",
    icon: Clock3Icon,
  },
  settled: {
    label: "已结清",
    variant: "success",
    icon: CheckCircle2Icon,
  },
  noDueDate: {
    label: "无到期日",
    variant: "neutral",
    icon: CircleDashedIcon,
  },
}

interface DebtStatusBadgeProps {
  urgency: DebtUrgency
}

/**
 * 五态映射：`settled` → success、`overdue` → error、`dueSoon` → warning、
 * `noDueDate` → neutral；`normal`（进行中且未临近到期）不渲染徽标，避免列表
 * 长期"到处是颜色"稀释警示效果。图标复用 status-badge.tsx 同一组。
 */
export function DebtStatusBadge({ urgency }: DebtStatusBadgeProps) {
  if (urgency === "normal") return null

  const meta = urgencyMeta[urgency]
  const Icon = meta.icon

  return <Badge variant={meta.variant} icon={<Icon />} label={meta.label} />
}
