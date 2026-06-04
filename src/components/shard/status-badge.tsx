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
      "border-[color:var(--shard-emerald)]/30 bg-[color:var(--shard-emerald)]/10 text-[color:var(--shard-emerald)]",
    icon: CheckCircle2Icon,
  },
  sync_pending: {
    label: "sync pending",
    className:
      "border-[color:var(--shard-amber)]/40 bg-[color:var(--shard-amber)]/10 text-[color:var(--shard-amber)]",
    icon: Clock3Icon,
  },
  commit_failed: {
    label: "commit failed",
    className:
      "border-[color:var(--shard-ruby)]/35 bg-[color:var(--shard-ruby)]/10 text-[color:var(--shard-ruby)]",
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
