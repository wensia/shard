import { useEffect, useMemo, useState, type FormEvent } from "react"
import {
  FileJsonIcon,
  GitBranchIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  createMindMap,
  getApiErrorMessage,
  listMindMaps,
  readMindMap,
} from "@/lib/api"
import type { MindMapReadResult, MindMapSummary, ShardMapNode } from "@/types"

interface MindMapDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function MindMapDialog({ open, onOpenChange }: MindMapDialogProps) {
  const [maps, setMaps] = useState<MindMapSummary[]>([])
  const [selectedMap, setSelectedMap] = useState<MindMapReadResult | null>(null)
  const [title, setTitle] = useState("")
  const [isCreating, setIsCreating] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isReadingId, setIsReadingId] = useState<string | null>(null)
  const rootNode = selectedMap
    ? selectedMap.file.nodes[selectedMap.file.rootId] ?? null
    : null
  const childNodes = useMemo(() => {
    if (!selectedMap || !rootNode) return []

    return Object.values(selectedMap.file.nodes)
      .filter((node) => node.parentId === rootNode.id)
      .sort(compareMapNodes)
      .slice(0, 5)
  }, [rootNode, selectedMap])

  useEffect(() => {
    if (!open) return
    void refreshMindMaps()
  }, [open])

  async function refreshMindMaps() {
    setIsLoading(true)
    try {
      const nextMaps = await listMindMaps()
      setMaps(nextMaps)

      if (
        selectedMap &&
        !nextMaps.some((summary) => summary.id === selectedMap.file.id)
      ) {
        setSelectedMap(null)
      }
    } catch (error) {
      toast.error("读取思维导图失败", {
        description: getApiErrorMessage(error),
      })
    } finally {
      setIsLoading(false)
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextTitle = title.trim()
    if (!nextTitle) return

    setIsCreating(true)
    try {
      const created = await createMindMap(nextTitle)
      setSelectedMap(created)
      setTitle("")
      setMaps((current) => [
        {
          id: created.file.id,
          title: created.file.title,
          createdAt: created.file.createdAt,
          updatedAt: created.file.updatedAt,
          path: created.path,
        },
        ...current.filter((summary) => summary.id !== created.file.id),
      ])
      toast.success("思维导图已创建")
    } catch (error) {
      toast.error("创建思维导图失败", {
        description: getApiErrorMessage(error),
      })
    } finally {
      setIsCreating(false)
    }
  }

  async function handleSelectMap(summary: MindMapSummary) {
    setIsReadingId(summary.id)
    try {
      setSelectedMap(await readMindMap(summary.id))
    } catch (error) {
      toast.error("打开思维导图失败", {
        description: getApiErrorMessage(error),
      })
    } finally {
      setIsReadingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(760px,calc(100vw-32px))] gap-[var(--shard-space-5)]">
        <DialogHeader>
          <DialogTitle>思维导图</DialogTitle>
          <DialogDescription>本地导图文件</DialogDescription>
        </DialogHeader>

        <form
          className="flex min-w-0 items-center gap-[var(--shard-space-2)]"
          onSubmit={handleCreate}
        >
          <Input
            aria-label="思维导图标题"
            disabled={isCreating}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="输入标题"
            value={title}
          />
          <Button disabled={!title.trim() || isCreating} type="submit">
            {isCreating ? (
              <Loader2Icon className="animate-spin" data-icon="inline-start" />
            ) : (
              <GitBranchIcon data-icon="inline-start" />
            )}
            新建
          </Button>
        </form>

        <div className="grid min-h-[300px] gap-[var(--shard-space-4)] md:grid-cols-[minmax(180px,240px)_1fr]">
          <section
            aria-busy={isLoading}
            className="min-h-0 border-r border-border pr-[var(--shard-space-4)]"
          >
            <div className="mb-[var(--shard-space-2)] flex items-center justify-between gap-[var(--shard-space-2)]">
              <div className="text-xs font-semibold text-muted-foreground">
                {maps.length} 份导图
              </div>
              <Button
                aria-label="刷新思维导图列表"
                disabled={isLoading}
                onClick={() => void refreshMindMaps()}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <RefreshCwIcon className={isLoading ? "animate-spin" : ""} />
              </Button>
            </div>

            <div className="flex max-h-[260px] min-h-0 flex-col gap-[var(--shard-space-1)] overflow-y-auto pr-[var(--shard-space-1)]">
              {isLoading && maps.length === 0 ? (
                <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                  正在读取...
                </div>
              ) : maps.length === 0 ? (
                <div className="flex h-24 items-center justify-center text-center text-sm text-muted-foreground">
                  还没有思维导图
                </div>
              ) : (
                maps.map((summary) => {
                  const selected = selectedMap?.file.id === summary.id

                  return (
                    <button
                      aria-pressed={selected}
                      className={[
                        "flex min-w-0 items-start gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] px-[var(--shard-space-2)] py-[var(--shard-space-2)] text-left transition-colors",
                        selected
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "hover:bg-muted",
                      ].join(" ")}
                      key={summary.id}
                      onClick={() => void handleSelectMap(summary)}
                      type="button"
                    >
                      {isReadingId === summary.id ? (
                        <Loader2Icon className="mt-0.5 size-3.5 shrink-0 animate-spin" />
                      ) : (
                        <FileJsonIcon className="mt-0.5 size-3.5 shrink-0 stroke-[1.75]" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">
                          {summary.title}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {formatMapTime(summary.updatedAt)}
                        </span>
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          </section>

          <section className="min-w-0">
            {selectedMap ? (
              <div className="flex min-h-full flex-col gap-[var(--shard-space-4)]">
                <div className="min-w-0">
                  <div className="flex items-center gap-[var(--shard-space-2)] text-xs font-medium text-muted-foreground">
                    <span>revision {selectedMap.file.revision}</span>
                    <span aria-hidden="true">·</span>
                    <span>{Object.keys(selectedMap.file.nodes).length} 节点</span>
                  </div>
                  <h2 className="mt-[var(--shard-space-2)] truncate text-lg leading-6 font-semibold">
                    {selectedMap.file.title}
                  </h2>
                  <p className="mt-[var(--shard-space-1)] truncate text-xs text-muted-foreground">
                    {selectedMap.path}
                  </p>
                </div>

                <div className="rounded-[var(--shard-radius-control)] border border-border bg-card p-[var(--shard-space-4)]">
                  <div className="text-xs font-semibold text-muted-foreground">
                    根节点
                  </div>
                  <div className="mt-[var(--shard-space-2)] text-sm font-medium">
                    {rootNode?.text ?? "无根节点"}
                  </div>
                  {childNodes.length > 0 ? (
                    <ul className="mt-[var(--shard-space-3)] flex flex-col gap-[var(--shard-space-1)] text-sm text-muted-foreground">
                      {childNodes.map((node) => (
                        <li className="truncate" key={node.id}>
                          {node.text}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-[var(--shard-space-2)] text-center text-muted-foreground">
                <GitBranchIcon className="size-7 stroke-[1.5]" />
                <div className="text-sm font-semibold text-foreground">
                  新建或选择一份导图
                </div>
              </div>
            )}
          </section>
        </div>

        <DialogFooter className="flex-row justify-end">
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function compareMapNodes(a: ShardMapNode, b: ShardMapNode) {
  return a.sortKey.localeCompare(b.sortKey)
}

function formatMapTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}
