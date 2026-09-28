import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import styles from "../App.module.css"
import { LockKeyholeIcon, XIcon } from "@/components/icons"
import { BottomTabs } from "@/components/shard/bottom-tabs"
import { StatusBar } from "@/components/shard/status-bar"
import {
  FragmentEditor,
  setFragmentEditorBlurCommitPaused,
} from "@/components/shard/fragment-editor"
import { FragmentImageExporter } from "@/components/shard/fragment-image-exporter"
import { SearchPalette } from "@/components/shard/search-palette"
import {
  SearchContextBar,
  type FragmentSearchSession as LegacyFragmentSearchSession,
} from "@/components/shard/fragment-search-workspace"
import {
  ConvertFragmentDialog,
  FragmentFilterContext,
  FragmentFilterDialog,
  FragmentTrashWorkspace,
  OutlineUpgradeContext,
  OutlineUpgradeDialog,
} from "@/components/shard/fragment-workspace-controls"
import { conversionTitle, EMPTY_FRAGMENT_FILTERS, libraryDirectoryOptions, matchesFragmentFilters, type FragmentFilters } from "@/lib/fragment-space"
import {
  LockboxDialog,
} from "@/components/shard/lockbox-dialog"
import {
  MindMapWorkspace,
  type MindMapCanvasStorage,
  type MindMapCanvasStorageSnapshot,
  type MindMapWorkspaceHandle,
} from "@/components/shard/mind-map-workspace"
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
import { ZenSurface } from "@/components/shard/zen-surface"
import {
  CanvasWorkspace,
  type CanvasWorkspaceHandle,
} from "@/features/canvas/canvas-workspace"
import type { CanvasFile } from "@/features/canvas/model"
import type { CanvasSaveTransport } from "@/features/canvas/save-queue"
import { CalendarWorkspace } from "@/workspace/calendar-workspace"
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
  createGraphFragment,
  createFragment,
  DESKTOP_RUNTIME_MESSAGE,
  getApiErrorMessage,
  linkFragments,
  listCsvFiles,
  listDiagramDocuments,
  listFragments,
  listLibraryTree,
  listMindMaps,
  lockLockbox,
  moveFragmentToLockbox,
  migrateLegacyNotes,
  organizeFragments,
  pinFragment,
  resetLockboxPassword,
  readGraphFragment,
  setupLockbox,
  checkpointVault,
  syncVault,
  unlockLockbox,
  unlinkFragments,
  updateFragment,
  writeGraphFragment,
  type OrganizeTemplate,
} from "@/lib/api"
import { deriveKind, isTypeTag } from "@/lib/content-kind"
import { readOutlineContent } from "@/lib/mind-map-outline"
import { readFlowchartContent } from "@/lib/flowchart-content"
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
import {
  searchTargetKey,
  type ReadSearchTargetResponse,
  type SearchMode,
  type SearchRevealHandle,
  type SearchSession,
} from "@/lib/search-contract"
import { runSearchNavigation } from "@/lib/search-navigation"
import { normalizeSearchError } from "@/lib/search-api"
import { buildOpenCatalog } from "@/lib/quick-open-catalog"
import { clearQuickOpenMatchCache } from "@/lib/quick-open-match"
import { readPublicOpenRecent, recordPublicOpen, removePublicOpen } from "@/lib/search-recent"
import {
  createPublicSearchProvider,
  createRustSearchProvider,
} from "@/lib/search-provider"
import {
  acceptsSearchSessionIdentity,
  captureSearchSessionIdentity,
  createSearchSession,
  revokeSearchSession as revokeSearchSessionState,
  scopeForSpace,
  type SearchRevokeReason,
} from "@/lib/search-session"
import type {
  Fragment,
  CsvFileSummary,
  MindMapSummary,
  OutlineUpgradeRunResult,
  LibraryMutationResult,
  LibraryTreeSnapshot,
  ShardMapFile,
  ShardDocumentLink,
  VaultState,
} from "@/types"
import { FragmentsWorkspace } from "@/workspace/fragments-workspace"
import { LockboxShell } from "@/workspace/lockbox-shell"
import {
  LibraryShell,
  type LibraryDraftHandle,
  type LibraryNavigationTarget,
  type LibrarySearchNavigationTarget,
  type SaveState,
} from "@/workspace/library-shell"
import { createSearchTargetRouter } from "@/workspace/search-target-router"
import {
  writeWorkspaceRoute,
  type WorkspaceRoute,
} from "@/workspace/route"
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
import { useReminderBadge } from "@/workspace/use-reminder-badge"
import { useSearchController } from "@/workspace/use-search-controller"
import { DatasetZen, type DatasetZenHandle } from "@/features/datasets/dataset-zen"
import { OPEN_DATASET_EVENT } from "@/features/datasets/open-dataset"

const AUTO_SYNC_FAILURE_TOAST_ID = "auto-sync-failure"
const GLOBAL_CAPTURE_EVENT = "shard:capture"
const SIDEBAR_COLLAPSED_STORAGE_KEY = "shard.sidebar-collapsed"
const OUTLINE_UPGRADE_DISMISSED_STORAGE_PREFIX = "shard.outline-upgrade-dismissed:"
/** 切回窗口时对账碎片列表的最小间隔，避免频繁切换反复全量读取 vault。 */
const FOCUS_REFRESH_INTERVAL_MS = 5_000

function isJsonOutlineFragment(fragment: Fragment) {
  return (
    deriveKind(fragment.tags) === "outline" &&
    readOutlineContent(fragment.content)?.format === "json"
  )
}

