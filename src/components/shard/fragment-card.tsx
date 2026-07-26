import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  GitBranchIcon,
  LockKeyholeIcon,
  MoreHorizontalIcon,
  PencilLineIcon,
  PinIcon,
  PinOffIcon,
  Share2Icon,
} from "lucide-react"

import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu"
import { HStack } from "@astryxdesign/core/HStack"
import { Stack } from "@astryxdesign/core/Stack"

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
    <Stack
      as="article"
      className={cn(isHighlighted && "shard-fragment-card-highlight")}
      data-shard-fragment-id={fragment.id}
      style={{
        borderRadius: "var(--shard-surface-radius)",
        background: "var(--card)",
        paddingInline: "var(--shard-card-padding-x)",
        paddingTop: "var(--shard-card-padding-y)",
        paddingBottom: "var(--shard-card-padding-bottom)",
      }}
    >
      <HStack gap={4} vAlign="start">
        <div style={{ minWidth: 0, flex: "1 1 0%" }}>
          <time
            className="shard-memo-meta"
            dateTime={fragment.createdAt}
            style={{
              display: "block",
              marginBottom: "var(--shard-space-2)",
              color: "var(--muted-foreground)",
            }}
          >
            {createdTime}
          </time>
          {fragment.pinned ||
          fragment.lockbox ||
          fragment.conflictOf ||
          displayTags.length > 0 ? (
            <HStack
              className="shard-card-tags"
              gap={2}
              style={{ marginBottom: "var(--shard-space-3)" }}
              wrap="wrap"
            >
              {fragment.pinned ? (
                <span
                  className="shard-tag shard-tag-muted"
                  style={{ fontWeight: 500 }}
                >
                  <PinIcon strokeWidth={1.75} />
                  置顶
                </span>
              ) : null}
              {fragment.lockbox ? (
                <span
                  className="shard-tag shard-tag-lockbox"
                  style={{ fontWeight: 500 }}
                >
                  <LockKeyholeIcon strokeWidth={1.75} />
                  密匣
                </span>
              ) : null}
              {fragment.conflictOf ? (
                // 同步冲突时本地那一版被另存成了这条。不打标的话，用户只会看到
                // 时间线里莫名多出一条内容相近的笔记，完全不知道发生了什么。
                <span
                  className="shard-tag shard-tag-muted"
                  style={{ fontWeight: 500 }}
                  title={`这是同步冲突时保留的本地版本，原件 ${fragment.conflictOf}`}
                >
                  <GitBranchIcon strokeWidth={1.75} />
                  冲突副本
                </span>
              ) : null}
              {displayTags.map((tag) => (
                <TagBadge key={tag} tag={tag} />
              ))}
            </HStack>
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

        <div style={{ display: "flex", flexShrink: 0, alignItems: "center" }}>
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
              icon={fragment.archived ? ArchiveRestoreIcon : ArchiveIcon}
              label={fragment.archived ? "移回收件箱" : "归档"}
              onClick={() => onArchive?.(fragment)}
            />
          </DropdownMenu>
        </div>
      </HStack>
    </Stack>
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
