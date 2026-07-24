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

import { Button } from "@astryxdesign/core/Button"
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu"
import { Grid } from "@astryxdesign/core/Grid"
import { HStack } from "@astryxdesign/core/HStack"
import { Stack } from "@astryxdesign/core/Stack"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"

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
  const toast = useToast()
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
      toast({
        body: `读取思维导图失败：${getApiErrorMessage(error)}`,
        type: "error",
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
      toast({ body: "思维导图已创建" })
      onOpenMap(created.file.id)
    } catch (error) {
      toast({
        body: `创建思维导图失败：${getApiErrorMessage(error)}`,
        type: "error",
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
    <Stack minHeight={0} style={{ flex: "1 1 0%" }}>
      <div className="shard-content-inset" style={{ paddingBottom: "var(--shard-space-4)" }}>
        <HStack
          className="shard-content-measure"
          gap={3}
          hAlign="between"
          vAlign="center"
          wrap="wrap"
        >
          <HStack gap={3} style={{ minWidth: 0 }} vAlign="center">
            <span
              style={{
                alignItems: "center",
                background: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: "var(--shard-radius-control)",
                color: "var(--shard-sapphire)",
                display: "flex",
                flexShrink: 0,
                height: 32,
                justifyContent: "center",
                width: 32,
              }}
            >
              <GitBranchIcon size={16} strokeWidth={1.75} />
            </span>
            <div style={{ minWidth: 0 }}>
              <h1
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  lineHeight: "24px",
                  margin: 0,
                  textWrap: "balance",
                }}
              >
                思维导图
              </h1>
              <p
                style={{
                  color: "var(--muted-foreground)",
                  fontSize: 14,
                  lineHeight: "20px",
                  margin: 0,
                  marginTop: 4,
                }}
              >
                {maps.length} 份导图
              </p>
            </div>
          </HStack>

          <HStack
            gap={2}
            hAlign="end"
            style={{ flex: "1 1 0%", minWidth: 0 }}
            vAlign="center"
          >
            <Button
              icon={<RefreshCwIcon />}
              isDisabled={isLoading}
              isIconOnly
              isLoading={isLoading}
              label="刷新思维导图列表"
              onClick={() => void refreshMindMaps()}
              size="sm"
              type="button"
              variant="ghost"
            />
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
                <TextInput
                  isDisabled={isCreating}
                  isLabelHidden
                  label="思维导图标题"
                  onChange={(value) => setTitle(value)}
                  placeholder="新建导图标题"
                  value={title}
                  width="100%"
                />
              </div>
              <Button
                icon={<PlusIcon />}
                isDisabled={!title.trim() || isCreating}
                isLoading={isCreating}
                label="新建"
                type="submit"
              />
            </form>
          </HStack>
        </HStack>
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
            <Stack
              gap={2}
              hAlign="center"
              style={{ color: "var(--muted-foreground)", height: 192, textAlign: "center" }}
              vAlign="center"
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
            </Stack>
          ) : (
            <Grid columns={{ minWidth: 260 }} gap={4}>
              {maps.map((map) => (
                <MindMapGridCard
                  key={map.id}
                  map={map}
                  onOpen={() => onOpenMap(map.id)}
                />
              ))}
            </Grid>
          )}
        </div>
      </div>
    </Stack>
  )
}

function MindMapGridCard({
  map,
  onOpen,
}: {
  map: MindMapSummary
  onOpen: () => void
}) {
  const toast = useToast()
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
      toast({ body: "已复制思维导图信息" })
    } catch (unknownError) {
      toast({
        body: `分享思维导图失败：${getApiErrorMessage(unknownError)}`,
        type: "error",
      })
    }
  }

  return (
    <article className={styles.card} onClick={onOpen} ref={cardRef}>
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

      <HStack
        gap={2}
        hAlign="between"
        style={{ marginTop: "var(--shard-space-3)", minWidth: 0 }}
        vAlign="start"
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
          style={{ alignItems: "center", display: "flex", flexShrink: 0 }}
        >
          <DropdownMenu
            button={{
              icon: <MoreHorizontalIcon />,
              isIconOnly: true,
              label: "思维导图操作",
              size: "sm",
              variant: "ghost",
            }}
          >
            <DropdownMenuItem icon={PencilLineIcon} label="编辑" onClick={onOpen} />
            <DropdownMenuItem
              icon={Share2Icon}
              label="分享"
              onClick={() => void shareMindMap()}
            />
          </DropdownMenu>
        </div>
      </HStack>
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
