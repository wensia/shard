import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  Clock3Icon,
} from "lucide-react"

import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge"
import type { FragmentStatus } from "@/types"

const statusMeta: Record<
  FragmentStatus,
  {
    label: string
    variant: BadgeVariant
    icon: typeof CheckCircle2Icon
  }
> = {
  saved: {
    label: "saved",
    variant: "neutral",
    icon: CircleDashedIcon,
  },
  committed: {
    label: "committed",
    variant: "success",
    icon: CheckCircle2Icon,
  },
  sync_pending: {
    label: "sync pending",
    variant: "warning",
    icon: Clock3Icon,
  },
  commit_failed: {
    label: "commit failed",
    variant: "error",
    icon: CircleAlertIcon,
  },
}

interface StatusBadgeProps {
  status: FragmentStatus
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const meta = statusMeta[status]
  const Icon = meta.icon

  return <Badge variant={meta.variant} icon={<Icon />} label={meta.label} />
}
