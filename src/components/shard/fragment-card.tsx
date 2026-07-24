import {
  ArchiveIcon,
  LockKeyholeIcon,
  MoreHorizontalIcon,
  PencilLineIcon,
  PinIcon,
  PinOffIcon,
  Share2Icon,
} from "lucide-react"

import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu"

import { FragmentEditor } from "@/components/shard/fragment-editor"
import { FragmentBody } from "@/components/shard/fragment-body"
import { ShardZenIcon } from "@/components/shard/shard-zen-icon"
import { TagBadge } from "@/components/shard/tag-badge"
import { cn } from "@/lib/utils"
import type { Fragment } from "@/types"

interface FragmentCardProps {
  fragment: Fragment
  isHighlighted?: boolean
  isEditing?: boolean
  knownTags?: string[]
  onArchive?: (fragment: Fragment) => void
  onCancelEdit?: () => void
  onEdit?: (fragment: Fragment) => void
  onExportImage?: (fragment: Fragment) => void
  onMoveToLockbox?: (fragment: Fragment) => void
  onOpenZen?: (fragment: Fragment) => void
  onPin?: (fragment: Fragment) => void
  onSave?: (id: string, content: string, tags: string[]) => Promise<Fragment>
  onToggleTask?: (fragment: Fragment, lineIndex: number) => void
  vaultPath?: string
}

export function FragmentCard({
  fragment,
  isHighlighted = false,
  isEditing = false,
  knownTags = [],
  onArchive,
  onCancelEdit,
  onEdit,
  onExportImage,
  onMoveToLockbox,
  onOpenZen,
  onPin,
  onSave,
  onToggleTask,
  vaultPath,
}: FragmentCardProps) {
  const createdTime = formatCreatedTime(fragment.createdAt)
  const displayContent = fragment.content.trimEnd()
  const displayTags = fragment.tags.filter((tag) => tag !== "inbox")

  if (isEditing && onSave) {
    return (
      <div
        className={cn(isHighlighted && "shard-fragment-card-highlight")}
        data-shard-fragment-id={fragment.id}
      >
        <FragmentEditor
          commitOnBlur
          fragment={fragment}
          knownTags={knownTags}
          onClose={() => onCancelEdit?.()}
          onSave={onSave}
          variant="inline"
          vaultPath={vaultPath}
        />
      </div>
    )
  }

  return (
    <article
      className={cn(
        "group flex flex-col rounded-[var(--shard-surface-radius)] bg-card px-[var(--shard-card-padding-x)] pt-[var(--shard-card-padding-y)] pb-[var(--shard-card-padding-bottom)]",
        isHighlighted && "shard-fragment-card-highlight"
      )}
      data-shard-fragment-id={fragment.id}
    >
      <div className="flex items-start gap-[var(--shard-card-gap)]">
        <div className="min-w-0 flex-1">
          <time
            className="shard-memo-meta mb-[var(--shard-space-2)] block text-muted-foreground"
            dateTime={fragment.createdAt}
          >
            {createdTime}
          </time>
          {fragment.pinned || fragment.lockbox || displayTags.length > 0 ? (
            <div className="shard-card-tags mb-[var(--shard-space-3)] flex flex-wrap gap-[var(--shard-space-2)]">
              {fragment.pinned ? (
                <span className="shard-tag shard-tag-muted border-0 py-0 font-medium shadow-none">
                  <PinIcon className="size-3.5 stroke-[1.75]" />
                  置顶
                </span>
              ) : null}
              {fragment.lockbox ? (
                <span className="shard-tag shard-tag-lockbox border-0 py-0 font-medium shadow-none">
                  <LockKeyholeIcon className="size-3.5 stroke-[1.75]" />
                  密匣
                </span>
              ) : null}
              {displayTags.map((tag) => (
                <TagBadge key={tag} tag={tag} />
              ))}
            </div>
          ) : null}
          <FragmentBody
            content={displayContent}
            contentClassName="shard-fragment-card-content"
            downloadableImages
            hideTags
            onTaskToggle={(lineIndex) => onToggleTask?.(fragment, lineIndex)}
            renderImages
            vaultPath={vaultPath}
          />
        </div>

        <div className="flex shrink-0 items-center">
          <DropdownMenu
            button={{
              icon: <MoreHorizontalIcon />,
              isIconOnly: true,
              label: "片段操作",
              size: "sm",
              variant: "ghost",
            }}
          >
            <DropdownMenuItem
              icon={PencilLineIcon}
              label="编辑"
              onClick={() => onEdit?.(fragment)}
            />
            {onOpenZen ? (
              <DropdownMenuItem
                icon={<ShardZenIcon />}
                label="禅模式"
                onClick={() => onOpenZen(fragment)}
              />
            ) : null}
            {onPin ? (
              <DropdownMenuItem
                icon={fragment.pinned ? PinOffIcon : PinIcon}
                isDisabled={fragment.archived}
                label={fragment.pinned ? "取消置顶" : "置顶"}
                onClick={() => onPin(fragment)}
              />
            ) : null}
            <DropdownMenuItem
              icon={Share2Icon}
              label="分享"
              onClick={() => onExportImage?.(fragment)}
            />
            {!fragment.lockbox ? (
              <DropdownMenuItem
                icon={LockKeyholeIcon}
                isDisabled={fragment.archived}
                label="移入密匣"
                onClick={() => onMoveToLockbox?.(fragment)}
              />
            ) : null}
            <DropdownMenuItem
              icon={ArchiveIcon}
              isDisabled={fragment.archived}
              label={fragment.archived ? "已归档" : "归档"}
              onClick={() => onArchive?.(fragment)}
            />
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
