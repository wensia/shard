import {
  BotIcon,
  BrainCircuitIcon,
  CalendarDaysIcon,
  CircleAlertIcon,
  CompassIcon,
  GitBranchIcon,
  CheckIcon,
  HeartHandshakeIcon,
  PlusIcon,
  RouteIcon,
  ScaleIcon,
  SparklesIcon,
  RotateCcwIcon,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { Badge } from "@astryxdesign/core/Badge"
import { Button } from "@astryxdesign/core/Button"

import { FragmentCard } from "@/components/shard/fragment-card"
import { MarkdownDocument } from "@/components/shard/markdown-document"
import {
  getCodexAgentStatus,
  getApiErrorMessage,
  runCodexReviewTask,
} from "@/lib/api"
import {
  codexReviewFragments,
  dailyReviewFragments,
  insightFragmentCharLimit,
  insightReviewFragments,
  randomWalkFragments,
  reviewFragmentSummary,
} from "@/lib/review-workflows"
import { cn } from "@/lib/utils"
import type {
  CodexAgentStatus,
  CodexInsightLens,
  CodexReviewTask,
  Fragment,
  FragmentFilter,
} from "@/types"

type ReviewMode = Extract<FragmentFilter, "dailyReview" | "insight" | "walk">

interface ReviewWorkspaceProps {
  editingFragmentId?: string | null
  fragments: Fragment[]
  isLoading: boolean
  knownTags?: string[]
  mode: ReviewMode
  onArchive?: (fragment: Fragment) => void
  onCancelEdit?: () => void
  onCreate: (content: string, tags: string[]) => Promise<void>
  onEdit?: (fragment: Fragment) => void
  onExportImage?: (fragment: Fragment) => void
  onMoveToLockbox?: (fragment: Fragment) => void
  onOpenZen?: (fragment: Fragment) => void
  onPin?: (fragment: Fragment) => void
  onSave?: (id: string, content: string, tags: string[]) => Promise<Fragment>
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
    title: "洞察视角",
    description:
      "选择任意视角，让本机 Codex 只读分析全部未归档笔记（不含密匣与 AI 洞察）。",
    icon: SparklesIcon,
  },
  walk: {
    title: "随机漫步",
    description: "抽取一串片段路径，再让 Codex 解释其中可能的意外连接。",
    icon: RouteIcon,
  },
}

const insightLenses: Array<{
  id: CodexInsightLens
  title: string
  description: string
  focus: string
  icon: typeof SparklesIcon
}> = [
  {
    id: "default",
    title: "默认洞察",
    description: "挖掘笔记背后反复出现的思维模式、关注点和内在张力。",
    focus: "主题复盘",
    icon: BrainCircuitIcon,
  },
  {
    id: "values",
    title: "价值澄清",
    description: "从取舍、反复记录和情绪强度里找出你真正看重的东西。",
    focus: "取舍判断",
    icon: ScaleIcon,
  },
  {
    id: "reverse",
    title: "逆向思考",
    description: "反过来审视笔记中的默认假设、遗漏条件和可能误判。",
    focus: "假设检查",
    icon: RotateCcwIcon,
  },
  {
    id: "secondOrder",
    title: "二阶思考",
    description: "识别表层问题背后的上游原因，以及继续行动的二阶影响。",
    focus: "影响推演",
    icon: GitBranchIcon,
  },
  {
    id: "cbt",
    title: "CBT 视角",
    description: "识别笔记中的自动想法、认知陷阱，并生成更平衡的替代想法。",
    focus: "思维校准",
    icon: HeartHandshakeIcon,
  },
  {
    id: "mbti",
    title: "MBTI 分析",
    description: "从笔记内容中观察偏好倾向，生成非定型的人格视角分析。",
    focus: "偏好识别",
    icon: CompassIcon,
  },
]

const insightLensById = Object.fromEntries(
  insightLenses.map((lens) => [lens.id, lens])
) as Record<CodexInsightLens, (typeof insightLenses)[number]>

const insightLensGroups: Array<{
  title: string
  lensIds: CodexInsightLens[]
}> = [
  { title: "思维复盘", lensIds: ["default", "reverse", "secondOrder"] },
  { title: "自我觉察", lensIds: ["values", "cbt", "mbti"] },
]

