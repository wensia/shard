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
import { useState, type ReactNode } from "react"

import { FragmentEditor } from "@/components/shard/fragment-editor"
import { FragmentBody } from "@/components/shard/fragment-body"
import { ShardZenIcon } from "@/components/shard/shard-zen-icon"
import { TagBadge } from "@/components/shard/tag-badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const createdTime = formatCreatedTime(fragment.createdAt)
  const displayContent = fragment.content.trimEnd()
  const displayTags = fragment.tags.filter((tag) => tag !== "inbox")

  function openNextSurface(action: () => void) {
    setIsMenuOpen(false)
    window.setTimeout(action, 0)
  }

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
      className={cn(isHighlighted && "shard-fragment-card-highlight")}
      data-shard-fragment-id={fragment.id}
      style={{
        display: "flex",
        flexDirection: "column",
        borderRadius: "var(--shard-surface-radius)",
        background: "var(--card)",
        paddingInline: "var(--shard-card-padding-x)",
        paddingTop: "var(--shard-card-padding-y)",
        paddingBottom: "var(--shard-card-padding-bottom)",
      }}
    >
      <div className="flex items-start gap-4">
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
            <div
              className="shard-card-tags"
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "var(--shard-space-2)",
                marginBottom: "var(--shard-space-3)",
              }}
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

        <div style={{ display: "flex", flexShrink: 0, alignItems: "center" }}>
          <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label="片段操作"
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <MoreHorizontalIcon aria-hidden="true" />
              <span className="sr-only">片段操作</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-fit min-w-0 p-1"
            >
              <CardMenuItem
                icon={<PencilLineIcon aria-hidden="true" />}
                label="编辑"
                onSelect={() =>
                  openNextSurface(() => onEdit?.(fragment))
                }
              />
              {onOpenZen ? (
                <CardMenuItem
                  icon={<ShardZenIcon aria-hidden="true" />}
                  label="禅模式"
                  onSelect={() =>
                    openNextSurface(() => onOpenZen(fragment))
                  }
                />
              ) : null}
              {onPin ? (
                <CardMenuItem
                  disabled={fragment.archived}
                  icon={
                    fragment.pinned ? (
                      <PinOffIcon aria-hidden="true" />
                    ) : (
                      <PinIcon aria-hidden="true" />
                    )
                  }
                  label={fragment.pinned ? "取消置顶" : "置顶"}
                  onSelect={() => onPin(fragment)}
                />
              ) : null}
              <CardMenuItem
                icon={<Share2Icon aria-hidden="true" />}
                label="分享"
                onSelect={() =>
                  openNextSurface(() => onExportImage?.(fragment))
                }
              />
              {!fragment.lockbox ? (
                <CardMenuItem
                  disabled={fragment.archived}
                  icon={<LockKeyholeIcon aria-hidden="true" />}
                  label="移入密匣"
                  onSelect={() =>
                    openNextSurface(() => onMoveToLockbox?.(fragment))
                  }
                />
              ) : null}
              <CardMenuItem
                icon={
                  fragment.archived ? (
                    <ArchiveRestoreIcon aria-hidden="true" />
                  ) : (
                    <ArchiveIcon aria-hidden="true" />
                  )
                }
                label={fragment.archived ? "移回收件箱" : "归档"}
                onSelect={() => onArchive?.(fragment)}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </article>
  )
}

function CardMenuItem({
  disabled = false,
  icon,
  label,
  onSelect,
}: {
  disabled?: boolean
  icon: ReactNode
  label: string
  onSelect: () => void
}) {
  return (
    <DropdownMenuItem
      className="h-8 gap-2 px-2 text-[13px] font-medium"
      disabled={disabled}
      onClick={onSelect}
      style={{ display: "grid", gridTemplateColumns: "14px max-content" }}
    >
      <span className="[&>svg]:size-3.5 [&>svg]:stroke-[1.65]">{icon}</span>
      <span>{label}</span>
    </DropdownMenuItem>
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
