import {
  BotIcon,
  CalendarDaysIcon,
  CircleAlertIcon,
  RefreshCwIcon,
  RouteIcon,
  SaveIcon,
  SparklesIcon,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { FragmentCard } from "@/components/shard/fragment-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  getCodexAgentStatus,
  getApiErrorMessage,
  runCodexReviewTask,
} from "@/lib/api"
import {
  codexReviewFragments,
  dailyReviewFragments,
  randomWalkFragments,
  reviewFragmentSummary,
} from "@/lib/review-workflows"
import type {
  CodexAgentStatus,
  CodexReviewTask,
  Fragment,
  FragmentFilter,
} from "@/types"

type ReviewMode = Extract<FragmentFilter, "dailyReview" | "insight" | "walk">

interface ReviewWorkspaceProps {
  fragments: Fragment[]
  isLoading: boolean
  mode: ReviewMode
  onArchive?: (fragment: Fragment) => void
  onCreate: (content: string, tags: string[]) => Promise<void>
  onEdit?: (fragment: Fragment) => void
  onToggleTask?: (fragment: Fragment, lineIndex: number) => void
  vaultPath: string
}

const modeMeta: Record<
  ReviewMode,
  {
    title: string
    description: string
    icon: typeof CalendarDaysIcon
  }
> = {
  dailyReview: {
    title: "每日回顾",
    description: "从近 6 个月的非归档片段里抽取 8 条，先回看，不打断捕捉。",
    icon: CalendarDaysIcon,
  },
  insight: {
    title: "AI 洞察",
    description: "让本机 Codex 只读分析当前回顾集，找主题、盲点和继续追问。",
    icon: SparklesIcon,
  },
  walk: {
    title: "随机漫步",
    description: "抽取一串片段路径，再让 Codex 解释其中可能的意外连接。",
    icon: RouteIcon,
  },
}

