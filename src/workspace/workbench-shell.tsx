import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { LockKeyholeIcon, TagIcon } from "lucide-react"
import { toast } from "sonner"

import styles from "../App.module.css"
import { BottomTabs } from "@/components/shard/bottom-tabs"
import { FragmentEditor } from "@/components/shard/fragment-editor"
import { FragmentImageExporter } from "@/components/shard/fragment-image-exporter"
import {
  type FragmentSearchSession,
} from "@/components/shard/fragment-search-workspace"
import {
  LockboxDialog,
} from "@/components/shard/lockbox-dialog"
import { MindMapWorkspace } from "@/components/shard/mind-map-workspace"
import {
  SidebarNav,
  SidebarToggleButton,
} from "@/components/shard/sidebar-nav"
import type { TaggedSummary } from "@/components/shard/tagged-panel"
import {
  VaultGuide,
  type SettingsSection,
} from "@/components/shard/vault-guide"
import {
  loadAppSettings,
  saveAppSettings,
  type AppSettings,
} from "@/lib/app-settings"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  setFragmentArchived,
  changeLockboxPassword,
  convertFragmentToNote,
  convertNoteToFragment,
  createFragment,
  DESKTOP_RUNTIME_MESSAGE,
  getApiErrorMessage,
  linkFragments,
  listCsvFiles,
  listFragments,
  listLibraryTree,
  listMindMaps,
  lockLockbox,
  moveFragmentToLockbox,
  migrateLegacyNotes,
  organizeFragments,
  pinFragment,
  restoreWindowFrame,
  resetLockboxPassword,
  setupLockbox,
  checkpointVault,
  syncVault,
  unlockLockbox,
  unlinkFragments,
  updateFragment,
  type OrganizeTemplate,
} from "@/lib/api"
import { deriveKind, isTypeTag } from "@/lib/content-kind"
import { toggleTaskLine } from "@/lib/editor-format"
import {
  buildWikilinkCandidates,
  resolveWikilinkTarget,
} from "@/lib/wikilink"
import { parseWikilinksInWorker } from "@/lib/wikilink-worker"
import {
  hasMarkdownImage,
  isLockboxReady,
  LOCKBOX_TAG,
  publicFragments,
  wantsLockbox,
} from "@/lib/lockbox"
import type {
  Fragment,
  CsvFileSummary,
  FragmentFilter,
  LockboxState,
  MindMapSummary,
  LibraryMutationResult,
  LibraryTreeSnapshot,
  VaultState,
} from "@/types"
import { FragmentsWorkspace } from "@/workspace/fragments-workspace"
import {
  LibraryShell,
  type LibraryDraftHandle,
} from "@/workspace/library-shell"
import {
  writeWorkspaceRoute,
  type WorkspaceRoute,
} from "@/workspace/route"
import { ReviewWorkspaceShell } from "@/workspace/review-workspace-shell"
import { useFragments } from "@/workspace/use-fragments"
import {
  useLockbox,
  useLockboxSecurityEffects,
} from "@/workspace/use-lockbox"
import {
  useVaultSync,
  useVaultSyncSchedule,
} from "@/workspace/use-vault-sync"
import { useAutoCheckpoint } from "@/workspace/use-auto-checkpoint"

const AUTO_SYNC_FAILURE_TOAST_ID = "auto-sync-failure"
const GLOBAL_CAPTURE_EVENT = "shard:capture"
const SIDEBAR_COLLAPSED_STORAGE_KEY = "shard.sidebar-collapsed"
const DEFAULT_PROJECT_TAGS: readonly string[] = ["日程"]
type EditingVariant = "inline" | "zen"
interface ZenDraft {
  content: string
  id: number
}

interface WorkbenchShellProps {
  route: WorkspaceRoute
  setRoute: (route: WorkspaceRoute) => void
}

function readSidebarCollapsed(): boolean {
  try {
    return (
      window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true"
    )
  } catch {
    return false
  }
}

