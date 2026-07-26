import { open } from "@tauri-apps/plugin-dialog"
import {
  FolderOpenIcon,
  FolderPlusIcon,
  KeyboardIcon,
  Loader2Icon,
  XIcon,
  DatabaseIcon,
} from "lucide-react"
import { useEffect, useRef, useState, type CSSProperties } from "react"

import { Button } from "@astryxdesign/core/Button"
import { HStack } from "@astryxdesign/core/HStack"
import { Stack } from "@astryxdesign/core/Stack"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import {
} from "@/lib/app-settings"
import {
  getApiErrorMessage,
  setVaultPath,
  exportVaultMarkdown,
  getNotesDbStats,
  getSyncConfig,
  getSyncStatus,
  importVaultMarkdown,
  rebuildSearchIndex,
  setSyncConfig,
  syncNow,
  verifyExport,
  type NotesDbStats,
  type SyncStatus,
} from "@/lib/api"
import type { VaultState } from "@/types"

import styles from "./vault-guide.module.css"

/*
 * Shared inline-style objects for text/spacing patterns that repeat verbatim
 * across sections. Kept as plain style objects (not a CSS utility layer) so
 * each still reads as "real CSS for this exact spot" — just deduplicated.
 */
const eyebrowStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: "16px",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--muted-foreground)",
}

const sectionTitleStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: "20px",
  fontWeight: 600,
}

const sectionDescriptionStyle: CSSProperties = {
  marginTop: "var(--shard-space-1)",
  fontSize: 12,
  lineHeight: "20px",
  textWrap: "pretty",
  color: "var(--muted-foreground)",
}

const monoPathStyle: CSSProperties = {
  marginTop: "var(--shard-space-1)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12,
  lineHeight: "20px",
  wordBreak: "break-all",
  color: "var(--muted-foreground)",
  userSelect: "all",
}

export type SettingsSection = "data" | "shortcuts" | "vault"

interface VaultGuideProps {
  initialSection: SettingsSection
  onClose: () => void
  onVaultState: (
    state: VaultState,
    options?: { resetView?: boolean }
  ) => void
  open: boolean
  required: boolean
  vaultPath: string
}

type VaultAction = "create" | "open" | null
type SettingsLocale = "en" | "zh"

interface SettingsCopy {
  close: string
  connectRemoteBusy: string
  createRepoBusy: string
  createVaultDescription: string
  createVaultLabel: string
  dialogTitleCreate: string
  dialogTitleOpen: string
  directoryDescription: string
  directoryTitle: string
  folderSelected: string
  githubBusy: string
  githubChecking: string
  githubCurrentAccount: string
  githubIdle: string
  githubMissing: string
  githubNotAuthenticated: string
  headlineDefault: string
  headlineNeedsRemote: string
  manualDividerLabel: string
  manualRemoteHint: string
  navShortcuts: string
  noVault: string
  openVaultDescription: string
  openVaultLabel: string
  remoteBusy: string
  remoteUrlLabel: string
  repoNameLabel: string
  settingsTitle: string
  sideCurrent: string
  syncSetupTitle: string
  toastVaultCreated: string
  toastVaultFailed: string
  toastVaultSwitched: string
  vaultTitle: string
  autoSyncMinutes(minutes: number): string
  githubAuthenticated(account: string, protocol: string): string
  githubProtocol(protocol: string): string
}

