import { invoke, isTauri } from "@tauri-apps/api/core"

import type {
  CodexAgentStatus,
  CodexInsightLens,
  CodexReviewFragment,
  CodexReviewTask,
  CodexReviewTaskResult,
  Debt,
  DebtDirection,
  Fragment,
  LockboxSetupResult,
  MindMapReadResult,
  MindMapSummary,
  ShardMapFile,
  TursoConfigView,
  VaultState,
} from "@/types"

export const DESKTOP_RUNTIME_MESSAGE =
  "此操作需要在 Shard 桌面应用中运行。浏览器预览仅用于界面检查。"

export function getApiErrorMessage(error: unknown) {
  const message = String(error).replace(/^Error:\s*/u, "")

  if (
    message.includes("reading 'invoke'") ||
    message.includes('reading "invoke"') ||
    message.includes("__TAURI__") ||
    message.includes("__TAURI_INTERNALS__")
  ) {
    return DESKTOP_RUNTIME_MESSAGE
  }

  return message
}

function desktopInvoke<T>(command: string, args?: Record<string, unknown>) {
  if (!isTauri()) {
    return Promise.reject(DESKTOP_RUNTIME_MESSAGE)
  }

  return invoke<T>(command, args).catch((error) =>
    Promise.reject(getApiErrorMessage(error))
  )
}

export function listFragments() {
  return desktopInvoke<VaultState>("list_fragments")
}

export function listMindMaps() {
  return desktopInvoke<MindMapSummary[]>("list_mind_maps")
}

export function createMindMap(title: string, sourceFragmentId?: string) {
  return desktopInvoke<MindMapReadResult>("create_mind_map", {
    title,
    sourceFragmentId: sourceFragmentId ?? null,
  })
}

export function readMindMap(id: string) {
  return desktopInvoke<MindMapReadResult>("read_mind_map", { id })
}

export function writeMindMap(
  id: string,
  file: ShardMapFile,
  expectedRevision: number,
  lastSavedHash: string
) {
  return desktopInvoke<MindMapReadResult>("write_mind_map", {
    id,
    file,
    expectedRevision,
    lastSavedHash,
  })
}

export function deleteMindMap(id: string, expectedRevision: number) {
  return desktopInvoke<MindMapSummary[]>("delete_mind_map", {
    id,
    expectedRevision,
  })
}

export function createFragment(content: string, tags: string[]) {
  return desktopInvoke<Fragment>("create_fragment", { content, tags })
}

export function updateFragment(id: string, content: string, tags: string[]) {
  return desktopInvoke<Fragment>("update_fragment", { id, content, tags })
}

export function updateFragmentTags(id: string, tags: string[]) {
  return desktopInvoke<Fragment>("update_fragment_tags", { id, tags })
}

/**
 * 归档与取消归档是同一个操作的两个方向。传 `archived: false` 可以把片段
 * 从归档区移回收件箱——旧版只能单向归档，移进去就取不回来了。
 * 已处于目标状态时是空操作。
 */
export function setFragmentArchived(id: string, archived: boolean) {
  return desktopInvoke<Fragment>("set_fragment_archived", { id, archived })
}

export function pinFragment(id: string, pinned: boolean) {
  return desktopInvoke<Fragment>("set_fragment_pinned", { id, pinned })
}

export function moveFragmentToLockbox(id: string) {
  return desktopInvoke<VaultState>("move_fragment_to_lockbox", { id })
}

// 返回正文里该写的引用（`shard-attachment:<hash>`），不是文件路径。
export function saveFragmentImage(fileName: string, bytes: number[]) {
  return desktopInvoke<string>("save_fragment_image", { fileName, bytes })
}

export function getFragmentImageFilePath(path: string) {
  return desktopInvoke<string>("fragment_image_file_path", { path })
}

export function revealFragmentImageInDir(path: string) {
  return desktopInvoke<void>("reveal_fragment_image_in_dir", { path })
}

export function saveRecoveryKey(path: string, recoveryKey: string) {
  return desktopInvoke<void>("save_recovery_key", { path, recoveryKey })
}

export function saveExportedImage(path: string, bytes: number[]) {
  return desktopInvoke<void>("save_exported_image", { path, bytes })
}

export function copyExportedImage(bytes: number[]) {
  return desktopInvoke<void>("copy_exported_image", { bytes })
}

export function setWindowControlsHidden(hidden: boolean) {
  return desktopInvoke<void>("set_window_controls_hidden", { hidden })
}

export function restoreWindowFrame() {
  return desktopInvoke<void>("restore_window_frame")
}

export function setVaultPath(path: string, initializeGit: boolean) {
  return desktopInvoke<VaultState>("set_vault_path", { path, initializeGit })
}

export function setupLockbox(password: string) {
  return desktopInvoke<LockboxSetupResult>("setup_lockbox", { password })
}

export function unlockLockbox(password: string) {
  return desktopInvoke<VaultState>("unlock_lockbox", { password })
}

export function lockLockbox() {
  return desktopInvoke<VaultState>("lock_lockbox")
}