export function WorkbenchShell({ route, setRoute }: WorkbenchShellProps) {
  const {
    archivedFragments,
    fragments,
    inboxFragments,
    isCreating,
    isLoading,
    lockboxFragments,
    publicActiveFragments,
    publicOnlyFragments,
    setFragments,
    setIsCreating,
    setIsLoading,
    taggedFragments,
  } = useFragments()
  const {
    insightIncludeLockbox,
    insightUnlockIntentRef,
    isArchivingLockboxFragment,
    lockbox,
    lockboxDialogMode,
    pendingLockboxArchiveFragment,
    pendingLockboxMoveId,
    recoveryKey,
    selectedLockboxTag,
    setInsightIncludeLockbox,
    setIsArchivingLockboxFragment,
    setLockbox,
    setLockboxDialogMode,
    setPendingLockboxArchiveFragment,
    setPendingLockboxMoveId,
    setRecoveryKey,
    setSelectedLockboxTag,
    unlockedForInsightRef,
  } = useLockbox()
  const {
    autoSyncFailureNotifiedRef,
    autoSyncTickRef,
    git,
    isSyncing,
    setGit,
    setIsSyncing,
  } = useVaultSync()
  const [vaultPath, setVaultPath] = useState("")
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
    readSidebarCollapsed
  )
  const [composerCollapseSignal, setComposerCollapseSignal] = useState(0)
  const [editingFragmentId, setEditingFragmentId] = useState<string | null>(null)
  const [editingVariant, setEditingVariant] =
    useState<EditingVariant>("inline")
  const [zenDraft, setZenDraft] = useState<ZenDraft | null>(null)
  const [exportingFragment, setExportingFragment] = useState<Fragment | null>(null)
  const [isVaultGuideOpen, setIsVaultGuideOpen] = useState(false)
  const [appSettings, setAppSettings] = useState<AppSettings>(loadAppSettings)
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("vault")
  const [needsVaultSetup, setNeedsVaultSetup] = useState(false)
  const [pendingScrollFragmentId, setPendingScrollFragmentId] = useState<
    string | null
  >(null)
  const [isSearchModeActive, setIsSearchModeActive] = useState(false)
  const [searchFocusSignal, setSearchFocusSignal] = useState(0)
  const [searchSession, setSearchSession] =
    useState<FragmentSearchSession | null>(null)
  const [isMindMapViewActive, setIsMindMapViewActive] = useState(false)
  const [activeMindMapId, setActiveMindMapId] = useState<string | null>(null)
  const [mindMaps, setMindMaps] = useState<MindMapSummary[]>([])
  const [csvFiles, setCsvFiles] = useState<CsvFileSummary[]>([])
  const [libraryTree, setLibraryTree] = useState<LibraryTreeSnapshot | null>(null)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [selectedInboxTag, setSelectedInboxTag] = useState<string | null>(null)
  const searchReturnFocusRef = useRef<HTMLElement | null>(null)
  const librarySaveHandlerRef = useRef<LibraryDraftHandle | null>(null)
  const [pendingLibraryNavigation, setPendingLibraryNavigation] = useState<{
    id: string
    requestId: number
  } | null>(null)
  const nextLibraryNavigationIdRef = useRef(0)
  const migratedLibraryVaultRef = useRef<string | null>(null)
  const routeRef = useRef(route)
  const filter: FragmentFilter =
    route.space === "fragments"
      ? route.params.filter
      : route.space === "review"
        ? route.params.mode
        : "inbox"

  useEffect(() => {
    void refreshFragments()
    void refreshMindMaps()
  }, [])

  useEffect(() => {
    routeRef.current = route
    writeWorkspaceRoute(route)
  }, [route])

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_COLLAPSED_STORAGE_KEY,
        JSON.stringify(isSidebarCollapsed)
      )
    } catch {
      // Storage can be unavailable (for example in a restricted webview).
    }
  }, [isSidebarCollapsed])

  useEffect(() => {
    if (route.space !== "library" || !vaultPath) return
    void prepareLibraryTree(vaultPath)
  }, [route.space, vaultPath])

  const registerLibrarySaveHandler = useCallback(
    (handle: LibraryDraftHandle | null) => {
      librarySaveHandlerRef.current = handle
    },
    []
  )

  const saveLibraryDraftBeforeNavigation = useCallback(async () => {
    if (routeRef.current.space !== "library") return true
    return (await librarySaveHandlerRef.current?.flush()) ?? true
  }, [])

  useEffect(() => {
    if (
      route.space !== "fragments" ||
      route.params.filter !== "lockbox" ||
      lockbox === null ||
      lockbox.unlocked
    ) {
      return
    }

    setLockboxDialogMode(lockbox.configured ? "unlock" : "setup")
  }, [route, lockbox, setLockboxDialogMode])

  useLockboxSecurityEffects({
    autoLock: (options) => {
      void autoLockLockbox(options)
    },
    insightIncludeLockbox,
    insightUnlockIntentRef,
    lockbox,
    route,
    setInsightIncludeLockbox,
    unlockedForInsightRef,
  })

  async function refreshFragments() {
    setIsLoading(true)
    try {
      const state = await listFragments()
      applyVaultState(state)
    } catch (error) {
      const message = getApiErrorMessage(error)

      if (message === DESKTOP_RUNTIME_MESSAGE) {
        setFragments([])
        setGit(null)
        setLockbox(null)
        setVaultPath("")
        setCsvFiles([])
        setNeedsVaultSetup(false)
        return
      }

      if (isVaultNotConfigured(error)) {
        setFragments([])
        setGit(null)
        setLockbox(null)
        setVaultPath("")
        setCsvFiles([])
        setNeedsVaultSetup(true)
        setIsVaultGuideOpen(true)
        return
      }

      toast.error(`${"读取 Shard vault 失败"}：${message}`, { duration: Infinity })
    } finally {
      setIsLoading(false)
    }
  }

  async function refreshMindMaps() {
    try {
      setMindMaps(await listMindMaps())
    } catch (error) {
      const message = getApiErrorMessage(error)
      if (message === DESKTOP_RUNTIME_MESSAGE || isVaultNotConfigured(error)) {
        setMindMaps([])
        return
      }
      toast.error(`${"读取思维导图失败"}：${message}`, { duration: Infinity })
    }
  }

  async function refreshCsvFiles() {
    try {
      const files = await listCsvFiles()
      setCsvFiles(Array.isArray(files) ? files : [])
    } catch (error) {
      const message = getApiErrorMessage(error)
      if (message === DESKTOP_RUNTIME_MESSAGE || isVaultNotConfigured(error)) {
        setCsvFiles([])
        return
      }
      toast.error(`读取 CSV 文件列表失败：${message}`, { duration: Infinity })
    }
  }

  async function refreshLibraryTree() {
    try {
      setLibraryTree(await listLibraryTree())
    } catch (error) {
      const message = getApiErrorMessage(error)
      if (message === DESKTOP_RUNTIME_MESSAGE || isVaultNotConfigured(error)) {
        setLibraryTree(null)
        return
      }
      toast.error(`读取资料库目录失败：${message}`, { duration: Infinity })
    }
  }

  async function prepareLibraryTree(currentVaultPath: string) {
    if (migratedLibraryVaultRef.current !== currentVaultPath) {
      try {
        const migration = await migrateLegacyNotes()
        migratedLibraryVaultRef.current = currentVaultPath
        if (migration.migratedCount > 0) {
          toast(`已迁移 ${migration.migratedCount} 篇旧笔记到资料库`)
          await refreshFragments()
          await refreshCsvFiles()
        }
      } catch (error) {
        toast.error(`迁移旧笔记失败：${getApiErrorMessage(error)}`, {
          duration: Infinity,
        })
        return
      }
    }
    await refreshLibraryTree()
  }

  function applyVaultState(state: VaultState) {
    const visibleFragments = state.lockbox.unlocked
      ? state.fragments
      : publicFragments(state.fragments)

    if (!state.lockbox.unlocked) setSearchSession(null)
    setFragments(sortFragmentsForDisplay(visibleFragments))
    setGit(state.git)
    setLockbox(state.lockbox)
    setVaultPath(state.vaultPath)
    if (vaultPath && vaultPath !== state.vaultPath) {
      setLibraryTree(null)
      migratedLibraryVaultRef.current = null
    }
    setNeedsVaultSetup(false)
    void refreshCsvFiles()
  }

  function handleVaultState(
    state: VaultState,
    options: { resetView?: boolean } = {}
  ) {
    applyVaultState(state)
    if (options.resetView) {
      closeEditor()
      setSelectedTag(null)
      setSelectedInboxTag(null)
      setIsMindMapViewActive(false)
      setFragmentFilter("inbox")
    }
    setIsVaultGuideOpen(true)
  }

  async function handleCreate(content: string, tags: string[]) {
    recordContentActivity()
    setIsCreating(true)
    const shouldCreateInLockbox = wantsLockbox(content, tags)

    if (shouldCreateInLockbox) {
      try {
        if (hasMarkdownImage(content)) {
          throw new Error("密匣暂不支持图片附件。请先移除图片，再保存到密匣。")
        }
        if (!ensureLockboxConfigured()) {
          throw new Error("请先设置密匣，然后再次保存。")
        }

        const created = await createFragment(content, tags)
        setFragments((current) => [created, ...current])
        toast("已保存到密匣")
        void refreshFragments()
      } catch (error) {
        const message = getApiErrorMessage(error)
        toast.error(`${"创建密匣片段失败"}：${message}`, {
          duration: Infinity,
        })
        throw new Error(message)
      } finally {
        setIsCreating(false)
      }
      return
    }

    const optimisticId = `pending-${Date.now()}`
    const pendingFragment: Fragment = {
      id: optimisticId,
      content,
      kind: deriveKind(tags),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags,
      category: null,
      path: "",
      gitStatus: "saved",
      error: null,
      archived: false,
      lockbox: false,
      pinned: false,
    }

    setFragments((current) => sortFragmentsForDisplay([pendingFragment, ...current]))

    try {
      let created = await createFragment(content, tags)
      setFragments((current) =>
        sortFragmentsForDisplay(
          current.map((fragment) =>
            fragment.id === optimisticId ? created : fragment
          )
        )
      )
      try {
        const links = await parseWikilinksInWorker(content)
        const candidates = buildWikilinkCandidates([...fragments, created])
        const targetIds = Array.from(
          new Set(
            links
              .map((link) =>
                resolveWikilinkTarget(link.target, candidates)?.fragmentId
              )
              .filter(
                (targetId): targetId is string =>
                  Boolean(targetId) && targetId !== created.id
              )
          )
        )
        for (const targetId of targetIds) {
          created = await linkFragments(created.id, targetId, "wikilink")
          setFragments((current) =>
            sortFragmentsForDisplay(
              current.map((fragment) =>
                fragment.id === created.id ? created : fragment
              )
            )
          )
        }
      } catch (error) {
        toast.error(
          `片段已保存，但双链同步失败：${getApiErrorMessage(error)}`,
          { duration: Infinity }
        )
      }
      if (created.gitStatus === "commit_failed") {
        toast(
          `${"片段已保存，但 Git commit 失败"}：${
            created.error ?? "可以继续记录，之后再处理 Git 配置。"
          }`
        )
      } else {
        toast("片段已保存")
      }
      void refreshFragments()
    } catch (error) {
      const message = getApiErrorMessage(error)
      setFragments((current) =>
        current.filter((fragment) => fragment.id !== optimisticId)
      )
      toast.error(`${"创建片段失败"}：${message}`, { duration: Infinity })
      throw new Error(message)
    } finally {
      setIsCreating(false)
    }
  }

  async function handleSync() {
    // 同步会先提交磁盘版本再 pull——不 flush 的话，旧磁盘内容被提交，
    // 之后迟到的自动保存还会把旧基线草稿盖回刚拉取的版本
    if (!(await saveLibraryDraftBeforeNavigation())) {
      toast.error("草稿保存失败，已取消同步", { duration: Infinity })
      return
    }
    setIsSyncing(true)
    try {
      const synced = await syncVault()
      setGit(synced)
      toast.dismiss(AUTO_SYNC_FAILURE_TOAST_ID)
      autoSyncFailureNotifiedRef.current = false
      toast("同步完成")
      void refreshFragments()
      void refreshMindMaps()
    } catch (error) {
      if (isGitSetupError(error)) {
        setSettingsSection("git")
        setIsVaultGuideOpen(true)
        void refreshFragments()
        toast(`${"需要完成 Git 配置"}：${getApiErrorMessage(error)}`)
        return
      }

      toast.error(`${"同步失败"}：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    } finally {
      setIsSyncing(false)
    }
  }

  async function handleUpdateFragment(
    id: string,
    content: string,
    tags: string[],
    expectedSha?: string
  ) {
    recordContentActivity()
    const currentFragment =
      fragments.find((fragment) => fragment.id === id) ?? null
    const movesToLockbox = !currentFragment?.lockbox && wantsLockbox(content, tags)
    const editsLockbox = Boolean(currentFragment?.lockbox)

    if (movesToLockbox || editsLockbox) {
      if (hasMarkdownImage(content)) {
        throw new Error("密匣暂不支持图片附件。请先移除图片，再保存到密匣。")
      }
      if (editsLockbox && !ensureLockboxReady()) {
        throw new Error("请先解锁或设置密匣，然后再次保存。")
      }
      if (movesToLockbox && !ensureLockboxConfigured()) {
        throw new Error("请先设置密匣，然后再次保存。")
      }
    }

    let updated = await updateFragment(id, content, tags, expectedSha)
    setFragments((current) =>
      current.map((fragment) => (fragment.id === id ? updated : fragment))
    )

    if (currentFragment && !movesToLockbox && !editsLockbox) {
      const links = await parseWikilinksInWorker(content)
      const candidates = buildWikilinkCandidates(
        fragments.map((fragment) =>
          fragment.id === id ? { ...updated, content } : fragment
        )
      )
      const nextTargets = new Set(
        links
          .map((link) =>
            resolveWikilinkTarget(link.target, candidates)?.fragmentId
          )
          .filter(
            (targetId): targetId is string =>
              Boolean(targetId) && targetId !== id
          )
      )
      const currentRelations = updated.related ?? []
      const removedTargets = currentRelations
        .filter(
          (relation) =>
            relation.origin === "wikilink" &&
            !nextTargets.has(relation.targetId)
        )
        .map((relation) => relation.targetId)
      const existingTargets = new Set(
        currentRelations.map((relation) => relation.targetId)
      )
      const addedTargets = Array.from(nextTargets).filter(
        (targetId) => !existingTargets.has(targetId)
      )

      for (const targetId of removedTargets) {
        updated = await unlinkFragments(id, targetId)
        setFragments((current) =>
          current.map((fragment) =>
            fragment.id === updated.id ? updated : fragment
          )
        )
      }
      for (const targetId of addedTargets) {
        updated = await linkFragments(id, targetId, "wikilink")
        setFragments((current) =>
          current.map((fragment) =>
            fragment.id === updated.id ? updated : fragment
          )
        )
      }
    }
    if (movesToLockbox) {
      closeEditor()
    }
    return updated
  }

  function openInlineEditor(fragment: Fragment) {
    setZenDraft(null)
    setEditingVariant("inline")
    setEditingFragmentId(fragment.id)
  }

  function openZenEditor(fragment: Fragment) {
    setZenDraft(null)
    setEditingVariant("zen")
    setEditingFragmentId(fragment.id)
  }

  function openZenDraft(content: string) {
    setEditingFragmentId(null)
    setEditingVariant("zen")
    setZenDraft({
      content,
      id: Date.now(),
    })
  }

  function closeEditor() {
    setEditingFragmentId(null)
    setZenDraft(null)
  }

  async function handleToggleFragmentTask(fragment: Fragment, lineIndex: number) {
    recordContentActivity()
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
      toast.error(`${"更新复选框失败"}：${getApiErrorMessage(error)}`, { duration: Infinity })
    }
  }

  async function handleArchiveFragment(fragment: Fragment) {
    recordContentActivity()
    // 取消归档不需要确认：它是个可撤销的、低风险的还原动作。
    if (fragment.archived) {
      await archiveFragmentWithFeedback(fragment, false)
      return
    }

    if (fragment.lockbox) {
      setPendingLockboxArchiveFragment(fragment)
      return
    }

    const confirmed = window.confirm("确认归档这条片段？归档后可在 Archive 中查看。")
    if (!confirmed) return

    await archiveFragmentWithFeedback(fragment, true)
  }

  async function archiveFragmentWithFeedback(
    fragment: Fragment,
    archived = true
  ) {
    try {
      const updated = await setFragmentArchived(fragment.id, archived)
      setFragments((current) =>
        current.map((currentFragment) =>
          currentFragment.id === fragment.id ? updated : currentFragment
        )
      )
      if (editingFragmentId === fragment.id) {
        closeEditor()
      }
      toast(archived ? "已归档" : "已移回收件箱")
      return true
    } catch (error) {
      toast.error(`${"归档失败"}：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
      return false
    }
  }

  async function handlePinFragment(fragment: Fragment) {
    recordContentActivity()
    if (fragment.archived) return

    const nextPinned = !fragment.pinned
    setFragments((current) =>
      sortFragmentsForDisplay(
        current.map((currentFragment) =>
          currentFragment.id === fragment.id
            ? { ...currentFragment, pinned: nextPinned }
            : currentFragment
        )
      )
    )

    try {
      const updated = await pinFragment(fragment.id, nextPinned)
      setFragments((current) =>
        sortFragmentsForDisplay(
          current.map((currentFragment) =>
            currentFragment.id === fragment.id ? updated : currentFragment
          )
        )
      )
      toast(nextPinned ? "已置顶" : "已取消置顶")
    } catch (error) {
      setFragments((current) =>
        sortFragmentsForDisplay(
          current.map((currentFragment) =>
            currentFragment.id === fragment.id ? fragment : currentFragment
          )
        )
      )
      toast.error(
        `${nextPinned ? "置顶失败" : "取消置顶失败"}：${getApiErrorMessage(error)}`,
        { duration: Infinity }
      )
    }
  }

  async function handleToggleFragmentKind(fragment: Fragment) {
    recordContentActivity()
    const nextKind = fragment.kind === "note" ? "fragment" : "note"

    try {
      const result =
        nextKind === "note"
          ? await convertFragmentToNote(fragment.id)
          : await convertNoteToFragment(fragment.id)
      handleLibraryMutation(result)
      toast(nextKind === "note" ? "已转为笔记" : "已转回碎片")
    } catch (error) {
      toast.error(
        `${nextKind === "note" ? "转为笔记失败" : "转回碎片失败"}：${getApiErrorMessage(error)}`,
        { duration: Infinity }
      )
    }
  }

  function handleLibraryMutation(result: LibraryMutationResult) {
    recordContentActivity()
    setLibraryTree(result.tree)
    if (result.fragment) {
      setFragments((current) =>
        sortFragmentsForDisplay([
          result.fragment!,
          ...current.filter((fragment) => fragment.id !== result.fragment!.id),
        ])
      )
    }
    void refreshFragments()
    void refreshCsvFiles()
  }

  async function handleLinkFragment(sourceId: string, targetId: string) {
    recordContentActivity()
    try {
      const updated = await linkFragments(sourceId, targetId, "manual")
      setFragments((current) =>
        current.map((fragment) =>
          fragment.id === updated.id ? updated : fragment
        )
      )
      toast.success("已关联")
    } catch (error) {
      toast.error(`关联失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
      throw error
    }
  }

  async function handleUnlinkFragment(sourceId: string, targetId: string) {
    recordContentActivity()
    try {
      const updated = await unlinkFragments(sourceId, targetId)
      setFragments((current) =>
        current.map((fragment) =>
          fragment.id === updated.id ? updated : fragment
        )
      )
      toast.success("已移除关联")
    } catch (error) {
      toast.error(`移除关联失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
      throw error
    }
  }

  async function handleMoveFragmentToLockbox(fragment: Fragment) {
    if (fragment.lockbox || fragment.archived) return
    if (hasMarkdownImage(fragment.content)) {
      toast.error(`${"密匣暂不支持图片附件"}：${"请先移除图片，再移入密匣，避免附件留在公开 assets 目录。"}`, { duration: Infinity })
      return
    }

    const confirmed = window.confirm(
      "移入密匣会把当前文件改为加密文件，但不会清理已经存在的 Git 历史提交。确认继续？"
    )
    if (!confirmed) return

    if (!lockbox?.configured) {
      setPendingLockboxMoveId(fragment.id)
      openLockboxGate()
      toast("设置密匣后会移入笔记")
      return
    }

    await moveFragmentIntoLockbox(fragment.id)
  }

  async function moveFragmentIntoLockbox(
    fragmentId: string,
    successMessage = "已移入密匣"
  ) {
    try {
      const state = await moveFragmentToLockbox(fragmentId)
      applyVaultState(state)
      await refreshLibraryTree()
      closeEditor()
      toast(successMessage)
      return true
    } catch (error) {
      toast.error(`${"移入密匣失败"}：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
      return false
    }
  }

  function ensureLockboxReady() {
    if (isLockboxReady(lockbox)) return true
    openLockboxGate()
    return false
  }

  function ensureLockboxConfigured() {
    if (lockbox?.configured) return true
    setLockboxDialogMode("setup")
    return false
  }

  function openLockboxGate() {
    if (!lockbox?.configured) {
      setLockboxDialogMode("setup")
      return
    }
    if (!lockbox.unlocked) {
      setLockboxDialogMode("unlock")
      return
    }
    setSelectedTag(null)
    setSelectedLockboxTag(null)
    setFragmentFilter("lockbox")
  }

  function updateAppSettings(patch: Partial<AppSettings>) {
    setAppSettings((current) => {
      const next = { ...current, ...patch }
      saveAppSettings(next)
      return next
    })
  }

  function openSettings(section: SettingsSection) {
    setSettingsSection(section)
    setIsVaultGuideOpen(true)
  }

  function showShortcuts() {
    openSettings("shortcuts")
  }

  function showHelp() {
    toast(
      `${"帮助"}：${"先在 Inbox 写片段，用 #标签归类。需要持久化和同步时，在设置里选择或创建 vault。"}`
    )
  }

  async function handleRestoreWindow() {
    try {
      await restoreWindowFrame()
      toast("已还原窗口尺寸")
    } catch (error) {
      toast.error(`${"还原窗口尺寸失败"}：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    }
  }

  async function handleSetupLockbox(password: string) {
    const result = await setupLockbox(password)
    applyVaultState(result.vault)
    setRecoveryKey(result.recoveryKey)

    if (pendingLockboxMoveId) {
      const fragmentId = pendingLockboxMoveId
      setPendingLockboxMoveId(null)
      await moveFragmentIntoLockbox(fragmentId, "密匣已设置，笔记已移入")
      return
    }

    toast("密匣已设置")
  }

  async function handleUnlockLockbox(password: string) {
    const state = await unlockLockbox(password)
    applyVaultState(state)
    setLockboxDialogMode(null)

    if (pendingLockboxMoveId) {
      const fragmentId = pendingLockboxMoveId
      setPendingLockboxMoveId(null)
      await moveFragmentIntoLockbox(fragmentId, "已解锁并移入密匣")
      return
    }

    // 洞察勾选发起的解锁：后端已校验密码，直接并入候选，不跳转密匣视图
    if (insightUnlockIntentRef.current) {
      insightUnlockIntentRef.current = false
      unlockedForInsightRef.current = true
      setInsightIncludeLockbox(true)
      toast("密匣已解锁，将包含在洞察中")
      return
    }

    setSelectedTag(null)
    setSelectedLockboxTag(null)
    setFragmentFilter("lockbox")
    toast("密匣已解锁")
  }

  // 勾选「包含密匣内容」一律要求重新输入密码：即使当前已解锁也先上锁，
  // 保证这次合入经过后端真实校验，而不是放行既有会话
  async function handleInsightIncludeLockboxChange(next: boolean) {
    if (next) {
      insightUnlockIntentRef.current = true
      if (lockbox?.unlocked) {
        try {
          const state = await lockLockbox()
          applyVaultState(state)
        } catch {
          // 上锁失败仍弹解锁窗，由后端 unlock 校验兜底
        }
      }
      setLockboxDialogMode(lockbox?.configured ? "unlock" : "setup")
      return
    }

    setInsightIncludeLockbox(false)
    if (unlockedForInsightRef.current) {
      unlockedForInsightRef.current = false
      void autoLockLockbox()
    }
  }

  async function handleLockLockbox() {
    try {
      const state = await lockLockbox()
      applyVaultState(state)
      closeEditor()
      setSelectedLockboxTag(null)
      if (
        route.space === "fragments" &&
        route.params.filter === "lockbox"
      ) {
        setFragmentFilter("tagged")
      }
      toast("密匣已上锁")
    } catch (error) {
      toast.error(`${"密匣上锁失败"}：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    }
  }

  async function autoLockLockbox(
    options: { returnToTagged?: boolean } = {}
  ) {
    try {
      const state = await lockLockbox()
      applyVaultState(state)
      if (
        options.returnToTagged &&
        routeRef.current.space === "fragments" &&
        routeRef.current.params.filter === "lockbox"
      ) {
        closeEditor()
        setSelectedLockboxTag(null)
        setFragmentFilter("tagged")
      }
    } catch {
      // 静默失败：下次进入密匣仍需密码，必要时可手动上锁
    }
  }

  async function handleChangeLockboxPassword(
    currentPassword: string,
    newPassword: string
  ) {
    const state = await changeLockboxPassword(currentPassword, newPassword)
    applyVaultState(state)
    setLockboxDialogMode(null)
    toast("密匣密码已修改")
  }

  async function handleResetLockboxPassword(
    nextRecoveryKey: string,
    newPassword: string
  ) {
    const result = await resetLockboxPassword(nextRecoveryKey, newPassword)
    applyVaultState(result.vault)
    setRecoveryKey(result.recoveryKey)
    insightUnlockIntentRef.current = false

    if (pendingLockboxMoveId) {
      const fragmentId = pendingLockboxMoveId
      setPendingLockboxMoveId(null)
      await moveFragmentIntoLockbox(fragmentId, "密匣密码已重置，笔记已移入")
      return
    }

    toast("密匣密码已重置")
  }

  function closeLockboxDialog() {
    setPendingLockboxMoveId(null)
    setLockboxDialogMode(null)
    setRecoveryKey(null)
    insightUnlockIntentRef.current = false
  }

  function handleOpenSearchResult(
    fragment: Fragment,
    session?: FragmentSearchSession
  ) {
    const visibleTag = getFirstVisibleTag(fragment)

    setEditingVariant("inline")
    setEditingFragmentId(null)
    setSelectedLockboxTag(null)
    setIsMindMapViewActive(false)

    if (fragment.archived) {
      setSelectedTag(null)
      setFragmentFilter("archive")
    } else if (fragment.lockbox) {
      if (!lockbox?.unlocked) {
        setIsSearchModeActive(false)
        setSearchSession(null)
        searchReturnFocusRef.current = null
        openLockboxGate()
        toast("请先解锁密匣后查看笔记")
        return
      }

      setSelectedTag(null)
      setFragmentFilter("lockbox")
    } else if (fragment.tags.includes("inbox")) {
      setSelectedTag(null)
      setSelectedInboxTag(null)
      setFragmentFilter("inbox")
    } else if (visibleTag) {
      setSelectedTag(visibleTag)
      setFragmentFilter("tagged")
    } else {
      toast("这条笔记当前不在时间线列表中")
      return
    }

    setIsSearchModeActive(false)
    if (session) setSearchSession(session)
    searchReturnFocusRef.current = null
    setPendingScrollFragmentId(fragment.id)
  }

  async function handleNavigateToFragment(fragmentId: string) {
    const target = publicOnlyFragments.find(
      (fragment) => fragment.id === fragmentId
    )
    if (!target) {
      toast("链接目标已不存在")
      return
    }

    if (target.kind === "note" && !target.archived) {
      if (!(await saveLibraryDraftBeforeNavigation())) return
      nextLibraryNavigationIdRef.current += 1
      setPendingLibraryNavigation({
        id: target.id,
        requestId: nextLibraryNavigationIdRef.current,
      })
      if (routeRef.current.space !== "library") {
        setRoute({ space: "library", params: {} })
      }
      return
    }

    if (!(await saveLibraryDraftBeforeNavigation())) return
    handleOpenSearchResult(target)
  }

  async function handleOrganizeFragments(
    selectedFragments: Fragment[],
    target: string,
    template: OrganizeTemplate
  ) {
    recordContentActivity()
    const created = await organizeFragments(
      selectedFragments.map((fragment) => fragment.path),
      target,
      template
    )
    setFragments((current) =>
      sortFragmentsForDisplay([
        created,
        ...current.filter((fragment) => fragment.id !== created.id),
      ])
    )
    nextLibraryNavigationIdRef.current += 1
    setPendingLibraryNavigation({
      id: created.id,
      requestId: nextLibraryNavigationIdRef.current,
    })
    setRoute({ space: "library", params: {} })
    toast("笔记已生成")
    void refreshFragments()
    void refreshLibraryTree()
  }

  async function openSearch() {
    if (!(await saveLibraryDraftBeforeNavigation())) return

    if (!isSearchModeActive && document.activeElement instanceof HTMLElement) {
      searchReturnFocusRef.current = document.activeElement
    }
    if (route.space !== "fragments") {
      setRoute({ space: "fragments", params: { filter: "inbox" } })
    }
    setIsSearchModeActive(true)
    setSearchFocusSignal((current) => current + 1)
  }

  function exitSearchMode() {
    setIsSearchModeActive(false)
    if (searchSession) return

    const returnFocus = searchReturnFocusRef.current
    searchReturnFocusRef.current = null
    window.requestAnimationFrame(() => returnFocus?.focus())
  }

  function endSearchSession() {
    setIsSearchModeActive(false)
    setSearchSession(null)
    searchReturnFocusRef.current = null
  }

  function navigateSearchResult(nextIndex: number) {
    if (!searchSession) return
    const fragmentId = searchSession.resultIds[nextIndex]
    const fragment = fragments.find((candidate) => candidate.id === fragmentId)
    if (!fragment) {
      toast("这条笔记已不在当前搜索范围中")
      return
    }

    const nextSession = { ...searchSession, activeIndex: nextIndex }
    handleOpenSearchResult(fragment, nextSession)
  }

  function handleCreateInboxTag(rawTag: string) {
    const tag = rawTag.trim().replace(/^#+/, "")
    if (!tag) return false

    if (/\s/.test(tag)) {
      toast.error("标签不能包含空格", { duration: Infinity })
      return false
    }

    if (tag === "inbox" || tag === LOCKBOX_TAG || isTypeTag(tag)) {
      if (isTypeTag(tag)) {
        toast.error(
          `#${tag} 是内容类型保留标签，请使用卡片菜单“转为笔记”`,
          { duration: Infinity }
        )
        return false
      }
      toast.error(`#${tag} 是保留标签，不能新建`, { duration: Infinity })
      return false
    }

    if (inboxTagSummaries.some((summary) => summary.tag === tag)) {
      setSelectedInboxTag(tag)
      toast(`标签 #${tag} 已存在`)
      return true
    }

    updateAppSettings({
      customTags: [...appSettings.customTags, tag],
    })
    setSelectedInboxTag(tag)
    toast(`${`标签 #${tag} 已创建`}：${`写片段时输入 #${tag} 即可归入这个标签。`}`)
    return true
  }

  async function openMindMap(map?: MindMapSummary) {
    if (!(await saveLibraryDraftBeforeNavigation())) return

    setIsSearchModeActive(false)
    setSearchSession(null)
    searchReturnFocusRef.current = null
    if (!map) {
      if (route.space !== "fragments") {
        setRoute({ space: "fragments", params: { filter: "inbox" } })
      }
      setIsMindMapViewActive(true)
      return
    }

    setActiveMindMapId(map.id)
  }

  function setFragmentFilter(nextFilter: FragmentFilter) {
    if (
      nextFilter === "dailyReview" ||
      nextFilter === "insight" ||
      nextFilter === "walk"
    ) {
      setRoute({ space: "review", params: { mode: nextFilter } })
      return
    }

    setRoute({ space: "fragments", params: { filter: nextFilter } })
  }

  async function handleRouteChange(nextRoute: WorkspaceRoute) {
    if (!(await saveLibraryDraftBeforeNavigation())) return

    setIsSearchModeActive(false)
    setSearchSession(null)
    searchReturnFocusRef.current = null
    setIsMindMapViewActive(false)

    if (
      nextRoute.space === "fragments" &&
      nextRoute.params.filter === "lockbox"
    ) {
      openLockboxGate()
      return
    }

    setRoute(nextRoute)
  }

  async function handleSelectFragmentMonth(month: string) {
    setSelectedInboxTag(null)
    await handleRouteChange({
      space: "fragments",
      params: { filter: "inbox", month },
    })
  }

  const lockboxTagSummaries = useMemo(
    () => buildTagSummaries(lockboxFragments, []),
    [lockboxFragments]
  )

  const tagSummaries = useMemo(
    () => buildTagSummaries(publicActiveFragments, DEFAULT_PROJECT_TAGS),
    [publicActiveFragments]
  )

  const inboxTagSummaries = useMemo(
    () => buildTagSummaries(inboxFragments, appSettings.customTags),
    [appSettings.customTags, inboxFragments]
  )

  useEffect(() => {
    if (
      selectedInboxTag &&
      !inboxTagSummaries.some((summary) => summary.tag === selectedInboxTag)
    ) {
      setSelectedInboxTag(null)
    }
  }, [inboxTagSummaries, selectedInboxTag])

  useEffect(() => {
    if (
      selectedTag &&
      !tagSummaries.some((summary) => summary.tag === selectedTag)
    ) {
      setSelectedTag(null)
    }
  }, [selectedTag, tagSummaries])

  useEffect(() => {
    if (!selectedLockboxTag) return
    if (!lockbox?.unlocked) {
      setSelectedLockboxTag(null)
      return
    }
    if (
      !lockboxTagSummaries.some((summary) => summary.tag === selectedLockboxTag)
    ) {
      setSelectedLockboxTag(null)
    }
  }, [lockbox?.unlocked, lockboxTagSummaries, selectedLockboxTag])

  const filteredFragments = useMemo(() => {
    let result: Fragment[]
    switch (filter) {
      case "tagged":
        result = selectedTag
          ? publicActiveFragments.filter((fragment) =>
              fragment.tags.includes(selectedTag)
            )
          : taggedFragments
        break
      case "lockbox":
        if (!lockbox?.unlocked) return []
        result = selectedLockboxTag
          ? lockboxFragments.filter((fragment) =>
              fragment.tags.includes(selectedLockboxTag)
            )
          : lockboxFragments
        break
      case "archive":
        result = archivedFragments
        break
      case "dailyReview":
      case "insight":
      case "walk":
        return []
      case "inbox":
      default:
        result = selectedInboxTag
          ? inboxFragments.filter((fragment) =>
              fragment.tags.includes(selectedInboxTag)
            )
          : inboxFragments
        break
    }

    const month = route.space === "fragments" ? route.params.month : undefined
    return month ? result.filter((fragment) => isFragmentInMonth(fragment, month)) : result
  }, [
    archivedFragments,
    filter,
    inboxFragments,
    lockbox?.unlocked,
    lockboxFragments,
    publicActiveFragments,
    route,
    selectedInboxTag,
    selectedLockboxTag,
    selectedTag,
    taggedFragments,
  ])

  const knownTags = useMemo(
    () =>
      Array.from(
        new Set(
          DEFAULT_PROJECT_TAGS.concat(
            [LOCKBOX_TAG],
            appSettings.customTags,
            publicActiveFragments
              .flatMap((fragment) => fragment.tags)
              .filter((tag) => tag !== "inbox" && !isTypeTag(tag))
          )
        )
      ).sort((a, b) => a.localeCompare(b)),
    [appSettings.customTags, publicActiveFragments]
  )

  const editingFragment = useMemo(
    () =>
      editingFragmentId
        ? fragments.find((fragment) => fragment.id === editingFragmentId) ?? null
        : null,
    [editingFragmentId, fragments]
  )
  const isInboxView = filter === "inbox" && !isMindMapViewActive
  const isReviewView =
    !isMindMapViewActive &&
    (filter === "dailyReview" || filter === "insight" || filter === "walk")
  const isVaultDialogOpen = isVaultGuideOpen || needsVaultSetup
  const isExportSheetOpen = exportingFragment !== null
  const isLockboxArchiveConfirmOpen = pendingLockboxArchiveFragment !== null
  const isModalBusy =
    isVaultDialogOpen ||
    lockboxDialogMode !== null ||
    isExportSheetOpen ||
    isLockboxArchiveConfirmOpen
  const isBlockingDialogOpen = isModalBusy

  const timelineScrollTargetId =
    pendingScrollFragmentId &&
    !isSearchModeActive &&
    !isReviewView &&
    filteredFragments.some((fragment) => fragment.id === pendingScrollFragmentId)
      ? pendingScrollFragmentId
      : null

  const handleTimelineScrollComplete = useCallback((fragmentId: string) => {
    setPendingScrollFragmentId((current) =>
      current === fragmentId ? null : current
    )
  }, [])

  useEffect(() => {
    function handleGlobalSearchShortcut(event: KeyboardEvent) {
      const isSearchShortcut =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "k"

      if (!isSearchShortcut) return

      event.preventDefault()
      if (isModalBusy) return

      void openSearch()
    }

    window.addEventListener("keydown", handleGlobalSearchShortcut)

    return () => {
      window.removeEventListener("keydown", handleGlobalSearchShortcut)
    }
  }, [isModalBusy, isSearchModeActive, route])

  useEffect(() => {
    function handleGlobalCaptureShortcut(event: KeyboardEvent) {
      const isCaptureShortcut =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "n"

      if (!isCaptureShortcut) return

      event.preventDefault()
      if (isModalBusy) return

      window.dispatchEvent(new Event(GLOBAL_CAPTURE_EVENT))
    }

    window.addEventListener("keydown", handleGlobalCaptureShortcut)

    return () => {
      window.removeEventListener("keydown", handleGlobalCaptureShortcut)
    }
  }, [isModalBusy])

  useEffect(() => {
    function handleGlobalSidebarShortcut(event: KeyboardEvent) {
      const isSidebarShortcut =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "b"

      if (!isSidebarShortcut) return

      event.preventDefault()
      if (isModalBusy) return

      setIsSidebarCollapsed((current) => !current)
    }

    window.addEventListener("keydown", handleGlobalSidebarShortcut)

    return () => {
      window.removeEventListener("keydown", handleGlobalSidebarShortcut)
    }
  }, [isModalBusy])

  useEffect(() => {
    function focusComposer() {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>(
              '[data-shard-editor="composer"] .cm-content'
            )
            ?.focus()
        })
      })
    }

    async function handleGlobalCapture() {
      if (isModalBusy || !(await saveLibraryDraftBeforeNavigation())) return

      setIsSearchModeActive(false)
      setSearchSession(null)
      searchReturnFocusRef.current = null
      setIsMindMapViewActive(false)
      setRoute({ space: "fragments", params: { filter: "inbox" } })
      focusComposer()
    }

    window.addEventListener(GLOBAL_CAPTURE_EVENT, handleGlobalCapture)
    return () => {
      window.removeEventListener(GLOBAL_CAPTURE_EVENT, handleGlobalCapture)
    }
  }, [isModalBusy, saveLibraryDraftBeforeNavigation, setRoute])

  autoSyncTickRef.current = () => {
    if (
      !appSettings.autoSyncEnabled ||
      !git?.hasRemote ||
      isSyncing ||
      isCreating ||
      isBlockingDialogOpen ||
      activeMindMapId !== null ||
      editingFragmentId !== null ||
      (librarySaveHandlerRef.current?.isDirty() ?? false)
    ) {
      return
    }

    setIsSyncing(true)
    void syncVault()
      .then((synced) => {
        setGit(synced)
        toast.dismiss(AUTO_SYNC_FAILURE_TOAST_ID)
        autoSyncFailureNotifiedRef.current = false
        void refreshFragments()
        void refreshMindMaps()
      })
      .catch((error) => {
        if (!autoSyncFailureNotifiedRef.current) {
          autoSyncFailureNotifiedRef.current = true
          toast.error(`${"自动同步失败"}：${getApiErrorMessage(error)}`, {
            id: AUTO_SYNC_FAILURE_TOAST_ID,
            duration: Infinity,
          })
        }
      })
      .finally(() => {
        setIsSyncing(false)
      })
  }

  useVaultSyncSchedule({
    enabled: appSettings.autoSyncEnabled,
    intervalMinutes: appSettings.autoSyncIntervalMinutes,
    onDisabled: () => {
      toast.dismiss(AUTO_SYNC_FAILURE_TOAST_ID)
      autoSyncFailureNotifiedRef.current = false
    },
    tickRef: autoSyncTickRef,
  })

  // 自动检查点（合并保存）：内容保存只落盘，git 提交由 idle/失焦触发的检查点聚合
  const { recordContentActivity } = useAutoCheckpoint({
    enabled: Boolean(git && git.status !== "no_git"),
    isStable: () =>
      !isSyncing &&
      !isCreating &&
      !isBlockingDialogOpen &&
      editingFragmentId === null &&
      activeMindMapId === null &&
      !(librarySaveHandlerRef.current?.isDirty() ?? false),
    checkpoint: async (trigger) => {
      try {
        const result = await checkpointVault(trigger)
        setGit(result.git)
        if (result.status === "committed") {
          // 逐文件 gitStatus 来自读取时的脏检测，必须整体刷新才会退回 clean
          void refreshFragments()
          void refreshMindMaps()
        }
        return result.status !== "blocked"
      } catch (error) {
        console.warn("[shard] 自动检查点失败：", error)
        return false
      }
    },
    flushDrafts: async () => {
      await librarySaveHandlerRef.current?.flush().catch(() => false)
    },
  })

  // 启动恢复识别：上次会话（或外部编辑）留下的未提交变更，纳入首次安全
  // idle 检查点，而不是启动瞬间就 commit（外部半成品不该被立即固化）。
  const startupRecoveryRef = useRef(false)
  useEffect(() => {
    if (startupRecoveryRef.current) return
    if (git && git.status === "dirty") {
      startupRecoveryRef.current = true
      recordContentActivity()
    }
  }, [git, recordContentActivity])

  // 退出兜底：close-requested 时先排空草稿、限时检查点，再放行关闭。
  // 浏览器/测试环境没有 Tauri 窗口事件，动态导入或取窗口失败即静默跳过。
  useEffect(() => {
    let closing = false
    let disposed = false
    let unlisten: (() => void) | null = null
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window")
        const currentWindow = getCurrentWindow()
        const stop = await currentWindow.onCloseRequested(async (event) => {
          if (closing) return
          event.preventDefault()
          closing = true
          try {
            const flushed =
              (await librarySaveHandlerRef.current?.flush()) ?? true
            if (!flushed) {
              const leaveAnyway = window.confirm(
                "还有草稿没能保存成功。仍要退出吗？（退出将丢失未保存的修改）"
              )
              if (!leaveAnyway) {
                closing = false
                return
              }
            }
            // 数据已落盘，提交只是历史整理：限时尽力而为，失败不阻塞退出
            await Promise.race([
              checkpointVault("退出前").catch(() => null),
              new Promise((resolve) => window.setTimeout(resolve, 5_000)),
            ])
          } finally {
            void currentWindow.destroy()
          }
        })
        if (disposed) stop()
        else unlisten = stop
      } catch {
        // 非 Tauri 环境：无窗口关闭事件可挂
      }
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (activeMindMapId) {
    return (
      <MindMapWorkspace
        mapId={activeMindMapId}
        onClose={() => setActiveMindMapId(null)}
        onMapsChange={setMindMaps}
      />
    )
  }

  return (
    <>
      <main
        aria-hidden={isBlockingDialogOpen ? true : undefined}
        className={styles.appShell}
        data-sidebar-collapsed={isSidebarCollapsed}
      >
        <div className={styles.sidebarSlot}>
          {isSidebarCollapsed ? null : (
            <SidebarNav
              fragments={publicOnlyFragments}
              git={git}
              isSyncing={isSyncing}
              isCollapsed={false}
              mindMapCount={mindMaps.length}
              mindMapViewActive={isMindMapViewActive}
              onHelp={showHelp}
              onOpenMindMaps={() => openMindMap()}
              onOpenSearch={openSearch}
              onOpenSettings={() => openSettings("vault")}
              onRestoreWindow={handleRestoreWindow}
              onRouteChange={handleRouteChange}
              onShortcuts={showShortcuts}
              onSync={handleSync}
              onToggleCollapsed={() => {
                setIsSidebarCollapsed(true)
              }}
              route={route}
            />
          )}
        </div>
        <div className={styles.workspaceSlot} data-workspace-slot>
          {isSidebarCollapsed ? (
            <div
              className={styles.collapsedTitlebar}
              data-sidebar-collapsed-titlebar
              data-tauri-drag-region="true"
            >
              <SidebarToggleButton
                isCollapsed
                onToggleCollapsed={() => {
                  setIsSidebarCollapsed(false)
                }}
              />
            </div>
          ) : null}
          <div className={styles.workspaceContent}>
            {route.space === "fragments" ? (
              <FragmentsWorkspace
            capture={{
              collapseSignal: composerCollapseSignal,
              csvFiles,
              fragments: publicOnlyFragments,
              isCreating,
              knownTags,
              onCreate: handleCreate,
              onNavigateToFragment: (fragmentId) => {
                void handleNavigateToFragment(fragmentId)
              },
              onOpenZen: openZenDraft,
            }}
            filter={route.params.filter}
            inboxTagBar={{
              selectedTag: selectedInboxTag,
              summaries: inboxTagSummaries,
              totalCount: inboxFragments.length,
              onCreateTag: handleCreateInboxTag,
              onSelectTag: setSelectedInboxTag,
            }}
            isMindMapViewActive={isMindMapViewActive}
            isSearchModeActive={isSearchModeActive}
            lockboxHeader={
              <LockboxHeader
                lockbox={lockbox}
                selectedTag={selectedLockboxTag}
                summaries={lockboxTagSummaries}
                totalCount={lockboxFragments.length}
                onChangePassword={() => setLockboxDialogMode("change")}
                onLock={() => void handleLockLockbox()}
                onSelectTag={setSelectedLockboxTag}
                onUnlock={openLockboxGate}
              />
            }
            mindMapPanel={{
              onMapsChange: setMindMaps,
              onOpenMap: setActiveMindMapId,
            }}
            search={{
              focusSignal: searchFocusSignal,
              fragments,
              initialSession: searchSession,
              lockboxSearchAvailable: Boolean(lockbox?.unlocked),
              onExit: exitSearchMode,
              onOpenFragment: handleOpenSearchResult,
            }}
            searchContextBar={
              searchSession
                ? {
                    onBack: openSearch,
                    onClose: endSearchSession,
                    onNavigate: navigateSearchResult,
                    session: searchSession,
                  }
                : null
            }
            taggedPanel={{
              selectedTag,
              summaries: tagSummaries,
              totalCount: taggedFragments.length,
              onSelectTag: setSelectedTag,
            }}
            timeline={{
              csvFiles,
              editingFragmentId:
                editingVariant === "inline" ? editingFragmentId : null,
              emptyMessage:
                filter === "tagged"
                  ? "还没有带标签的内容。到 Inbox 输入 #标签 即可归类。"
                  : filter === "lockbox"
                    ? lockbox?.unlocked
                      ? "密匣里还没有笔记。到 Inbox 输入 #密匣 即可保存到这里。"
                      : "密匣已上锁。"
                    : filter === "archive"
                      ? "还没有归档内容。"
                      : isInboxView && selectedInboxTag
                        ? `#${selectedInboxTag} 下还没有片段。写片段时输入 #${selectedInboxTag} 即可归入。`
                        : undefined,
              fragments: filteredFragments,
              isLoading,
              knownTags,
              onArchive: handleArchiveFragment,
              onCancelEdit: closeEditor,
              onEdit: openInlineEditor,
              onExportImage: setExportingFragment,
              onLinkFragment: handleLinkFragment,
              onMoveToLockbox: handleMoveFragmentToLockbox,
              onOpenZen: openZenEditor,
              onOrganize:
                filter === "lockbox" ? undefined : handleOrganizeFragments,
              onPin: handlePinFragment,
              onScrollDown: () => {
                setComposerCollapseSignal((current) => current + 1)
              },
              onNavigateToFragment: (fragmentId) => {
                void handleNavigateToFragment(fragmentId)
              },
              onScrollToFragmentComplete: handleTimelineScrollComplete,
              onSave: handleUpdateFragment,
              onToggleKind: handleToggleFragmentKind,
              onToggleTask: (fragment, lineIndex) => {
                void handleToggleFragmentTask(fragment, lineIndex)
              },
              onUnlinkFragment: handleUnlinkFragment,
              scrollToFragmentId: timelineScrollTargetId,
              vaultPath,
            }}
              />
            ) : route.space === "review" ? (
              <ReviewWorkspaceShell
            csvFiles={csvFiles}
            editingFragmentId={
              editingVariant === "inline" ? editingFragmentId : null
            }
            fragments={
              route.params.mode === "insight" &&
              insightIncludeLockbox &&
              lockbox?.unlocked
                ? fragments
                : publicOnlyFragments
            }
            insightIncludeLockbox={insightIncludeLockbox}
            isLoading={isLoading}
            knownTags={knownTags}
            lockboxConfigured={Boolean(lockbox?.configured)}
            mode={route.params.mode}
            onArchive={handleArchiveFragment}
            onCancelEdit={closeEditor}
            onCreate={handleCreate}
            onEdit={openInlineEditor}
            onExportImage={setExportingFragment}
            onInsightIncludeLockboxChange={handleInsightIncludeLockboxChange}
            onModeChange={(mode) =>
              handleRouteChange({ space: "review", params: { mode } })
            }
            onMoveToLockbox={handleMoveFragmentToLockbox}
            onOpenZen={openZenEditor}
            onPin={handlePinFragment}
            onSave={handleUpdateFragment}
            onToggleKind={handleToggleFragmentKind}
            onToggleTask={(fragment, lineIndex) => {
              void handleToggleFragmentTask(fragment, lineIndex)
            }}
            vaultPath={vaultPath}
              />
            ) : (
              <LibraryShell
            csvFiles={csvFiles}
            fragments={publicActiveFragments}
            isLoading={isLoading}
            libraryTree={libraryTree}
            knownTags={knownTags}
            navigateToNote={pendingLibraryNavigation}
            onNavigateToFragment={(fragmentId) => {
              void handleNavigateToFragment(fragmentId)
            }}
            onLibraryMutation={handleLibraryMutation}
            onMoveToLockbox={handleMoveFragmentToLockbox}
            onRefreshFragments={refreshFragments}
            onRegisterSaveHandler={registerLibrarySaveHandler}
            onSave={handleUpdateFragment}
            onSelectFragmentMonth={(month) => {
              void handleSelectFragmentMonth(month)
            }}
            relationFragments={publicOnlyFragments}
              />
            )}
          </div>
        </div>
        <div className={styles.bottomTabsSlot}>
          <BottomTabs
            fragments={publicOnlyFragments}
            onHelp={showHelp}
            onOpenMindMaps={() => openMindMap()}
            onOpenSearch={openSearch}
            onOpenSettings={() => openSettings("vault")}
            onRestoreWindow={handleRestoreWindow}
            onRouteChange={handleRouteChange}
            onShortcuts={showShortcuts}
            route={route}
            vaultPath={vaultPath}
          />
        </div>
      </main>
      <FragmentEditor
        csvFiles={csvFiles}
        draft={editingVariant === "zen" ? zenDraft : null}
        fragment={editingVariant === "zen" ? editingFragment : null}
        fragments={publicOnlyFragments}
        knownTags={knownTags}
        onClose={closeEditor}
        onCreate={handleCreate}
        onNavigateToFragment={(fragmentId) => {
          void handleNavigateToFragment(fragmentId)
        }}
        onSave={handleUpdateFragment}
        vaultPath={vaultPath}
      />
      <FragmentImageExporter
        fragment={exportingFragment}
        onClose={() => setExportingFragment(null)}
        open={isExportSheetOpen}
        vaultPath={vaultPath}
      />
      <LockboxArchiveConfirmDialog
        fragment={pendingLockboxArchiveFragment}
        isArchiving={isArchivingLockboxFragment}
        onCancel={() => setPendingLockboxArchiveFragment(null)}
        onConfirm={() => {
          if (!pendingLockboxArchiveFragment) return

          setIsArchivingLockboxFragment(true)
          void archiveFragmentWithFeedback(pendingLockboxArchiveFragment)
            .then((archived) => {
              if (archived) setPendingLockboxArchiveFragment(null)
            })
            .finally(() => {
              setIsArchivingLockboxFragment(false)
            })
        }}
      />
      <VaultGuide
        autoSyncEnabled={appSettings.autoSyncEnabled}
        autoSyncIntervalMinutes={appSettings.autoSyncIntervalMinutes}
        git={git}
        initialSection={settingsSection}
        isSyncing={isSyncing}
        onAutoSyncChange={updateAppSettings}
        onClose={() => {
          if (!needsVaultSetup) {
            setIsVaultGuideOpen(false)
          }
        }}
        onSync={() => void handleSync()}
        onVaultState={handleVaultState}
        open={isVaultDialogOpen}
        required={needsVaultSetup}
        vaultPath={vaultPath}
      />
      <LockboxDialog
        mode={lockboxDialogMode}
        recoveryKey={recoveryKey}
        onChangePassword={handleChangeLockboxPassword}
        onClose={closeLockboxDialog}
        onModeChange={setLockboxDialogMode}
        onReset={handleResetLockboxPassword}
        onSetup={handleSetupLockbox}
        onUnlock={handleUnlockLockbox}
      />
    </>
  )
}

