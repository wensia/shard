import {
  ArchiveRestoreIcon,
  CopyIcon,
  FileTextIcon,
  GitBranchIcon,
  LockKeyholeIcon,
  MoreHorizontalIcon,
  PencilLineIcon,
  PinIcon,
  PinOffIcon,
  Share2Icon,
  ShardZenIcon,
  Trash2Icon,
  WorkflowIcon,
  type ShardIcon,
} from "@/components/icons"
import { useMemo, useState, type ReactNode } from "react"

import { FragmentEditor } from "@/components/shard/fragment-editor"
import { FragmentBody } from "@/components/shard/fragment-body"
import { MindMapFenceEmbed } from "@/components/shard/mind-map-fence-embed"
import { FragmentRelated } from "@/components/shard/fragment-related"
import { TagBadge } from "@/components/shard/tag-badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  CONTENT_KIND_LABELS,
  deriveDocumentDigest,
  isTypeTag,
  type ContentKind,
} from "@/lib/content-kind"
import { readOutlineContent } from "@/lib/mind-map-outline"
import { readFlowchartContent } from "@/lib/flowchart-content"
import { notify } from "@/lib/notify"
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
  knownTags?: string[]
  onArchive?: (fragment: Fragment) => void
  onCancelEdit?: () => void
  onRegisterEditorFlush?: (flush: (() => Promise<boolean>) | null) => void
  onEdit?: (fragment: Fragment) => void
  onExportImage?: (fragment: Fragment) => void
  onOpenTag?: (tag: string) => void
  onNavigateToFragment?: (fragmentId: string) => void
  onOpenZen?: (fragment: Fragment) => void
  onPin?: (fragment: Fragment) => void
  onRefreshFragments?: () => Promise<void> | void
  onRequestOutlineUpgrade?: (fragmentId: string) => Promise<void> | void
  onSave?: (
    id: string,
    content: string,
    tags: string[],
    expectedFileSha?: string
  ) => Promise<Fragment>
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
  knownTags = [],
  onArchive,
  onCancelEdit,
  onRegisterEditorFlush,
  onEdit,
  onExportImage,
  onOpenTag,
  onOpenZen,
  onPin,
  onRefreshFragments,
  onRequestOutlineUpgrade,
  onNavigateToFragment,
  onSave,
  onToggleTask,
  onUnlinkFragment,
  requestRelated,
  variant = "card",
  vaultPath,
}: FragmentCardProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isRelatedOpen, setIsRelatedOpen] = useState(false)
  const createdTime = formatCreatedTime(fragment.createdAt)
  const displayContent = fragment.content.trimEnd()
  const displayTags = fragment.tags.filter(
    (tag) => tag !== "inbox" && !isTypeTag(tag)
  )
  const typeBadge = TYPE_BADGES[fragment.kind]

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
      notify.success("片段内容已复制")
    } catch (error) {
      notify.failure("片段内容复制失败", error, {
        action: { label: "重试", onClick: () => void copyFragmentContent() },
      })
    }
  }

  if (isEditing && onSave) {
    return (
      <div
        className={cn(isHighlighted && "shard-fragment-card-highlight")}
        data-search-reveal-host="editor"
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
          // 文档类型不做行内编辑，由编辑器转交禅模式（产品框架 §2）。
          onRequestZen={onOpenZen ? () => onOpenZen(fragment) : undefined}
          onRefreshFragments={onRefreshFragments}
          onRequestOutlineUpgrade={onRequestOutlineUpgrade}
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
      data-search-reveal-host={fragment.kind === "fragment" ? "dom" : "documentOnly"}
      data-shard-fragment-id={fragment.id}
      style={{
        display: "flex",
        flexDirection: "column",
        borderRadius: "var(--shard-surface-radius)",
        background: variant === "flat" ? "transparent" : "var(--card)",
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
          typeBadge ||
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
              {typeBadge ? (
                <span
                  className="shard-tag shard-tag-muted"
                  data-fragment-type-badge={fragment.kind}
                  style={{ fontWeight: 500 }}
                >
                  <typeBadge.icon />
                  {typeBadge.label}
                </span>
              ) : null}
              {displayTags.map((tag) => (
                <TagBadge inline key={tag} onOpen={onOpenTag} tag={tag} />
              ))}
            </div>
          ) : null}
          {fragment.kind === "outline" ? (
            <OutlineCardBody content={displayContent} />
          ) : fragment.kind === "flowchart" ? (
            <FlowchartCardBody
              content={displayContent}
              onTaskToggle={(lineIndex) => onToggleTask?.(fragment, lineIndex)}
              vaultPath={vaultPath}
            />
          ) : fragment.kind === "document" ? (
            <DocumentCardBody content={displayContent} />
          ) : (
            <FragmentBody
              content={displayContent}
              contentClassName="shard-fragment-card-content"
              downloadableImages
              hideTags
              onTaskToggle={(lineIndex) => onToggleTask?.(fragment, lineIndex)}
              renderImages
              vaultPath={vaultPath}
            />
          )}
        </div>

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
              <CardMenuItem
                icon={<CopyIcon aria-hidden="true" />}
                label="复制"
                onSelect={() => void copyFragmentContent()}
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
    </article>
  )
}

