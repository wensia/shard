import {
  ArchiveRestoreIcon,
  CopyIcon,
  FileTextIcon,
  GitBranchIcon,
  PaperclipIcon,
  LinkIcon,
  ListTodoIcon,
  LockKeyholeIcon,
  MoreHorizontalIcon,
  PencilLineIcon,
  PinIcon,
  PinOffIcon,
  Share2Icon,
  ShardZenIcon,
  Trash2Icon,
} from "@/components/icons"
import { useState, type ReactNode } from "react"
import { toast } from "sonner"

import { FragmentEditor } from "@/components/shard/fragment-editor"
import { FragmentBody } from "@/components/shard/fragment-body"
import { FragmentLinkDialog } from "@/components/shard/fragment-link-dialog"
import { FragmentRelated } from "@/components/shard/fragment-related"
import { TagBadge } from "@/components/shard/tag-badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getApiErrorMessage } from "@/lib/api"
import { isTypeTag } from "@/lib/content-kind"
import type { RelatedFragment } from "@/lib/relations"
import { cn } from "@/lib/utils"
import type { CsvFileSummary, Fragment } from "@/types"

interface FragmentCardProps {
  csvFiles?: CsvFileSummary[]
  fragment: Fragment
  relationIndexVersion?: number
  fragments?: Fragment[]
  isHighlighted?: boolean
  isEditing?: boolean
  isSelectable?: boolean
  isSelected?: boolean
  isSelectionMode?: boolean
  knownTags?: string[]
  onArchive?: (fragment: Fragment) => void
  onCancelEdit?: () => void
  onRegisterEditorFlush?: (flush: (() => Promise<boolean>) | null) => void
  onEdit?: (fragment: Fragment) => void
  onExportImage?: (fragment: Fragment) => void
  onMoveToLockbox?: (fragment: Fragment) => void
  onLinkFragment?: (
    sourceId: string,
    targetId: string
  ) => Promise<void> | void
  onNavigateToFragment?: (fragmentId: string) => void
  onOpenZen?: (fragment: Fragment) => void
  onPin?: (fragment: Fragment) => void
  onSave?: (id: string, content: string, tags: string[]) => Promise<Fragment>
  onSelectChange?: (fragmentId: string, selected: boolean) => void
  onStartSelection?: (fragment: Fragment) => Promise<void> | void
  onToggleKind?: (fragment: Fragment) => void
  onToggleTask?: (fragment: Fragment, lineIndex: number) => void
  onUnlinkFragment?: (
    sourceId: string,
    targetId: string
  ) => Promise<void> | void
  requestRelated?: (
    targetId: string,
    limit?: number
  ) => Promise<RelatedFragment[]>
  /**
   * card：卡片底色，靠与页面 --background 的色差呈现（捕捉页、密匣）。
   * flat：透明底，用于本身就是 --card 底色的容器（资料库中列），
   *       条目分割由列容器的细实线承担。
   */
  variant?: "card" | "flat"
  vaultPath?: string
}