const settingsCopy: Record<SettingsLocale, SettingsCopy> = {
  en: {
    close: "Close",
    connectRemoteBusy: "Connecting",
    createRepoBusy: "Configuring",
    createVaultDescription: "Choose an empty folder and initialize Git.",
    createVaultLabel: "Create folder",
    dialogTitleCreate: "Choose or create a Shard vault folder",
    dialogTitleOpen: "Choose an existing vault folder",
    directoryDescription:
      "Open an existing ShardVault or choose a new folder. Switching never moves your files.",
    directoryTitle: "Folder",
    folderSelected: "Selected",
    githubBusy:
      "Initializing Git if needed, creating a private GitHub repository, connecting origin, and pushing the current commit.",
    githubChecking: "Checking GitHub CLI sign-in...",
    githubCurrentAccount: "current account",
    githubIdle:
      "When available, Shard will initialize Git if needed, create a private repository, connect origin, and push local commits.",
    githubMissing:
      "GitHub CLI was not found. You can still enter a remote URL manually.",
    githubNotAuthenticated: "gh is not signed in. Run gh auth login first.",
    headlineDefault:
      "Choose an existing Shard folder, or create a new one as the local root for Markdown and Git.",
    headlineNeedsRemote:
      "The current folder is usable, but sync is not configured yet. Auto configure GitHub sync, or enter any Git remote URL manually.",
    manualDividerLabel: "Or connect a remote manually",
    manualRemoteHint:
      "The manual URL is saved as origin. You can also run git remote add origin <url> in the current folder.",
    navShortcuts: "Shortcuts",
    noVault: "No folder selected",
    openVaultDescription: "Open an existing ShardVault or Git repository.",
    openVaultLabel: "Choose folder",
    remoteBusy: "Connecting Git remote.",
    remoteUrlLabel: "Git remote URL",
    repoNameLabel: "GitHub repository name",
    settingsTitle: "Settings",
    sideCurrent: "Folder",
    syncSetupTitle: "Set up sync",
    toastVaultCreated: "Vault created",
    toastVaultFailed: "Vault setup failed",
    toastVaultSwitched: "Vault switched",
    vaultTitle: "Vault",
    autoSyncMinutes: (minutes) => `${minutes} min`,
    githubAuthenticated: (account, protocol) =>
      `Signed in as ${account}${protocol}. Shard can configure GitHub sync automatically.`,
    githubProtocol: (protocol) => `, Git protocol ${protocol}`,
  },
  zh: {
    close: "关闭",
    connectRemoteBusy: "连接中",
    createRepoBusy: "配置中",
    createVaultDescription: "选择一个空目录，并为它初始化 Git。",
    createVaultLabel: "创建新目录",
    dialogTitleCreate: "选择或新建 Shard vault 目录",
    dialogTitleOpen: "选择已有 vault 目录",
    directoryDescription: "打开已有 ShardVault，或新建一个空目录。更换目录不会移动现有文件。",
    directoryTitle: "目录",
    folderSelected: "已选择",
    githubBusy: "正在初始化 Git、创建 GitHub 私有仓库、连接 origin，并推送当前提交。",
    githubChecking: "正在检查 GitHub CLI 登录状态...",
    githubCurrentAccount: "当前账号",
    githubIdle: "可用时会自动初始化 Git、创建私有仓库、连接 origin，并推送本地提交。",
    githubMissing: "未检测到 gh。可以继续手动填写远端 URL。",
    githubNotAuthenticated: "gh 尚未登录。请先运行 gh auth login。",
    headlineDefault:
      "选择已有 Shard 目录，或创建一个新目录作为 Markdown 与 Git 的本地根目录。",
    headlineNeedsRemote:
      "当前目录已经可用，但还没有完成同步配置。可以自动配置 GitHub 同步，也可以手动填写任意 Git 远端。",
    manualDividerLabel: "或手动连接远端",
    manualRemoteHint:
      "手动 URL 会保存为 origin。也可以在当前目录运行 git remote add origin <url>。",
    navShortcuts: "快捷键",
    noVault: "未选择目录",
    openVaultDescription: "打开已有 ShardVault 或 Git 仓库。",
    openVaultLabel: "选择已有目录",
    remoteBusy: "正在连接 Git 远端。",
    remoteUrlLabel: "Git 远端 URL",
    repoNameLabel: "GitHub 仓库名",
    settingsTitle: "设置",
    sideCurrent: "目录",
    syncSetupTitle: "配置同步",
    toastVaultCreated: "Vault 已创建",
    toastVaultFailed: "Vault 设置失败",
    toastVaultSwitched: "Vault 已切换",
    vaultTitle: "Vault",
    autoSyncMinutes: (minutes) => `${minutes} 分钟`,
    githubAuthenticated: (account, protocol) =>
      `已登录 ${account}${protocol}。Shard 可以自动配置 GitHub 同步。`,
    githubProtocol: (protocol) => `，Git 协议 ${protocol}`,
  },
}

const shortcutRows: Record<
  SettingsLocale,
  { keys: string[]; label: string }[]
