import { useEffect, useRef, useState, type FormEvent } from "react"
import {
  GitBranchIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilLineIcon,
  PlusIcon,
  RefreshCwIcon,
  Share2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { MindMapPreview } from "@/components/shard/mind-map-preview"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  createMindMap,
  getApiErrorMessage,
  listMindMaps,
  readMindMap,
} from "@/lib/api"
import type { MindMapReadResult, MindMapSummary } from "@/types"

interface MindMapPanelProps {
  onMapsChange?: (maps: MindMapSummary[]) => void
  onOpenMap: (mapId: string) => void
}

const CARD_PREVIEW_HEIGHT = 168

const mindMapMenuItemClass =
  "grid h-8 grid-cols-[14px_max-content] gap-[var(--shard-space-2)] px-[var(--shard-space-2)] text-[13px] font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:stroke-[1.65]"

export function MindMapPanel({ onMapsChange, onOpenMap }: MindMapPanelProps) {
  const [maps, setMaps] = useState<MindMapSummary[]>([])
  const [title, setTitle] = useState("")
  const [isCreating, setIsCreating] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    void refreshMindMaps()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function refreshMindMaps() {
    setIsLoading(true)
    try {
      updateMaps(await listMindMaps())
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
      setTitle("")
      updateMaps([
        {
          id: created.file.id,
          title: created.file.title,
          createdAt: created.file.createdAt,
          updatedAt: created.file.updatedAt,
          nodeCount: Object.keys(created.file.nodes).length,
          path: created.path,
        },
        ...maps,
      ])
      toast.success("思维导图已创建")
      onOpenMap(created.file.id)
    } catch (error) {
      toast.error("创建思维导图失败", {
        description: getApiErrorMessage(error),
      })
    } finally {
      setIsCreating(false)
    }
  }

  function updateMaps(nextMaps: MindMapSummary[]) {
    setMaps(nextMaps)
    onMapsChange?.(nextMaps)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shard-content-inset pb-[var(--shard-space-4)]">
        <div className="shard-content-measure flex flex-wrap items-center justify-between gap-[var(--shard-space-3)]">
          <div className="flex min-w-0 items-center gap-[var(--shard-space-3)]">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--shard-radius-control)] border border-border bg-card text-[color:var(--shard-sapphire)]">
              <GitBranchIcon className="size-4 stroke-[1.75]" />
            </span>
            <div className="min-w-0">
              <h1 className="text-lg leading-6 font-bold text-balance">
                思维导图
              </h1>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                {maps.length} 份导图
              </p>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 items-center justify-end gap-[var(--shard-space-2)]">
            <Button
              aria-label="刷新思维导图列表"
              disabled={isLoading}
              onClick={() => void refreshMindMaps()}
              size="icon"
              type="button"
              variant="ghost"
            >
              <RefreshCwIcon className={isLoading ? "animate-spin" : ""} />
            </Button>
            <form
              className="flex min-w-0 items-center gap-[var(--shard-space-2)] sm:max-w-[320px]"
              onSubmit={handleCreate}
            >
              <Input
                aria-label="思维导图标题"
                disabled={isCreating}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="新建导图标题"
                value={title}
              />
              <Button disabled={!title.trim() || isCreating} type="submit">
                {isCreating ? (
                  <Loader2Icon className="animate-spin" data-icon="inline-start" />
                ) : (
                  <PlusIcon data-icon="inline-start" />
                )}
                新建
              </Button>
            </form>
          </div>
        </div>
      </div>

      <div className="shard-content-inset min-h-0 flex-1 overflow-y-auto pb-[var(--shard-space-6)]">
        <div className="shard-content-measure">
          {isLoading && maps.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              正在读取...
            </div>
          ) : maps.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center gap-[var(--shard-space-2)] text-center text-muted-foreground">
              <GitBranchIcon className="size-7 stroke-[1.5]" />
              <div className="text-sm font-semibold text-foreground">
                还没有思维导图
              </div>
              <p className="text-sm">在上方输入标题即可新建第一份导图。</p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-[var(--shard-space-4)]">
              {maps.map((map) => (
                <MindMapGridCard
                  key={map.id}
                  map={map}
                  onOpen={() => onOpenMap(map.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function MindMapGridCard({
  map,
  onOpen,
}: {
  map: MindMapSummary
  onOpen: () => void
}) {
  const cardRef = useRef<HTMLElement | null>(null)
  const [readResult, setReadResult] = useState<MindMapReadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const hasRequestedRef = useRef(false)

  useEffect(() => {
    const element = cardRef.current
    if (!element) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || hasRequestedRef.current) return
        hasRequestedRef.current = true
        setIsLoading(true)
        void readMindMap(map.id)
          .then((result) => {
            setReadResult(result)
            setError(null)
          })
          .catch((unknownError) => {
            setError(getApiErrorMessage(unknownError))
          })
          .finally(() => setIsLoading(false))
      },
      { rootMargin: "240px" }
    )

    observer.observe(element)
    return () => observer.disconnect()
  }, [map.id])

  async function shareMindMap() {
    try {
      const clipboard = navigator.clipboard
      if (!clipboard) {
        throw new Error("当前环境不支持复制到剪贴板")
      }

      await clipboard.writeText(`${map.title}\n${map.path}`)
      toast.success("已复制思维导图信息")
    } catch (unknownError) {
      toast.error("分享思维导图失败", {
        description: getApiErrorMessage(unknownError),
      })
    }
  }

  return (
    <article
      className="group flex cursor-pointer flex-col rounded-[var(--shard-surface-radius)] bg-card p-[var(--shard-space-3)] shadow-card transition-shadow hover:shadow-card-hover"
      onClick={onOpen}
      ref={cardRef}
    >
      {readResult ? (
        <MindMapPreview file={readResult.file} height={CARD_PREVIEW_HEIGHT} />
      ) : (
        <div
          className="flex items-center justify-center rounded-[var(--shard-radius-control)] bg-background text-xs text-muted-foreground"
          style={{ height: CARD_PREVIEW_HEIGHT }}
        >
          {isLoading ? (
            <span className="inline-flex items-center gap-[var(--shard-space-2)]">
              <Loader2Icon className="size-3.5 animate-spin" />
              正在渲染导图
            </span>
          ) : error ? (
            <span className="max-w-full truncate px-[var(--shard-space-3)]">
              无法读取导图预览
            </span>
          ) : (
            <span>准备渲染导图</span>
          )}
        </div>
      )}

      <div className="mt-[var(--shard-space-3)] flex min-w-0 items-start justify-between gap-[var(--shard-space-2)]">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm leading-5 font-semibold text-foreground">
            {map.title}
          </h2>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {map.nodeCount} 节点 · {formatMapTime(map.updatedAt)}
          </div>
        </div>

        <div
          className="flex shrink-0 items-center"
          onClick={(event) => event.stopPropagation()}
        >
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" />}>
              <MoreHorizontalIcon
                className="size-4 stroke-[1.65]"
                data-icon="inline-start"
              />
              <span className="sr-only">思维导图操作</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-fit min-w-0"
            >
              <DropdownMenuGroup>
                <DropdownMenuItem
                  className={mindMapMenuItemClass}
                  onClick={onOpen}
                >
                  <PencilLineIcon />
                  编辑
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={mindMapMenuItemClass}
                  onClick={() => void shareMindMap()}
                >
                  <Share2Icon />
                  分享
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </article>
  )
}

function formatMapTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}
