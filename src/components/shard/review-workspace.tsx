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
import { Grid } from "@astryxdesign/core/Grid"
import { HStack, Stack, StackItem } from "@astryxdesign/core/Stack"

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

import styles from "./review-workspace.module.css"

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
    <Stack minHeight={0} style={{ flex: 1 }}>
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

      <StackItem size="fill" isScrollable>
        {isLoading ? (
          <ReviewEmpty icon={MetaIcon} message="正在读取 Shard vault..." />
        ) : displayFragments.length === 0 ? (
          <ReviewEmpty icon={MetaIcon} message="还没有可回顾的片段。" />
        ) : (
          <div
            className="shard-content-inset"
            style={{ paddingBottom: "var(--shard-space-8)" }}
          >
            <Stack className="shard-content-measure" gap={4}>
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
                <Stack gap={4}>
                  {displayFragments.map((fragment, index) => (
                    <div
                      key={fragment.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "28px minmax(0,1fr)",
                        gap: "var(--shard-space-3)",
                      }}
                    >
                      {mode === "walk" ? (
                        <Stack
                          hAlign="center"
                          style={{ paddingTop: "var(--shard-space-4)" }}
                        >
                          <span
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              width: 24,
                              height: 24,
                              borderRadius: "9999px",
                              border: "1px solid var(--border)",
                              background: "var(--background)",
                              fontSize: "var(--font-size-xs)",
                              fontWeight: 700,
                              color: "var(--muted-foreground)",
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {index + 1}
                          </span>
                          {index < displayFragments.length - 1 ? (
                            <span
                              aria-hidden="true"
                              style={{
                                marginTop: "var(--shard-space-2)",
                                height: "100%",
                                minHeight: 32,
                                width: 1,
                                background: "var(--border)",
                              }}
                            />
                          ) : null}
                        </Stack>
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
                </Stack>
              ) : null}
            </Stack>
          </div>
        )}
      </StackItem>
    </Stack>
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
    <header
      className="shard-content-inset"
      style={{ flexShrink: 0, paddingBottom: "var(--shard-space-3)" }}
    >
      <HStack
        className="shard-content-measure"
        wrap="wrap"
        hAlign="between"
        vAlign="center"
        gap={3}
        style={{
          borderBottom: "1px solid var(--border)",
          paddingBottom: "var(--shard-space-3)",
        }}
      >
        <HStack gap={2} vAlign="center" style={{ minWidth: 0 }}>
          <h1
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "var(--font-size-base)",
              lineHeight: "24px",
              fontWeight: 600,
              textWrap: "balance",
            }}
          >
            {title}
          </h1>
          <Badge style={{ flexShrink: 0 }} label={summary} />
        </HStack>
        <HStack gap={2} vAlign="center" style={{ flexShrink: 0 }}>
          {mode === "dailyReview" ? (
            <Button label="换一组" size="sm" onClick={onRefreshDaily} />
          ) : null}
          {mode === "walk" ? (
            <Button label="换路径" size="sm" onClick={onRefreshWalk} />
          ) : null}
        </HStack>
      </HStack>
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
    <Stack as="section" aria-label="洞察视角选择" gap={8}>
      {insightLensGroups.map((group) => (
        <div key={group.title}>
          <h2
            style={{
              paddingInline: 4,
              fontSize: "var(--font-size-xl)",
              lineHeight: "28px",
              fontWeight: 700,
              textWrap: "balance",
            }}
          >
            {group.title}
          </h2>
          <Grid
            columns={{ minWidth: 220, max: 3 }}
            gap={3}
            style={{ marginTop: "var(--shard-space-4)" }}
          >
            {group.lensIds.map((lensId) => {
              const lens = insightLensById[lensId]
              const Icon = lens.icon
              const isSelected = lens.id === selectedLens
              return (
                <button
                  aria-pressed={isSelected}
                  className={cn(
                    styles.lensCard,
                    isSelected && styles.lensCardSelected
                  )}
                  key={lens.id}
                  onClick={() => onSelect(lens.id)}
                  type="button"
                >
                  <span
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: "var(--shard-space-4)",
                    }}
                  >
                    <span
                      className={cn(
                        styles.lensIconWrap,
                        isSelected && styles.lensIconWrapSelected
                      )}
                    >
                      <Icon size={24} strokeWidth={1.75} />
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        styles.checkToggle,
                        isSelected && styles.checkToggleSelected
                      )}
                    >
                      <span
                        className={cn(
                          styles.crossfadeLayer,
                          styles.crossfadeCheck,
                          isSelected
                            ? styles.crossfadeVisible
                            : styles.crossfadeHidden
                        )}
                      >
                        <CheckIcon size={16} strokeWidth={2} />
                      </span>
                      <span
                        className={cn(
                          styles.crossfadeLayer,
                          isSelected
                            ? styles.crossfadeHidden
                            : styles.crossfadeVisible
                        )}
                      >
                        <PlusIcon size={16} strokeWidth={2} />
                      </span>
                    </span>
                  </span>

                  <span
                    style={{
                      marginTop: "var(--shard-space-5)",
                      display: "block",
                      fontSize: "var(--font-size-lg)",
                      lineHeight: "24px",
                      fontWeight: 700,
                      textWrap: "balance",
                    }}
                  >
                    {lens.title}
                  </span>
                  <span
                    style={{
                      marginTop: "var(--shard-space-3)",
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 3,
                      overflow: "hidden",
                      fontSize: "var(--font-size-sm)",
                      lineHeight: "24px",
                      textWrap: "pretty",
                      color: "var(--muted-foreground)",
                    }}
                  >
                    {lens.description}
                  </span>
                  <span
                    style={{
                      marginTop: "auto",
                      paddingTop: "var(--shard-space-5)",
                      fontSize: "var(--font-size-xs)",
                      lineHeight: "16px",
                      color: "var(--muted-foreground)",
                    }}
                  >
                    适合：{lens.focus}
                  </span>
                </button>
              )
            })}
          </Grid>
        </div>
      ))}
    </Stack>
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
    <section
      style={{
        borderRadius: "var(--shard-surface-radius)",
        border: "1px solid var(--border)",
        background: "var(--card)",
        padding: "var(--shard-card-padding-x)",
      }}
    >
      <HStack wrap="wrap" hAlign="between" vAlign="center" gap={3}>
        <div style={{ minWidth: 0 }}>
          <HStack gap={2} vAlign="center">
            <BotIcon size={16} style={{ color: "var(--shard-sapphire)" }} />
            <h2
              style={{
                fontSize: "var(--font-size-sm)",
                fontWeight: 700,
                textWrap: "balance",
              }}
            >
              {title}
            </h2>
          </HStack>
          <div
            style={{
              marginTop: 4,
              fontSize: "var(--font-size-xs)",
              lineHeight: "20px",
              color: "var(--muted-foreground)",
            }}
          >
            {isChecking
              ? "正在检测 Codex CLI..."
              : status?.installed
                ? `Codex ${status.version ?? "已安装"}`
                : "需要本机 Codex CLI"}
          </div>
        </div>

        <HStack gap={2} vAlign="center" style={{ flexShrink: 0 }}>
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
        </HStack>
      </HStack>

      {error ? (
        <HStack
          gap={2}
          paddingInline={3}
          paddingBlock={2}
          style={{
            marginTop: "var(--shard-space-3)",
            borderRadius: "var(--shard-radius-control)",
            border:
              "1px solid rgb(var(--shard-ruby-rgb) / var(--shard-alpha-34))",
            background: "rgb(var(--shard-ruby-rgb) / var(--shard-alpha-8))",
            fontSize: "var(--font-size-xs)",
            lineHeight: "20px",
            color: "var(--shard-ruby)",
          }}
        >
          <CircleAlertIcon
            size={14}
            style={{ marginTop: 2, flexShrink: 0 }}
          />
          <span style={{ textWrap: "pretty" }}>{error}</span>
        </HStack>
      ) : null}

      {result ? (
        <div style={{ marginTop: "var(--shard-space-4)" }}>
          <MarkdownDocument content={result} />
        </div>
      ) : (
        <div
          style={{
            marginTop: "var(--shard-space-4)",
            fontSize: "var(--font-size-sm)",
            lineHeight: "24px",
            textWrap: "pretty",
            color: "var(--muted-foreground)",
          }}
        >
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
    <Stack
      height="100%"
      hAlign="center"
      vAlign="center"
      gap={3}
      style={{ textAlign: "center", color: "var(--muted-foreground)" }}
    >
      <Icon size={32} />
      <div
        style={{
          fontSize: "var(--font-size-sm)",
          fontWeight: 600,
          textWrap: "balance",
        }}
      >
        {message}
      </div>
    </Stack>
  )
}

function daySeed() {
  const now = new Date()
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate()
}