export function ReviewWorkspace({
  editingFragmentId = null,
  fragments,
  isLoading,
  knownTags = [],
  mode,
  onArchive,
  onCancelEdit,
  onCreate,
  onEdit,
  onExportImage,
  onMoveToLockbox,
  onOpenZen,
  onPin,
  onSave,
  onToggleTask,
  vaultPath,
}: ReviewWorkspaceProps) {
  const [dailySeed, setDailySeed] = useState(() => daySeed())
  const [walkSeed, setWalkSeed] = useState(() => daySeed() + 17)
  const [selectedInsightLens, setSelectedInsightLens] =
    useState<CodexInsightLens>("default")
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
  const insightFragments = useMemo(
    () => insightReviewFragments(fragments),
    [fragments]
  )
  const walkFragments = useMemo(
    () => randomWalkFragments(fragments, walkSeed),
    [fragments, walkSeed]
  )
  const displayFragments =
    mode === "walk"
      ? walkFragments
      : mode === "insight"
        ? insightFragments
        : dailyFragments
  const meta = modeMeta[mode]
  const MetaIcon = meta.icon
  const canRunCodex = Boolean(codexStatus?.installed)
  const selectedInsightLensMeta = insightLensById[selectedInsightLens]

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
    const selectedFragments = task === "walk" ? walkFragments : insightFragments
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
        task === "insight"
          ? codexReviewFragments(
              selectedFragments,
              insightFragmentCharLimit(selectedFragments.length)
            )
          : codexReviewFragments(selectedFragments),
        vaultPath,
        task === "insight" ? selectedInsightLens : undefined
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
      await onCreate(`${selectedInsightLensMeta.title}\n\n${content}`, [
        "inbox",
        "ai/insight",
        `insight/${selectedInsightLens}`,
      ])
    } finally {
      setIsSavingInsight(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ReviewHeader
        icon={MetaIcon}
        mode={mode}
        summary={reviewFragmentSummary(
          displayFragments,
          mode === "insight" ? "笔记" : "片段"
        )}
        title={meta.title}
        description={meta.description}
        onRefreshDaily={() => {
          setDailySeed((current) => current + 1)
        }}
        onRefreshWalk={() => {
          setWalkSeed((current) => current + 1)
          setWalkText("")
        }}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <ReviewEmpty icon={MetaIcon} message="正在读取 Shard vault..." />
        ) : displayFragments.length === 0 ? (
          <ReviewEmpty icon={MetaIcon} message="还没有可回顾的片段。" />
        ) : (
          <div className="shard-content-inset pb-[var(--shard-space-8)]">
            <div className="shard-content-measure flex flex-col gap-[var(--shard-card-gap)]">
              {mode === "insight" ? (
                <>
                  <InsightLensGallery
                    selectedLens={selectedInsightLens}
                    onSelect={(lens) => {
                      setSelectedInsightLens(lens)
                      setInsightText("")
                    }}
                  />
                  <CodexPanel
                    actionLabel={isRunningInsight ? "洞察中" : "开始洞察"}
                    canRun={canRunCodex && !isRunningInsight}
                    error={codexError}
                    isChecking={isCheckingCodex}
                    isRunning={isRunningInsight}
                    onRun={() => void runCodex("insight")}
                    result={insightText}
                    status={codexStatus}
                    title={selectedInsightLensMeta.title}
                    onSave={insightText ? saveInsight : undefined}
                    isSaving={isSavingInsight}
                  />
                </>
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

              {mode !== "insight" ? (
                <div className="flex flex-col gap-[var(--shard-card-gap)]">
                  {displayFragments.map((fragment, index) => (
                    <div
                      className="grid grid-cols-[28px_minmax(0,1fr)] gap-[var(--shard-space-3)]"
                      key={fragment.id}
                    >
                      {mode === "walk" ? (
                        <div className="flex flex-col items-center pt-[var(--shard-space-4)]">
                          <span className="flex size-6 items-center justify-center rounded-full border border-border bg-background text-xs font-bold text-muted-foreground tabular-nums">
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
                        isEditing={editingFragmentId === fragment.id}
                        knownTags={knownTags}
                        onArchive={onArchive}
                        onCancelEdit={onCancelEdit}
                        onEdit={onEdit}
                        onExportImage={onExportImage}
                        onMoveToLockbox={onMoveToLockbox}
                        onOpenZen={onOpenZen}
                        onPin={onPin}
                        onSave={onSave}
                        onToggleTask={onToggleTask}
                        vaultPath={vaultPath}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
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
  mode,
  onRefreshDaily,
  onRefreshWalk,
  summary,
  title,
}: ReviewHeaderProps) {
  return (
    <header className="shard-content-inset shrink-0 pb-[var(--shard-space-3)]">
      <div className="shard-content-measure flex flex-wrap items-center justify-between gap-[var(--shard-space-3)] border-b border-border pb-[var(--shard-space-3)]">
        <div className="flex min-w-0 items-center gap-[var(--shard-space-2)]">
          <h1 className="truncate text-base leading-6 font-semibold text-balance">
            {title}
          </h1>
          <Badge className="shrink-0" label={summary} />
        </div>
        <div className="flex shrink-0 items-center gap-[var(--shard-space-2)]">
          {mode === "dailyReview" ? (
            <Button label="换一组" size="sm" onClick={onRefreshDaily} />
          ) : null}
          {mode === "walk" ? (
            <Button label="换路径" size="sm" onClick={onRefreshWalk} />
          ) : null}
        </div>
      </div>
    </header>
  )
}

function InsightLensGallery({
  selectedLens,
  onSelect,
}: {
  selectedLens: CodexInsightLens
  onSelect: (lens: CodexInsightLens) => void
}) {
  return (
    <section
      aria-label="洞察视角选择"
      className="flex flex-col gap-[var(--shard-space-8)]"
    >
      {insightLensGroups.map((group) => (
        <div key={group.title}>
          <h2 className="px-1 text-xl leading-7 font-bold text-balance">
            {group.title}
          </h2>
          <div className="mt-[var(--shard-space-4)] grid gap-[var(--shard-space-3)] md:grid-cols-3">
            {group.lensIds.map((lensId) => {
              const lens = insightLensById[lensId]
              const Icon = lens.icon
              const isSelected = lens.id === selectedLens
              return (
                <button
                  aria-pressed={isSelected}
                  className={[
                    "group/lens flex min-h-[176px] flex-col rounded-[var(--shard-surface-radius)] border p-[var(--shard-space-5)] text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/[var(--shard-alpha-34)]",
                    isSelected
                      ? "border-[rgb(var(--shard-primary-rgb)/var(--shard-alpha-34))] bg-[rgb(var(--shard-primary-rgb)/var(--shard-alpha-5))]"
                      : "border-border bg-card hover:border-[rgb(var(--shard-primary-rgb)/var(--shard-alpha-21))]",
                  ].join(" ")}
                  key={lens.id}
                  onClick={() => onSelect(lens.id)}
                  type="button"
                >
                  <span className="flex items-start justify-between gap-[var(--shard-space-4)]">
                    <span
                      className={[
                        "flex size-11 items-center justify-center rounded-[var(--shard-radius-control)] border bg-background transition-colors",
                        isSelected
                          ? "border-[rgb(var(--shard-primary-rgb)/var(--shard-alpha-21))] text-[color:var(--shard-sapphire)]"
                          : "border-transparent text-foreground group-hover/lens:border-border",
                      ].join(" ")}
                    >
                      <Icon className="size-6 stroke-[1.75]" />
                    </span>
                    <span
                      aria-hidden="true"
                      className={[
                        "relative flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
                        isSelected
                          ? "bg-[color:var(--shard-sapphire)] text-white"
                          : "border border-border bg-background text-muted-foreground group-hover/lens:border-[color:var(--shard-sapphire)] group-hover/lens:text-[color:var(--shard-sapphire)]",
                      ].join(" ")}
                    >
                      <span
                        className={cn(
                          "absolute inset-0 flex items-center justify-center transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)]",
                          isSelected
                            ? "scale-100 opacity-100 blur-0"
                            : "scale-[0.25] opacity-0 blur-[4px]"
                        )}
                      >
                        <CheckIcon className="size-4 stroke-[2]" />
                      </span>
                      <span
                        className={cn(
                          "flex items-center justify-center transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)]",
                          isSelected
                            ? "scale-[0.25] opacity-0 blur-[4px]"
                            : "scale-100 opacity-100 blur-0"
                        )}
                      >
                        <PlusIcon className="size-4 stroke-[2]" />
                      </span>
                    </span>
                  </span>

                  <span className="mt-[var(--shard-space-5)] block text-lg leading-6 font-bold text-balance">
                    {lens.title}
                  </span>
                  <span className="mt-[var(--shard-space-3)] line-clamp-3 block text-sm leading-6 text-pretty text-muted-foreground">
                    {lens.description}
                  </span>
                  <span className="mt-auto pt-[var(--shard-space-5)] text-xs leading-4 text-muted-foreground">
                    适合：{lens.focus}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </section>
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
            <h2 className="text-sm font-bold text-balance">{title}</h2>
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
              isDisabled={isSaving || isRunning}
              label={isSaving ? "保存中" : "保存为片段"}
              onClick={() => void onSave()}
              size="sm"
            />
          ) : null}
          <Button
            isDisabled={!canRun || isChecking}
            label={actionLabel}
            onClick={onRun}
            size="sm"
            variant="primary"
          />
        </div>
      </div>

      {error ? (
        <div className="mt-[var(--shard-space-3)] flex gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] border border-[rgb(var(--shard-ruby-rgb)/var(--shard-alpha-34))] bg-[rgb(var(--shard-ruby-rgb)/var(--shard-alpha-8))] px-[var(--shard-space-3)] py-[var(--shard-space-2)] text-xs leading-5 text-[color:var(--shard-ruby)]">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="text-pretty">{error}</span>
        </div>
      ) : null}

      {result ? (
        <MarkdownDocument
          className="mt-[var(--shard-space-4)]"
          content={result}
        />
      ) : (
        <div className="mt-[var(--shard-space-4)] text-sm leading-6 text-pretty text-muted-foreground">
          {isRunning ? "Codex 正在只读分析所选笔记..." : "生成后会显示在这里。"}
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
      <div className="text-sm font-semibold text-balance">{message}</div>
    </div>
  )
}

function daySeed() {
  const now = new Date()
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate()
}
