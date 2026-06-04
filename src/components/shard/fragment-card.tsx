import {
  ArchiveIcon,
  MoreHorizontalIcon,
  PencilLineIcon,
} from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { TagBadge } from "@/components/shard/tag-badge"
import type { Fragment } from "@/types"

interface FragmentCardProps {
  fragment: Fragment
}

export function FragmentCard({ fragment }: FragmentCardProps) {
  const createdTime = formatCreatedTime(fragment.createdAt)

  return (
    <article
      className="group flex min-h-40 flex-col rounded-[var(--shard-surface-radius)] border border-border bg-card px-5 py-4 transition-colors hover:border-[color:var(--shard-border-strong)]"
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <time
            className="mb-2 block text-xs font-medium text-muted-foreground"
            dateTime={fragment.createdAt}
          >
            {createdTime}
          </time>
          <p className="line-clamp-4 text-[15px] leading-6 font-medium whitespace-pre-wrap">
            {fragment.content}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" />}>
              <MoreHorizontalIcon
                className="size-4 stroke-[1.65]"
                data-icon="inline-start"
              />
              <span className="sr-only">片段操作</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-fit min-w-0 rounded-md p-1 shadow-[0_8px_20px_rgba(0,0,0,0.08)] ring-black/10"
            >
              <DropdownMenuGroup>
                <DropdownMenuItem className="grid h-8 grid-cols-[14px_max-content] gap-2 px-2 text-[13px] font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:stroke-[1.65]">
                  <PencilLineIcon />
                  编辑片段
                </DropdownMenuItem>
                <DropdownMenuItem className="grid h-8 grid-cols-[14px_max-content] gap-2 px-2 text-[13px] font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:stroke-[1.65]">
                  <ArchiveIcon />
                  归档片段
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        {fragment.tags.map((tag) => (
          <TagBadge key={tag} tag={tag} />
        ))}
      </div>
    </article>
  )
}

function formatCreatedTime(createdAt: string) {
  return new Date(createdAt).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}
