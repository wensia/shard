import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  Clock3Icon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { DebtUrgency } from "@/types"

const urgencyMeta: Record<
  Exclude<DebtUrgency, "normal">,
  {
    label: string
    className: string
    icon: typeof CheckCircle2Icon
  }
> = {
  overdue: {
    label: "逾期",
    className:
      "border-[rgb(var(--shard-ruby-rgb)/var(--shard-alpha-34))] bg-[rgb(var(--shard-ruby-rgb)/var(--shard-alpha-8))] text-[color:var(--shard-ruby)]",
    icon: CircleAlertIcon,
  },
  dueSoon: {
    label: "临近到期",
    className:
      "border-[rgb(var(--shard-amber-rgb)/var(--shard-alpha-34))] bg-[rgb(var(--shard-amber-rgb)/var(--shard-alpha-8))] text-[color:var(--shard-amber)]",
    icon: Clock3Icon,
  },
  settled: {
    label: "已结清",
    className:
      "border-[rgb(var(--shard-emerald-rgb)/var(--shard-alpha-34))] bg-[rgb(var(--shard-emerald-rgb)/var(--shard-alpha-8))] text-[color:var(--shard-emerald)]",
    icon: CheckCircle2Icon,
  },
  noDueDate: {
    label: "无到期日",
    className: "border-border bg-muted text-muted-foreground",
    icon: CircleDashedIcon,
  },
}

interface DebtStatusBadgeProps {
  urgency: DebtUrgency
}

/**
 * 五态映射：`settled` → emerald、`overdue` → ruby、`dueSoon` → amber、
 * `noDueDate` → muted；`normal`（进行中且未临近到期）不渲染徽标，避免列表
 * 长期"到处是颜色"稀释警示效果。图标复用 status-badge.tsx 同一组。
 */
export function DebtStatusBadge({ urgency }: DebtStatusBadgeProps) {
  if (urgency === "normal") return null

  const meta = urgencyMeta[urgency]
  const Icon = meta.icon

  return (
    <Badge className={meta.className} variant="outline">
      <Icon />
      {meta.label}
    </Badge>
  )
}
