import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  Clock3Icon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { FragmentStatus } from "@/types"

const statusMeta: Record<
  FragmentStatus,
  {
    label: string
    className: string
    icon: typeof CheckCircle2Icon
  }
> = {
  saved: {
    label: "saved",
    className:
      "border-border bg-muted text-muted-foreground",
    icon: CircleDashedIcon,
  },
  committed: {
    label: "committed",
    className:
      "border-[rgb(var(--shard-emerald-rgb)/var(--shard-alpha-34))] bg-[rgb(var(--shard-emerald-rgb)/var(--shard-alpha-8))] text-[color:var(--shard-emerald)]",
    icon: CheckCircle2Icon,
  },
  sync_pending: {
    label: "sync pending",
    className:
      "border-[rgb(var(--shard-amber-rgb)/var(--shard-alpha-34))] bg-[rgb(var(--shard-amber-rgb)/var(--shard-alpha-8))] text-[color:var(--shard-amber)]",
    icon: Clock3Icon,
  },
  commit_failed: {
    label: "commit failed",
    className:
      "border-[rgb(var(--shard-ruby-rgb)/var(--shard-alpha-34))] bg-[rgb(var(--shard-ruby-rgb)/var(--shard-alpha-8))] text-[color:var(--shard-ruby)]",
    icon: CircleAlertIcon,
  },
}

interface StatusBadgeProps {
  status: FragmentStatus
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const meta = statusMeta[status]
  const Icon = meta.icon

  return (
    <Badge className={meta.className} variant="outline">
      <Icon />
      {meta.label}
    </Badge>
  )
}