export function ReviewWorkspace({
  fragments,
  isLoading,
  mode,
  onArchive,
  onCreate,
  onEdit,
  onToggleTask,
  vaultPath,
}: ReviewWorkspaceProps) {
  const [dailySeed, setDailySeed] = useState(() => daySeed())
  const [walkSeed, setWalkSeed] = useState(() => daySeed() + 17)
  const [codexStatus, setCodexStatus] = useState<CodexAgentStatus | null>(null)
  const [codexError, setCodexError] = useState<string | null>(null)
  const [isCheckingCodex, setIsCheckingCodex] = useState(false)
  const [isRunningInsight, setIsRunningInsight] = useState(false)
  const [isRunningWalk, setIsRunningWalk] = useState(false)
  const [insightText, setInsightText] = useState("")
  const [walkText, setWalkText] = useState("")
  const [isSavingInsight, setIsSavingInsight] = useState(false)

  const dailyFragments = useMemo(
    () => dailyReviewFragments(fragments, dailySeed),
    [dailySeed, fragments]
  )
  const walkFragments = useMemo(
    () => randomWalkFragments(fragments, walkSeed),
    [fragments, walkSeed]
  )
  const displayFragments = mode === "walk" ? walkFragments : dailyFragments
  const meta = modeMeta[mode]
  const MetaIcon = meta.icon
  const canRunCodex = Boolean(codexStatus?.installed)

  useEffect(() => {
    if (mode !== "insight" && mode !== "walk") return

    let isMounted = true
    setIsCheckingCodex(true)
    setCodexError(null)

    getCodexAgentStatus()
      .then((status) => {
        if (!isMounted) return
        setCodexStatus(status)
        if (!status.installed && status.error) {
          setCodexError(status.error)
        }
      })
      .catch((error) => {
        if (!isMounted) return
        setCodexStatus(null)
        setCodexError(getApiErrorMessage(error))
      })
      .finally(() => {
        if (isMounted) setIsCheckingCodex(false)
      })

    return () => {
      isMounted = false
    }
  }, [mode])

  async function runCodex(task: CodexReviewTask) {
    const selectedFragments = task === "walk" ? walkFragments : dailyFragments
    if (selectedFragments.length === 0) return

    setCodexError(null)
    if (task === "walk") {
      setIsRunningWalk(true)
    } else {
      setIsRunningInsight(true)
    }

    try {
      const result = await runCodexReviewTask(
        task,
        codexReviewFragments(selectedFragments),
        vaultPath
      )
      if (task === "walk") {
        setWalkText(result.text)
      } else {
        setInsightText(result.text)
      }
    } catch (error) {
      setCodexError(getApiErrorMessage(error))
    } finally {
      setIsRunningWalk(false)
      setIsRunningInsight(false)
    }
  }

  async function saveInsight() {
    const content = insightText.trim()
    if (!content) return

    setIsSavingInsight(true)
    try {
      await onCreate(`AI 洞察\n\n${content}`, ["inbox", "ai/insight"])
    } finally {
      setIsSavingInsight(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ReviewHeader
        icon={MetaIcon}
        mode={mode}
        summary={reviewFragmentSummary(displayFragments)}
        title={meta.title}
        description={meta.description}
        onRefreshDaily={() => {
          setDailySeed((current) => current + 1)
          setInsightText("")
        }}
        onRefreshWalk={() => {
          setWalkSeed((current) => current + 1)
          setWalkText("")
        }}
      />

      <ScrollArea className="min-h-0 flex-1">
        {isLoading ? (
          <ReviewEmpty icon={MetaIcon} message="正在读取 Shard vault..." />
        ) : displayFragments.length === 0 ? (
          <ReviewEmpty icon={MetaIcon} message="还没有可回顾的片段。" />
        ) : (
          <div className="shard-content-inset pb-[var(--shard-space-8)]">
            <div className="shard-content-measure flex flex-col gap-[var(--shard-card-gap)]">
              {mode === "insight" ? (
                <CodexPanel
                  actionLabel={isRunningInsight ? "生成中" : "生成洞察"}
                  canRun={canRunCodex && !isRunningInsight}
                  error={codexError}
                  isChecking={isCheckingCodex}
                  isRunning={isRunningInsight}
                  onRun={() => void runCodex("insight")}
                  result={insightText}
                  status={codexStatus}
                  title="当前回顾集洞察"
                  onSave={insightText ? saveInsight : undefined}
                  isSaving={isSavingInsight}
                />
              ) : null}

              {mode === "walk" ? (
                <CodexPanel
                  actionLabel={isRunningWalk ? "生成中" : "生成连接理由"}
                  canRun={canRunCodex && !isRunningWalk}
                  error={codexError}
                  isChecking={isCheckingCodex}
                  isRunning={isRunningWalk}
                  onRun={() => void runCodex("walk")}
                  result={walkText}
                  status={codexStatus}
                  title="漫步连接"
                />
              ) : null}

              <div className="flex flex-col gap-[var(--shard-card-gap)]">
                {displayFragments.map((fragment, index) => (
                  <div
                    className="grid grid-cols-[28px_minmax(0,1fr)] gap-[var(--shard-space-3)]"
                    key={fragment.id}
                  >
                    {mode === "walk" ? (
                      <div className="flex flex-col items-center pt-[var(--shard-space-4)]">
                        <span className="flex size-6 items-center justify-center rounded-full border border-border bg-background text-xs font-bold text-muted-foreground">
                          {index + 1}
                        </span>
                        {index < displayFragments.length - 1 ? (
                          <span
                            aria-hidden="true"
                            className="mt-[var(--shard-space-2)] h-full min-h-8 w-px bg-border"
                          />
                        ) : null}
                      </div>
                    ) : (
                      <span aria-hidden="true" />
                    )}
                    <FragmentCard
                      fragment={fragment}
                      onArchive={onArchive}
                      onEdit={onEdit}
                      onToggleTask={onToggleTask}
                      vaultPath={vaultPath}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

interface ReviewHeaderProps {
  description: string
  icon: typeof CalendarDaysIcon
  mode: ReviewMode
  onRefreshDaily: () => void
  onRefreshWalk: () => void
  summary: string
  title: string
}

function ReviewHeader({
  description,
  icon: Icon,
  mode,
  onRefreshDaily,
  onRefreshWalk,
  summary,
  title,
}: ReviewHeaderProps) {
  return (
    <header className="shard-content-inset shrink-0 pb-[var(--shard-space-4)]">
      <div className="shard-content-measure flex flex-col gap-[var(--shard-space-3)] border-b border-border pb-[var(--shard-space-4)]">
        <div className="flex flex-wrap items-start justify-between gap-[var(--shard-space-3)]">
          <div className="flex min-w-0 items-start gap-[var(--shard-space-3)]">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[var(--shard-radius-control)] border border-border bg-card text-[color:var(--shard-sapphire)]">
              <Icon className="size-4 stroke-[1.75]" />
            </span>
            <div className="min-w-0">
              <h1 className="text-lg leading-6 font-bold">{title}</h1>
              <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">
                {description}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-[var(--shard-space-2)]">
            {mode === "dailyReview" || mode === "insight" ? (
              <Button variant="outline" size="sm" onClick={onRefreshDaily}>
                <RefreshCwIcon data-icon="inline-start" />
                换一组
              </Button>
            ) : null}
            {mode === "walk" ? (
              <Button variant="outline" size="sm" onClick={onRefreshWalk}>
                <RefreshCwIcon data-icon="inline-start" />
                换路径
              </Button>
            ) : null}
          </div>
        </div>

        <Badge
          className="border-border bg-muted text-muted-foreground"
          variant="outline"
        >
          {summary}
        </Badge>
      </div>
    </header>
  )
}

interface CodexPanelProps {
  actionLabel: string
  canRun: boolean
  error: string | null
  isChecking: boolean
  isRunning: boolean
  isSaving?: boolean
  onRun: () => void
  onSave?: () => Promise<void>
  result: string
  status: CodexAgentStatus | null
  title: string
}

function CodexPanel({
  actionLabel,
  canRun,
  error,
  isChecking,
  isRunning,
  isSaving = false,
  onRun,
  onSave,
  result,
  status,
  title,
}: CodexPanelProps) {
  return (
    <section className="rounded-[var(--shard-surface-radius)] border border-border bg-card p-[var(--shard-card-padding-x)]">
      <div className="flex flex-wrap items-center justify-between gap-[var(--shard-space-3)]">
        <div className="min-w-0">
          <div className="flex items-center gap-[var(--shard-space-2)]">
            <BotIcon className="size-4 text-[color:var(--shard-sapphire)]" />
            <h2 className="text-sm font-bold">{title}</h2>
          </div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">
            {isChecking
              ? "正在检测 Codex CLI..."
              : status?.installed
                ? `Codex ${status.version ?? "已安装"}`
                : "需要本机 Codex CLI"}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-[var(--shard-space-2)]">
          {onSave ? (
            <Button
              disabled={isSaving || isRunning}
              onClick={() => void onSave()}
              size="sm"
              variant="outline"
            >
              <SaveIcon data-icon="inline-start" />
              {isSaving ? "保存中" : "保存为片段"}
            </Button>
          ) : null}
          <Button disabled={!canRun || isChecking} onClick={onRun} size="sm">
            <SparklesIcon data-icon="inline-start" />
            {actionLabel}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mt-[var(--shard-space-3)] flex gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] border border-[rgb(var(--shard-ruby-rgb)/var(--shard-alpha-34))] bg-[rgb(var(--shard-ruby-rgb)/var(--shard-alpha-8))] px-[var(--shard-space-3)] py-[var(--shard-space-2)] text-xs leading-5 text-[color:var(--shard-ruby)]">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {result ? (
        <div className="mt-[var(--shard-space-4)] whitespace-pre-wrap rounded-[var(--shard-radius-control)] bg-background px-[var(--shard-space-4)] py-[var(--shard-space-3)] text-sm leading-6">
          {result}
        </div>
      ) : (
        <div className="mt-[var(--shard-space-4)] text-sm leading-6 text-muted-foreground">
          {isRunning ? "Codex 正在只读分析当前片段..." : "生成后会显示在这里。"}
        </div>
      )}
    </section>
  )
}

function ReviewEmpty({
  icon: Icon,
  message,
}: {
  icon: typeof CalendarDaysIcon
  message: string
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
      <Icon className="size-8" />
      <div className="text-sm font-semibold">{message}</div>
    </div>
  )
}

function daySeed() {
  const now = new Date()
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate()
}
