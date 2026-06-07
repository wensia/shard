import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { BottomTabs } from "@/components/shard/bottom-tabs"
import { CaptureBox } from "@/components/shard/capture-box"
import { FragmentEditor } from "@/components/shard/fragment-editor"
import { FragmentTimeline } from "@/components/shard/fragment-timeline"
import { SidebarNav } from "@/components/shard/sidebar-nav"
import { TaggedPanel, type TaggedSummary } from "@/components/shard/tagged-panel"
import { VaultGuide } from "@/components/shard/vault-guide"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  archiveFragment,
  createFragment,
  listFragments,
  syncVault,
  updateFragment,
} from "@/lib/api"
import { toggleTaskLine } from "@/lib/editor-format"
import type { Fragment, FragmentFilter, GitInfo, VaultState } from "@/types"

function App() {
  const [fragments, setFragments] = useState<Fragment[]>([])
  const [git, setGit] = useState<GitInfo | null>(null)
  const [vaultPath, setVaultPath] = useState("")
  const [filter, setFilter] = useState<FragmentFilter>("inbox")
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [composerCollapseSignal, setComposerCollapseSignal] = useState(0)
  const [editingFragmentId, setEditingFragmentId] = useState<string | null>(null)
  const [isVaultGuideOpen, setIsVaultGuideOpen] = useState(false)
  const [needsVaultSetup, setNeedsVaultSetup] = useState(false)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)

  useEffect(() => {
    void refreshFragments()
  }, [])

  async function refreshFragments() {
    setIsLoading(true)
    try {
      const state = await listFragments()
      applyVaultState(state)
    } catch (error) {
      if (isVaultNotConfigured(error)) {
        setFragments([])
        setGit(null)
        setVaultPath("")
        setNeedsVaultSetup(true)
        setIsVaultGuideOpen(true)
        return
      }

      toast.error("读取 Shard vault 失败", {
        description: String(error),
      })
    } finally {
      setIsLoading(false)
    }
  }

  function applyVaultState(state: VaultState) {
    setFragments(state.fragments)
    setGit(state.git)
    setVaultPath(state.vaultPath)
    setNeedsVaultSetup(false)
  }

  function handleVaultState(state: VaultState) {
    applyVaultState(state)
    setEditingFragmentId(null)
    setSelectedTag(null)
    setFilter("inbox")
    setIsVaultGuideOpen(false)
  }

  async function handleCreate(content: string, tags: string[]) {
    setIsCreating(true)
    const optimisticId = `pending-${Date.now()}`
    const pendingFragment: Fragment = {
      id: optimisticId,
      content,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags,
      category: null,
      path: "",
      gitStatus: "saved",
      error: null,
      archived: false,
    }

    setFragments((current) => [pendingFragment, ...current])

    try {
      const created = await createFragment(content, tags)
      setFragments((current) =>
        current.map((fragment) =>
          fragment.id === optimisticId ? created : fragment
        )
      )
      if (created.gitStatus === "commit_failed") {
        toast.warning("片段已保存，但 Git commit 失败", {
          description: created.error ?? "可以继续记录，之后再处理 Git 配置。",
        })
      } else {
        toast.success("片段已保存")
      }
      void refreshFragments()
    } catch (error) {
      setFragments((current) =>
        current.filter((fragment) => fragment.id !== optimisticId)
      )
      toast.error("创建片段失败", {
        description: String(error),
      })
    } finally {
      setIsCreating(false)
    }
  }

  async function handleSync() {
    setIsSyncing(true)
    try {
      const synced = await syncVault()
      setGit(synced)
      toast.success("同步完成")
      void refreshFragments()
    } catch (error) {
      if (isGitSetupError(error)) {
        setIsVaultGuideOpen(true)
        void refreshFragments()
        toast.warning("需要完成 Git 配置", {
          description: String(error),
        })
        return
      }

      toast.error("同步失败", {
        description: String(error),
      })
    } finally {
      setIsSyncing(false)
    }
  }

  async function handleUpdateFragment(id: string, content: string, tags: string[]) {
    const updated = await updateFragment(id, content, tags)
    setFragments((current) =>
      current.map((fragment) => (fragment.id === id ? updated : fragment))
    )
    return updated
  }

  async function handleToggleFragmentTask(fragment: Fragment, lineIndex: number) {
    const nextContent = toggleTaskLine(fragment.content, lineIndex)
    if (nextContent === fragment.content) return

    setFragments((current) =>
      current.map((currentFragment) =>
        currentFragment.id === fragment.id
          ? { ...currentFragment, content: nextContent }
          : currentFragment
      )
    )

    try {
      const updated = await updateFragment(fragment.id, nextContent, fragment.tags)
      setFragments((current) =>
        current.map((currentFragment) =>
          currentFragment.id === fragment.id ? updated : currentFragment
        )
      )
    } catch (error) {
      setFragments((current) =>
        current.map((currentFragment) =>
          currentFragment.id === fragment.id ? fragment : currentFragment
        )
      )
      toast.error("更新复选框失败", {
        description: String(error),
      })
    }
  }

  async function handleArchiveFragment(fragment: Fragment) {
    if (fragment.archived) return

    const confirmed = window.confirm("确认归档这条片段？归档后可在 Archive 中查看。")
    if (!confirmed) return

    try {
      const archived = await archiveFragment(fragment.id)
      setFragments((current) =>
        current.map((currentFragment) =>
          currentFragment.id === fragment.id ? archived : currentFragment
        )
      )
      if (editingFragmentId === fragment.id) {
        setEditingFragmentId(null)
      }
      toast.success("已归档")
    } catch (error) {
      toast.error("归档失败", {
        description: String(error),
      })
    }
  }

  const activeFragments = useMemo(
    () => fragments.filter((fragment) => !fragment.archived),
    [fragments]
  )

  const archivedFragments = useMemo(
    () => fragments.filter((fragment) => fragment.archived),
    [fragments]
  )

  const taggedFragments = useMemo(
    () => activeFragments.filter(hasVisibleTag),
    [activeFragments]
  )

  const tagSummaries = useMemo(
    () => buildTagSummaries(activeFragments),
    [activeFragments]
  )

  useEffect(() => {
    if (
      selectedTag &&
      !tagSummaries.some((summary) => summary.tag === selectedTag)
    ) {
      setSelectedTag(null)
    }
  }, [selectedTag, tagSummaries])

  const filteredFragments = useMemo(() => {
    switch (filter) {
      case "tagged":
        return selectedTag
          ? activeFragments.filter((fragment) =>
              fragment.tags.includes(selectedTag)
            )
          : taggedFragments
      case "ai":
        return activeFragments.filter(
          (fragment) => fragment.aiStatus === "suggested"
        )
      case "archive":
        return archivedFragments
      case "inbox":
      default:
        return activeFragments.filter((fragment) =>
          fragment.tags.includes("inbox")
        )
    }
  }, [activeFragments, archivedFragments, filter, selectedTag, taggedFragments])

  const knownTags = useMemo(
    () =>
      Array.from(
        new Set(
          activeFragments
            .flatMap((fragment) => fragment.tags)
            .filter((tag) => tag !== "inbox")
        )
      ).sort((a, b) => a.localeCompare(b)),
    [activeFragments]
  )

  const editingFragment = useMemo(
    () =>
      editingFragmentId
        ? fragments.find((fragment) => fragment.id === editingFragmentId) ?? null
        : null,
    [editingFragmentId, fragments]
  )
  const isInboxView = filter === "inbox"

  return (
    <TooltipProvider>
      <main className="grid h-dvh grid-rows-[1fr_auto] overflow-hidden bg-background text-foreground lg:grid-cols-[var(--shard-sidebar-width)_minmax(0,1fr)] lg:grid-rows-1">
        <div className="hidden min-h-0 lg:block">
          <SidebarNav
            activeFilter={filter}
            fragments={fragments}
            git={git}
            isSyncing={isSyncing}
            onFilterChange={setFilter}
            onOpenSettings={() => setIsVaultGuideOpen(true)}
            onSync={handleSync}
            vaultPath={vaultPath}
          />
        </div>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {isInboxView ? (
            <div className="px-[var(--shard-content-inset)] pt-[var(--shard-composer-top-gap)] pb-[var(--shard-composer-bottom-gap)] lg:px-[var(--shard-content-inset-lg)]">
              <CaptureBox
                collapseSignal={composerCollapseSignal}
                isCreating={isCreating}
                knownTags={knownTags}
                onCreate={handleCreate}
              />
            </div>
          ) : (
            <div
              aria-hidden="true"
              className="h-[var(--shard-composer-top-gap)] shrink-0"
            />
          )}

          {filter === "tagged" ? (
            <TaggedPanel
              selectedTag={selectedTag}
              summaries={tagSummaries}
              totalCount={taggedFragments.length}
              onSelectTag={setSelectedTag}
            />
          ) : null}

          <FragmentTimeline
            emptyMessage={
              filter === "tagged"
                ? "还没有带标签的内容。到 Inbox 输入 #标签 即可归类。"
                : filter === "ai"
                  ? "还没有 AI 建议。"
                  : filter === "archive"
                    ? "还没有归档内容。"
                    : undefined
            }
            fragments={filteredFragments}
            isLoading={isLoading}
            onArchive={handleArchiveFragment}
            onEdit={(fragment) => setEditingFragmentId(fragment.id)}
            onScrollDown={() => {
              setComposerCollapseSignal((current) => current + 1)
            }}
            onToggleTask={(fragment, lineIndex) => {
              void handleToggleFragmentTask(fragment, lineIndex)
            }}
          />
        </section>
        <div className="lg:hidden">
          <BottomTabs
            activeFilter={filter}
            fragments={fragments}
            git={git}
            isSyncing={isSyncing}
            onFilterChange={setFilter}
            onOpenSettings={() => setIsVaultGuideOpen(true)}
            onSync={handleSync}
            vaultPath={vaultPath}
          />
        </div>
      </main>
      <FragmentEditor
        fragment={editingFragment}
        knownTags={knownTags}
        onClose={() => setEditingFragmentId(null)}
        onSave={handleUpdateFragment}
      />
      <VaultGuide
        git={git}
        onClose={() => {
          if (!needsVaultSetup) {
            setIsVaultGuideOpen(false)
          }
        }}
        onVaultState={handleVaultState}
        open={isVaultGuideOpen || needsVaultSetup}
        required={needsVaultSetup}
        vaultPath={vaultPath}
      />
      <Toaster />
    </TooltipProvider>
  )
}

export default App

function isVaultNotConfigured(error: unknown) {
  return String(error).includes("vault_not_configured")
}

function isGitSetupError(error: unknown) {
  const message = String(error)
  return message.includes("Git 未初始化") || message.includes("Git remote 未配置")
}

function hasVisibleTag(fragment: Fragment) {
  return fragment.tags.some((tag) => tag !== "inbox")
}

function buildTagSummaries(fragments: Fragment[]): TaggedSummary[] {
  const summaries = new Map<string, TaggedSummary>()

  for (const fragment of fragments) {
    const tags = new Set(fragment.tags.filter((tag) => tag !== "inbox"))

    for (const tag of tags) {
      const current = summaries.get(tag)

      summaries.set(tag, {
        count: (current?.count ?? 0) + 1,
        latestAt:
          current && current.latestAt > fragment.createdAt
            ? current.latestAt
            : fragment.createdAt,
        tag,
      })
    }
  }

  return Array.from(summaries.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    if (b.latestAt !== a.latestAt) return b.latestAt.localeCompare(a.latestAt)
    return a.tag.localeCompare(b.tag)
  })
}
