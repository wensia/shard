import {
  CalendarDaysIcon,
  CircleAlertIcon,
  RouteIcon,
  SparklesIcon,
} from "@/components/icons"
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"

import { FragmentCard } from "@/components/shard/fragment-card"
import { MarkdownDocument } from "@/components/shard/markdown-document"
import {
  getAiAgentStatuses,
  getApiErrorMessage,
  linkFragments,
  runAiReviewTask,
} from "@/lib/api"
import { markdownToSearchText } from "@/lib/fragment-search"
import { LOCKBOX_TAG } from "@/lib/lockbox"
import {
  codexReviewFragments,
  dailyReviewFragments,
  insightFragmentCharLimit,
  insightReviewFragments,
  parseSuggestedEdges,
  randomWalkFragments,
  reviewFragmentSummary,
} from "@/lib/review-workflows"
import { cn } from "@/lib/utils"
import type {
  AiAgentKind,
  AiAgentStatus,
  CodexInsightLens,
  CodexReviewTask,
  CsvFileSummary,
  Fragment,
  FragmentFilter,
} from "@/types"

import styles from "./review-workspace.module.css"

type ReviewMode = Extract<FragmentFilter, "dailyReview" | "insight" | "walk">

interface ReviewWorkspaceProps {
  csvFiles?: CsvFileSummary[]
  editingFragmentId?: string | null
  fragments: Fragment[]
  insightIncludeLockbox: boolean
  isLoading: boolean
  knownTags?: string[]
  lockboxConfigured: boolean
  mode: ReviewMode
  onArchive?: (fragment: Fragment) => void
  onCancelEdit?: () => void
  onCreate: (content: string, tags: string[]) => Promise<void>
  onEdit?: (fragment: Fragment) => void
  onExportImage?: (fragment: Fragment) => void
  onInsightIncludeLockboxChange: (next: boolean) => void
  onMoveToLockbox?: (fragment: Fragment) => void
  onOpenZen?: (fragment: Fragment) => void
  onPin?: (fragment: Fragment) => void
  onSave?: (id: string, content: string, tags: string[]) => Promise<Fragment>
  onToggleKind?: (fragment: Fragment) => void
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
    description: "从近 6 个月未删除的片段里抽取 8 条，先回看，不打断捕捉。",
    icon: CalendarDaysIcon,
  },
  insight: {
    title: "洞察视角",
    description:
      "选择任意视角与本机 AI 运行器，只读分析全部未删除笔记（不含密匣与 AI 洞察）。",
    icon: SparklesIcon,
  },
  walk: {
    title: "随机漫步",
    description: "抽取一串片段路径，再让本机 AI 解释其中可能的意外连接。",
    icon: RouteIcon,
  },
}

const agentLabels: Record<AiAgentKind, string> = {
  codex: "Codex",
  claude: "Claude Code",
  kimi: "Kimi Code",
  opencode: "OpenCode",
}

// 含密匣洞察只允许 stdin 传输密匣内容的运行器（Claude / Codex），
// Kimi / OpenCode 走 argv 会泄露明文，这里在选择层直接禁用
const LOCKBOX_BLOCKED_AGENTS: readonly AiAgentKind[] = ["kimi", "opencode"]

