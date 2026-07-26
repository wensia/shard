import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { LockKeyholeIcon, TagIcon } from "lucide-react"
import { HStack } from "@astryxdesign/core/HStack"
import { Stack } from "@astryxdesign/core/Stack"
import { useToast } from "@astryxdesign/core/Toast"

import styles from "./App.module.css"
import { BottomTabs } from "@/components/shard/bottom-tabs"
import { CaptureBox } from "@/components/shard/capture-box"
import { DebtWorkspace } from "@/components/shard/debt-workspace"
import { FragmentEditor } from "@/components/shard/fragment-editor"
import { FragmentImageExporter } from "@/components/shard/fragment-image-exporter"
import { FragmentSearchDialog } from "@/components/shard/fragment-search-dialog"
import { FragmentTimeline } from "@/components/shard/fragment-timeline"
import { InboxTagBar } from "@/components/shard/inbox-tag-bar"
import {
  LockboxDialog,
  type LockboxDialogMode,
} from "@/components/shard/lockbox-dialog"
import { MindMapPanel } from "@/components/shard/mind-map-panel"
import { MindMapWorkspace } from "@/components/shard/mind-map-workspace"
import { ReviewWorkspace } from "@/components/shard/review-workspace"
import { SidebarNav } from "@/components/shard/sidebar-nav"
import { TaggedPanel, type TaggedSummary } from "@/components/shard/tagged-panel"
import {
  VaultGuide,
  type SettingsSection,
} from "@/components/shard/vault-guide"
import {
  loadAppSettings,
  saveAppSettings,
  type AppSettings,
} from "@/lib/app-settings"
import { Button } from "@astryxdesign/core/Button"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { Layout, LayoutFooter } from "@astryxdesign/core/Layout"
import { ToastViewport } from "@astryxdesign/core/Toast"
import {
  setFragmentArchived,
  changeLockboxPassword,
  createFragment,
  DESKTOP_RUNTIME_MESSAGE,
  getApiErrorMessage,
  listDebts,
  listFragments,
  listMindMaps,
  lockLockbox,
  moveFragmentToLockbox,
  pinFragment,
  restoreWindowFrame,
  resetLockboxPassword,
  setupLockbox,
  unlockLockbox,
  updateFragment,
} from "@/lib/api"
import { toggleTaskLine } from "@/lib/editor-format"
import {
  hasMarkdownImage,
  isLockboxReady,
  LOCKBOX_TAG,
  publicFragments,
  wantsLockbox,
} from "@/lib/lockbox"
import type {
  Debt,
  Fragment,
  FragmentFilter,
  LockboxState,
  MindMapSummary,
  VaultState,
} from "@/types"

const DEFAULT_PROJECT_TAGS: readonly string[] = ["日程"]
const LOCKBOX_IDLE_TIMEOUT_MS = 3 * 60 * 1000
type EditingVariant = "inline" | "zen"
interface ZenDraft {
  content: string
  id: number
}