export function changeLockboxPassword(
  currentPassword: string,
  newPassword: string
) {
  return desktopInvoke<VaultState>("change_lockbox_password", {
    currentPassword,
    newPassword,
  })
}

export function resetLockboxPassword(recoveryKey: string, newPassword: string) {
  return desktopInvoke<LockboxSetupResult>("reset_lockbox_password", {
    recoveryKey,
    newPassword,
  })
}

export function getCodexAgentStatus() {
  return desktopInvoke<CodexAgentStatus>("codex_agent_status")
}

export function runCodexReviewTask(
  task: CodexReviewTask,
  fragments: CodexReviewFragment[],
  vaultPath: string,
  lens?: CodexInsightLens
) {
  return desktopInvoke<CodexReviewTaskResult>("run_codex_review_task", {
    request: {
      task,
      lens,
      fragments,
      vaultPath,
    },
  })
}

export function listDebts() {
  return desktopInvoke<Debt[]>("list_debts")
}

export function createDebt(input: {
  direction: DebtDirection
  counterparty: string
  principalCents: number
  dueDate?: string | null
  note?: string
  tags?: string[]
  createdAt?: string | null
}) {
  return desktopInvoke<Debt>("create_debt", {
    direction: input.direction,
    counterparty: input.counterparty,
    principalCents: input.principalCents,
    dueDate: input.dueDate ?? null,
    note: input.note ?? "",
    tags: input.tags ?? [],
  })
}

export function updateDebt(input: {
  id: string
  counterparty: string
  principalCents: number
  dueDate?: string | null
  note?: string
  tags?: string[]
  createdAt?: string | null
}) {
  return desktopInvoke<Debt>("update_debt", {
    id: input.id,
    counterparty: input.counterparty,
    principalCents: input.principalCents,
    dueDate: input.dueDate ?? null,
    note: input.note ?? "",
    tags: input.tags ?? [],
  })
}

export function setDebtArchived(id: string, archived: boolean) {
  return desktopInvoke<Debt>("set_debt_archived", { id, archived })
}

export function deleteDebt(id: string) {
  return desktopInvoke<Debt[]>("delete_debt", { id })
}

export function addRepayment(input: {
  debtId: string
  amountCents: number
  paidOn: string
  note?: string
}) {
  return desktopInvoke<Debt>("add_repayment", {
    debtId: input.debtId,
    amountCents: input.amountCents,
    paidOn: input.paidOn,
    note: input.note ?? "",
  })
}

export function deleteRepayment(debtId: string, repaymentId: string) {
  return desktopInvoke<Debt>("delete_repayment", { debtId, repaymentId })
}

/** 读取记账模块当前的 Turso 云端配置（不含 token 明文）。 */
export function getTursoConfig() {
  return desktopInvoke<TursoConfigView>("get_turso_config")
}

/**
 * 配置记账模块的 Turso 云端同步。`token` 传 `undefined` 表示保留原值，传空串
 * 表示清除；`url` 为空/undefined 时退化为纯本地 libSQL（不同步）。
 */
export function setTursoConfig(input: { url?: string | null; token?: string }) {
  return desktopInvoke<TursoConfigView>("set_turso_config", {
    url: input.url ?? null,
    token: input.token,
  })
}

// ---------------------------------------------------------------------------
// 笔记库：导入 / 导出 / 校验 / 索引维护
//
// Git 移除后，导出是数据离开应用的唯一出口，因此这些能力必须在 UI 上可达，
// 不能只作为内部命令存在。
// ---------------------------------------------------------------------------

export interface NotesDbStats {
  total: number
  active: number
  deleted: number
  lockbox: number
  indexed: number
  importState: string | null
  importAt: string | null
}

export interface ImportReport {
  scanned: number
  imported: number
  skippedUnchanged: number
  failed: { path: string; reason: string }[]
  warnings: string[]
  lockboxMetadataPending: number
  durationMs: number
}

export interface ExportReport {
  exported: number
  skipped: number
  failed: { id: string; reason: string }[]
  durationMs: number
}

export interface VerifyReport {
  checked: number
  mismatched: { id: string; field: string; detail: string }[]
  missing: string[]
  byteDifferences: string[]
  unmapped: string[]
  /** 库内容能否被产物无损还原。false 表示不该把文件当作可靠备份。 */
  lossless: boolean
}

export function getNotesDbStats() {
  return desktopInvoke<NotesDbStats>("notes_db_stats")
}

/** `dryRun` 为 true 时只扫描不写库，用于先让用户确认规模。 */
export function importVaultMarkdown(dryRun: boolean, includeLockbox = true) {
  return desktopInvoke<ImportReport>("import_vault_markdown", {
    dryRun,
    includeLockbox,
  })
}

/** `full` 为 true 时全量重写，否则只写有改动的条目。 */
export function exportVaultMarkdown(full: boolean) {
  return desktopInvoke<ExportReport>("export_vault_markdown", { full })
}

export function verifyExport() {
  return desktopInvoke<VerifyReport>("verify_export")
}

export function rebuildSearchIndex() {
  return desktopInvoke<number>("rebuild_search_index")
}
