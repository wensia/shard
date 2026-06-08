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
import { FragmentContent } from "@/components/shard/fragment-content"
import { TagBadge } from "@/components/shard/tag-badge"
import type { Fragment } from "@/types"

interface FragmentCardProps {
  fragment: Fragment
  onArchive?: (fragment: Fragment) => void
  onEdit?: (fragment: Fragment) => void
  onToggleTask?: (fragment: Fragment, lineIndex: number) => void
  vaultPath?: string
}

export function FragmentCard({
  fragment,
  onArchive,
  onEdit,
  onToggleTask,
  vaultPath,
}: FragmentCardProps) {
  const createdTime = formatCreatedTime(fragment.createdAt)
  const displayContent = fragment.content.trimEnd()
  const visibleTags = fragment.tags.filter((tag) => tag !== "inbox")
  const displayTags = visibleTags.length > 0 ? visibleTags : fragment.tags

  return (
    <article
      className="group flex flex-col rounded-[var(--shard-surface-radius)] bg-card px-[var(--shard-card-padding-x)] pt-[var(--shard-card-padding-y)] pb-[var(--shard-card-padding-bottom)]"
    >
      <div className="flex items-start gap-[var(--shard-card-gap)]">
        <div className="min-w-0 flex-1">
          <time
            className="shard-memo-meta mb-[var(--shard-space-2)] block text-muted-foreground"
            dateTime={fragment.createdAt}
          >
            {createdTime}
          </time>
          {displayTags.length > 0 ? (
            <div className="shard-card-tags mb-[var(--shard-space-3)] flex flex-wrap gap-[var(--shard-space-2)]">
              {displayTags.map((tag) => (
                <TagBadge key={tag} tag={tag} />
              ))}
            </div>
          ) : null}
          <p className="shard-memo-body whitespace-pre-wrap">
            <FragmentContent
              content={displayContent}
              onTaskToggle={(lineIndex) => onToggleTask?.(fragment, lineIndex)}
              renderImages
              vaultPath={vaultPath}
            />
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-[var(--shard-space-2)]">
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
              className="w-fit min-w-0 rounded-[var(--shard-radius-control)] p-[var(--shard-space-1)] shadow-[0_8px_20px_rgb(0_0_0/var(--shard-alpha-8))] ring-[rgb(0_0_0/var(--shard-alpha-13))]"
            >
              <DropdownMenuGroup>
                <DropdownMenuItem
                  className="grid h-8 grid-cols-[14px_max-content] gap-[var(--shard-space-2)] px-[var(--shard-space-2)] text-[13px] font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:stroke-[1.65]"
                  onClick={() => onEdit?.(fragment)}
                >
                  <PencilLineIcon />
                  编辑
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="grid h-8 grid-cols-[14px_max-content] gap-[var(--shard-space-2)] px-[var(--shard-space-2)] text-[13px] font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:stroke-[1.65]"
                  disabled={fragment.archived}
                  onClick={() => onArchive?.(fragment)}
                >
                  <ArchiveIcon />
                  {fragment.archived ? "已归档" : "归档"}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
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