const insightLenses: Array<{
  id: CodexInsightLens
  title: string
  description: string
  focus: string
}> = [
  {
    id: "default",
    title: "默认洞察",
    description: "挖掘笔记背后反复出现的思维模式、关注点和内在张力。",
    focus: "主题复盘",
  },
  {
    id: "values",
    title: "价值澄清",
    description: "从取舍、反复记录和情绪强度里找出你真正看重的东西。",
    focus: "取舍判断",
  },
  {
    id: "reverse",
    title: "逆向思考",
    description: "反过来审视笔记中的默认假设、遗漏条件和可能误判。",
    focus: "假设检查",
  },
  {
    id: "secondOrder",
    title: "二阶思考",
    description: "识别表层问题背后的上游原因，以及继续行动的二阶影响。",
    focus: "影响推演",
  },
  {
    id: "cbt",
    title: "CBT 视角",
    description: "识别笔记中的自动想法、认知陷阱，并生成更平衡的替代想法。",
    focus: "思维校准",
  },
  {
    id: "mbti",
    title: "MBTI 分析",
    description: "从笔记内容中观察偏好倾向，生成非定型的人格视角分析。",
    focus: "偏好识别",
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
  csvFiles = [],
  editingFragmentId = null,
  fragments,
  insightIncludeLockbox,
  isLoading,
  knownTags = [],
  lockboxConfigured,
  mode,
  onArchive,
  onCancelEdit,
  onCreate,
  onEdit,
  onExportImage,
  onInsightIncludeLockboxChange,
  onMoveToLockbox,
  onOpenZen,
  onPin,
  onSave,
  onToggleKind,
  onToggleTask,
  vaultPath,
}: ReviewWorkspaceProps) {
  const [dailySeed, setDailySeed] = useState(() => daySeed())
  const [walkSeed, setWalkSeed] = useState(() => daySeed() + 17)
  const [selectedInsightLens, setSelectedInsightLens] =
    useState<CodexInsightLens>("default")
  const [agentStatuses, setAgentStatuses] = useState<AiAgentStatus[]>([])
  const [selectedAgent, setSelectedAgent] = useState<AiAgentKind | null>(null)
  const [agentError, setAgentError] = useState<string | null>(null)
  const [isCheckingAgents, setIsCheckingAgents] = useState(false)
  const [isRunningInsight, setIsRunningInsight] = useState(false)
  const [isRunningWalk, setIsRunningWalk] = useState(false)
  const [insightText, setInsightText] = useState("")
  const [insightResultLens, setInsightResultLens] =
    useState<CodexInsightLens>("default")
  const [insightResultAgent, setInsightResultAgent] =
    useState<AiAgentKind | null>(null)
  const [insightResultIncludesLockbox, setInsightResultIncludesLockbox] =
    useState(false)
  const [walkText, setWalkText] = useState("")
  const [walkResultAgent, setWalkResultAgent] = useState<AiAgentKind | null>(null)
  const [preservedWalkEdges, setPreservedWalkEdges] = useState<Set<string>>(
    () => new Set()
  )
  const [savingWalkEdges, setSavingWalkEdges] = useState<Set<string>>(
    () => new Set()
  )
  const [isSavingInsight, setIsSavingInsight] = useState(false)

  const dailyFragments = useMemo(
    () => dailyReviewFragments(fragments, dailySeed),
    [dailySeed, fragments]
  )
  const insightFragments = useMemo(
    () =>
      insightReviewFragments(fragments, {
        includeLockbox: insightIncludeLockbox,
      }),
    [fragments, insightIncludeLockbox]
  )
  const walkFragments = useMemo(
    () => randomWalkFragments(fragments, walkSeed),
    [fragments, walkSeed]
  )
  const suggestedWalkEdges = useMemo(
    () => parseSuggestedEdges(walkText, walkFragments),
    [walkFragments, walkText]
  )
  const displayFragments =
    mode === "walk"
      ? walkFragments
      : mode === "insight"
        ? insightFragments
        : dailyFragments
  const meta = modeMeta[mode]
  const MetaIcon = meta.icon
  const selectedAgentStatus = agentStatuses.find(
    (status) => status.agent === selectedAgent
  )
  const canRunAgent = Boolean(selectedAgentStatus?.installed)
  const insightAgentBlocked =
    insightIncludeLockbox &&
    selectedAgent !== null &&
    LOCKBOX_BLOCKED_AGENTS.includes(selectedAgent)
  const canRunInsight = canRunAgent && !insightAgentBlocked
  const insightDescription = insightIncludeLockbox
    ? "选择任意视角与本机 AI 运行器，只读分析全部未删除笔记（含密匣，不含既往 AI 洞察）。"
    : modeMeta.insight.description
  const selectedInsightLensMeta = insightLensById[selectedInsightLens]

  useEffect(() => {
    if (mode !== "insight" && mode !== "walk") return

    let isMounted = true
    setIsCheckingAgents(true)
    setAgentError(null)

    getAiAgentStatuses()
      .then((statuses) => {
        if (!isMounted) return
        setAgentStatuses(statuses)
        setSelectedAgent((current) => {
          if (current && statuses.some((item) => item.agent === current && item.installed)) {
            return current
          }
          return statuses.find((item) => item.installed)?.agent ?? null
        })
        if (!statuses.some((item) => item.installed)) {
          setAgentError("未检测到可用的 AI CLI。请先安装 Codex、Claude Code、Kimi Code 或 OpenCode。")
        }
      })
      .catch((error) => {
        if (!isMounted) return
        setAgentStatuses([])
        setSelectedAgent(null)
        setAgentError(getApiErrorMessage(error))
      })
      .finally(() => {
        if (isMounted) setIsCheckingAgents(false)
      })

    return () => {
      isMounted = false
    }
  }, [mode])

  async function runCodex(task: CodexReviewTask) {
    const selectedFragments = task === "walk" ? walkFragments : insightFragments
    if (selectedFragments.length === 0 || !selectedAgent) return

    setAgentError(null)
    const runningAgent = selectedAgent
    if (task === "walk") {
      setIsRunningWalk(true)
    } else {
      setIsRunningInsight(true)
    }

    try {
      const result = await runAiReviewTask(
        runningAgent,
        task,
        task === "insight"
          ? codexReviewFragments(
              selectedFragments,
              insightFragmentCharLimit(selectedFragments.length)
            )
          : codexReviewFragments(selectedFragments),
        vaultPath,
        task === "insight" ? selectedInsightLens : undefined,
        task === "insight" ? insightIncludeLockbox : undefined
      )
      if (task === "walk") {
        setWalkText(result.text)
        setWalkResultAgent(runningAgent)
        setPreservedWalkEdges(new Set())
        setSavingWalkEdges(new Set())
      } else {
        // 结果标题记录实际来源视角；之后再切换选择不影响已生成内容。
        setInsightResultLens(selectedInsightLens)
        setInsightResultAgent(runningAgent)
        setInsightResultIncludesLockbox(insightIncludeLockbox)
        setInsightText(result.text)
      }
    } catch (error) {
      setAgentError(getApiErrorMessage(error))
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
      // 含密匣的洞察结果只能回到密匣：加「密匣」标签走加密存储链路
      // （handleCreate 按 wantsLockbox 判定），且不带 inbox 标签
      await onCreate(
        `${insightLensById[insightResultLens].title}\n\n${content}`,
        insightResultIncludesLockbox
          ? [LOCKBOX_TAG, "ai/insight", `insight/${insightResultLens}`]
          : ["inbox", "ai/insight", `insight/${insightResultLens}`]
      )
    } finally {
      setIsSavingInsight(false)
    }
  }

  async function preserveWalkEdge(
    fromId: string,
    toId: string,
    reason: string
  ) {
    const edgeKey = walkEdgeKey(fromId, toId)
    if (preservedWalkEdges.has(edgeKey) || savingWalkEdges.has(edgeKey)) return

    setSavingWalkEdges((current) => new Set(current).add(edgeKey))
    try {
      await linkFragments(fromId, toId, "walk", reason)
      setPreservedWalkEdges((current) => new Set(current).add(edgeKey))
    } catch (error) {
      toast.error(`保留关联失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    } finally {
      setSavingWalkEdges((current) => {
        const next = new Set(current)
        next.delete(edgeKey)
        return next
      })
    }
  }

  return (
    <div
      style={{
        display: "flex",
        minHeight: 0,
        flex: 1,
        flexDirection: "column",
      }}
    >
      <ReviewHeader
        icon={MetaIcon}
        mode={mode}
        summary={reviewFragmentSummary(
          displayFragments,
          mode === "insight" ? "笔记" : "片段"
        )}
        title={meta.title}
        description={mode === "insight" ? undefined : meta.description}
        onRefreshDaily={() => {
          setDailySeed((current) => current + 1)
        }}
        onRefreshWalk={() => {
          setWalkSeed((current) => current + 1)
          setWalkText("")
          setPreservedWalkEdges(new Set())
          setSavingWalkEdges(new Set())
        }}
      />

      <div style={{ minHeight: 0, flex: 1, overflowY: "auto" }}>
        {isLoading ? (
          <ReviewEmpty icon={MetaIcon} message="正在读取 Shard vault..." />
        ) : displayFragments.length === 0 ? (
          <ReviewEmpty icon={MetaIcon} message="还没有可回顾的片段。" />
        ) : (
          <div
            className="shard-content-inset"
            style={{
              paddingTop: "var(--shard-space-4)",
              paddingBottom: "var(--shard-space-8)",
            }}
          >
            <div
              className="shard-content-measure"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--shard-space-4)",
              }}
            >
              {mode === "insight" ? (
                <div className={styles.insightMeasure}>
                  <TaskPanel
                    actionHint={
                      insightAgentBlocked
                        ? "含密匣洞察仅支持 Claude / Codex（stdin 传输），请改选运行器。"
                        : undefined
                    }
                    actionLabel={isRunningInsight ? "洞察中..." : "开始洞察"}
                    agents={agentStatuses}
                    busy={isRunningInsight}
                    canRun={canRunInsight}
                    description={insightDescription}
                    disabledAgents={
                      insightIncludeLockbox ? LOCKBOX_BLOCKED_AGENTS : undefined
                    }
                    disabledAgentsHint={
                      insightIncludeLockbox
                        ? "含密匣洞察仅支持 Claude / Codex（stdin 传输）"
                        : undefined
                    }
                    error={agentError}
                    isChecking={isCheckingAgents}
                    onRun={() => void runCodex("insight")}
                    onSelectAgent={setSelectedAgent}
                    selectedAgent={selectedAgent}
                    summary={
                      <>
                        <div className={styles.taskSummaryTitle}>
                          {selectedInsightLensMeta.title}
                        </div>
                        <div className={styles.taskSummaryDesc}>
                          {selectedInsightLensMeta.description} 适合：
                          {selectedInsightLensMeta.focus}。
                        </div>
                      </>
                    }
                    title="分析设置"
                  >
                    <InsightLensSelect
                      disabled={isRunningInsight}
                      onSelect={setSelectedInsightLens}
                      selectedLens={selectedInsightLens}
                    />
                    {lockboxConfigured ? (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "var(--shard-space-1)",
                          marginTop: "var(--shard-space-3)",
                        }}
                      >
                        <label
                          className="flex items-center gap-2 text-sm"
                          htmlFor="insight-include-lockbox"
                        >
                          <Checkbox
                            checked={insightIncludeLockbox}
                            disabled={isRunningInsight}
                            id="insight-include-lockbox"
                            onCheckedChange={onInsightIncludeLockboxChange}
                          />
                          包含密匣内容
                        </label>
                        {insightIncludeLockbox ? (
                          <p
                            style={{
                              margin: 0,
                              paddingLeft: 26,
                              fontSize: "var(--text-tiny)",
                              lineHeight: "18px",
                              color: "var(--muted-foreground)",
                              textWrap: "pretty",
                            }}
                          >
                            密匣内容将随洞察一并发送给所选 AI 运行器；生成结果保存时将自动存入密匣。
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </TaskPanel>

                  <ResultSection
                    emptyHint="选择一个视角并开始，结果会在这里展开。"
                    emptyTitle="尚未生成洞察"
                    isRunning={isRunningInsight}
                    isSaving={isSavingInsight}
                    onSave={insightText ? saveInsight : undefined}
                    result={insightText}
                    saveLabel={
                      insightResultIncludesLockbox ? "保存到密匣" : undefined
                    }
                    title={`洞察结果 · ${insightLensById[insightResultLens].title}${insightResultAgent ? ` · ${agentLabels[insightResultAgent]}` : ""}`}
                  />
                </div>
              ) : null}

              {mode === "walk" ? (
                <>
                  <TaskPanel
                    actionLabel={isRunningWalk ? "生成中..." : "生成连接理由"}
                    agents={agentStatuses}
                    busy={isRunningWalk}
                    canRun={canRunAgent}
                    error={agentError}
                    isChecking={isCheckingAgents}
                    onRun={() => void runCodex("walk")}
                    onSelectAgent={setSelectedAgent}
                    selectedAgent={selectedAgent}
                    summary={null}
                    title="漫步连接"
                  />
                  <ResultSection
                    emptyHint="点击生成按钮，连接理由会在这里展开。"
                    emptyTitle="尚未生成连接理由"
                    isRunning={isRunningWalk}
                    result={walkText}
                    title={`连接理由${walkResultAgent ? ` · ${agentLabels[walkResultAgent]}` : ""}`}
                  />
                  {suggestedWalkEdges.length > 0 ? (
                    <section
                      aria-labelledby="suggested-walk-edges-title"
                      className={styles.suggestedEdges}
                    >
                      <h2
                        className={styles.suggestedEdgesTitle}
                        id="suggested-walk-edges-title"
                      >
                        建议的关联
                      </h2>
                      <div className={styles.suggestedEdgeList}>
                        {suggestedWalkEdges.map((edge) => {
                          const edgeKey = walkEdgeKey(edge.fromId, edge.toId)
                          const fromFragment = walkFragments.find(
                            (fragment) => fragment.id === edge.fromId
                          )
                          const toFragment = walkFragments.find(
                            (fragment) => fragment.id === edge.toId
                          )
                          const isPreserved = preservedWalkEdges.has(edgeKey)
                          const isSaving = savingWalkEdges.has(edgeKey)

                          if (!fromFragment || !toFragment) return null

                          return (
                            <div className={styles.suggestedEdgeRow} key={edgeKey}>
                              <div className={styles.suggestedEdgeCopy}>
                                <div className={styles.suggestedEdgeRoute}>
                                  <span>{walkFragmentSummary(fromFragment)}</span>
                                  <span aria-hidden="true">→</span>
                                  <span>{walkFragmentSummary(toFragment)}</span>
                                </div>
                                <div className={styles.suggestedEdgeReason}>
                                  {edge.reason}
                                </div>
                              </div>
                              {isPreserved ? (
                                <span className={styles.suggestedEdgeSaved}>已保留</span>
                              ) : (
                                <Button
                                  aria-busy={isSaving}
                                  disabled={isSaving}
                                  onClick={() =>
                                    void preserveWalkEdge(
                                      edge.fromId,
                                      edge.toId,
                                      edge.reason
                                    )
                                  }
                                  size="sm"
                                  variant="default"
                                >
                                  {isSaving ? "保留中" : "保留"}
                                </Button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  ) : null}
                </>
              ) : null}

              {mode !== "insight" ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--shard-space-4)",
                  }}
                >
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
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            flexDirection: "column",
                            paddingTop: "var(--shard-space-4)",
                          }}
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
                        </div>
                      ) : (
                        <span aria-hidden="true" />
                      )}
                      <FragmentCard
                        csvFiles={csvFiles}
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
                        onToggleKind={onToggleKind}
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

function walkEdgeKey(fromId: string, toId: string) {
  return `${fromId}\u0000${toId}`
}

function walkFragmentSummary(fragment: Fragment) {
  const summary = markdownToSearchText(fragment.content).trim()
  if (summary.length <= 48) return summary
  return `${summary.slice(0, 48).trimEnd()}…`
}

interface ReviewHeaderProps {
  description?: string
  icon: typeof CalendarDaysIcon
  mode: ReviewMode
  onRefreshDaily: () => void
  onRefreshWalk: () => void
  summary: string
  title: string
}

function ReviewHeader({
  description,
  mode,
  onRefreshDaily,
  onRefreshWalk,
  summary,
  title,
}: ReviewHeaderProps) {
  return (
    <header
      className="shard-content-inset"
      style={{
        flexShrink: 0,
        borderBottom: "1px solid var(--border)",
        paddingBlock: "var(--shard-space-3)",
      }}
    >
      <div
        className="shard-content-measure"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--shard-space-3)",
        }}
      >
        <div
          style={{
            display: "flex",
            minWidth: 0,
            alignItems: "center",
            gap: "var(--shard-space-2)",
          }}
        >
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
          {/* 元信息用中性 Badge：clay 只留给"开始洞察"这个唯一主动作。 */}
          <Badge style={{ flexShrink: 0 }} variant="secondary">
            {summary}
          </Badge>
        </div>
        <div
          style={{
            display: "flex",
            flexShrink: 0,
            alignItems: "center",
            gap: "var(--shard-space-2)",
          }}
        >
          {mode === "dailyReview" ? (
            <Button
              onClick={onRefreshDaily}
              size="sm"
              variant="secondary"
            >
              换一组
            </Button>
          ) : null}
          {mode === "walk" ? (
            <Button
              onClick={onRefreshWalk}
              size="sm"
              variant="secondary"
            >
              换路径
            </Button>
          ) : null}
        </div>
      </div>
      {/* 一句话说明这页在做什么、数据边界在哪（本机只读、不含密匣），
          帮用户做"要不要跑"的决定——这是它挣到的位置。 */}
      {description ? (
        <div
          className="shard-content-measure"
          style={{
            marginTop: "var(--shard-space-1)",
            fontSize: "var(--font-size-xs)",
            lineHeight: "20px",
            color: "var(--muted-foreground)",
            textWrap: "pretty",
          }}
        >
          {description}
        </div>
      ) : null}
    </header>
  )
}

// 分组单选列表（Codex 裁决：不是 button tabs——那暗示每项有独立结果）。
// 行 = 组名 + 三个等分选项；短文本已够识别，不需要图标。
function InsightLensSelect({
  disabled = false,
  selectedLens,
  onSelect,
}: {
  disabled?: boolean
  selectedLens: CodexInsightLens
  onSelect: (lens: CodexInsightLens) => void
}) {
  return (
    <div
      aria-label="洞察视角选择"
      className={styles.lensSelect}
      role="radiogroup"
    >
      {insightLensGroups.map((group) => (
        <div className={styles.lensSelectRow} key={group.title}>
          <span className={styles.lensSelectGroup}>{group.title}</span>
          <div className={styles.lensOptionItems}>
            {group.lensIds.map((lensId) => {
              const lens = insightLensById[lensId]
              const isSelected = lens.id === selectedLens
              return (
                <button
                  aria-checked={isSelected}
                  className={cn(
                    styles.lensOption,
                    isSelected && styles.lensOptionSelected
                  )}
                  disabled={disabled}
                  key={lens.id}
                  onClick={() => onSelect(lens.id)}
                  role="radio"
                  type="button"
                >
                  {lens.title}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// 设置面板：白卡 + shadow-card，承载"这次动作"的全部参数与唯一 clay 主动作。
function TaskPanel({
  actionHint,
  actionLabel,
  agents,
  busy,
  canRun,
  children,
  description,
  disabledAgents,
  disabledAgentsHint,
  error,
  isChecking,
  onRun,
  onSelectAgent,
  selectedAgent,
  summary,
  title,
}: {
  actionHint?: string
  actionLabel: string
  agents: AiAgentStatus[]
  busy: boolean
  canRun: boolean
  children?: ReactNode
  description?: string
  disabledAgents?: readonly AiAgentKind[]
  disabledAgentsHint?: string
  error: string | null
  isChecking: boolean
  onRun: () => void
  onSelectAgent: (agent: AiAgentKind) => void
  selectedAgent: AiAgentKind | null
  summary: ReactNode
  title: string
}) {
  return (
    <section aria-busy={busy} className={styles.taskCard}>
      <h2 className={styles.taskCardTitle}>{title}</h2>
      {description ? (
        <p className={styles.taskCardDesc}>{description}</p>
      ) : null}
      {children}

      <AgentSelect
        agents={agents}
        disabled={busy || isChecking}
        disabledAgents={disabledAgents}
        disabledAgentsHint={disabledAgentsHint}
        isChecking={isChecking}
        onSelect={onSelectAgent}
        selectedAgent={selectedAgent}
      />

      <div className={styles.taskCardActionRow}>
        <div className={styles.taskCardSummary}>{summary}</div>
        <Button
          disabled={!canRun || isChecking || busy}
          onClick={onRun}
          variant="primary"
        >
          {actionLabel}
        </Button>
      </div>

      {actionHint ? (
        <p className={styles.taskCardDesc}>{actionHint}</p>
      ) : null}

      {error ? (
        <div className={styles.taskCardError}>
          <CircleAlertIcon
            className="size-(--shard-icon-size-sm)"
            style={{ marginTop: 2, flexShrink: 0 }}
          />
          <span style={{ textWrap: "pretty" }}>{error}</span>
        </div>
      ) : null}
    </section>
  )
}

function AgentSelect({
  agents,
  disabled,
  disabledAgents = [],
  disabledAgentsHint,
  isChecking,
  onSelect,
  selectedAgent,
}: {
  agents: AiAgentStatus[]
  disabled: boolean
  disabledAgents?: readonly AiAgentKind[]
  disabledAgentsHint?: string
  isChecking: boolean
  onSelect: (agent: AiAgentKind) => void
  selectedAgent: AiAgentKind | null
}) {
  const selectedStatus = agents.find((item) => item.agent === selectedAgent)
  const availableCount = agents.filter((item) => item.installed).length
  const version = selectedStatus?.version?.replace(/^codex-cli\s+/u, "")

  return (
    <div className={styles.agentField}>
      <div className={styles.agentFieldHeading}>
        <label className={styles.agentFieldLabel} htmlFor="review-agent-select">
          运行器
        </label>
        {!isChecking ? (
          <span className={styles.agentCount}>
            已识别 {availableCount}/{agents.length || 4}
          </span>
        ) : null}
      </div>
      <select
        aria-label="AI 运行器"
        className={styles.agentSelect}
        disabled={disabled || availableCount === 0}
        id="review-agent-select"
        onChange={(event) => onSelect(event.target.value as AiAgentKind)}
        value={selectedAgent ?? ""}
      >
        {selectedAgent === null ? <option value="">选择运行器</option> : null}
        {agents.map((status) => {
          const blockedByLockbox = disabledAgents.includes(status.agent)
          return (
            <option
              disabled={!status.installed || blockedByLockbox}
              key={status.agent}
              value={status.agent}
            >
              {agentLabels[status.agent]} ·{" "}
              {blockedByLockbox
                ? "含密匣时不可用"
                : status.installed
                  ? "已就绪"
                  : "未检测到"}
            </option>
          )
        })}
      </select>
      <div
        aria-live="polite"
        className={cn(
          styles.agentStatus,
          selectedStatus?.installed && styles.agentStatusReady
        )}
      >
        <span aria-hidden="true" className={styles.agentStatusDot} />
        {isChecking
          ? "正在检测本机运行器..."
          : selectedStatus?.installed
            ? `已就绪${version ? ` · ${version}` : ""}`
            : "没有可用的本机运行器"}
      </div>
      {disabledAgentsHint ? (
        <div
          style={{
            fontSize: "var(--text-tiny)",
            lineHeight: "18px",
            color: "var(--muted-foreground)",
            textWrap: "pretty",
          }}
        >
          {disabledAgentsHint}
        </div>
      ) : null}
    </div>
  )
}

// 结果区：标题 + hairline + 文档/骨架/稳定空态；保存动作属于结果，放在文档末尾。
function ResultSection({
  emptyHint,
  emptyTitle,
  isRunning,
  isSaving = false,
  onSave,
  result,
  saveLabel = "保存为片段",
  title,
}: {
  emptyHint: string
  emptyTitle: string
  isRunning: boolean
  isSaving?: boolean
  onSave?: () => Promise<void>
  result: string
  saveLabel?: string
  title: string
}) {
  return (
    <section className={styles.resultSection}>
      <h2 className={styles.resultTitle}>{title}</h2>
      {result ? (
        <>
          <div className={styles.resultBody}>
            <MarkdownDocument content={result} />
          </div>
          {onSave ? (
            <div className={styles.resultActions}>
              <Button
                disabled={isSaving}
                onClick={() => void onSave()}
                variant="default"
              >
                {isSaving ? "保存中" : saveLabel}
              </Button>
            </div>
          ) : null}
        </>
      ) : isRunning ? (
        <div aria-hidden="true" className={styles.resultSkeleton}>
          <span className={styles.skeletonBar} />
          <span className={styles.skeletonBar} style={{ width: "82%" }} />
          <span className={styles.skeletonBar} style={{ width: "64%" }} />
          <span className={styles.skeletonBar} style={{ width: "74%" }} />
        </div>
      ) : (
        <div className={styles.resultEmpty}>
          <div className={styles.resultEmptyTitle}>{emptyTitle}</div>
          <div className={styles.resultEmptyHint}>{emptyHint}</div>
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
    <div
      style={{
        display: "flex",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: "var(--shard-space-3)",
        textAlign: "center",
        color: "var(--muted-foreground)",
      }}
    >
      <Icon className="size-(--shard-icon-size-xl)" />
      <div
        style={{
          fontSize: "var(--font-size-sm)",
          fontWeight: 600,
          textWrap: "balance",
        }}
      >
        {message}
      </div>
    </div>
  )
}

function daySeed() {
  const now = new Date()
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate()
}
