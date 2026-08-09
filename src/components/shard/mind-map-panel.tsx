import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react"
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

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"

import { MindMapPreview } from "@/components/shard/mind-map-preview"
import {
  createMindMap,
  getApiErrorMessage,
  listMindMaps,
  readMindMap,
} from "@/lib/api"
import type { MindMapReadResult, MindMapSummary } from "@/types"

import styles from "./mind-map-panel.module.css"

interface MindMapPanelProps {
  onMapsChange?: (maps: MindMapSummary[]) => void
  onOpenMap: (mapId: string) => void
}

const CARD_PREVIEW_HEIGHT = 168

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
      toast.error(`读取思维导图失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
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
      toast("思维导图已创建", { duration: 5000 })
      onOpenMap(created.file.id)
    } catch (error) {
      toast.error(`创建思维导图失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
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
      <div
        className="shard-content-inset"
        data-tauri-drag-region
        style={{
          paddingBottom: "var(--shard-space-4)",
          paddingTop: "var(--shard-top-inset)",
        }}
      >
        <div
          className="shard-content-measure"
          style={{
            alignItems: "center",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--shard-space-3)",
            justifyContent: "space-between",
            paddingBottom: "var(--shard-space-3)",
          }}
        >
          <div
            style={{
              alignItems: "center",
              display: "flex",
              gap: "var(--shard-space-2)",
              minWidth: 0,
            }}
          >
            <h1
              style={{
                fontSize: "var(--font-size-base)",
                fontWeight: 600,
                lineHeight: "24px",
                margin: 0,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                textWrap: "balance",
                whiteSpace: "nowrap",
              }}
            >
              思维导图
            </h1>
            <Badge style={{ flexShrink: 0 }}>{maps.length} 份</Badge>
          </div>

          <div
            style={{
              alignItems: "center",
              display: "flex",
              flex: "1 1 0%",
              gap: "var(--shard-space-2)",
              justifyContent: "flex-end",
              minWidth: 0,
            }}
          >
            <Button
              aria-label="刷新思维导图列表"
              disabled={isLoading}
              onClick={() => void refreshMindMaps()}
              size="icon-sm"
              title="刷新思维导图列表"
              type="button"
              variant="ghost"
            >
              <RefreshCwIcon
                aria-hidden="true"
                className={isLoading ? styles.spinner : undefined}
              />
              <span className="sr-only">刷新思维导图列表</span>
            </Button>
            <form
              className={styles.createForm}
              onSubmit={handleCreate}
              style={{
                alignItems: "center",
                display: "flex",
                gap: "var(--shard-space-2)",
                minWidth: 0,
              }}
            >
              <div style={{ flex: "1 1 0%", minWidth: 0 }}>
                <Input
                  aria-label="思维导图标题"
                  className={styles.createInput}
                  disabled={isCreating}
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  placeholder="新建导图标题"
                  value={title}
                />
              </div>
              <Button
                disabled={!title.trim() || isCreating}
                size="sm"
                type="submit"
                variant="default"
              >
                {isCreating ? (
                  <Loader2Icon
                    aria-hidden="true"
                    className={styles.spinner}
                  />
                ) : (
                  <PlusIcon aria-hidden="true" />
                )}
                <span>新建</span>
              </Button>
            </form>
          </div>
        </div>
      </div>

      <div
        className="shard-content-inset"
        style={{
          flex: "1 1 0%",
          minHeight: 0,
          overflowY: "auto",
          paddingBottom: "var(--shard-space-6)",
        }}
      >
        <div className="shard-content-measure">
          {isLoading && maps.length === 0 ? (
            <div
              style={{
                alignItems: "center",
                color: "var(--muted-foreground)",
                display: "flex",
                fontSize: 14,
                height: 128,
                justifyContent: "center",
              }}
            >
              正在读取...
            </div>
          ) : maps.length === 0 ? (
            <div
              style={{
                alignItems: "center",
                color: "var(--muted-foreground)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--shard-space-2)",
                height: 192,
                justifyContent: "center",
                textAlign: "center",
              }}
            >
              <GitBranchIcon
                size={28}
                strokeWidth={1.5}
                style={{ color: "var(--muted-foreground)" }}
              />
              <div style={{ color: "var(--foreground)", fontSize: 14, fontWeight: 600 }}>
                还没有思维导图
              </div>
              <p style={{ fontSize: 14, margin: 0 }}>在上方输入标题即可新建第一份导图。</p>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gap: "var(--shard-space-4)",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(260px, 100%), 1fr))",
              }}
            >
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
      toast("已复制思维导图信息", { duration: 5000 })
    } catch (unknownError) {
      toast.error(`分享思维导图失败：${getApiErrorMessage(unknownError)}`, {
        duration: Infinity,
      })
    }
  }

  return (
    <article
      aria-label={`打开思维导图：${map.title}`}
      className={styles.card}
      onClick={onOpen}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        onOpen()
      }}
      ref={cardRef}
      role="button"
      tabIndex={0}
    >
      {readResult ? (
        <MindMapPreview file={readResult.file} height={CARD_PREVIEW_HEIGHT} />
      ) : (
        <div
          style={{
            alignItems: "center",
            background: "var(--background)",
            borderRadius: "var(--shard-radius-control)",
            color: "var(--muted-foreground)",
            display: "flex",
            fontSize: 12,
            height: CARD_PREVIEW_HEIGHT,
            justifyContent: "center",
          }}
        >
          {isLoading ? (
            <span
              style={{
                alignItems: "center",
                display: "inline-flex",
                gap: "var(--shard-space-2)",
              }}
            >
              <Loader2Icon className={styles.spinner} size={14} />
              正在渲染导图
            </span>
          ) : error ? (
            <span
              style={{
                maxWidth: "100%",
                overflow: "hidden",
                paddingInline: "var(--shard-space-3)",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              无法读取导图预览
            </span>
          ) : (
            <span>准备渲染导图</span>
          )}
        </div>
      )}

      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: "var(--shard-space-2)",
          justifyContent: "space-between",
          marginTop: "var(--shard-space-3)",
          minWidth: 0,
        }}
      >
        <div style={{ flex: "1 1 0%", minWidth: 0 }}>
          <h2
            style={{
              color: "var(--foreground)",
              fontSize: 14,
              fontWeight: 600,
              lineHeight: "20px",
              margin: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {map.title}
          </h2>
          <div
            style={{
              color: "var(--muted-foreground)",
              fontSize: 12,
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {map.nodeCount} 节点 · {formatMapTime(map.updatedAt)}
          </div>
        </div>

        <div
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          style={{ alignItems: "center", display: "flex", flexShrink: 0 }}
        >
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label="思维导图操作"
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                />
              }
            >
              <MoreHorizontalIcon aria-hidden="true" />
              <span className="sr-only">思维导图操作</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" style={{ width: 144 }}>
              <DropdownMenuItem onClick={() => window.setTimeout(onOpen, 0)}>
                <PencilLineIcon aria-hidden="true" />
                <span>编辑</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void shareMindMap()}>
                <Share2Icon aria-hidden="true" />
                <span>分享</span>
              </DropdownMenuItem>
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