function App() {
  const toast = useToast()
  const [fragments, setFragments] = useState<Fragment[]>([])
  const [vaultPath, setVaultPath] = useState("")
  const [filter, setFilter] = useState<FragmentFilter>("inbox")
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [lockbox, setLockbox] = useState<LockboxState | null>(null)
  const [lockboxDialogMode, setLockboxDialogMode] =
    useState<LockboxDialogMode | null>(null)
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)
  const [composerCollapseSignal, setComposerCollapseSignal] = useState(0)
  const [editingFragmentId, setEditingFragmentId] = useState<string | null>(null)
  const [editingVariant, setEditingVariant] =
    useState<EditingVariant>("inline")
  const [zenDraft, setZenDraft] = useState<ZenDraft | null>(null)
  const [exportingFragment, setExportingFragment] = useState<Fragment | null>(null)
  const [isArchivingLockboxFragment, setIsArchivingLockboxFragment] =
    useState(false)
  const [isVaultGuideOpen, setIsVaultGuideOpen] = useState(false)
  const [appSettings, setAppSettings] = useState<AppSettings>(loadAppSettings)
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("vault")
  const [needsVaultSetup, setNeedsVaultSetup] = useState(false)
  const [pendingLockboxArchiveFragment, setPendingLockboxArchiveFragment] =
    useState<Fragment | null>(null)
  const [pendingLockboxMoveId, setPendingLockboxMoveId] = useState<string | null>(null)
  const [pendingScrollFragmentId, setPendingScrollFragmentId] = useState<
    string | null
  >(null)
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false)
  const [isMindMapViewActive, setIsMindMapViewActive] = useState(false)
  const [activeMindMapId, setActiveMindMapId] = useState<string | null>(null)
  const [mindMaps, setMindMaps] = useState<MindMapSummary[]>([])
  const [isDebtViewActive, setIsDebtViewActive] = useState(false)
  const [debts, setDebts] = useState<Debt[]>([])
  const [selectedLockboxTag, setSelectedLockboxTag] = useState<string | null>(null)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [selectedInboxTag, setSelectedInboxTag] = useState<string | null>(null)
  const filterRef = useRef(filter)

  useEffect(() => {
    void refreshFragments()
    void refreshMindMaps()
    void refreshDebts()
  }, [])

  useEffect(() => {
    filterRef.current = filter
  }, [filter])

  // 离开「标签」区域（标签面板 / 密匣视图）即重新上锁，再次进入需要密码
  useEffect(() => {
    if (filter === "tagged" || filter === "lockbox") return
    if (!lockbox?.unlocked) return
    void autoLockLockbox()
  }, [filter, lockbox?.unlocked])

  // 密匣页 3 分钟无操作后自动上锁，并回到标签页。
  useEffect(() => {
    if (filter !== "lockbox" || !lockbox?.unlocked) return

    let timeoutId = window.setTimeout(() => {
      void autoLockLockbox({ returnToTagged: true })
    }, LOCKBOX_IDLE_TIMEOUT_MS)

    const resetTimer = () => {
      window.clearTimeout(timeoutId)
      timeoutId = window.setTimeout(() => {
        void autoLockLockbox({ returnToTagged: true })
      }, LOCKBOX_IDLE_TIMEOUT_MS)
    }

    const activityEvents = [
      "focusin",
      "input",
      "keydown",
      "pointerdown",
      "touchstart",
      "wheel",
    ] as const

    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, resetTimer, { capture: true })
    })

    return () => {
      window.clearTimeout(timeoutId)
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, resetTimer, { capture: true })
      })
    }
  }, [filter, lockbox?.unlocked])

  async function refreshFragments() {
    setIsLoading(true)
    try {
      const state = await listFragments()
      applyVaultState(state)
    } catch (error) {
      const message = getApiErrorMessage(error)

      if (message === DESKTOP_RUNTIME_MESSAGE) {
        setFragments([])
        setLockbox(null)
        setVaultPath("")
        setNeedsVaultSetup(false)
        return
      }

      if (isVaultNotConfigured(error)) {
        setFragments([])
        setLockbox(null)
        setVaultPath("")
        setNeedsVaultSetup(true)
        setIsVaultGuideOpen(true)
        return
      }

      toast({ body: `${"读取 Shard vault 失败"}：${message}`, type: "error" })
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
      toast({ body: `${"读取思维导图失败"}：${message}`, type: "error" })
    }
  }

  async function refreshDebts() {
    try {
      setDebts(await listDebts())
    } catch (error) {
      const message = getApiErrorMessage(error)
      if (message === DESKTOP_RUNTIME_MESSAGE || isVaultNotConfigured(error)) {
        setDebts([])
        return
      }
      toast({ body: `${"读取债务记录失败"}：${message}`, type: "error" })
    }
  }

  function applyVaultState(state: VaultState) {
    const visibleFragments = state.lockbox.unlocked
      ? state.fragments
      : publicFragments(state.fragments)

    setFragments(sortFragmentsForDisplay(visibleFragments))
    setLockbox(state.lockbox)
    setVaultPath(state.vaultPath)
    setNeedsVaultSetup(false)
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
      setIsDebtViewActive(false)
      setFilter("inbox")
    }
    setIsVaultGuideOpen(true)
  }

  async function handleCreate(content: string, tags: string[]) {
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
        toast({ body: "已保存到密匣" })
        void refreshFragments()
      } catch (error) {
        const message = getApiErrorMessage(error)
        toast({ body: `${"创建密匣片段失败"}：${message}`, type: "error" })
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags,
      category: null,
      path: "",
      archived: false,
      lockbox: false,
      pinned: false,
    }

    setFragments((current) => sortFragmentsForDisplay([pendingFragment, ...current]))

    try {
      const created = await createFragment(content, tags)
      setFragments((current) =>
        sortFragmentsForDisplay(
          current.map((fragment) =>
            fragment.id === optimisticId ? created : fragment
          )
        )
      )
      toast({ body: "片段已保存" })
      void refreshFragments()
    } catch (error) {
      const message = getApiErrorMessage(error)
      setFragments((current) =>
        current.filter((fragment) => fragment.id !== optimisticId)
      )
      toast({ body: `${"创建片段失败"}：${message}`, type: "error" })
      throw new Error(message)
    } finally {
      setIsCreating(false)
    }
  }

  async function handleUpdateFragment(id: string, content: string, tags: string[]) {
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

    const updated = await updateFragment(id, content, tags)
    setFragments((current) =>
      current.map((fragment) => (fragment.id === id ? updated : fragment))
    )
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
      toast({ body: `${"更新复选框失败"}：${getApiErrorMessage(error)}`, type: "error" })
    }
  }

  async function handleArchiveFragment(fragment: Fragment) {
    if (fragment.archived) return

    if (fragment.lockbox) {
      setPendingLockboxArchiveFragment(fragment)
      return
    }

    // 取消归档不需要确认：它是个可撤销的、低风险的还原动作。
    if (fragment.archived) {
      await archiveFragmentWithFeedback(fragment, false)
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
      toast({ body: archived ? "已归档" : "已移回收件箱" })
      return true
    } catch (error) {
      toast({ body: `${"归档失败"}：${getApiErrorMessage(error)}`, type: "error" })
      return false
    }
  }

  async function handlePinFragment(fragment: Fragment) {
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
      toast({ body: nextPinned ? "已置顶" : "已取消置顶" })
    } catch (error) {
      setFragments((current) =>
        sortFragmentsForDisplay(
          current.map((currentFragment) =>
            currentFragment.id === fragment.id ? fragment : currentFragment
          )
        )
      )
      toast({ body: `${nextPinned ? "置顶失败" : "取消置顶失败"}：${getApiErrorMessage(error)}`, type: "error" })
    }
  }

  async function handleMoveFragmentToLockbox(fragment: Fragment) {
    if (fragment.lockbox || fragment.archived) return
    if (hasMarkdownImage(fragment.content)) {
      toast({ body: `${"密匣暂不支持图片附件"}：${"请先移除图片，再移入密匣，避免附件留在公开 assets 目录。"}`, type: "error" })
      return
    }

    const confirmed = window.confirm(
      "移入密匣会把当前文件改为加密文件，但不会清理已经存在的 Git 历史提交。确认继续？"
    )
    if (!confirmed) return

    if (!lockbox?.configured) {
      setPendingLockboxMoveId(fragment.id)
      openLockboxGate()
      toast({ body: "设置密匣后会移入笔记" })
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
      closeEditor()
      toast({ body: successMessage })
      return true
    } catch (error) {
      toast({ body: `${"移入密匣失败"}：${getApiErrorMessage(error)}`, type: "error" })
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
    setFilter("lockbox")
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
    toast({ body: `${"帮助"}：${"先在 Inbox 写片段，用 #标签归类。需要持久化和同步时，在设置里选择或创建 vault。"}` })
  }

  async function handleRestoreWindow() {
    try {
      await restoreWindowFrame()
      toast({ body: "已还原窗口尺寸" })
    } catch (error) {
      toast({ body: `${"还原窗口尺寸失败"}：${getApiErrorMessage(error)}`, type: "error" })
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

    toast({ body: "密匣已设置" })
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

    setSelectedTag(null)
    setSelectedLockboxTag(null)
    setFilter("lockbox")
    toast({ body: "密匣已解锁" })
  }

  async function handleLockLockbox() {
    try {
      const state = await lockLockbox()
      applyVaultState(state)
      closeEditor()
      setSelectedLockboxTag(null)
      if (filter === "lockbox") {
        setFilter("tagged")
      }
      toast({ body: "密匣已上锁" })
    } catch (error) {
      toast({ body: `${"密匣上锁失败"}：${getApiErrorMessage(error)}`, type: "error" })
    }
  }

  async function autoLockLockbox(
    options: { returnToTagged?: boolean } = {}
  ) {
    try {
      const state = await lockLockbox()
      applyVaultState(state)
      if (options.returnToTagged && filterRef.current === "lockbox") {
        closeEditor()
        setSelectedLockboxTag(null)
        setFilter("tagged")
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
    toast({ body: "密匣密码已修改" })
  }

  async function handleResetLockboxPassword(
    nextRecoveryKey: string,
    newPassword: string
  ) {
    const result = await resetLockboxPassword(nextRecoveryKey, newPassword)
    applyVaultState(result.vault)
    setRecoveryKey(result.recoveryKey)

    if (pendingLockboxMoveId) {
      const fragmentId = pendingLockboxMoveId
      setPendingLockboxMoveId(null)
      await moveFragmentIntoLockbox(fragmentId, "密匣密码已重置，笔记已移入")
      return
    }

    toast({ body: "密匣密码已重置" })
  }

  function closeLockboxDialog() {
    setPendingLockboxMoveId(null)
    setLockboxDialogMode(null)
    setRecoveryKey(null)
  }

  function handleOpenSearchResult(fragment: Fragment) {
    const visibleTag = getFirstVisibleTag(fragment)

    setEditingVariant("inline")
    setEditingFragmentId(null)
    setSelectedLockboxTag(null)
    setIsMindMapViewActive(false)
    setIsDebtViewActive(false)

    if (fragment.archived) {
      setSelectedTag(null)
      setFilter("archive")
    } else if (fragment.lockbox) {
      if (!lockbox?.unlocked) {
        openLockboxGate()
        toast({ body: "请先解锁密匣后查看笔记" })
        return
      }

      setSelectedTag(null)
      setFilter("lockbox")
    } else if (fragment.tags.includes("inbox")) {
      setSelectedTag(null)
      setSelectedInboxTag(null)
      setFilter("inbox")
    } else if (visibleTag) {
      setSelectedTag(visibleTag)
      setFilter("tagged")
    } else {
      toast({ body: "这条笔记当前不在时间线列表中" })
      return
    }

    setPendingScrollFragmentId(fragment.id)
  }

  function openSearch() {
    setIsSearchDialogOpen(true)
  }

  function handleCreateInboxTag(rawTag: string) {
    const tag = rawTag.trim().replace(/^#+/, "")
    if (!tag) return false

    if (/\s/.test(tag)) {
      toast({ body: "标签不能包含空格", type: "error" })
      return false
    }

    if (tag === "inbox" || tag === LOCKBOX_TAG) {
      toast({ body: `#${tag} 是保留标签，不能新建`, type: "error" })
      return false
    }

    if (inboxTagSummaries.some((summary) => summary.tag === tag)) {
      setSelectedInboxTag(tag)
      toast({ body: `标签 #${tag} 已存在` })
      return true
    }

    updateAppSettings({
      customTags: [...appSettings.customTags, tag],
    })
    setSelectedInboxTag(tag)
    toast({ body: `${`标签 #${tag} 已创建`}：${`写片段时输入 #${tag} 即可归入这个标签。`}` })
    return true
  }

  function openMindMap(map?: MindMapSummary) {
    setIsDebtViewActive(false)
    if (!map) {
      setIsMindMapViewActive(true)
      return
    }

    setActiveMindMapId(map.id)
  }

  function openDebts() {
    setIsMindMapViewActive(false)
    setIsDebtViewActive(true)
  }

  function handleFilterChange(nextFilter: FragmentFilter) {
    setIsMindMapViewActive(false)
    setIsDebtViewActive(false)
    setFilter(nextFilter)
  }

  const publicOnlyFragments = useMemo(
    () => publicFragments(fragments),
    [fragments]
  )

  const activeFragments = useMemo(
    () => fragments.filter((fragment) => !fragment.archived),
    [fragments]
  )

  const publicActiveFragments = useMemo(
    () => publicOnlyFragments.filter((fragment) => !fragment.archived),
    [publicOnlyFragments]
  )

  const archivedFragments = useMemo(
    () => publicOnlyFragments.filter((fragment) => fragment.archived),
    [publicOnlyFragments]
  )

  const lockboxFragments = useMemo(
    () => activeFragments.filter((fragment) => fragment.lockbox),
    [activeFragments]
  )

  const lockboxTagSummaries = useMemo(
    () => buildTagSummaries(lockboxFragments, []),
    [lockboxFragments]
  )

  const taggedFragments = useMemo(
    () => publicActiveFragments.filter(hasVisibleTag),
    [publicActiveFragments]
  )

  const tagSummaries = useMemo(
    () => buildTagSummaries(publicActiveFragments, DEFAULT_PROJECT_TAGS),
    [publicActiveFragments]
  )

  const inboxFragments = useMemo(
    () =>
      publicActiveFragments.filter((fragment) =>
        fragment.tags.includes("inbox")
      ),
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
    switch (filter) {
      case "tagged":
        return selectedTag
          ? publicActiveFragments.filter((fragment) =>
              fragment.tags.includes(selectedTag)
            )
          : taggedFragments
      case "lockbox":
        if (!lockbox?.unlocked) return []
        return selectedLockboxTag
          ? lockboxFragments.filter((fragment) =>
              fragment.tags.includes(selectedLockboxTag)
            )
          : lockboxFragments
      case "archive":
        return archivedFragments
      case "dailyReview":
      case "insight":
      case "walk":
        return []
      case "inbox":
      default:
        return selectedInboxTag
          ? inboxFragments.filter((fragment) =>
              fragment.tags.includes(selectedInboxTag)
            )
          : inboxFragments
    }
  }, [
    archivedFragments,
    filter,
    inboxFragments,
    lockbox?.unlocked,
    lockboxFragments,
    publicActiveFragments,
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
              .filter((tag) => tag !== "inbox")
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
  const isInboxView =
    filter === "inbox" && !isMindMapViewActive && !isDebtViewActive
  const isReviewView =
    !isMindMapViewActive &&
    !isDebtViewActive &&
    (filter === "dailyReview" || filter === "insight" || filter === "walk")
  const isVaultDialogOpen = isVaultGuideOpen || needsVaultSetup
  const isExportSheetOpen = exportingFragment !== null
  const isLockboxArchiveConfirmOpen = pendingLockboxArchiveFragment !== null
  const isModalBusy =
    isVaultDialogOpen ||
    lockboxDialogMode !== null ||
    isExportSheetOpen ||
    isLockboxArchiveConfirmOpen
  const isBlockingDialogOpen = isModalBusy || isSearchDialogOpen

  const timelineScrollTargetId =
    pendingScrollFragmentId &&
    !isSearchDialogOpen &&
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

      openSearch()
    }

    window.addEventListener("keydown", handleGlobalSearchShortcut)

    return () => {
      window.removeEventListener("keydown", handleGlobalSearchShortcut)
    }
  }, [isModalBusy])

  if (activeMindMapId) {
    return (
      <>
        <MindMapWorkspace
          mapId={activeMindMapId}
          onClose={() => setActiveMindMapId(null)}
          onMapsChange={setMindMaps}
        />
        <ToastViewport />
      </>
    )
  }

  return (
    <>
      <main
        aria-hidden={isBlockingDialogOpen ? true : undefined}
        className={styles.appShell}
      >
        <div className={styles.sidebarSlot}>
          <SidebarNav
            activeFilter={filter}
            fragments={publicOnlyFragments}
            mindMapCount={mindMaps.length}
            mindMapViewActive={isMindMapViewActive}
            debtCount={debts.filter((debt) => !debt.archived && !debt.settled).length}
            debtViewActive={isDebtViewActive}
            onOpenDebts={openDebts}
            onFilterChange={handleFilterChange}
            onHelp={showHelp}
            onOpenMindMaps={() => openMindMap()}
            onOpenSearch={openSearch}
            onOpenSettings={() => openSettings("vault")}
            onRestoreWindow={handleRestoreWindow}
            onShortcuts={showShortcuts}
          />
        </div>
        <Stack
          as="section"
          height="100%"
          minHeight={0}
          isScrollable={false}
          style={{ minWidth: 0, overflow: "hidden", background: "var(--background)" }}
        >
          {isInboxView ? (
            <div className={styles.composerPadding} data-tauri-drag-region>
              <CaptureBox
                collapseSignal={composerCollapseSignal}
                isCreating={isCreating}
                knownTags={knownTags}
                onCreate={handleCreate}
                onOpenZen={openZenDraft}
              />
            </div>
          ) : null}

          {isInboxView ? (
            <InboxTagBar
              selectedTag={selectedInboxTag}
              summaries={inboxTagSummaries}
              totalCount={inboxFragments.length}
              onCreateTag={handleCreateInboxTag}
              onSelectTag={setSelectedInboxTag}
            />
          ) : null}

          {filter === "tagged" && !isMindMapViewActive && !isDebtViewActive ? (
            <TaggedPanel
              lockbox={lockbox}
              selectedTag={selectedTag}
              summaries={tagSummaries}
              totalCount={taggedFragments.length}
              onOpenLockbox={openLockboxGate}
              onSelectTag={setSelectedTag}
            />
          ) : null}

          {filter === "lockbox" && !isMindMapViewActive && !isDebtViewActive ? (
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
          ) : null}

          {isDebtViewActive ? (
            <DebtWorkspace debts={debts} onDebtsChange={setDebts} />
          ) : isMindMapViewActive ? (
            <MindMapPanel
              onMapsChange={setMindMaps}
              onOpenMap={setActiveMindMapId}
            />
          ) : isReviewView ? (
            <ReviewWorkspace
              editingFragmentId={
                editingVariant === "inline" ? editingFragmentId : null
              }
              fragments={publicOnlyFragments}
              isLoading={isLoading}
              knownTags={knownTags}
              mode={filter}
              onArchive={handleArchiveFragment}
              onCancelEdit={closeEditor}
              onCreate={handleCreate}
              onEdit={openInlineEditor}
              onExportImage={setExportingFragment}
              onMoveToLockbox={handleMoveFragmentToLockbox}
              onOpenZen={openZenEditor}
              onPin={handlePinFragment}
              onSave={handleUpdateFragment}
              onToggleTask={(fragment, lineIndex) => {
                void handleToggleFragmentTask(fragment, lineIndex)
              }}
              vaultPath={vaultPath}
            />
          ) : (
            <FragmentTimeline
              editingFragmentId={
                editingVariant === "inline" ? editingFragmentId : null
              }
              emptyMessage={
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
                      : undefined
              }
              fragments={filteredFragments}
              isLoading={isLoading}
              knownTags={knownTags}
              mindMaps={isInboxView && !selectedInboxTag ? mindMaps : []}
              onArchive={handleArchiveFragment}
              onCancelEdit={closeEditor}
              onEdit={openInlineEditor}
              onExportImage={setExportingFragment}
              onMoveToLockbox={handleMoveFragmentToLockbox}
              onOpenMindMap={openMindMap}
              onOpenZen={openZenEditor}
              onPin={handlePinFragment}
              onScrollDown={() => {
                setComposerCollapseSignal((current) => current + 1)
              }}
              onScrollToFragmentComplete={handleTimelineScrollComplete}
              onSave={handleUpdateFragment}
              onToggleTask={(fragment, lineIndex) => {
                void handleToggleFragmentTask(fragment, lineIndex)
              }}
              scrollToFragmentId={timelineScrollTargetId}
              vaultPath={vaultPath}
            />
          )}
        </Stack>
        <div className={styles.bottomTabsSlot}>
          <BottomTabs
            activeFilter={filter}
            fragments={publicOnlyFragments}
            onFilterChange={handleFilterChange}
            onHelp={showHelp}
            onOpenDebts={openDebts}
            onOpenMindMaps={() => openMindMap()}
            onOpenSearch={openSearch}
            onOpenSettings={() => openSettings("vault")}
            onRestoreWindow={handleRestoreWindow}
            onShortcuts={showShortcuts}
            vaultPath={vaultPath}
          />
        </div>
      </main>
      <FragmentEditor
        draft={editingVariant === "zen" ? zenDraft : null}
        fragment={editingVariant === "zen" ? editingFragment : null}
        knownTags={knownTags}
        onClose={closeEditor}
        onCreate={handleCreate}
        onSave={handleUpdateFragment}
        vaultPath={vaultPath}
      />
      <FragmentImageExporter
        fragment={exportingFragment}
        onClose={() => setExportingFragment(null)}
        open={isExportSheetOpen}
        vaultPath={vaultPath}
      />
      <FragmentSearchDialog
        fragments={activeFragments}
        open={isSearchDialogOpen}
        onOpenChange={setIsSearchDialogOpen}
        onOpenFragment={handleOpenSearchResult}
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
        initialSection={settingsSection}
        onClose={() => {
          if (!needsVaultSetup) {
            setIsVaultGuideOpen(false)
          }
        }}
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
      <ToastViewport />
    </>
  )
}

export default App

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
      isOpen={fragment !== null}
      onOpenChange={(nextOpen: boolean) => {
        if (!nextOpen && !isArchiving) onCancel()
      }}
      purpose={isArchiving ? "required" : "form"}
      width={420}
    >
      <Layout
        header={
          <DialogHeader
            onOpenChange={isArchiving ? undefined : () => onCancel()}
            subtitle="这条笔记属于密匣。归档后会从密匣列表移除，并且不会出现在「归档/回收站」列表中。"
            title="确认归档密匣笔记"
          />
        }
        footer={
          <LayoutFooter hasDivider>
            <Button
              isDisabled={isArchiving}
              label="取消"
              onClick={onCancel}
              variant="secondary"
            />
            <Button
              isDisabled={isArchiving}
              label={isArchiving ? "归档中" : "仍然归档"}
              onClick={onConfirm}
              variant="destructive"
            />
          </LayoutFooter>
        }
      />
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
        <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
          <HStack gap={3} vAlign="center" style={{ minWidth: 0 }}>
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
          </HStack>

          <HStack gap={2} vAlign="center" style={{ flexShrink: 0 }}>
            {lockbox?.unlocked ? (
              <>
                <Button label="修改密码" onClick={onChangePassword} size="sm" variant="secondary" />
                <Button label="上锁" onClick={onLock} size="sm" variant="secondary" />
              </>
            ) : (
              <Button label="解锁" onClick={onUnlock} size="sm" variant="primary" />
            )}
          </HStack>
        </HStack>

        {lockbox?.unlocked ? (
          <Stack gap={2} style={{ marginTop: "var(--shard-space-3)" }}>
            <HStack
              gap={2}
              vAlign="center"
              style={{
                height: "var(--shard-chip-height)",
                fontSize: 12,
                fontWeight: 500,
                color: "var(--muted-foreground)",
              }}
            >
              <TagIcon size={14} strokeWidth={1.75} />
              <span className="tabular-nums">{summaries.length} 子标签</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{totalCount} 条</span>
            </HStack>

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
          </Stack>
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

function hasVisibleTag(fragment: Fragment) {
  return fragment.tags.some((tag) => tag !== "inbox" && tag !== LOCKBOX_TAG)
}

function getFirstVisibleTag(fragment: Fragment) {
  return (
    fragment.tags.find((tag) => tag !== "inbox" && tag !== LOCKBOX_TAG) ?? null
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
      fragment.tags.filter((tag) => tag !== "inbox" && tag !== LOCKBOX_TAG)
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