function LockboxArchiveConfirmDialog({
  fragment,
  isArchiving,
  onCancel,
  onConfirm,
}: {
  fragment: Fragment | null
  isArchiving: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      disablePointerDismissal={isArchiving}
      open={fragment !== null}
      onOpenChange={(nextOpen: boolean) => {
        if (!nextOpen && !isArchiving) onCancel()
      }}
    >
      <DialogContent
        aria-busy={isArchiving}
        role="alertdialog"
        showCloseButton={!isArchiving}
        style={{ maxWidth: 420 }}
      >
        <DialogHeader>
          <DialogTitle>确认归档密匣笔记</DialogTitle>
          <DialogDescription>
            这条笔记属于密匣。归档后会从密匣列表移除，并且不会出现在「归档/回收站」列表中。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-row justify-end">
          <Button disabled={isArchiving} onClick={onCancel} variant="secondary">
            取消
          </Button>
          <Button
            disabled={isArchiving}
            onClick={onConfirm}
            variant="destructive"
          >
            {isArchiving ? "归档中" : "仍然归档"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LockboxHeader({
  lockbox,
  selectedTag,
  summaries,
  totalCount,
  onChangePassword,
  onLock,
  onSelectTag,
  onUnlock,
}: {
  lockbox: LockboxState | null
  selectedTag: string | null
  summaries: TaggedSummary[]
  totalCount: number
  onChangePassword: () => void
  onLock: () => void
  onSelectTag: (tag: string | null) => void
  onUnlock: () => void
}) {
  return (
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
          borderBottom: "1px solid var(--border)",
          paddingBottom: "var(--shard-space-4)",
        }}
      >
        <div
          style={{
            display: "flex",
            minWidth: 0,
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "var(--shard-space-3)",
          }}
        >
          <div
            style={{
              display: "flex",
              minWidth: 0,
              alignItems: "center",
              gap: "var(--shard-space-3)",
            }}
          >
            <span
              style={{
                display: "flex",
                flexShrink: 0,
                width: 32,
                height: 32,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "var(--shard-radius-control)",
                border: "1px solid var(--border)",
                background: "var(--card)",
                color: "var(--shard-sapphire)",
              }}
            >
              <LockKeyholeIcon size={16} strokeWidth={1.75} />
            </span>
            <div style={{ minWidth: 0 }}>
              <h1
                style={{
                  fontSize: 18,
                  lineHeight: "24px",
                  fontWeight: 700,
                  textWrap: "balance",
                }}
              >
                密匣
              </h1>
              <p
                style={{
                  marginTop: 4,
                  fontSize: 14,
                  lineHeight: "20px",
                  textWrap: "pretty",
                  color: "var(--muted-foreground)",
                }}
              >
                {lockbox?.unlocked
                  ? `已解锁${lockbox.expiresAt ? `至 ${formatLockboxExpiry(lockbox.expiresAt)}` : ""}`
                  : "需要密码访问。私密笔记不会出现在主页、回顾或普通统计中。"}
              </p>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexShrink: 0,
              alignItems: "center",
              gap: "var(--shard-space-2)",
            }}
          >
            {lockbox?.unlocked ? (
              <>
                <Button onClick={onChangePassword} size="sm" variant="secondary">
                  修改密码
                </Button>
                <Button onClick={onLock} size="sm" variant="secondary">
                  上锁
                </Button>
              </>
            ) : (
              <Button onClick={onUnlock} size="sm" variant="primary">
                解锁
              </Button>
            )}
          </div>
        </div>

        {lockbox?.unlocked ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--shard-space-2)",
              marginTop: "var(--shard-space-3)",
            }}
          >
            <div
              style={{
                display: "flex",
                height: "var(--shard-chip-height)",
                alignItems: "center",
                gap: "var(--shard-space-2)",
                fontSize: 12,
                fontWeight: 500,
                color: "var(--muted-foreground)",
              }}
            >
              <TagIcon size={14} strokeWidth={1.75} />
              <span className="tabular-nums">{summaries.length} 子标签</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{totalCount} 条</span>
            </div>

            <div
              className="shard-tag-filters"
              style={{
                display: "flex",
                maxHeight: 72,
                flexWrap: "wrap",
                alignContent: "flex-start",
                gap: "var(--shard-space-2)",
                overflowY: "auto",
                paddingRight: "var(--shard-space-1)",
              }}
            >
              <LockboxTagFilterButton
                active={selectedTag === null}
                count={totalCount}
                label="全部"
                onClick={() => onSelectTag(null)}
              />
              {summaries.map((summary) => (
                <LockboxTagFilterButton
                  active={selectedTag === summary.tag}
                  count={summary.count}
                  key={summary.tag}
                  label={`#${summary.tag}`}
                  onClick={() => onSelectTag(summary.tag)}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function LockboxTagFilterButton({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean
  count: number
  label: string
  onClick: () => void
}) {
  return (
    <button
      aria-pressed={active}
      className={["shard-tag", active ? "shard-tag-active" : ""].join(" ")}
      onClick={onClick}
      style={{ maxWidth: "100%", gap: "var(--shard-space-micro)", fontWeight: 500 }}
      title={label}
      type="button"
    >
      <span
        className="shard-chip-text"
        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {label}
      </span>
      <span className="shard-chip-text shard-tag-count">{count}</span>
    </button>
  )
}

function isVaultNotConfigured(error: unknown) {
  return String(error).includes("vault_not_configured")
}

function isGitSetupError(error: unknown) {
  const message = String(error)
  return message.includes("Git 未初始化") || message.includes("Git remote 未配置")
}

function getFirstVisibleTag(fragment: Fragment) {
  return (
    fragment.tags.find(
      (tag) => tag !== "inbox" && tag !== LOCKBOX_TAG && !isTypeTag(tag)
    ) ?? null
  )
}

function formatLockboxExpiry(expiresAt: string) {
  return new Date(expiresAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function sortFragmentsForDisplay(fragments: Fragment[]) {
  return [...fragments].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.createdAt.localeCompare(a.createdAt)
  })
}

function isFragmentInMonth(fragment: Fragment, month: string) {
  if (fragment.kind !== "fragment" || fragment.archived || fragment.lockbox) {
    return false
  }
  const pathMonth = fragment.path.match(/^fragments\/(\d{4})\/(\d{2})\//u)
  if (pathMonth) return `${pathMonth[1]}-${pathMonth[2]}` === month
  if (!fragment.path.startsWith("fragments/")) return false
  return fragment.createdAt.slice(0, 7) === month
}

function buildTagSummaries(
  fragments: Fragment[],
  defaultTags: readonly string[]
): TaggedSummary[] {
  const summaries = new Map<string, TaggedSummary>()

  for (const tag of defaultTags) {
    summaries.set(tag, {
      count: 0,
      latestAt: "",
      tag,
    })
  }

  for (const fragment of fragments) {
    const tags = new Set(
      fragment.tags.filter(
        (tag) => tag !== "inbox" && tag !== LOCKBOX_TAG && !isTypeTag(tag)
      )
    )

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