/** type 徽标：缺省的碎片没有徽标，其余类型各占一枚。 */
const TYPE_BADGES: Partial<Record<ContentKind, { icon: ShardIcon; label: string }>> = {
  document: { icon: FileTextIcon, label: CONTENT_KIND_LABELS.document },
  flowchart: { icon: WorkflowIcon, label: CONTENT_KIND_LABELS.flowchart },
  note: { icon: FileTextIcon, label: CONTENT_KIND_LABELS.note },
  outline: { icon: GitBranchIcon, label: CONTENT_KIND_LABELS.outline },
}

/**
 * 大纲卡片：整篇正文就是一棵树，卡片给「根节点文本 + 导图缩略」，
 * 不铺原始缩进列表（产品框架 §2 时间线卡片一列）。
 */
function OutlineCardBody({ content }: { content: string }) {
  const title = useMemo(() => {
    const file = readOutlineContent(content)?.file
    return (file ? file.nodes[file.rootId]?.text ?? "" : "").trim()
  }, [content])

  return (
    <div data-fragment-card-kind="outline">
      <p
        className="shard-memo-body"
        style={{
          margin: 0,
          marginBottom: "var(--shard-space-2)",
          fontWeight: "var(--font-weight-semibold)",
        }}
      >
        {title || "未命名大纲"}
      </p>
      <MindMapFenceEmbed code={content} />
    </div>
  )
}

function FlowchartCardBody({
  content,
  onTaskToggle,
  vaultPath,
}: {
  content: string
  onTaskToggle: (lineIndex: number) => void
  vaultPath?: string
}) {
  const flowchart = useMemo(() => readFlowchartContent(content), [content])
  if (!flowchart) {
    return (
      <FragmentBody
        content={content}
        contentClassName="shard-fragment-card-content"
        downloadableImages
        hideTags
        onTaskToggle={onTaskToggle}
        renderImages
        vaultPath={vaultPath}
      />
    )
  }

  const { file } = flowchart
  return (
    <div data-fragment-card-kind="flowchart">
      <p
        className="shard-memo-body"
        style={{ margin: 0, fontWeight: "var(--font-weight-semibold)" }}
      >
        {file.title.trim() || "未命名流程图"}
      </p>
      <p
        className="shard-memo-meta"
        style={{ color: "var(--muted-foreground)", margin: 0 }}
      >
        {file.nodes.length} 个节点 · {file.edges.length} 条连线
      </p>
    </div>
  )
}

/** 文档卡片：标题 + 摘要，正文不上卡片。 */
function DocumentCardBody({ content }: { content: string }) {
  const digest = useMemo(() => deriveDocumentDigest(content), [content])

  return (
    <div data-fragment-card-kind="document">
      <p
        className="shard-memo-body"
        style={{ margin: 0, fontWeight: "var(--font-weight-semibold)" }}
      >
        {digest.title || "未命名文档"}
      </p>
      {digest.summary ? (
        <p
          className="shard-memo-body"
          style={{
            margin: 0,
            marginTop: "var(--shard-space-2)",
            color: "var(--muted-foreground)",
          }}
        >
          {digest.summary}
        </p>
      ) : null}
    </div>
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
