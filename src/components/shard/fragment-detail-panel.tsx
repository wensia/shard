import { useMemo, useState } from "react"
import {
  CopyIcon,
  PlusIcon,
  SparklesIcon,
} from "lucide-react"

import { StatusBadge } from "@/components/shard/status-badge"
import { TagBadge } from "@/components/shard/tag-badge"
import { Button } from "@/components/ui/button"
import { FragmentBody } from "@/components/shard/fragment-body"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { normalizeTag, toggleTaskLine } from "@/lib/editor-format"
import type { Fragment } from "@/types"

interface FragmentDetailPanelProps {
  fragment: Fragment | null
  onUpdateContent?: (id: string, content: string, tags: string[]) => void | Promise<void>
  onUpdateTags: (id: string, tags: string[]) => void | Promise<void>
  vaultPath: string
}

export function FragmentDetailPanel({
  fragment,
  onUpdateContent,
  onUpdateTags,
  vaultPath,
}: FragmentDetailPanelProps) {
  const [draftTag, setDraftTag] = useState("")

  const createdTime = useMemo(() => {
    if (!fragment) return ""
    return new Date(fragment.createdAt).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
  }, [fragment])

  if (!fragment) {
    return (
      <aside className="flex min-h-0 flex-col bg-card px-5 py-6">
        <div className="text-lg font-bold">片段详情</div>
        <Separator className="my-5" />
        <div className="flex flex-1 items-center justify-center text-center text-sm font-medium text-muted-foreground">
          选择一张卡片查看详情。
        </div>
      </aside>
    )
  }

  function addTag() {
    if (!fragment) return
    const next = normalizeTag(draftTag)
    if (!next || fragment.tags.includes(next)) {
      setDraftTag("")
      return
    }
    setDraftTag("")
    void onUpdateTags(fragment.id, [...fragment.tags, next])
  }

  function removeTag(tag: string) {
    if (!fragment) return
    const nextTags = fragment.tags.filter((current) => current !== tag)
    void onUpdateTags(fragment.id, nextTags.length ? nextTags : ["inbox"])
  }

  function toggleTask(lineIndex: number) {
    if (!fragment || !onUpdateContent) return
    const nextContent = toggleTaskLine(fragment.content, lineIndex)
    if (nextContent === fragment.content) return
    void onUpdateContent(fragment.id, nextContent, fragment.tags)
  }

  return (
    <aside className="flex min-h-0 flex-col bg-card">
      <div className="flex items-center justify-between px-5 py-5">
        <div className="text-lg font-bold">片段详情</div>
        <Button size="icon-sm" variant="ghost">
          <CopyIcon data-icon="inline-start" />
          <span className="sr-only">复制片段 ID</span>
        </Button>
      </div>
      <Separator />

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-bold">基本信息</h2>
          <dl className="grid grid-cols-[72px_1fr] gap-y-3 text-sm">
            <dt className="text-muted-foreground">创建时间</dt>
            <dd className="text-right font-medium">{createdTime}</dd>
            <dt className="text-muted-foreground">ID</dt>
            <dd className="truncate text-right font-mono text-xs">{fragment.id}</dd>
            <dt className="text-muted-foreground">文件</dt>
            <dd className="truncate text-right text-xs">{fragment.path}</dd>
          </dl>
        </section>

        <Separator />

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold">标签</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {fragment.tags.map((tag) => (
              <TagBadge
                key={tag}
                onRemove={removeTag}
                removable
                tag={tag}
              />
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              className="h-8"
              onChange={(event) => setDraftTag(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  addTag()
                }
              }}
              placeholder="添加标签"
              value={draftTag}
            />
            <Button onClick={addTag} size="icon" variant="outline">
              <PlusIcon data-icon="inline-start" />
              <span className="sr-only">添加标签</span>
            </Button>
          </div>
        </section>

        <Separator />

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold">Git 状态</h2>
            <StatusBadge status={fragment.gitStatus} />
          </div>
          <dl className="grid grid-cols-[72px_1fr] gap-y-3 text-sm">
            <dt className="text-muted-foreground">Vault</dt>
            <dd className="truncate text-right text-xs">{vaultPath}</dd>
            <dt className="text-muted-foreground">错误</dt>
            <dd className="text-right text-xs text-muted-foreground">
              {fragment.error || "无"}
            </dd>
          </dl>
        </section>

        <Separator />

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-bold">内容</h2>
          <FragmentBody
            as="div"
            className="min-h-28 rounded-md border border-border bg-muted/[var(--shard-alpha-55)] p-3"
            content={fragment.content}
            downloadableImages
            onTaskToggle={onUpdateContent ? toggleTask : undefined}
            renderImages
            vaultPath={vaultPath}
          />
        </section>

        <Separator />

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold">AI 建议</h2>
            <Button size="icon-sm" variant="ghost">
              <SparklesIcon data-icon="inline-start" />
              <span className="sr-only">整理片段</span>
            </Button>
          </div>
          <div className="rounded-md border border-[rgb(var(--shard-primary-rgb)/var(--shard-alpha-34))] bg-[rgb(var(--shard-primary-rgb)/var(--shard-alpha-8))] p-3 text-sm leading-6 text-[color:var(--shard-sapphire-text)]">
            AI 整理会在后续版本中接入本地 Codex / Claude Code CLI。创建片段时不会等待 AI。
          </div>
        </section>
      </div>

      <div className="flex gap-3 border-t border-border p-5">
        <Button className="flex-1" variant="outline">
          归档片段
        </Button>
        <Button className="flex-1" variant="outline">
          编辑片段
        </Button>
      </div>
    </aside>
  )
}
