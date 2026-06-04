import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { CaptureBox } from "@/components/shard/capture-box"
import { FragmentTimeline } from "@/components/shard/fragment-timeline"
import { SidebarNav } from "@/components/shard/sidebar-nav"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { createFragment, listFragments, syncVault } from "@/lib/api"
import type { Fragment, FragmentFilter, GitInfo, VaultState } from "@/types"

function App() {
  const [fragments, setFragments] = useState<Fragment[]>([])
  const [git, setGit] = useState<GitInfo | null>(null)
  const [vaultPath, setVaultPath] = useState("")
  const [filter, setFilter] = useState<FragmentFilter>("inbox")
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)

  useEffect(() => {
    void refreshFragments()
  }, [])

  async function refreshFragments() {
    setIsLoading(true)
    try {
      const state = await listFragments()
      applyVaultState(state)
    } catch (error) {
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
      toast.error("同步失败", {
        description: String(error),
      })
    } finally {
      setIsSyncing(false)
    }
  }

  const filteredFragments = useMemo(() => {
    switch (filter) {
      case "tagged":
        return fragments.filter((fragment) =>
          fragment.tags.some((tag) => tag !== "inbox")
        )
      case "ai":
        return fragments.filter((fragment) => fragment.aiStatus === "suggested")
      case "archive":
        return []
      case "inbox":
      default:
        return fragments.filter((fragment) => fragment.tags.includes("inbox"))
    }
  }, [filter, fragments])

  const knownTags = useMemo(
    () =>
      Array.from(
        new Set(
          fragments
            .flatMap((fragment) => fragment.tags)
            .filter((tag) => tag !== "inbox")
        )
      ).sort((a, b) => a.localeCompare(b)),
    [fragments]
  )

  return (
    <TooltipProvider>
      <main className="grid h-dvh grid-cols-[256px_minmax(0,1fr)] overflow-hidden bg-background text-foreground">
        <SidebarNav
          activeFilter={filter}
          fragments={fragments}
          git={git}
          isSyncing={isSyncing}
          onFilterChange={setFilter}
          onSync={handleSync}
          vaultPath={vaultPath}
        />

        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
          <div className="px-6 pt-[60px] pb-7">
            <CaptureBox
              isCreating={isCreating}
              knownTags={knownTags}
              onCreate={handleCreate}
            />
          </div>

          <FragmentTimeline
            activeFilter={filter}
            fragments={filteredFragments}
            isLoading={isLoading}
            totalCount={fragments.length}
          />
        </section>
      </main>
      <Toaster />
    </TooltipProvider>
  )
}

export default App