export function FragmentCard({
  csvFiles = [],
  fragment,
  relationIndexVersion = 0,
  fragments = [],
  isHighlighted = false,
  isEditing = false,
  isSelectable = true,
  isSelected = false,
  isSelectionMode = false,
  knownTags = [],
  onArchive,
  onCancelEdit,
  onRegisterEditorFlush,
  onEdit,
  onExportImage,
  onLinkFragment,
  onMoveToLockbox,
  onOpenZen,
  onPin,
  onNavigateToFragment,
  onSave,
  onSelectChange,
  onStartSelection,
  onToggleKind,
  onToggleTask,
  onUnlinkFragment,
  requestRelated,
  variant = "card",
  vaultPath,
}: FragmentCardProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isLinkDialogOpen, setIsLinkDialogOpen] = useState(false)
  const [isRelatedOpen, setIsRelatedOpen] = useState(false)
  const createdTime = formatCreatedTime(fragment.createdAt)
  const displayContent = fragment.content.trimEnd()
  const displayTags = fragment.tags.filter(
    (tag) => tag !== "inbox" && !isTypeTag(tag)
  )

  function openNextSurface(action: () => void) {
    setIsMenuOpen(false)
    window.setTimeout(action, 0)
  }

  async function copyFragmentContent() {
    try {
      const clipboard = navigator.clipboard
      if (!clipboard) {
        throw new Error("当前环境不支持复制到剪贴板")
      }

      await clipboard.writeText(fragment.content)
      toast("已复制片段内容")
    } catch (error) {
      toast.error(`复制片段失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    }
  }

  if (isEditing && onSave) {
    return (
      <div
        className={cn(isHighlighted && "shard-fragment-card-highlight")}
        data-shard-fragment-id={fragment.id}
      >
        <FragmentEditor
          commitOnBlur
          csvFiles={csvFiles}
          fragment={fragment}
          fragments={fragments}
          knownTags={knownTags}
          onClose={() => onCancelEdit?.()}
          onRegisterFlush={onRegisterEditorFlush}
          onNavigateToFragment={onNavigateToFragment}
          onSave={onSave}
          variant="inline"
          vaultPath={vaultPath}
        />
      </div>
    )
  }

  return (
    <article
      aria-selected={isSelectionMode ? isSelected : undefined}
      className={cn(isHighlighted && "shard-fragment-card-highlight")}
      data-shard-fragment-id={fragment.id}
      style={{
        display: "flex",
        flexDirection: "column",
        borderRadius: "var(--shard-surface-radius)",
        background: isSelected
          ? "var(--primary-subtle)"
          : variant === "flat"
            ? "transparent"
            : "var(--card)",
        boxShadow: isSelected ? "var(--ring-focus)" : undefined,
        paddingInline: "var(--shard-card-padding-x)",
        paddingTop: "var(--shard-card-padding-y)",
        paddingBottom: "var(--shard-card-padding-bottom)",
      }}
    >
      <div className="flex items-start gap-4">
        {isSelectionMode ? (
          <Checkbox
            aria-label={
              isSelectable
                ? `选择片段：${displayContent.slice(0, 40) || "空片段"}`
                : "笔记不参与碎片整理"
            }
            checked={isSelected}
            className="mt-0.5"
            disabled={!isSelectable}
            onCheckedChange={(checked) =>
              onSelectChange?.(fragment.id, checked === true)
            }
          />
        ) : null}
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
          fragment.kind === "note" ||
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
                  <PinIcon />
                  置顶
                </span>
              ) : null}
              {fragment.lockbox ? (
                <span
                  className="shard-tag shard-tag-lockbox"
                  style={{ fontWeight: 500 }}
                >
                  <LockKeyholeIcon />
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
                  <GitBranchIcon />
                  冲突副本
                </span>
              ) : null}
              {fragment.kind === "note" ? (
                <span
                  className="shard-tag shard-tag-muted"
                  style={{ fontWeight: 500 }}
                >
                  <FileTextIcon />
                  笔记
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

        {!isSelectionMode ? (
          <div
            style={{ display: "flex", flexShrink: 0, alignItems: "center" }}
          >
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
              {onToggleKind ? (
                <CardMenuItem
                  icon={<FileTextIcon aria-hidden="true" />}
                  label={fragment.kind === "note" ? "转回碎片" : "转为文档…"}
                  onSelect={() => onToggleKind(fragment)}
                />
              ) : null}
              <CardMenuItem
                icon={<CopyIcon aria-hidden="true" />}
                label="复制"
                onSelect={() => void copyFragmentContent()}
              />
              {isSelectable && onStartSelection ? (
                <CardMenuItem
                  icon={<ListTodoIcon aria-hidden="true" />}
                  label="多选"
                  onSelect={() =>
                    openNextSurface(() => void onStartSelection(fragment))
                  }
                />
              ) : null}
              {requestRelated ? (
                <CardMenuItem
                  icon={<LinkIcon aria-hidden="true" />}
                  label="相关片段"
                  onSelect={() =>
                    openNextSurface(() => setIsRelatedOpen(true))
                  }
                />
              ) : null}
              {onLinkFragment ? (
                <CardMenuItem
                  icon={<PaperclipIcon aria-hidden="true" />}
                  label="关联到片段…"
                  onSelect={() =>
                    openNextSurface(() => setIsLinkDialogOpen(true))
                  }
                />
              ) : null}
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
                    <Trash2Icon aria-hidden="true" />
                  )
                }
                label={fragment.archived ? "恢复" : "删除"}
                onSelect={() => onArchive?.(fragment)}
              />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </div>

      <FragmentRelated
        fragment={fragment}
        indexVersion={relationIndexVersion}
        isOpen={isRelatedOpen}
        onNavigate={onNavigateToFragment}
        onToggle={() => setIsRelatedOpen((open) => !open)}
        onUnlinkFragment={onUnlinkFragment}
        requestRelated={requestRelated}
      />
      {onLinkFragment ? (
        <FragmentLinkDialog
          fragments={fragments}
          isOpen={isLinkDialogOpen}
          onConfirm={(targetId) => onLinkFragment(fragment.id, targetId)}
          onOpenChange={setIsLinkDialogOpen}
          source={fragment}
        />
      ) : null}
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
      <span className="[&>svg]:size-(--shard-icon-size-sm)">{icon}</span>
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