function isJsonFlowchartFragment(fragment: Fragment) {
  return (
    deriveKind(fragment.tags) === "flowchart" &&
    readFlowchartContent(fragment.content)?.format === "json"
  )
}
const DEFAULT_PROJECT_TAGS: readonly string[] = ["日程"]
const LOCKBOX_SEARCH_PROVIDER = createRustSearchProvider("lockbox")
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
    acceptsVaultStateResponse,
    beginVaultStateRequest,
    completeVaultPrivacyChange,
    fragments,
    inboxFragments,
    isCreating,
    isLoading,
    lockboxFragments,
    publicActiveFragments,
    publicOnlyFragments,
    revokeVaultStateRequests,
    setFragments,
    setIsCreating,
    setIsLoading,
  } = useFragments()
  const {
    isArchivingLockboxFragment,
    lockbox,
    lockboxDialogMode,
    pendingLockboxArchiveFragment,
    pendingLockboxMoveId,
    recoveryKey,
    selectedLockboxTag,
    setIsArchivingLockboxFragment,
    setLockbox,
    setLockboxDialogMode,
    setPendingLockboxArchiveFragment,
    setPendingLockboxMoveId,
    setRecoveryKey,
    setSelectedLockboxTag,
  } = useLockbox()
  const {
    autoSyncFailureNotifiedRef,
    autoSyncTickRef,
    git,
    isSyncing,
    lastSyncAt,
    markSynced,
    setGit,
    setIsSyncing,
  } = useVaultSync()
  const [librarySaveState, setLibrarySaveState] =
    useState<SaveState | null>(null)
  const [isClosing, setIsClosing] = useState(false)
  const [openDatasetPath, setOpenDatasetPath] = useState<string | null>(null)
  const openDatasetPathRef = useRef<string | null>(null)
  const datasetZenRef = useRef<DatasetZenHandle>(null)
  const datasetOpenQueue = useRef(Promise.resolve())
  const [vaultPath, setVaultPath] = useState("")
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
    readSidebarCollapsed
  )
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
  const [pendingScrollNavigationId, setPendingScrollNavigationId] =
    useState<string | null>(null)
  const [isSearchModeActive, setIsSearchModeActive] = useState(false)
  const [legacySearchSession, setLegacySearchSession] =
    useState<LegacyFragmentSearchSession | null>(null)
  const [searchSession, setSearchSession] = useState<SearchSession | null>(null)
  const [isMindMapViewActive, setIsMindMapViewActive] = useState(false)
  const [activeMindMapId, setActiveMindMapId] = useState<string | null>(null)
  const [activeOutlineEditor, setActiveOutlineEditor] = useState<{
    fragmentId: string
    searchRequestId?: string
  } | null>(null)
  const [activeFlowchartEditor, setActiveFlowchartEditor] = useState<{
    fragmentId: string
    searchRequestId?: string
  } | null>(null)
  const [searchMindMapNavigation, setSearchMindMapNavigation] = useState<{
    requestId: string
    result: import("@/types").MindMapReadResult
  } | null>(null)
  const [searchEditorNavigation, setSearchEditorNavigation] = useState<{
    fragment: Fragment
    readOnly: boolean
    requestId: string
  } | null>(null)
  const [mindMaps, setMindMaps] = useState<MindMapSummary[]>([])
  const [csvFiles, setCsvFiles] = useState<CsvFileSummary[]>([])
  const [libraryTree, setLibraryTree] = useState<LibraryTreeSnapshot | null>(null)
  const [fragmentFilters, setFragmentFilters] = useState<FragmentFilters>(EMPTY_FRAGMENT_FILTERS)
  const [isFragmentFilterOpen, setIsFragmentFilterOpen] = useState(false)
  const [navigationOrigin, setNavigationOrigin] = useState<{ route: WorkspaceRoute; filters: FragmentFilters } | null>(null)
  const [convertingFragment, setConvertingFragment] = useState<Fragment | null>(null)
  const [conversionDraft, setConversionDraft] = useState({ title: "", directory: "notes" })
  const [conversionBusy, setConversionBusy] = useState(false)
  const [conversionNeedsVerification, setConversionNeedsVerification] = useState(false)
  const conversionActionRef = useRef(false)
  const [conversionError, setConversionError] = useState<string | null>(null)
  const [outlineUpgradeRequest, setOutlineUpgradeRequest] = useState<{
    preselectedIds: string[] | null
  } | null>(null)
  const [dismissedOutlineUpgradeCount, setDismissedOutlineUpgradeCount] = useState(0)
  const [fragmentSelectionActive, setFragmentSelectionActive] = useState(false)
  const fragmentsView = route.space === "fragments" ? route.params.view ?? "all" : "all"
  const searchReturnFocusRef = useRef<HTMLElement | null>(null)
  const fragmentFilterReturnFocusRef = useRef<HTMLElement | null>(null)
  const librarySaveHandlerRef = useRef<LibraryDraftHandle | null>(null)
  const mindMapWorkspaceRef = useRef<MindMapWorkspaceHandle>(null)
  const flowchartWorkspaceRef = useRef<CanvasWorkspaceHandle>(null)
  const composerDraftRef = useRef("")
  const fragmentFlushRef = useRef<(() => Promise<boolean>) | null>(null)
  const registerFragmentFlush = useCallback((flush: (() => Promise<boolean>) | null) => { fragmentFlushRef.current = flush }, [])
  useEffect(() => {
    const onOpen = (event: Event) => {
      const path = (event as CustomEvent<{ path: string }>).detail?.path
      if (!path) return
      datasetOpenQueue.current = datasetOpenQueue.current.then(async () => {
        if (openDatasetPathRef.current === path) { datasetZenRef.current?.focus(); return }
        if (openDatasetPathRef.current && !((await datasetZenRef.current?.flush()) ?? true)) {
          toast.error("当前数据集尚未保存，请先处理保存问题")
          return
        }
        openDatasetPathRef.current = path
        setOpenDatasetPath(path)
      }).catch(error => { toast.error(`打开数据集失败：${getApiErrorMessage(error)}`) })
    }
    window.addEventListener(OPEN_DATASET_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_DATASET_EVENT, onOpen)
  }, [])
  const [pendingLibraryTarget, setPendingLibraryTarget] =
    useState<LibraryNavigationTarget | null>(null)
  const [pendingLibrarySearchTarget, setPendingLibrarySearchTarget] =
    useState<LibrarySearchNavigationTarget | null>(null)
  const nextLibraryNavigationIdRef = useRef(0)
  const migratedLibraryVaultRef = useRef<string | null>(null)
  const routeRef = useRef(route)
  const vaultPathRef = useRef(vaultPath)
  const searchSessionRef = useRef<SearchSession | null>(null)
  const searchUiEpochRef = useRef(0)
  const nextSearchSessionIdRef = useRef(0)
  const nextSearchNavigationIdRef = useRef(0)
  const searchNavigationAbortRef = useRef<AbortController | null>(null)
  const searchNavigationStartedRef = useRef<string | null>(null)
  const searchNavigationWaitersRef = useRef(new Map<string, {
    reject: (error: unknown) => void
    resolve: (result: { reveal: SearchRevealHandle | null }) => void
  }>())
  const activeSearchRevealRef = useRef<{
    handle: SearchRevealHandle
    requestId: string
    targetKey: string
  } | null>(null)
  const recordContentActivityRef = useRef<() => void>(() => {})

  const syncOutlineFragment = useCallback((snapshot: MindMapCanvasStorageSnapshot) => {
    if (!snapshot.fragment) return
    setFragments((current) =>
      sortFragmentsForDisplay(
        current.map((fragment) =>
          fragment.id === snapshot.fragment!.id
            ? snapshot.fragment!
            : fragment
        )
      )
    )
  }, [])

  const outlineFragmentStorage = useMemo<MindMapCanvasStorage>(() => ({
    afterRead(snapshot) {
      syncOutlineFragment(snapshot)
    },
    afterSave(snapshot) {
      if (!snapshot.fragment) return
      syncOutlineFragment(snapshot)
      setGit((current) => current?.status === "ready"
        ? { ...current, status: "dirty" }
        : current)
      recordContentActivityRef.current()
    },
    isConflict(error) {
      return getApiErrorMessage(error).includes("STALE_BASE")
    },
    async read(id) {
      const result = await readGraphFragment(id)
      return {
        baseline: result.fragment.fileSha ?? null,
        file: result.graph as ShardMapFile,
        fragment: result.fragment,
      }
    },
    async write(id, file, baseline) {
      const result = await writeGraphFragment(
        id,
        file,
        typeof baseline === "string" ? baseline : undefined
      )
      return {
        baseline: result.fragment.fileSha ?? null,
        file: result.graph,
        fragment: result.fragment,
      }
    },
  }), [syncOutlineFragment])

  const syncFlowchartFragment = useCallback((fragment: Fragment) => {
    setFragments((current) =>
      sortFragmentsForDisplay(
        current.map((candidate) => candidate.id === fragment.id ? fragment : candidate)
      )
    )
  }, [])

  const flowchartFragmentStorage = useMemo(() => {
    const id = activeFlowchartEditor?.fragmentId
    if (!id) return null
    const readFromStorage = async () => {
      const result = await readGraphFragment(id)
      syncFlowchartFragment(result.fragment)
      if (!result.fragment.fileSha) throw new Error("流程图片段缺少文件保存基线。")
      return {
        file: result.graph as CanvasFile,
        lastSavedHash: result.fragment.fileSha,
        path: result.fragment.path,
      }
    }
    const saveTransport: CanvasSaveTransport = async (request) => {
      const result = await writeGraphFragment<CanvasFile>(id, request.file, request.lastSavedHash)
      syncFlowchartFragment(result.fragment)
      if (!result.fragment.fileSha) throw new Error("流程图片段缺少文件保存基线。")
      setGit((current) => current?.status === "ready"
        ? { ...current, status: "dirty" }
        : current)
      recordContentActivityRef.current()
      return {
        file: result.graph,
        lastSavedHash: result.fragment.fileSha,
        path: result.fragment.path,
      }
    }
    return { readFromStorage, saveTransport }
  }, [activeFlowchartEditor?.fragmentId, syncFlowchartFragment])

  vaultPathRef.current = vaultPath
  searchSessionRef.current = searchSession

  useEffect(() => {
    void refreshFragments()
    void refreshMindMaps()
  }, [])

  useEffect(() => () => {
    searchUiEpochRef.current += 1
    searchSessionRef.current = null
    setFragmentEditorBlurCommitPaused(false)
    clearQuickOpenMatchCache()
  }, [])

  // 没有文件监听：终端 `shard` 等外部写入的碎片，在切回窗口时静默对账一次。
  const refreshFragmentsRef = useRef(refreshFragments)
  refreshFragmentsRef.current = refreshFragments
  useEffect(() => {
    let lastRefreshAt = Date.now()
    let inFlight = false
    const handleFocus = () => {
      if (inFlight || Date.now() - lastRefreshAt < FOCUS_REFRESH_INTERVAL_MS) return
      inFlight = true
      lastRefreshAt = Date.now()
      void refreshFragmentsRef.current({ silent: true }).finally(() => {
        inFlight = false
      })
    }
    window.addEventListener("focus", handleFocus)
    return () => window.removeEventListener("focus", handleFocus)
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
    if (!vaultPath || (route.space !== "library" && fragmentsView !== "trash")) return
    void prepareLibraryTree(vaultPath)
  }, [route.space, fragmentsView, vaultPath])

  const registerLibrarySaveHandler = useCallback(
    (handle: LibraryDraftHandle | null) => {
      librarySaveHandlerRef.current = handle
    },
    []
  )

  const saveLibraryDraftBeforeNavigation = useCallback(async () => {
    if (fragmentFlushRef.current && !(await fragmentFlushRef.current())) return false
    if ((activeMindMapId || activeOutlineEditor) && !((await mindMapWorkspaceRef.current?.flush()) ?? true)) return false
    if (activeFlowchartEditor && !((await flowchartWorkspaceRef.current?.flush()) ?? true)) return false
    if (routeRef.current.space !== "library") return true
    return (await librarySaveHandlerRef.current?.flush()) ?? true
  }, [activeFlowchartEditor, activeMindMapId, activeOutlineEditor])

  useLockboxSecurityEffects({
    autoLock: (options) => {
      void autoLockLockbox(options)
    },
    lockbox,
    route,
  })

  const replaceSearchSession = useCallback((next: SearchSession | null) => {
    searchSessionRef.current = next
    setSearchSession(next)
  }, [])

  function beginSearchSession(mode: SearchMode) {
    const scope = scopeForSpace(routeRef.current.space)
    searchUiEpochRef.current += 1
    nextSearchSessionIdRef.current += 1
    const next = createSearchSession({
      id: `search-${nextSearchSessionIdRef.current}`,
      mode,
      scope,
      uiEpoch: searchUiEpochRef.current,
      vaultPath: vaultPathRef.current,
    })
    replaceSearchSession(next)
    return next
  }

  function revokeSearchSession(reason: SearchRevokeReason) {
    searchNavigationAbortRef.current?.abort()
    searchNavigationAbortRef.current = null
    activeSearchRevealRef.current?.handle.clearHits("revoke")
    activeSearchRevealRef.current = null
    revokeSearchSessionState(
      {
        sessionRef: searchSessionRef,
        uiEpochRef: searchUiEpochRef,
        clear: () => {
          clearQuickOpenMatchCache()
          setFragmentEditorBlurCommitPaused(false)
          setSearchSession(null)
          setLegacySearchSession(null)
          setIsSearchModeActive(false)
          setPendingLibraryTarget(null)
          setPendingLibrarySearchTarget(null)
          setPendingScrollFragmentId(null)
          setPendingScrollNavigationId(null)
          setSearchEditorNavigation(null)
          setSearchMindMapNavigation(null)
          searchReturnFocusRef.current = null
        },
      },
      reason
    )
  }

  /** `silent`：后台对账（如切回窗口），不闪加载态，失败也不打扰，等下一次显式刷新。 */
  async function refreshFragments(options: { silent?: boolean } = {}) {
    if (!options.silent) setIsLoading(true)
    const request = beginVaultStateRequest(vaultPathRef.current || null)
    try {
      const state = await listFragments()
      if (!acceptsVaultStateResponse(request, state.vaultPath)) return
      applyVaultState(state)
    } catch (error) {
      if (options.silent) return
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
      if (!options.silent) setIsLoading(false)
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
        await refreshMindMaps()
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
    const previousVaultPath = vaultPathRef.current
    if (previousVaultPath && previousVaultPath !== state.vaultPath) {
      revokeSearchSession("vaultChanged")
    } else if (
      !state.lockbox.unlocked &&
      searchSessionRef.current?.scope === "lockbox"
    ) {
      revokeSearchSession("locked")
    }

    const visibleFragments = state.lockbox.unlocked
      ? state.fragments
      : publicFragments(state.fragments)

    setFragments(sortFragmentsForDisplay(visibleFragments))
    setGit(state.git)
    setLockbox(state.lockbox)
    vaultPathRef.current = state.vaultPath
    setVaultPath(state.vaultPath)
    if (previousVaultPath && previousVaultPath !== state.vaultPath) {
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
    revokeVaultStateRequests()
    applyVaultState(state)
    if (options.resetView) {
      closeEditor()
      setIsMindMapViewActive(false)
      setRoute({ space: "fragments", params: {} })
    }
    setIsVaultGuideOpen(true)
  }

  /** 返回创建好的碎片：`/文档` 提交后速记框据此直接进禅模式（产品框架 §2）。 */
  async function handleCreate(content: string, tags: string[]): Promise<Fragment> {
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
        return created
      } catch (error) {
        const message = getApiErrorMessage(error)
        toast.error(`${"创建密匣片段失败"}：${message}`, {
          duration: Infinity,
        })
        throw new Error(message)
      } finally {
        setIsCreating(false)
      }
    }

    try {
      let created = await createFragment(content, tags)
      setFragments((current) =>
        sortFragmentsForDisplay([created, ...current])
      )
      setGit((current) => current?.status === "ready"
        ? { ...current, status: "dirty" }
        : current)
      if (content.includes("[[")) {
        try {
          const links = await parseWikilinksInWorker(content)
          if (links.length > 0) {
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
          }
        } catch (error) {
          toast.error(
            `片段已保存，但双链同步失败：${getApiErrorMessage(error)}`,
            { duration: Infinity }
          )
        }
      }
      if (created.gitStatus === "commit_failed") {
        toast(
          `${"片段已保存，但 Git commit 失败"}：${
            created.error ?? "可以继续记录，之后再处理 Git 配置。"
          }`
        )
      } else {
        if (!matchesFragmentFilters(created, fragmentFilters)) {
          toast("已记录，当前筛选下不可见", { action: { label: "查看碎片", onClick: () => showFragmentTarget(created) } })
        } else toast("碎片已保存")
      }
      return created
    } catch (error) {
      const message = getApiErrorMessage(error)
      toast.error(`${"创建片段失败"}：${message}`, { duration: Infinity })
      throw new Error(message)
    } finally {
      setIsCreating(false)
    }
  }

  async function handleCreateOutline(
    operationId: string,
    file: ShardMapFile,
    tags: string[]
  ): Promise<Fragment> {
    recordContentActivity()
    setIsCreating(true)
    try {
      const { fragment } = await createGraphFragment(
        "outline",
        operationId,
        file,
        tags
      )
      setFragments((current) =>
        sortFragmentsForDisplay([fragment, ...current])
      )
      setGit((current) => current?.status === "ready"
        ? { ...current, status: "dirty" }
        : current)
      if (!matchesFragmentFilters(fragment, fragmentFilters)) {
        toast("已记录，当前筛选下不可见", {
          action: { label: "查看碎片", onClick: () => showFragmentTarget(fragment) },
        })
      } else {
        toast("碎片已保存")
      }
      return fragment
    } catch (error) {
      const message = getApiErrorMessage(error)
      toast.error(`创建大纲失败：${message}`, { duration: Infinity })
      throw new Error(message)
    } finally {
      setIsCreating(false)
    }
  }

  async function handleCreateFlowchart(
    operationId: string,
    tags: string[]
  ): Promise<Fragment> {
    recordContentActivity()
    setIsCreating(true)
    try {
      const { fragment } = await createGraphFragment(
        "flowchart",
        operationId,
        null,
        tags
      )
      setFragments((current) =>
        sortFragmentsForDisplay([fragment, ...current])
      )
      setGit((current) => current?.status === "ready"
        ? { ...current, status: "dirty" }
        : current)
      if (!matchesFragmentFilters(fragment, fragmentFilters)) {
        toast("已记录，当前筛选下不可见", {
          action: { label: "查看碎片", onClick: () => showFragmentTarget(fragment) },
        })
      } else {
        toast("碎片已保存")
      }
      return fragment
    } catch (error) {
      const message = getApiErrorMessage(error)
      toast.error(`创建流程图失败：${message}`, { duration: Infinity })
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
      markSynced()
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

  // 状态栏的「未提交更改」入口。语义是「立即做一次检查点」而不是传统 commit：
  // 走的正是自动检查点那条路（AGENTS.md 的合并保存策略），只把 90s idle 等待提前，
  // 不新开一条绕过策略的提交路径。
  async function handleCheckpoint() {
    // 同 handleSync：不 flush 会把旧磁盘内容提交进去
    if (!(await saveLibraryDraftBeforeNavigation())) {
      toast.error("草稿保存失败，已取消提交", { duration: Infinity })
      return
    }
    try {
      const result = await checkpointVault("手动")
      setGit(result.git)
      switch (result.status) {
        case "committed":
          toast(`已提交 ${result.changes} 项变更`)
          // 逐文件 gitStatus 来自读取时的脏检测，要整体刷新才会退回 clean
          void refreshFragments()
          void refreshMindMaps()
          break
        case "no_changes":
          toast("没有需要提交的变更")
          break
        case "blocked":
          toast(`提交已跳过：${result.reason ?? "有未完成的 Git 操作"}`)
          break
        case "not_git":
          toast("当前资料库未启用 Git")
          break
      }
    } catch (error) {
      toast.error(`${"提交失败"}：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    }
  }

  async function handleUpdateFragment(
    id: string,
    content: string,
    tags: string[],
    expectedFileSha?: string
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

    let updated = await updateFragment(id, content, tags, expectedFileSha)
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

  function handleFragmentPropertyUpdated(updated: Fragment) {
    recordContentActivity()
    setFragments((current) =>
      current.map((fragment) => (fragment.id === updated.id ? updated : fragment))
    )
  }

  function openInlineEditor(fragment: Fragment) {
    if (isJsonOutlineFragment(fragment)) {
      openOutlineEditor(fragment)
      return
    }
    if (isJsonFlowchartFragment(fragment)) {
      openFlowchartEditor(fragment)
      return
    }
    setZenDraft(null)
    setEditingVariant("inline")
    setEditingFragmentId(fragment.id)
  }

  function openZenEditor(fragment: Fragment) {
    if (isJsonOutlineFragment(fragment)) {
      openOutlineEditor(fragment)
      return
    }
    if (isJsonFlowchartFragment(fragment)) {
      openFlowchartEditor(fragment)
      return
    }
    setZenDraft(null)
    setEditingVariant("zen")
    setEditingFragmentId(fragment.id)
  }

  async function openOutlineUpgrade(fragmentId?: string) {
    if (fragmentId && fragmentFlushRef.current && !(await fragmentFlushRef.current())) return
    setOutlineUpgradeRequest({ preselectedIds: fragmentId ? [fragmentId] : null })
  }

  async function handleOutlineUpgradeComplete(result: OutlineUpgradeRunResult) {
    const upgradedIds = new Set(
      result.results
        .filter((item) => item.status === "upgraded")
        .map((item) => item.id)
    )
    const openFragmentId = searchEditorNavigation?.fragment.id ?? editingFragmentId
    if (openFragmentId && upgradedIds.has(openFragmentId)) closeEditor()
    if (upgradedIds.size > 0) {
      setDismissedOutlineUpgradeCount(0)
      try {
        window.localStorage.removeItem(
          `${OUTLINE_UPGRADE_DISMISSED_STORAGE_PREFIX}${vaultPathRef.current}`
        )
      } catch {
        // 受限 WebView 中 localStorage 可能不可用。
      }
    }
    await refreshFragments()
  }

  function openOutlineEditor(fragment: Fragment, searchRequestId?: string) {
    setZenDraft(null)
    setEditingFragmentId(null)
    setSearchEditorNavigation(null)
    setActiveMindMapId(null)
    setSearchMindMapNavigation(null)
    setActiveFlowchartEditor(null)
    setActiveOutlineEditor({ fragmentId: fragment.id, searchRequestId })
  }

  function openFlowchartEditor(fragment: Fragment, searchRequestId?: string) {
    setZenDraft(null)
    setEditingFragmentId(null)
    setSearchEditorNavigation(null)
    setActiveMindMapId(null)
    setSearchMindMapNavigation(null)
    setActiveOutlineEditor(null)
    setActiveFlowchartEditor({ fragmentId: fragment.id, searchRequestId })
  }

  async function closeFlowchartEditor() {
    if (!((await flowchartWorkspaceRef.current?.flush()) ?? true)) return
    setActiveFlowchartEditor(null)
  }

  async function openFlowchartLink(link: ShardDocumentLink) {
    if (link.targetType === "map" || link.targetType === "flow") {
      try {
        const documents = await listDiagramDocuments()
        const kind = link.targetType === "map" ? "mindmap" : "flowchart"
        const document = documents.find(
          (candidate) => candidate.id === link.targetId && candidate.kind === kind
        )
        if (!document) {
          const fragment = publicActiveFragments.find((candidate) =>
            candidate.id === link.targetId && (
              link.targetType === "map"
                ? isJsonOutlineFragment(candidate)
                : isJsonFlowchartFragment(candidate)
            )
          )
          if (!fragment) {
            toast.error("引用的图文档已不存在")
            return
          }
          if (link.targetType === "map") openOutlineEditor(fragment)
          else openFlowchartEditor(fragment)
          return
        }
        setActiveFlowchartEditor(null)
        requestLibraryTarget({ kind, path: document.path })
        setRoute({ space: "library", params: {} })
      } catch (error) {
        toast.error(`打开图文档失败：${getApiErrorMessage(error)}`)
      }
      return
    }
    const fragment = publicOnlyFragments.find((candidate) =>
      link.targetType === "fragment"
        ? candidate.id === link.targetId
        : candidate.path === link.path
    )
    if (!fragment) {
      toast.error("引用的资料已不存在或已移动")
      return
    }
    setActiveFlowchartEditor(null)
    await handleOpenSearchResult(fragment)
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
    setSearchEditorNavigation(null)
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
    if (fragment.archived) {
      await archiveFragmentWithFeedback(fragment, false)
      return
    }

    if (fragment.lockbox) {
      setPendingLockboxArchiveFragment(fragment)
      return
    }

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
      if (!fragment.lockbox) await refreshLibraryTree()
      toast(archived ? "已移入回收站" : "已恢复")
      return true
    } catch (error) {
      toast.error(`${archived ? "删除失败" : "恢复失败"}：${getApiErrorMessage(error)}`, {
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
    if (deriveKind(fragment.tags) === "fragment" && !fragment.lockbox) {
      if (!(await saveLibraryDraftBeforeNavigation())) return
      setConversionError(null)
      setConversionNeedsVerification(false)
      setConversionDraft({ title: conversionTitle(fragment), directory: "notes" })
      setConvertingFragment(fragment)
      setConversionBusy(true)
      try {
        const tree = await listLibraryTree()
        setLibraryTree(tree)
        let directory = "notes"
        try { directory = localStorage.getItem(`shard.convert-directory:${vaultPath}`) ?? "notes" } catch { /* unavailable storage */ }
        if (!libraryDirectoryOptions(tree.entries).some(option => option.value === directory)) directory = "notes"
        setConversionDraft({ title: conversionTitle(fragment), directory })
      } catch (error) {
        setConversionError(`目录读取失败：${getApiErrorMessage(error)}`)
      } finally { setConversionBusy(false) }
      return
    }
    recordContentActivity()
    const nextKind = fragment.kind === "note" ? "fragment" : "note"

    try {
      const result =
        nextKind === "note"
          ? await convertFragmentToNote(fragment.id)
          : await convertNoteToFragment(fragment.id)
      handleLibraryMutation(result)
      toast(nextKind === "note" ? "已转为文档" : "已转回碎片")
    } catch (error) {
      toast.error(
        `${nextKind === "note" ? "转为文档失败" : "转回碎片失败"}：${getApiErrorMessage(error)}`,
        { duration: Infinity }
      )
    }
  }

  function openConvertedDocument(fragment: Fragment) {
    setNavigationOrigin({ route, filters: fragmentFilters })
    setConvertingFragment(null)
    setConversionNeedsVerification(false)
    closeEditor()
    requestLibraryTarget({ kind: "note", id: fragment.id, edit: true })
  }

  async function verifyFragmentConversion(id: string, failureMessage: string) {
    const request = beginVaultStateRequest(vaultPathRef.current || null)
    try {
      const state = await listFragments()
      if (!acceptsVaultStateResponse(request, state.vaultPath)) return
      const current = state.fragments.find(fragment => fragment.id === id)
      if (!current || current.archived || current.lockbox) {
        setConversionError("暂时无法确认内容所在位置，请重新核对后继续。")
        return
      }
      if (deriveKind(current.tags) === "note") {
        applyVaultState(state)
        openConvertedDocument(current)
        toast("已核对：内容已转为文档")
      } else {
        setConversionNeedsVerification(false)
        setConversionError(`${failureMessage} 已核对：内容仍在碎片中，可以重试。`)
      }
    } catch (error) {
      setConversionError(`暂时无法核对转换结果：${getApiErrorMessage(error)}。请重新核对后继续。`)
    }
  }

  async function submitFragmentConversion() {
    if (!convertingFragment || conversionBusy || conversionActionRef.current) return
    conversionActionRef.current = true
    try {
      if (conversionNeedsVerification) {
        setConversionBusy(true)
        await verifyFragmentConversion(convertingFragment.id, "转换尚未完成。")
        return
      }
      if (!(await saveLibraryDraftBeforeNavigation())) return
      setConversionBusy(true)
      setConversionError(null)
      const result = await convertFragmentToNote(convertingFragment.id, conversionDraft.directory, conversionDraft.title.trim())
      if (!result.fragment) throw new Error("转换结果缺少文档，请刷新后核对。")
      handleLibraryMutation(result)
      try { localStorage.setItem(`shard.convert-directory:${vaultPath}`, conversionDraft.directory) } catch { /* unavailable storage */ }
      openConvertedDocument(result.fragment)
      toast("已转为文档")
    } catch (error) {
      // A failed transport can follow a successful disk mutation; never retry until its state is known.
      setConversionNeedsVerification(true)
      await verifyFragmentConversion(convertingFragment.id, `转换失败：${getApiErrorMessage(error)}。`)
    } finally {
      conversionActionRef.current = false
      setConversionBusy(false)
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
    void refreshMindMaps()
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
    const previousPath = publicOnlyFragments.find((fragment) => fragment.id === fragmentId)?.path
    if (searchSessionRef.current || legacySearchSession) {
      revokeSearchSession("targetMoved")
    }
    const request = beginVaultStateRequest(
      vaultPathRef.current || null,
      "privacy"
    )
    try {
      const state = await moveFragmentToLockbox(fragmentId)
      if (!acceptsVaultStateResponse(request, state.vaultPath)) return false
      if (previousPath) {
        removePublicOpen(
          state.vaultPath,
          searchTargetKey(state.vaultPath, "public", previousPath)
        )
      }
      completeVaultPrivacyChange()
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
    setSelectedLockboxTag(null)
    setRoute({ space: "lockbox", params: {} })
  }

  // 传送门：从资料库挂载点推门直接落进密匣一级空间。上锁态由空间页
  // 自己呈现（头部解锁按钮 + 上锁空态），解锁弹窗只由页内按钮触发，
  // 不在推门瞬间弹出。未配置时空间还不存在，仍先引导设置。
  function enterLockboxSpace() {
    if (!lockbox?.configured) {
      setLockboxDialogMode("setup")
      return
    }
    setSelectedLockboxTag(null)
    setRoute({ space: "lockbox", params: {} })
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

  async function handleSetupLockbox(password: string) {
    const request = beginVaultStateRequest(
      vaultPathRef.current || null,
      "privacy"
    )
    const result = await setupLockbox(password)
    if (!acceptsVaultStateResponse(request, result.vault.vaultPath)) return
    completeVaultPrivacyChange()
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
    const request = beginVaultStateRequest(
      vaultPathRef.current || null,
      "privacy"
    )
    const state = await unlockLockbox(password)
    if (!acceptsVaultStateResponse(request, state.vaultPath)) {
      if (state.lockbox.unlocked) {
        try {
          const relockRequest = beginVaultStateRequest(
            vaultPathRef.current || null,
            "privacy"
          )
          const lockedState = await lockLockbox()
          if (
            acceptsVaultStateResponse(relockRequest, lockedState.vaultPath) &&
            lockedState.vaultPath === vaultPathRef.current
          ) {
            completeVaultPrivacyChange()
            applyVaultState(lockedState)
          }
        } catch {
          // 离开安全区后的迟到解锁必须尽力回锁；失败时不把旧响应写回前端。
        }
      }
      return
    }
    completeVaultPrivacyChange()
    applyVaultState(state)
    setLockboxDialogMode(null)

    if (pendingLockboxMoveId) {
      const fragmentId = pendingLockboxMoveId
      setPendingLockboxMoveId(null)
      await moveFragmentIntoLockbox(fragmentId, "已解锁并移入密匣")
      return
    }

    setSelectedLockboxTag(null)
    setRoute({ space: "lockbox", params: {} })
    toast("密匣已解锁")
  }

  function hideLockboxLocally(returnToLibrary: boolean) {
    setLockbox((current) =>
      current ? { ...current, unlocked: false, expiresAt: null } : current
    )
    setFragments((current) => publicFragments(current))
    closeEditor()
    setSelectedLockboxTag(null)
    if (returnToLibrary && routeRef.current.space === "lockbox") {
      setRoute({ space: "library", params: {} })
    }
  }

  async function handleLockLockbox() {
    revokeSearchSession("locked")
    hideLockboxLocally(true)
    const request = beginVaultStateRequest(
      vaultPathRef.current || null,
      "privacy"
    )
    try {
      const state = await lockLockbox()
      if (!acceptsVaultStateResponse(request, state.vaultPath)) return
      completeVaultPrivacyChange()
      applyVaultState(state)
      toast("密匣已上锁")
    } catch (error) {
      toast.error(`${"密匣上锁失败"}：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    }
  }

  async function autoLockLockbox(
    options: { returnToLibrary?: boolean } = {}
  ) {
    if (searchSessionRef.current?.scope === "lockbox") {
      revokeSearchSession(options.returnToLibrary ? "expired" : "locked")
    }
    hideLockboxLocally(Boolean(options.returnToLibrary))
    const request = beginVaultStateRequest(
      vaultPathRef.current || null,
      "privacy"
    )
    try {
      const state = await lockLockbox()
      if (!acceptsVaultStateResponse(request, state.vaultPath)) return
      completeVaultPrivacyChange()
      applyVaultState(state)
    } catch (error) {
      toast.error(`密匣上锁失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    }
  }

  useEffect(() => {
    if (searchSession?.scope !== "lockbox" || !searchSession.expiresAt) return
    const deadline = Date.parse(searchSession.expiresAt)
    if (!Number.isFinite(deadline)) return
    const sessionId = searchSession.id
    const uiEpoch = searchSession.uiEpoch
    const timer = window.setTimeout(() => {
      const current = searchSessionRef.current
      if (current?.id !== sessionId || current.uiEpoch !== uiEpoch) return
      revokeSearchSession("expired")
      void autoLockLockbox({ returnToLibrary: true })
    }, Math.max(0, Math.min(deadline - Date.now(), 2_147_483_647)))
    return () => window.clearTimeout(timer)
  }, [searchSession?.id, searchSession?.uiEpoch, searchSession?.expiresAt, searchSession?.scope])

  async function handleChangeLockboxPassword(
    currentPassword: string,
    newPassword: string
  ) {
    const request = beginVaultStateRequest(
      vaultPathRef.current || null,
      "privacy"
    )
    const state = await changeLockboxPassword(currentPassword, newPassword)
    if (!acceptsVaultStateResponse(request, state.vaultPath)) return
    completeVaultPrivacyChange()
    applyVaultState(state)
    setLockboxDialogMode(null)
    toast("密匣密码已修改")
  }

  async function handleResetLockboxPassword(
    nextRecoveryKey: string,
    newPassword: string
  ) {
    const request = beginVaultStateRequest(
      vaultPathRef.current || null,
      "privacy"
    )
    const result = await resetLockboxPassword(nextRecoveryKey, newPassword)
    if (!acceptsVaultStateResponse(request, result.vault.vaultPath)) return
    completeVaultPrivacyChange()
    applyVaultState(result.vault)
    setRecoveryKey(result.recoveryKey)

    if (pendingLockboxMoveId) {
      const fragmentId = pendingLockboxMoveId
      setPendingLockboxMoveId(null)
      await moveFragmentIntoLockbox(fragmentId, "密匣密码已重置，笔记已移入")
      return
    }

    toast("密匣密码已重置")
  }

  function closeLockboxDialog() {
    if (lockboxDialogMode === "unlock") {
      revokeVaultStateRequests()
    }
    setPendingLockboxMoveId(null)
    setLockboxDialogMode(null)
    setRecoveryKey(null)
  }

  function showFragmentTarget(fragment: Fragment) {
    setPendingLibraryTarget(null)
    if (route.space !== "fragments" || fragmentsView !== "all" || !matchesFragmentFilters(fragment, fragmentFilters)) {
      setNavigationOrigin(current => current ?? { route, filters: fragmentFilters })
      setFragmentFilters(EMPTY_FRAGMENT_FILTERS)
    }
    setRoute({ space: "fragments", params: { view: fragment.archived ? "trash" : "all" } })
    setPendingScrollFragmentId(fragment.id)
  }

  async function returnToOrigin() {
    if (!navigationOrigin || !(await saveLibraryDraftBeforeNavigation())) return
    setActiveOutlineEditor(null)
    setActiveFlowchartEditor(null)
    revokeSearchSession("spaceChanged")
    setFragmentFilters(navigationOrigin.filters)
    setRoute(navigationOrigin.route)
    setNavigationOrigin(null)
  }

  async function handleOpenSearchResult(
    fragment: Fragment,
    session?: LegacyFragmentSearchSession
  ) {
    let identity: ReturnType<typeof captureSearchSessionIdentity> | null = null
    let targetKey: string | null = null
    if (session) {
      const currentSearchSession = searchSessionRef.current
      if (!currentSearchSession) return
      nextSearchNavigationIdRef.current += 1
      targetKey = searchTargetKey(
        currentSearchSession.vaultPath,
        currentSearchSession.scope,
        fragment.path
      )
      const navigationSession = {
        ...currentSearchSession,
        pendingNavigation: {
          requestId: `legacy-navigation-${nextSearchNavigationIdRef.current}`,
          targetKey,
        },
      }
      replaceSearchSession(navigationSession)
      identity = captureSearchSessionIdentity(navigationSession)
    }
    if (!(await saveLibraryDraftBeforeNavigation())) {
      const current = searchSessionRef.current
      if (
        identity &&
        acceptsSearchSessionIdentity(current, identity) &&
        current
      ) {
        replaceSearchSession({ ...current, pendingNavigation: null })
      }
      return
    }
    if (
      identity &&
      !acceptsSearchSessionIdentity(searchSessionRef.current, identity)
    ) {
      return
    }

    const completeNavigation = () => {
      if (!identity || !targetKey) return true
      const current = searchSessionRef.current
      if (!acceptsSearchSessionIdentity(current, identity) || !current) {
        return false
      }
      replaceSearchSession({
        ...current,
        openedKey: targetKey,
        pendingNavigation: null,
      })
      if (session) setLegacySearchSession(session)
      return true
    }

    // Search sessions may outlive a conversion. Resolve the current object by identity.
    fragment = fragments.find(current => current.id === fragment.id) ?? fragment
    setEditingVariant("inline")
    setEditingFragmentId(null)
    setSelectedLockboxTag(null)
    setIsMindMapViewActive(false)

    if (isJsonOutlineFragment(fragment) && !fragment.archived && !fragment.lockbox) {
      openOutlineEditor(fragment)
      setIsSearchModeActive(false)
      if (!completeNavigation()) return
      searchReturnFocusRef.current = null
      return
    }
    if (isJsonFlowchartFragment(fragment) && !fragment.archived && !fragment.lockbox) {
      openFlowchartEditor(fragment)
      setIsSearchModeActive(false)
      if (!completeNavigation()) return
      searchReturnFocusRef.current = null
      return
    }
    setActiveOutlineEditor(null)
    setActiveFlowchartEditor(null)

    if (fragment.lockbox) {
      if (!lockbox?.unlocked) {
        revokeSearchSession("locked")
        // 推门进密匣空间，解锁在空间内的面板里完成
        enterLockboxSpace()
        toast("请先解锁密匣后查看笔记")
        return
      }

      setRoute({ space: "lockbox", params: {} })
      if (deriveKind(fragment.tags) === "note") {
        // 密匣笔记住在空间的笔记树里而非碎片流，直接进禅编辑器
        openZenEditor(fragment)
      }
    } else if (deriveKind(fragment.tags) === "note" && !fragment.archived) {
      // 公开笔记进资料库编辑器；笔记不在碎片流里，不设滚动目标
      if (route.space !== "library") setNavigationOrigin(current => current ?? { route, filters: fragmentFilters })
      requestLibraryTarget({ kind: "note", id: fragment.id })
      setIsSearchModeActive(false)
      completeNavigation()
      searchReturnFocusRef.current = null
      return
    } else if (fragment.archived && deriveKind(fragment.tags) === "note") {
      requestLibraryTarget({ kind: "trash" })
    } else {
      showFragmentTarget(fragment)
    }

    setIsSearchModeActive(false)
    if (!completeNavigation()) return
    searchReturnFocusRef.current = null
    setPendingScrollFragmentId(fragment.id)
  }

  function requestLibraryTarget(
    target:
      | { kind: "note"; id: string; edit?: boolean }
      | { kind: "trash" }
      | { kind: "mindmap" | "flowchart"; path: string }
  ) {
    nextLibraryNavigationIdRef.current += 1
    setPendingLibraryTarget({
      ...target,
      requestId: nextLibraryNavigationIdRef.current,
    })
    if (routeRef.current.space !== "library") {
      setRoute({ space: "library", params: {} })
    }
  }

  async function handleNavigateToFragment(fragmentId: string) {
    const target = publicOnlyFragments.find(
      (fragment) => fragment.id === fragmentId
    )
    if (!target) {
      toast("链接目标已不存在")
      return
    }

    await handleOpenSearchResult(target)
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
    setNavigationOrigin({ route, filters: fragmentFilters })
    requestLibraryTarget({ kind: "note", id: created.id, edit: true })
    toast("文档已保存，来源碎片已保留")
    void refreshFragments()
    void refreshLibraryTree()
  }

  function openSearch() {
    openSearchMode("fullText")
  }

  function openQuickOpen() {
    openSearchMode("open")
  }

  function openSearchMode(mode: SearchMode) {
    // This must happen before React mounts the Dialog and moves focus.
    setFragmentEditorBlurCommitPaused(true)
    if (!isSearchModeActive && document.activeElement instanceof HTMLElement) {
      searchReturnFocusRef.current = document.activeElement
    }
    const current = searchSessionRef.current
    const scope = scopeForSpace(routeRef.current.space)
    if (
      !current ||
      current.vaultPath !== vaultPathRef.current ||
      current.scope !== scope
    ) {
      beginSearchSession(mode)
    } else if (current.mode !== mode) {
      searchController.onModeChange(mode)
    }
    if (mode === "open" && scope === "public" && !libraryTree) {
      void refreshLibraryTree()
    }
    setIsSearchModeActive(true)
  }

  function exitSearchMode() {
    setIsSearchModeActive(false)
    setFragmentEditorBlurCommitPaused(false)
    const returnFocus = searchReturnFocusRef.current
    revokeSearchSession("close")
    window.requestAnimationFrame(() => returnFocus?.focus())
  }

  function openFragmentFiltersFromSearch() {
    const current = searchSessionRef.current
    if (!current || current.scope !== "public" || current.mode !== "fullText") return
    fragmentFilterReturnFocusRef.current = searchReturnFocusRef.current
    setIsSearchModeActive(false)
    setFragmentEditorBlurCommitPaused(false)
    revokeSearchSession("close")
    setIsFragmentFilterOpen(true)
  }

  function closeFragmentFilters() {
    setIsFragmentFilterOpen(false)
    const returnFocus = fragmentFilterReturnFocusRef.current
    fragmentFilterReturnFocusRef.current = null
    window.requestAnimationFrame(() => returnFocus?.focus())
  }

  async function applyFragmentFilters(filters: FragmentFilters) {
    if (!(await saveLibraryDraftBeforeNavigation())) return
    setActiveOutlineEditor(null)
    setActiveFlowchartEditor(null)
    setFragmentFilters(filters)
    setIsFragmentFilterOpen(false)
    fragmentFilterReturnFocusRef.current = null
    revokeSearchSession("close")
    setIsMindMapViewActive(false)
    setActiveMindMapId(null)
    setSearchMindMapNavigation(null)
    setNavigationOrigin(null)
    setRoute({ space: "fragments", params: {} })
  }

  function endSearchSession() {
    activeSearchRevealRef.current?.handle.clearHits("exit")
    activeSearchRevealRef.current = null
    revokeSearchSession("close")
  }

  function navigateSearchResult(nextIndex: number) {
    if (!legacySearchSession) return
    const fragmentId = legacySearchSession.resultIds[nextIndex]
    const fragment = fragments.find((candidate) => candidate.id === fragmentId)
    if (!fragment) {
      toast("这条笔记已不在当前搜索范围中")
      return
    }

    const nextSession = { ...legacySearchSession, activeIndex: nextIndex }
    handleOpenSearchResult(fragment, nextSession)
  }

  function navigateCurrentSearchResult(nextIndex: number) {
    const current = searchSessionRef.current
    const hit = current?.hits[nextIndex]
    if (!current || !hit) return
    searchController.onSelect(hit)
  }

  function stepCurrentDocumentHit(direction: 1 | -1) {
    const active = activeSearchRevealRef.current
    const current = searchSessionRef.current
    if (!active || !current || current.openedKey !== active.targetKey) return
    void active.handle.stepHit(direction).then((result) => {
      const latest = searchSessionRef.current
      if (
        !latest ||
        latest.openedKey !== active.targetKey ||
        activeSearchRevealRef.current?.requestId !== active.requestId
      ) {
        return
      }
      replaceSearchSession({ ...latest, lastReveal: result })
    })
  }

  async function openMindMap(map?: MindMapSummary) {
    if (!(await saveLibraryDraftBeforeNavigation())) return

    setActiveOutlineEditor(null)
    setActiveFlowchartEditor(null)
    revokeSearchSession("spaceChanged")
    if (!map) {
      if (route.space !== "fragments") {
        setRoute({ space: "fragments", params: {} })
      }
      setIsMindMapViewActive(true)
      return
    }

    setActiveMindMapId(map.id)
  }

  async function handleRouteChange(nextRoute: WorkspaceRoute) {
    revokeSearchSession("spaceChanged")
    if (
      routeRef.current.space === "lockbox" &&
      nextRoute.space !== "lockbox"
    ) {
      revokeVaultStateRequests()
    }
    if (!(await saveLibraryDraftBeforeNavigation())) return

    setActiveOutlineEditor(null)
    setActiveFlowchartEditor(null)
    setIsMindMapViewActive(false)
    setNavigationOrigin(null)
    setFragmentSelectionActive(false)

    if (nextRoute.space === "lockbox" && !lockbox?.configured) {
      setLockboxDialogMode("setup")
      return
    }

    setRoute(nextRoute)
  }

  const lockboxTagSummaries = useMemo(
    () => buildTagSummaries(lockboxFragments, []),
    [lockboxFragments]
  )

  // 密匣空间里笔记住在笔记树、碎片住在碎片流，两边互斥
  const lockboxNotes = useMemo(
    () =>
      lockboxFragments.filter(
        (fragment) => deriveKind(fragment.tags) === "note"
      ),
    [lockboxFragments]
  )

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

  const lockboxTimelineFragments = useMemo(() => {
    if (!lockbox?.unlocked) return []
    const lockboxStream = lockboxFragments.filter(
      (fragment) => deriveKind(fragment.tags) !== "note"
    )
    return selectedLockboxTag
      ? lockboxStream.filter((fragment) =>
          fragment.tags.includes(selectedLockboxTag)
        )
      : lockboxStream
  }, [lockbox?.unlocked, lockboxFragments, selectedLockboxTag])

  const visibleStreamFragments = useMemo(() => inboxFragments.filter(fragment => matchesFragmentFilters(fragment, fragmentFilters)), [inboxFragments, fragmentFilters])
  const searchScope = scopeForSpace(route.space)
  const publicSearchProvider = useMemo(
    () => createPublicSearchProvider(publicOnlyFragments),
    [publicOnlyFragments]
  )
  useEffect(
    () => () => {
      publicSearchProvider.dispose()
    },
    [publicSearchProvider]
  )
  const openCatalog = useMemo(
    () =>
      buildOpenCatalog({
        csvFiles,
        fragments,
        libraryTree,
        mindMaps,
        scope: searchScope,
        vaultPath,
      }),
    [csvFiles, fragments, libraryTree, mindMaps, searchScope, vaultPath]
  )
  const openRecent = useMemo(
    () =>
      searchScope === "public" && vaultPath
        ? readPublicOpenRecent(vaultPath)
        : new Map<string, number>(),
    [searchScope, vaultPath]
  )
  const getSearchSession = useCallback(() => searchSessionRef.current, [])
  const searchController = useSearchController({
    getSession: getSearchSession,
    isLockboxAvailable: Boolean(lockbox?.unlocked),
    lockboxProvider: LOCKBOX_SEARCH_PROVIDER,
    openCatalog,
    publicProvider: publicSearchProvider,
    recent: openRecent,
    replaceSession: (next) => replaceSearchSession(next),
    session: searchSession,
  })

  useEffect(() => {
    const session = searchSession
    const pending = session?.pendingNavigation
    if (!session || !pending || searchNavigationStartedRef.current === pending.requestId) {
      return
    }
    const hit = session.hits.find((candidate) => candidate.target.key === pending.targetKey)
    if (!hit) return

    searchNavigationStartedRef.current = pending.requestId
    searchNavigationAbortRef.current?.abort()
    const controller = new AbortController()
    searchNavigationAbortRef.current = controller
    const identity = captureSearchSessionIdentity(session)
    const isCurrent = () => {
      const current = searchSessionRef.current
      return Boolean(
        acceptsSearchSessionIdentity(current, identity) &&
        current?.pendingNavigation?.requestId === pending.requestId &&
        current.pendingNavigation.targetKey === pending.targetKey
      )
    }

    const router = createSearchTargetRouter({
      // The temporary public Worker has no native epoch authority. Let the
      // single-target Rust read bind the current public context itself.
      context: session.snapshotId === "legacy-public-worker" ? null : session.context,
      hit,
      adapters: {
        flushBeforeLeave: saveLibraryDraftBeforeNavigation,
        openMarkdown: (response, requestId, signal) =>
          openMarkdownSearchTarget(response, requestId, signal),
        openMindMap: async (_target, result, requestId, signal) => {
          setActiveOutlineEditor(null)
          setActiveFlowchartEditor(null)
          setPendingLibrarySearchTarget(null)
          setSearchEditorNavigation(null)
          setSearchMindMapNavigation({ requestId, result })
          setActiveMindMapId(result.file.id)
          await waitForSearchHost(requestId, signal)
          return { reveal: null }
        },
        openCanvas: async (target, result, requestId, signal) => {
          setActiveOutlineEditor(null)
          setActiveFlowchartEditor(null)
          setActiveMindMapId(null)
          setSearchEditorNavigation(null)
          setPendingLibrarySearchTarget({
            kind: target.kind === "flowchart" ? "flowchart" : "canvas",
            requestId,
            result,
            target,
          })
          setRoute({ space: "library", params: {} })
          await waitForSearchHost(requestId, signal)
          return { reveal: null }
        },
        openGraphFragment: async (_target, result, requestId, signal) => {
          setPendingLibrarySearchTarget(null)
          setSearchEditorNavigation(null)
          setFragments((current) => sortFragmentsForDisplay([
            result.fragment,
            ...current.filter((candidate) => candidate.id !== result.fragment.id),
          ]))
          openFlowchartEditor(result.fragment, requestId)
          await waitForSearchHost(requestId, signal)
          return { reveal: null }
        },
        openTable: async (target, result, requestId, signal) => {
          setActiveOutlineEditor(null)
          setActiveFlowchartEditor(null)
          setActiveMindMapId(null)
          setSearchEditorNavigation(null)
          setPendingLibrarySearchTarget({
            kind: "table",
            requestId,
            result,
            target,
          })
          setRoute({ space: "library", params: {} })
          await waitForSearchHost(requestId, signal)
          return { reveal: null }
        },
      },
    })

    void runSearchNavigation(
      {
        hit,
        query: session.drafts[session.mode],
        requestId: pending.requestId,
        sessionId: session.id,
        uiEpoch: session.uiEpoch,
      },
      router,
      isCurrent,
      controller.signal
    ).then((result) => {
      if (!isCurrent()) return
      const current = searchSessionRef.current
      if (!current) return

      if (result.status === "ready") {
        if (
          activeSearchRevealRef.current?.handle !== result.revealHandle
        ) {
          activeSearchRevealRef.current?.handle.clearHits("revoke")
        }
        activeSearchRevealRef.current = result.revealHandle
          ? {
              handle: result.revealHandle,
              requestId: pending.requestId,
              targetKey: hit.target.key,
            }
          : null
        replaceSearchSession({
          ...current,
          error: null,
          lastReveal: result.reveal,
          openedKey: hit.target.key,
          pendingNavigation: null,
        })
        recordPublicOpen(hit.target, Date.now())
        setIsSearchModeActive(false)
        setFragmentEditorBlurCommitPaused(false)
        searchReturnFocusRef.current = null
        return
      }

      if (result.status === "saveFailed") {
        replaceSearchSession({ ...current, pendingNavigation: null })
      } else if (result.status === "cancelled") {
        replaceSearchSession({ ...current, pendingNavigation: null })
      } else if (result.status === "failed") {
        replaceSearchSession({
          ...current,
          error: normalizeSearchError(result.error),
          pendingNavigation: null,
        })
      }
    })

    return () => {
      controller.abort()
      if (searchNavigationAbortRef.current === controller) {
        searchNavigationAbortRef.current = null
      }
    }
    // Navigation is keyed by the frozen request identity. Other state changes
    // are validated through searchSessionRef before they can acknowledge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchSession?.pendingNavigation?.requestId])

  async function openMarkdownSearchTarget(
    response: ReadSearchTargetResponse,
    requestId: string,
    signal: AbortSignal
  ): Promise<{ reveal: SearchRevealHandle | null }> {
    const { fragment, target } = response
    setActiveMindMapId(null)
    setSearchMindMapNavigation(null)

    if (
      target.scope === "public" &&
      !target.archived &&
      isJsonOutlineFragment(fragment)
    ) {
      setPendingLibrarySearchTarget(null)
      openOutlineEditor(fragment, requestId)
      return waitForSearchHost(requestId, signal)
    }
    setActiveOutlineEditor(null)
    setActiveFlowchartEditor(null)

    if (target.scope === "lockbox") {
      if (!lockbox?.unlocked) throw { code: "locked" }
      setRoute({ space: "lockbox", params: {} })
      if (target.kind === "note" || target.archived) {
        setZenDraft(null)
        setEditingVariant("zen")
        setEditingFragmentId(null)
        setSearchEditorNavigation({
          fragment,
          readOnly: response.readOnly || target.archived,
          requestId,
        })
      } else {
        setFragments((current) => sortFragmentsForDisplay([
          fragment,
          ...current.filter((candidate) => candidate.id !== fragment.id),
        ]))
        setPendingScrollNavigationId(requestId)
        setPendingScrollFragmentId(fragment.id)
      }
      return waitForSearchHost(requestId, signal)
    }

    if (target.kind === "note") {
      setSearchEditorNavigation(null)
      setPendingLibrarySearchTarget({
        fragment,
        kind: "note",
        readOnly: response.readOnly || target.archived,
        requestId,
        revision: response.revision,
        target,
      })
      setRoute({ space: "library", params: {} })
      return waitForSearchHost(requestId, signal)
    }

    if (target.archived) {
      setZenDraft(null)
      setRoute({ space: "fragments", params: { view: "trash" } })
      setEditingVariant("zen")
      setEditingFragmentId(null)
      setSearchEditorNavigation({
        fragment,
        readOnly: true,
        requestId,
      })
      return waitForSearchHost(requestId, signal)
    }

    setSearchEditorNavigation(null)
    setFragments((current) => sortFragmentsForDisplay([
      fragment,
      ...current.filter((candidate) => candidate.id !== fragment.id),
    ]))
    setFragmentFilters(EMPTY_FRAGMENT_FILTERS)
    setRoute({ space: "fragments", params: {} })
    setPendingScrollNavigationId(requestId)
    setPendingScrollFragmentId(fragment.id)
    return waitForSearchHost(requestId, signal)
  }

  function waitForSearchHost(requestId: string, signal: AbortSignal) {
    return new Promise<{ reveal: SearchRevealHandle | null }>((resolve, reject) => {
      const abort = () => {
        searchNavigationWaitersRef.current.delete(requestId)
        reject(new DOMException("Navigation aborted", "AbortError"))
      }
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener("abort", abort, { once: true })
      searchNavigationWaitersRef.current.set(requestId, {
        reject: (error) => {
          signal.removeEventListener("abort", abort)
          reject(error)
        },
        resolve: (result) => {
          signal.removeEventListener("abort", abort)
          resolve(result)
        },
      })
    })
  }

  function settleSearchHost(
    requestId: string,
    error?: unknown,
    reveal: SearchRevealHandle | null = null
  ) {
    const waiter = searchNavigationWaitersRef.current.get(requestId)
    if (!waiter) return
    searchNavigationWaitersRef.current.delete(requestId)
    if (error) waiter.reject(error)
    else waiter.resolve({ reveal })
  }

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
  const legacyOutlineFragments = useMemo(
    () => publicActiveFragments.filter((fragment) =>
      fragment.path.startsWith("fragments/") &&
      deriveKind(fragment.tags) === "outline" &&
      readOutlineContent(fragment.content)?.format === "legacy"
    ),
    [publicActiveFragments]
  )
  useEffect(() => {
    if (!vaultPath) {
      setDismissedOutlineUpgradeCount(0)
      return
    }
    try {
      const stored = Number(window.localStorage.getItem(
        `${OUTLINE_UPGRADE_DISMISSED_STORAGE_PREFIX}${vaultPath}`
      ))
      setDismissedOutlineUpgradeCount(Number.isFinite(stored) && stored > 0 ? stored : 0)
    } catch {
      setDismissedOutlineUpgradeCount(0)
    }
  }, [vaultPath])
  const showOutlineUpgradeContext =
    legacyOutlineFragments.length > dismissedOutlineUpgradeCount
  const isVaultDialogOpen = isVaultGuideOpen || needsVaultSetup
  const isExportSheetOpen = exportingFragment !== null
  const isLockboxArchiveConfirmOpen = pendingLockboxArchiveFragment !== null
  const isModalBusy =
    isVaultDialogOpen ||
    lockboxDialogMode !== null ||
    // 内联重置发起时没有弹窗 mode，恢复密钥步骤仍会独立弹出
    recoveryKey !== null ||
    isExportSheetOpen ||
    isLockboxArchiveConfirmOpen || convertingFragment !== null || isFragmentFilterOpen || outlineUpgradeRequest !== null
  const isBlockingDialogOpen = isModalBusy || isClosing

  const lockboxScrollTargetId =
    pendingScrollFragmentId &&
    (!isSearchModeActive || pendingScrollNavigationId !== null) &&
    lockboxTimelineFragments.some(
      (fragment) => fragment.id === pendingScrollFragmentId
    )
      ? pendingScrollFragmentId
      : null

  const handleTimelineScrollComplete = useCallback((
    fragmentId: string,
    navigationId?: string,
    reveal?: SearchRevealHandle | null
  ) => {
    if (navigationId) settleSearchHost(navigationId, undefined, reveal ?? null)
    setPendingScrollFragmentId((current) =>
      current === fragmentId ? null : current
    )
    setPendingScrollNavigationId((current) =>
      current === navigationId ? null : current
    )
  }, [])

  useEffect(() => {
    function handleGlobalSearchShortcut(event: KeyboardEvent) {
      const key = event.key.toLowerCase()
      const isSearchShortcut =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        (key === "k" || key === "o")

      if (!isSearchShortcut) return

      event.preventDefault()
      if (isModalBusy) return

      if (key === "k") openSearch()
      else openQuickOpen()
    }

    window.addEventListener("keydown", handleGlobalSearchShortcut)

    return () => {
      window.removeEventListener("keydown", handleGlobalSearchShortcut)
    }
  }, [
    isModalBusy,
    isSearchModeActive,
    libraryTree,
    route,
    searchController,
    vaultPath,
  ])

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
    function handleDocumentHitShortcut(event: KeyboardEvent) {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "g" ||
        !activeSearchRevealRef.current
      ) {
        return
      }
      event.preventDefault()
      stepCurrentDocumentHit(event.shiftKey ? -1 : 1)
    }
    window.addEventListener("keydown", handleDocumentHitShortcut)
    return () => window.removeEventListener("keydown", handleDocumentHitShortcut)
  })

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

      setActiveOutlineEditor(null)
      setActiveFlowchartEditor(null)
      revokeSearchSession("spaceChanged")
      setIsMindMapViewActive(false)
      setRoute({ space: "fragments", params: {} })
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
      activeOutlineEditor !== null ||
      activeFlowchartEditor !== null ||
      editingFragmentId !== null ||
      (librarySaveHandlerRef.current?.isDirty() ?? false)
    ) {
      return
    }

    setIsSyncing(true)
    void syncVault()
      .then((synced) => {
        setGit(synced)
        markSynced()
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

  // 备忘提醒 → Dock 角标：碎片加载完成后推送一次（已过期的立即计入），之后随内容变化去抖推送
  useReminderBadge(fragments, !isLoading)

  // 自动检查点（合并保存）：内容保存只落盘，git 提交由 idle/失焦触发的检查点聚合
  const { recordContentActivity } = useAutoCheckpoint({
    enabled: Boolean(git && git.status !== "no_git"),
    isStable: () =>
      !isSyncing &&
      !isCreating &&
      !isBlockingDialogOpen &&
      editingFragmentId === null &&
      activeMindMapId === null &&
      activeOutlineEditor === null &&
      activeFlowchartEditor === null &&
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
  recordContentActivityRef.current = recordContentActivity

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
          event.preventDefault()
          if (closing) return
          closing = true
          setIsClosing(true)
          const drafts = librarySaveHandlerRef.current
          drafts?.setInteractionBlocked(true)
          toast.loading("正在保存并退出…", { id: "window-close" })
          try {
            const datasetFlushed = (await datasetZenRef.current?.flush()) ?? true
            const flushed =
              (await drafts?.flush()) ?? true
            if (!datasetFlushed || !flushed) {
              const leaveAnyway = window.confirm(
                "还有草稿没能保存成功。仍要退出吗？（退出将丢失未保存的修改）"
              )
              if (!leaveAnyway) {
                return
              }
            }
            // 数据已落盘，提交只是历史整理：限时尽力而为，失败不阻塞退出
            await Promise.race([
              checkpointVault("退出前").catch(() => null),
              new Promise((resolve) => window.setTimeout(resolve, 5_000)),
            ])
            await currentWindow.destroy()
          } catch (error) {
            toast.error(`退出未完成，当前窗口已保留：${getApiErrorMessage(error)}`)
          } finally {
            closing = false
            drafts?.setInteractionBlocked(false)
            setIsClosing(false)
            toast.dismiss("window-close")
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

  // 上锁态的主体区是内联解锁面板，时间线只在解锁后渲染
  const lockboxEmptyMessage =
    "密匣里还没有碎片。到 Inbox 输入 #密匣 即可保存到这里。"

  const timelineHandlers = {
    csvFiles,
    editingFragmentId: editingVariant === "inline" ? editingFragmentId : null,
    isLoading,
    knownTags,
    onArchive: handleArchiveFragment,
    onCancelEdit: closeEditor,
    onRegisterEditorFlush: registerFragmentFlush,
    onBeforeSelection: saveLibraryDraftBeforeNavigation,
    onEdit: openInlineEditor,
    onExportImage: setExportingFragment,
    onLinkFragment: handleLinkFragment,
    onMoveToLockbox: handleMoveFragmentToLockbox,
    onOpenZen: openZenEditor,
    onPin: handlePinFragment,
    onRefreshFragments: refreshFragments,
    onRequestOutlineUpgrade: openOutlineUpgrade,
    onNavigateToFragment: (fragmentId: string) => {
      void handleNavigateToFragment(fragmentId)
    },
    onScrollToFragmentComplete: handleTimelineScrollComplete,
    scrollNavigationId: pendingScrollNavigationId,
    onSave: handleUpdateFragment,
    onToggleKind: handleToggleFragmentKind,
    onToggleTask: (fragment: Fragment, lineIndex: number) => {
      void handleToggleFragmentTask(fragment, lineIndex)
    },
    onUnlinkFragment: handleUnlinkFragment,
    // 展示范围只含当前碎片；关联候选与反链索引覆盖全部公开内容。
    relationFragments: publicOnlyFragments,
    vaultPath,
  }

  const openedSearchIndex = searchSession?.openedKey
    ? searchSession.hits.findIndex((hit) => hit.target.key === searchSession.openedKey)
    : -1
  const searchContextBarProps = searchSession && openedSearchIndex >= 0
    ? {
        documentHit:
          searchSession.lastReveal?.status === "revealed" &&
          activeSearchRevealRef.current?.targetKey === searchSession.openedKey
            ? {
                activeIndex: searchSession.lastReveal.activeIndex,
                matchCount: searchSession.lastReveal.matchCount,
                onNavigate: stepCurrentDocumentHit,
              }
            : null,
        onBack: () => openSearchMode(searchSession.mode),
        onClose: endSearchSession,
        onNavigate: navigateCurrentSearchResult,
        session: {
          activeIndex: openedSearchIndex,
          query: searchSession.drafts[searchSession.mode],
          resultIds: searchSession.hits.map((hit) => hit.target.key),
          total: searchSession.total ?? searchSession.hits.length,
        },
      }
    : legacySearchSession
      ? {
          onBack: () => openSearchMode("fullText"),
          onClose: endSearchSession,
          onNavigate: navigateSearchResult,
          session: legacySearchSession,
        }
      : null

  const searchPalette =
    isSearchModeActive && searchSession ? (
      <SearchPalette
        onClose={exitSearchMode}
        onFilterFragments={openFragmentFiltersFromSearch}
        onIncludeTrashChange={searchController.onIncludeTrashChange}
        onModeChange={searchController.onModeChange}
        onQueryChange={searchController.onQueryChange}
        onSelect={searchController.onSelect}
        onSelectedKeyChange={searchController.onSelectedKeyChange}
        session={searchSession}
      />
    ) : null

  const fragmentFilterDialog = (
    <FragmentFilterDialog
      filters={fragmentFilters}
      fragments={inboxFragments}
      onApply={filters => void applyFragmentFilters(filters)}
      onClose={closeFragmentFilters}
      open={isFragmentFilterOpen}
    />
  )

  const activeFlowchartFragment = activeFlowchartEditor
    ? fragments.find((fragment) => fragment.id === activeFlowchartEditor.fragmentId) ?? null
    : null

  if (activeFlowchartEditor && activeFlowchartFragment && flowchartFragmentStorage) {
    return (
      <>
        <ZenSurface
          ariaLabel="流程图工作区"
          onRequestClose={() => void closeFlowchartEditor()}
        >
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            {searchContextBarProps ? <SearchContextBar {...searchContextBarProps} /> : null}
            <div className="min-h-0 flex-1">
              <CanvasWorkspace
                fragmentMode
                fragments={publicOnlyFragments}
                key={`flowchart:${activeFlowchartEditor.fragmentId}:${activeFlowchartEditor.searchRequestId ?? "browse"}`}
                onLoadError={(error) => {
                  if (activeFlowchartEditor.searchRequestId) {
                    settleSearchHost(activeFlowchartEditor.searchRequestId, error)
                  }
                }}
                onOpenLink={openFlowchartLink}
                onReady={() => {
                  if (activeFlowchartEditor.searchRequestId) {
                    settleSearchHost(activeFlowchartEditor.searchRequestId)
                  }
                }}
                onRequestClose={closeFlowchartEditor}
                path={activeFlowchartFragment.path}
                readFromStorage={flowchartFragmentStorage.readFromStorage}
                ref={flowchartWorkspaceRef}
                saveTransport={flowchartFragmentStorage.saveTransport}
                toolbarLeading={(
                  <Button
                    aria-label="退出流程图"
                    onClick={() => void closeFlowchartEditor()}
                    size="icon-sm"
                    title="退出流程图（Esc）"
                    variant="ghost"
                  >
                    <XIcon />
                  </Button>
                )}
              />
            </div>
          </div>
        </ZenSurface>
        {searchPalette}
        {fragmentFilterDialog}
      </>
    )
  }

  if (activeOutlineEditor) {
    return (
      <>
        <MindMapWorkspace
          contextBar={searchContextBarProps ? <SearchContextBar {...searchContextBarProps} /> : null}
          fragments={publicOnlyFragments}
          initialView="outline"
          key={`outline:${activeOutlineEditor.fragmentId}:${activeOutlineEditor.searchRequestId ?? "browse"}`}
          mapId={activeOutlineEditor.fragmentId}
          onClose={() => setActiveOutlineEditor(null)}
          onLoadError={(error) => {
            if (activeOutlineEditor.searchRequestId) {
              settleSearchHost(activeOutlineEditor.searchRequestId, error)
            }
          }}
          onOpenLink={openFlowchartLink}
          onReady={() => {
            if (activeOutlineEditor.searchRequestId) {
              settleSearchHost(activeOutlineEditor.searchRequestId)
            }
          }}
          ref={mindMapWorkspaceRef}
          storage={outlineFragmentStorage}
        />
        {searchPalette}
        {fragmentFilterDialog}
      </>
    )
  }

  if (activeMindMapId) {
    return (
      <>
        <MindMapWorkspace
          contextBar={searchContextBarProps ? <SearchContextBar {...searchContextBarProps} /> : null}
          initialRead={searchMindMapNavigation?.result ?? null}
          key={`${activeMindMapId}:${searchMindMapNavigation?.requestId ?? "browse"}`}
          mapId={activeMindMapId}
          onClose={() => {
            setActiveMindMapId(null)
            setSearchMindMapNavigation(null)
          }}
          onLoadError={(error) => {
            if (searchMindMapNavigation) {
              settleSearchHost(searchMindMapNavigation.requestId, error)
            }
          }}
          onMapsChange={setMindMaps}
          onReady={() => {
            if (searchMindMapNavigation) {
              settleSearchHost(searchMindMapNavigation.requestId)
            }
          }}
          ref={mindMapWorkspaceRef}
        />
        {searchPalette}
        {fragmentFilterDialog}
      </>
    )
  }

  return (
    <>
      <main
        aria-hidden={isBlockingDialogOpen ? true : undefined}
        aria-busy={isClosing || undefined}
        inert={isClosing || undefined}
        className={styles.appShell}
        data-sidebar-collapsed={isSidebarCollapsed}
      >
        <div className={styles.sidebarSlot}>
          {isSidebarCollapsed ? null : (
            <SidebarNav
              fragments={publicOnlyFragments}
              isCollapsed={false}
              mindMapViewActive={isMindMapViewActive}
              onOpenSearch={openSearch}
              onRouteChange={handleRouteChange}
              onToggleCollapsed={() => {
                setIsSidebarCollapsed(true)
              }}
              route={route}
            />
          )}
        </div>
        <div className={styles.workspaceSlot} data-workspace-slot>
          {isSidebarCollapsed && route.space !== "calendar" ? (
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
            <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            {navigationOrigin && !isSearchModeActive && !searchSession ? (
              <div className="shard-content-inset shrink-0 py-1">
                <Button size="sm" variant="ghost" onClick={() => void returnToOrigin()}>
                  {navigationOrigin.route.space === "library" ? "返回资料库" : "返回碎片"}
                </Button>
              </div>
            ) : null}
            {route.space === "fragments" && fragmentsView !== "trash" ? (
              <FragmentsWorkspace
            capture={{
              initialContent: composerDraftRef.current,
              secondarySubmit: fragmentSelectionActive,
              csvFiles,
              fragments: publicOnlyFragments,
              isCreating,
              knownTags,
              mindMaps,
              onCreate: handleCreate,
              onCreateFlowchart: handleCreateFlowchart,
              onDraftChange: (content) => {
                composerDraftRef.current = content
              },
              onCreateOutline: handleCreateOutline,
              onNavigateToFragment: (fragmentId) => {
                void handleNavigateToFragment(fragmentId)
              },
              onOpenMindMap: (map) => void openMindMap(map),
              onOpenFragmentZen: openZenEditor,
              onOpenZen: openZenDraft,
            }}
            isMindMapViewActive={isMindMapViewActive}
            mindMapPanel={{
              onMapsChange: setMindMaps,
              onOpenMap: setActiveMindMapId,
            }}
            searchContextBar={searchContextBarProps}
            filterContext={<>
              {showOutlineUpgradeContext ? <OutlineUpgradeContext
                count={legacyOutlineFragments.length}
                onDismiss={() => {
                  const count = legacyOutlineFragments.length
                  setDismissedOutlineUpgradeCount(count)
                  try {
                    window.localStorage.setItem(
                      `${OUTLINE_UPGRADE_DISMISSED_STORAGE_PREFIX}${vaultPath}`,
                      String(count)
                    )
                  } catch {
                    // 受限 WebView 中 localStorage 可能不可用；本会话仍保持隐藏。
                  }
                }}
                onOpen={() => void openOutlineUpgrade()}
              /> : null}
              <FragmentFilterContext filters={fragmentFilters} onClear={() => void applyFragmentFilters(EMPTY_FRAGMENT_FILTERS)} />
            </>}
            timeline={{
              ...timelineHandlers,
              fragments: visibleStreamFragments,
              scopeKey: `${vaultPath}:${JSON.stringify(fragmentFilters)}`,
              scrollToFragmentId: pendingScrollFragmentId,
              onOrganize: handleOrganizeFragments,
              onSelectionModeChange: setFragmentSelectionActive,
              emptyMessage: fragmentFilters.tag || fragmentFilters.month || fragmentFilters.pinned ? "没有符合条件的碎片，可清除筛选后查看。" : "还没有碎片，记下一点什么吧。",
            }}
              />
            ) : route.space === "fragments" && fragmentsView === "trash" ? (
              <FragmentTrashWorkspace
                entries={libraryTree?.fragmentTrashEntries ?? []}
                fragments={publicOnlyFragments}
                loading={isLoading || !libraryTree}
                targetId={pendingScrollFragmentId}
                onMutation={handleLibraryMutation}
                onRestored={id => {
                  setFragmentFilters(EMPTY_FRAGMENT_FILTERS)
                  setRoute({ space: "fragments", params: {} })
                  setPendingScrollFragmentId(id ?? null)
                }}
              />
            ) : route.space === "calendar" ? (
              <CalendarWorkspace
                fragments={publicActiveFragments}
                onOpenFragment={(id) => void handleNavigateToFragment(id)}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={() => setIsSidebarCollapsed(false)}
              />
            ) : route.space === "lockbox" ? (
              <LockboxShell
            lockbox={lockbox}
            notes={lockboxNotes}
            onBack={() => void handleRouteChange({ space: "library", params: {} })}
            onChangePassword={() => setLockboxDialogMode("change")}
            onLock={() => void handleLockLockbox()}
            onOpenNote={openZenEditor}
            onResetPassword={handleResetLockboxPassword}
            onSelectTag={setSelectedLockboxTag}
            onUnlock={handleUnlockLockbox}
            selectedTag={selectedLockboxTag}
            summaries={lockboxTagSummaries}
            timeline={{
              ...timelineHandlers,
              emptyIcon: LockKeyholeIcon,
              emptyMessage: lockboxEmptyMessage,
              fragments: lockboxTimelineFragments,
              // 密匣内的关联候选保持密匣隔离，不混入公开内容
              relationFragments: lockboxTimelineFragments,
              scrollToFragmentId: lockboxScrollTargetId,
            }}
            totalCount={lockboxFragments.length}
              />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {searchContextBarProps ? <SearchContextBar {...searchContextBarProps} /> : null}
                <LibraryShell
                key={vaultPath}
                vaultPath={vaultPath}
            csvFiles={csvFiles}
            fragments={publicActiveFragments}
            isLoading={isLoading}
            libraryTree={libraryTree}
            knownTags={knownTags}
            navigateTo={pendingLibraryTarget}
            searchNavigateTo={pendingLibrarySearchTarget}
            onSearchNavigationSettled={(requestId, result) => {
              if (result.status === "error") settleSearchHost(requestId, result.error)
              else settleSearchHost(requestId)
            }}
            onNavigateToFragment={(fragmentId) => {
              void handleNavigateToFragment(fragmentId)
            }}
            onLibraryMutation={handleLibraryMutation}
            onConvertedToFragment={fragment => {
              setFragments(current => sortFragmentsForDisplay([fragment, ...current.filter(item => item.id !== fragment.id)]))
              showFragmentTarget(fragment)
            }}
            onRefreshLibrary={refreshLibraryTree}
            onTableSaved={recordContentActivity}
            onMoveToLockbox={handleMoveFragmentToLockbox}
            onFragmentUpdated={handleFragmentPropertyUpdated}
            onOpenGraphFragment={(fragment) => {
              setFragments(current => sortFragmentsForDisplay([fragment, ...current.filter(item => item.id !== fragment.id)]))
              if (isJsonOutlineFragment(fragment)) openOutlineEditor(fragment)
              else if (isJsonFlowchartFragment(fragment)) openFlowchartEditor(fragment)
            }}
            onOpenLockbox={enterLockboxSpace}
            onRefreshFragments={refreshFragments}
            onRegisterSaveHandler={registerLibrarySaveHandler}
            onSaveStateChange={setLibrarySaveState}
            onSave={handleUpdateFragment}
            relationFragments={publicOnlyFragments}
              />
              </div>
            )}
            </div>
          </div>
        </div>
        <div className={styles.bottomTabsSlot}>
          <BottomTabs
            fragments={publicOnlyFragments}
            onHelp={showHelp}
            onOpenMindMaps={() => openMindMap()}
            onOpenSearch={openSearch}
            onOpenSettings={() => openSettings("vault")}
            onRouteChange={handleRouteChange}
            onShortcuts={showShortcuts}
            route={route}
            vaultPath={vaultPath}
          />
        </div>

        <div className={styles.statusBarSlot}>
          <StatusBar
            git={git}
            isCreating={isCreating}
            isSyncing={isSyncing}
            lastSyncAt={lastSyncAt}
            onCheckpoint={() => void handleCheckpoint()}
            onHelp={showHelp}
            onOpenGitSettings={() => openSettings("git")}
            onOpenMindMaps={() => openMindMap()}
            onOpenSettings={() => openSettings("vault")}
            onShortcuts={showShortcuts}
            onSync={() => void handleSync()}
            saveState={librarySaveState}
          />
        </div>
      </main>
      <FragmentEditor
        csvFiles={csvFiles}
        draft={editingVariant === "zen" ? zenDraft : null}
        fragment={searchEditorNavigation?.fragment ??
          (editingVariant === "zen" ? editingFragment : null)}
        fragments={publicOnlyFragments}
        knownTags={knownTags}
        onClose={closeEditor}
        onRegisterFlush={registerFragmentFlush}
        onCreate={handleCreate}
        onNavigateToFragment={(fragmentId) => {
          void handleNavigateToFragment(fragmentId)
        }}
        onFragmentUpdated={handleFragmentPropertyUpdated}
        onReady={() => {
          if (searchEditorNavigation) {
            settleSearchHost(searchEditorNavigation.requestId)
          }
        }}
        onRefreshFragments={refreshFragments}
        onRequestOutlineUpgrade={openOutlineUpgrade}
        onSave={handleUpdateFragment}
        readOnly={searchEditorNavigation?.readOnly ?? false}
        vaultPath={vaultPath}
      />
      {openDatasetPath && <DatasetZen key={openDatasetPath} ref={datasetZenRef} path={openDatasetPath} onClose={() => { openDatasetPathRef.current = null; setOpenDatasetPath(null) }} />}
      {fragmentFilterDialog}
      <ConvertFragmentDialog open={convertingFragment !== null} title={conversionDraft.title} directory={conversionDraft.directory}
        entries={libraryTree?.entries ?? []} busy={conversionBusy} needsVerification={conversionNeedsVerification} error={conversionError}
        onTitleChange={title => setConversionDraft(current => ({ ...current, title }))}
        onDirectoryChange={directory => setConversionDraft(current => ({ ...current, directory }))}
        onClose={() => setConvertingFragment(null)} onSubmit={() => void submitFragmentConversion()} />
      <OutlineUpgradeDialog
        open={outlineUpgradeRequest !== null}
        preselectedIds={outlineUpgradeRequest?.preselectedIds ?? null}
        onClose={() => setOutlineUpgradeRequest(null)}
        onComplete={handleOutlineUpgradeComplete}
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
      {searchPalette}
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
          <DialogTitle>确认删除密匣笔记</DialogTitle>
          <DialogDescription>
            这条笔记属于密匣。删除后会保留在密匣内部，不会写入明文回收站。
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
            {isArchiving ? "删除中" : "仍然删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function isVaultNotConfigured(error: unknown) {
  return String(error).includes("vault_not_configured")
}

function isGitSetupError(error: unknown) {
  const message = String(error)
  return message.includes("Git 未初始化") || message.includes("Git remote 未配置")
}

function sortFragmentsForDisplay(fragments: Fragment[]) {
  return [...fragments].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.createdAt.localeCompare(a.createdAt)
  })
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