> = {
  en: [
    { keys: ["⌘", "Enter"], label: "Save fragment" },
    { keys: ["⌘", "K"], label: "Search" },
    { keys: ["⌘", "⇧", "F"], label: "Zen mode (in composer)" },
    { keys: ["Enter"], label: "New line" },
    { keys: ["Esc"], label: "Exit editing" },
  ],
  zh: [
    { keys: ["⌘", "Enter"], label: "保存片段" },
    { keys: ["⌘", "K"], label: "搜索" },
    { keys: ["⌘", "⇧", "F"], label: "禅模式（输入框内）" },
    { keys: ["Enter"], label: "换行" },
    { keys: ["Esc"], label: "退出编辑" },
  ],
}

function getPreferredSettingsLocale(): SettingsLocale {
  const language =
    typeof navigator === "undefined"
      ? ""
      : navigator.languages?.[0] || navigator.language || ""

  return language.toLowerCase().startsWith("zh") ? "zh" : "en"
}

export function VaultGuide({
  initialSection,
  onClose,
  onVaultState,
  open: isOpen,
  required,
  vaultPath,
}: VaultGuideProps) {
  const [activeAction, setActiveAction] = useState<VaultAction>(null)
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [dbStats, setDbStats] = useState<NotesDbStats | null>(null)
  const [syncState, setSyncState] = useState<SyncStatus | null>(null)
  const [syncUrl, setSyncUrl] = useState("")
  const [syncToken, setSyncToken] = useState("")
  const [syncHasToken, setSyncHasToken] = useState(false)
  const [dataBusy, setDataBusy] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const toast = useToast()
  const locale = getPreferredSettingsLocale()
  const copy = settingsCopy[locale]

  const isVaultActionBusy = activeAction !== null
  const folderName =
    vaultPath.split(/[\\/]/).filter(Boolean).pop() || copy.vaultTitle

  useEffect(() => {
    if (isOpen) {
      setSection(initialSection)
    }
  }, [initialSection, isOpen])

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        dialogRef.current?.focus()
      })
    }
  }, [isOpen])

  if (!isOpen) return null


  async function chooseVault(initializeGit: boolean) {
    setActiveAction(initializeGit ? "create" : "open")

    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: initializeGit ? copy.dialogTitleCreate : copy.dialogTitleOpen,
      })

      const path = Array.isArray(selected) ? selected[0] : selected
      if (!path) return

      const state = await setVaultPath(path, initializeGit)
      onVaultState(state, { resetView: true })
      toast({
        body: initializeGit ? copy.toastVaultCreated : copy.toastVaultSwitched,
      })
    } catch (error) {
      toast({
        body: `${copy.toastVaultFailed}: ${getApiErrorMessage(error)}`,
        type: "error",
      })
    } finally {
      setActiveAction(null)
    }
  }

  async function refreshDbStats() {
    try {
      setDbStats(await getNotesDbStats())
    } catch (error) {
      toast({ body: `读取库状态失败：${getApiErrorMessage(error)}`, type: "error" })
    }
  }

  async function refreshSyncState() {
    try {
      const [config, status] = await Promise.all([getSyncConfig(), getSyncStatus()])
      setSyncUrl(config.url)
      setSyncHasToken(config.hasToken)
      setSyncState(status)
    } catch (error) {
      toast({ body: `读取同步状态失败：${getApiErrorMessage(error)}`, type: "error" })
    }
  }

  useEffect(() => {
    if (isOpen && section === "data") {
      void refreshDbStats()
      void refreshSyncState()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, section])

  /** 统一包裹：跑一个数据操作，期间禁用其它按钮，结束后刷新状态。 */
  async function runDataAction(key: string, run: () => Promise<string>) {
    setDataBusy(key)
    try {
      toast({ body: await run() })
      await refreshDbStats()
      await refreshSyncState()
    } catch (error) {
      toast({ body: `${getApiErrorMessage(error)}`, type: "error" })
    } finally {
      setDataBusy(null)
    }
  }

  const dataSection = (
    <>
      <section className={styles.sectionPad}>
        <h3 style={sectionTitleStyle}>笔记库</h3>
        <p style={sectionDescriptionStyle}>
          笔记存放在本地数据库中，Markdown 文件是可随时重新生成的导出产物。
        </p>
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "var(--shard-space-2) var(--shard-space-4)",
            marginTop: "var(--shard-space-3)",
            fontSize: 13,
          }}
        >
          <dt style={{ color: "var(--muted-foreground)" }}>笔记总数</dt>
          <dd>{dbStats ? `${dbStats.total}（活跃 ${dbStats.active}）` : "…"}</dd>
          <dt style={{ color: "var(--muted-foreground)" }}>密匣</dt>
          <dd>{dbStats ? `${dbStats.lockbox} 条` : "…"}</dd>
          <dt style={{ color: "var(--muted-foreground)" }}>搜索索引</dt>
          <dd>{dbStats ? `${dbStats.indexed} 条` : "…"}</dd>
        </dl>
      </section>

      <section className={styles.sectionPad}>
        <h3 style={sectionTitleStyle}>同步</h3>
        <p style={sectionDescriptionStyle}>
          配置自建服务器后，笔记会在多台设备之间同步。离线时照常读写，联网后自动追平；
          两端同时改过同一条时不会覆盖，本地那一版会另存为冲突副本。
        </p>

        <Stack gap={2} style={{ marginTop: "var(--shard-space-3)" }}>
          <TextInput
            label="服务器地址"
            onChange={setSyncUrl}
            placeholder="https://shard.example.com"
            value={syncUrl}
          />
          <TextInput
            label={syncHasToken ? "访问令牌（留空则保留当前令牌）" : "访问令牌"}
            onChange={setSyncToken}
            placeholder={syncHasToken ? "已配置" : "服务器上生成的令牌"}
            type="password"
            value={syncToken}
          />
        </Stack>

        <HStack gap={2} style={{ marginTop: "var(--shard-space-3)", flexWrap: "wrap" }}>
          <Button
            isDisabled={dataBusy !== null}
            label={dataBusy === "sync-config" ? "保存中…" : "保存同步设置"}
            onClick={() =>
              void runDataAction("sync-config", async () => {
                // 令牌留空表示"沿用当前的"，不要把它清掉。
                const config = await setSyncConfig(
                  syncUrl,
                  syncToken.trim() === "" ? undefined : syncToken
                )
                setSyncToken("")
                return config.url ? `已保存：${config.url}` : "已关闭同步"
              })
            }
            size="sm"
            variant="secondary"
          />
          <Button
            isDisabled={dataBusy !== null || !syncState?.configured}
            label={dataBusy === "sync" ? "同步中…" : "立即同步"}
            onClick={() =>
              void runDataAction("sync", async () => {
                const report = await syncNow()
                const parts = [`拉取 ${report.pulled} 条`, `推送 ${report.pushed} 条`]
                if (report.uploadedAttachments > 0) {
                  parts.push(`上传 ${report.uploadedAttachments} 个附件`)
                }
                if (report.conflicts > 0) {
                  parts.push(`${report.conflicts} 条冲突已另存副本`)
                }
                if (report.rejected.length > 0) {
                  parts.push(`${report.rejected.length} 条被服务器拒绝`)
                }
                return parts.join("，")
              })
            }
            size="sm"
            variant="secondary"
          />
        </HStack>

        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "var(--shard-space-2) var(--shard-space-4)",
            marginTop: "var(--shard-space-3)",
            fontSize: 13,
          }}
        >
          <dt style={{ color: "var(--muted-foreground)" }}>状态</dt>
          <dd>{syncState?.configured ? "已配置" : "未配置（纯本地运行）"}</dd>
          <dt style={{ color: "var(--muted-foreground)" }}>待同步</dt>
          <dd>{syncState ? `${syncState.pending} 条本地改动` : "…"}</dd>
          <dt style={{ color: "var(--muted-foreground)" }}>上次同步</dt>
          <dd>{syncState?.lastSyncedAt ?? "从未"}</dd>
        </dl>

        {syncState?.lastError ? (
          <p
            style={{
              ...sectionDescriptionStyle,
              color: "var(--shard-danger)",
              marginTop: "var(--shard-space-2)",
            }}
          >
            上次同步失败：{syncState.lastError}
          </p>
        ) : null}
      </section>

      <section className={styles.sectionPad}>
        <h3 style={sectionTitleStyle}>备份与校验</h3>
        <p style={sectionDescriptionStyle}>
          导出会把库中全部内容写回文件：笔记、思维导图与图片附件。密匣条目以密文形式导出，不需要解锁。
        </p>
        <HStack gap={2} style={{ marginTop: "var(--shard-space-3)", flexWrap: "wrap" }}>
          <Button
            isDisabled={dataBusy !== null}
            label={dataBusy === "export" ? "导出中…" : "导出全部笔记"}
            onClick={() =>
              void runDataAction("export", async () => {
                const report = await exportVaultMarkdown(true)
                const summary = `已导出 ${report.exported} 条笔记、${report.maps} 份导图、${report.attachments} 个附件`
                return report.failed.length
                  ? `${summary}，${report.failed.length} 项失败`
                  : summary
              })
            }
            size="sm"
            variant="secondary"
          />
          <Button
            isDisabled={dataBusy !== null}
            label={dataBusy === "verify" ? "校验中…" : "校验导出完整性"}
            onClick={() =>
              void runDataAction("verify", async () => {
                const report = await verifyExport()
                if (!report.lossless) {
                  return `校验未通过：${report.mismatched.length} 条内容不符、${report.missing.length} 条文件缺失`
                }
                return report.byteDifferences.length
                  ? `内容完整，但 ${report.byteDifferences.length} 个文件与库不一致（可重新导出覆盖）`
                  : `已校验 ${report.checked} 条，全部可无损还原`
              })
            }
            size="sm"
            variant="ghost"
          />
        </HStack>
      </section>

      <section className={styles.sectionPad}>
        <h3 style={sectionTitleStyle}>维护</h3>
        <p style={sectionDescriptionStyle}>
          从磁盘重新扫描会把外部改动过的 Markdown 文件同步进库；重建索引用于搜索结果异常时修复。
        </p>
        <HStack gap={2} style={{ marginTop: "var(--shard-space-3)", flexWrap: "wrap" }}>
          <Button
            isDisabled={dataBusy !== null}
            label={dataBusy === "import" ? "扫描中…" : "从磁盘重新扫描"}
            onClick={() =>
              void runDataAction("import", async () => {
                const report = await importVaultMarkdown(false)
                return `扫描 ${report.scanned} 个文件，同步 ${report.imported} 条`
              })
            }
            size="sm"
            variant="ghost"
          />
          <Button
            isDisabled={dataBusy !== null}
            label={dataBusy === "reindex" ? "重建中…" : "重建搜索索引"}
            onClick={() =>
              void runDataAction("reindex", async () => {
                const count = await rebuildSearchIndex()
                return `已重建 ${count} 条笔记的索引`
              })
            }
            size="sm"
            variant="ghost"
          />
        </HStack>
      </section>
    </>
  )

  const railSection = (
    <section className={styles.sectionPad}>
      <div className={styles.railRow}>
        <RailStation
          label={copy.sideCurrent}
          tone={vaultPath ? "emerald" : "empty"}
          value={vaultPath ? copy.folderSelected : copy.noVault}
        />
      </div>
    </section>
  )

  const directorySection = (
    <section className={styles.sectionPad}>
      <h3 style={sectionTitleStyle}>{copy.directoryTitle}</h3>
      <p style={sectionDescriptionStyle}>{copy.directoryDescription}</p>
      <div
        className={styles.directoryGrid}
        style={{ marginTop: "var(--shard-space-3)" }}
      >
        <VaultActionButton
          active={activeAction === "open"}
          disabled={isVaultActionBusy}
          description={copy.openVaultDescription}
          icon={FolderOpenIcon}
          label={copy.openVaultLabel}
          onClick={() => void chooseVault(false)}
        />
        <VaultActionButton
          active={activeAction === "create"}
          disabled={isVaultActionBusy}
          description={copy.createVaultDescription}
          icon={FolderPlusIcon}
          label={copy.createVaultLabel}
          onClick={() => void chooseVault(true)}
        />
      </div>
    </section>
  )

  if (required || !vaultPath) {
    return (
      <div className={styles.overlay}>
        <div
          aria-labelledby="vault-guide-title"
          aria-modal="true"
          className={`${styles.panelBase} ${styles.panelSolo}`}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !required) {
              event.preventDefault()
              onClose()
            }
          }}
          ref={dialogRef}
          role="dialog"
          tabIndex={-1}
        >
          <header className={styles.headerBlock}>
            <HStack gap={3} hAlign="between" vAlign="center">
              <span style={eyebrowStyle}>
                {copy.settingsTitle}
                {vaultPath ? ` · ${copy.vaultTitle}` : ""}
              </span>
              {!required ? (
                <Button
                  icon={<XIcon data-icon="inline-start" />}
                  isIconOnly
                  label={copy.close}
                  onClick={onClose}
                  size="sm"
                  style={{ marginTop: -4, marginRight: -8 }}
                  type="button"
                  variant="ghost"
                />
              ) : null}
            </HStack>
            <h2
              id="vault-guide-title"
              style={{
                marginTop: "var(--shard-space-1)",
                fontSize: 18,
                lineHeight: "24px",
                fontWeight: 600,
                textWrap: "balance",
              }}
            >
              {vaultPath ? folderName : copy.vaultTitle}
            </h2>
            {vaultPath ? (
              <p style={monoPathStyle}>{vaultPath}</p>
            ) : (
              <p
                style={{
                  marginTop: "var(--shard-space-2)",
                  fontSize: 14,
                  lineHeight: "24px",
                  textWrap: "pretty",
                  color: "var(--muted-foreground)",
                }}
              >
                {copy.headlineDefault}
              </p>
            )}
          </header>

          <main className={styles.mainScroll}>
            {railSection}
            {directorySection}
          </main>
        </div>
      </div>
    )
  }

  const navItems: { icon: typeof FolderOpenIcon; id: SettingsSection; label: string }[] = [
    { icon: FolderOpenIcon, id: "vault", label: copy.vaultTitle },
    { icon: DatabaseIcon, id: "data", label: "数据" },
    { icon: KeyboardIcon, id: "shortcuts", label: copy.navShortcuts },
  ]
  const sectionTitle =
    section === "shortcuts"
      ? copy.navShortcuts
      : section === "data"
        ? "数据"
        : copy.vaultTitle

  return (
    <div className={styles.overlay}>
      <div
        aria-labelledby="vault-guide-title"
        aria-modal="true"
        className={`${styles.panelBase} ${styles.panelFull}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            onClose()
          }
        }}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <nav className={styles.navRail}>
          <div className={styles.navEyebrow}>{copy.settingsTitle}</div>
          {navItems.map(({ icon: Icon, id, label }) => {
            const isActive = section === id
            return (
              <button
                className={styles.navButton}
                key={id}
                onClick={() => setSection(id)}
                style={
                  isActive
                    ? {
                        background: "var(--sidebar-accent)",
                        color: "var(--sidebar-accent-foreground)",
                      }
                    : undefined
                }
                type="button"
              >
                <Icon size={16} strokeWidth={1.75} style={{ flexShrink: 0 }} />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </span>
              </button>
            )
          })}
        </nav>

        <Stack
          style={{
            minHeight: 0,
            minWidth: 0,
            flexGrow: 1,
            flexShrink: 1,
            flexBasis: 0,
          }}
        >
          <HStack
            as="header"
            gap={3}
            hAlign="between"
            paddingBlock={3}
            paddingInline={6}
            style={{ borderBottom: "1px solid var(--border)", flexShrink: 0 }}
            vAlign="center"
          >
            <h2
              id="vault-guide-title"
              style={{ fontSize: 16, lineHeight: "24px", fontWeight: 600 }}
            >
              {sectionTitle}
            </h2>
            <Button
              icon={<XIcon data-icon="inline-start" />}
              isIconOnly
              label={copy.close}
              onClick={onClose}
              size="sm"
              style={{ marginRight: -8 }}
              type="button"
              variant="ghost"
            />
          </HStack>

          <main className={styles.mainScroll}>
            {section === "data" ? dataSection : null}

            {section === "vault" ? (
              <>
                <section className={styles.sectionPad}>
                  <div style={eyebrowStyle}>{copy.sideCurrent}</div>
                  <div
                    style={{
                      marginTop: "var(--shard-space-1)",
                      fontSize: 16,
                      lineHeight: "24px",
                      fontWeight: 600,
                      textWrap: "balance",
                    }}
                  >
                    {folderName}
                  </div>
                  <p style={monoPathStyle}>{vaultPath}</p>
                </section>
                {directorySection}
              </>
            ) : null}


            {section === "shortcuts" ? (
              <section className={styles.sectionPadCompact}>
                <div>
                  {shortcutRows[locale].map((row, index) => (
                    <HStack
                      gap={4}
                      hAlign="between"
                      key={row.label}
                      paddingBlock={3}
                      style={{
                        borderTop:
                          index === 0 ? "none" : "1px solid var(--border)",
                      }}
                      vAlign="center"
                    >
                      <span style={{ fontSize: 14, lineHeight: "20px" }}>
                        {row.label}
                      </span>
                      <HStack gap={1} style={{ flexShrink: 0 }} vAlign="center">
                        {row.keys.map((key) => (
                          <kbd className={styles.kbdKey} key={key}>
                            {key}
                          </kbd>
                        ))}
                      </HStack>
                    </HStack>
                  ))}
                </div>
              </section>
            ) : null}
          </main>
        </Stack>
      </div>
    </div>
  )
}

type StationTone = "amber" | "emerald" | "empty" | "info" | "ruby"

const stationToneStyle: Record<StationTone, CSSProperties> = {
  amber: {
    background: "var(--shard-amber)",
    boxShadow: "0 0 0 3px rgb(var(--shard-amber-rgb) / var(--shard-alpha-13))",
  },
  emerald: {
    background: "var(--shard-emerald)",
    boxShadow:
      "0 0 0 3px rgb(var(--shard-emerald-rgb) / var(--shard-alpha-13))",
  },
  empty: {
    border:
      "1.5px solid color-mix(in srgb, var(--muted-foreground) 55%, transparent)",
  },
  info: {
    background: "var(--shard-info)",
    boxShadow: "0 0 0 3px rgb(var(--shard-info-rgb) / var(--shard-alpha-13))",
  },
  ruby: {
    background: "var(--shard-ruby)",
    boxShadow: "0 0 0 3px rgb(var(--shard-ruby-rgb) / var(--shard-alpha-13))",
  },
}

interface RailStationProps {
  detail?: string
  label: string
  tone: StationTone
  value: string
}

function RailStation({ detail, label, tone, value }: RailStationProps) {
  return (
    <div className={styles.railStation}>
      <span
        aria-hidden="true"
        className={tone === "info" ? styles.pulseDot : undefined}
        style={{
          marginTop: 3,
          width: 10,
          height: 10,
          flexShrink: 0,
          borderRadius: "9999px",
          ...stationToneStyle[tone],
        }}
      />
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 11,
            lineHeight: "16px",
            fontWeight: 600,
            color: "var(--muted-foreground)",
          }}
        >
          {label}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 14,
            lineHeight: "20px",
            fontWeight: 600,
          }}
        >
          {value}
        </span>
        {detail ? (
          <span
            style={{
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              fontSize: 12,
              lineHeight: "16px",
              color: "var(--muted-foreground)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {detail}
          </span>
        ) : null}
      </span>
    </div>
  )
}

interface VaultActionButtonProps {
  active: boolean
  disabled?: boolean
  description: string
  icon: typeof FolderOpenIcon
  label: string
  onClick: () => void
}

function VaultActionButton({
  active,
  disabled = false,
  description,
  icon: Icon,
  label,
  onClick,
}: VaultActionButtonProps) {
  return (
    <button
      className={styles.actionButton}
      disabled={disabled || active}
      onClick={onClick}
      type="button"
    >
      <span
        style={{
          display: "flex",
          width: 32,
          height: 32,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "var(--shard-radius-control)",
          background: "var(--muted)",
          color: "var(--muted-foreground)",
        }}
      >
        {active ? (
          <Loader2Icon className={styles.spin} size={16} />
        ) : (
          <Icon size={16} />
        )}
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 14,
            lineHeight: "20px",
            fontWeight: 600,
            textWrap: "balance",
          }}
        >
          {label}
        </span>
        <span
          style={{
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 12,
            lineHeight: "16px",
            color: "var(--muted-foreground)",
          }}
        >
          {description}
        </span>
      </span>
    </button>
  )
}
