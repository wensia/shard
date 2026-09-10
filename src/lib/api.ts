import { invoke, isTauri } from "@tauri-apps/api/core"

import { deriveKind } from "@/lib/content-kind"
import type {
  CheckpointResult,
  CsvFileSummary,
  DiagramDocumentSummary,
  Fragment,
  FragmentRelation,
  GithubCliInfo,
  GitInfo,
  LockboxSetupResult,
  LegacyNoteMigrationResult,
  LibraryMutationResult,
  LibraryTreeSnapshot,
  MindMapReadResult,
  MindMapSummary,
  ShardMapFile,
  VaultState,
} from "@/types"

type StoredFragment = Omit<Fragment, "kind">
type StoredVaultState = Omit<VaultState, "fragments"> & {
  fragments: StoredFragment[]
}
type StoredLockboxSetupResult = Omit<LockboxSetupResult, "vault"> & {
  vault: StoredVaultState
}
type StoredLibraryMutationResult = Omit<LibraryMutationResult, "fragment"> & {
  fragment?: StoredFragment
}

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

function hydrateFragment(fragment: StoredFragment): Fragment {
  return { ...fragment, kind: deriveKind(fragment.tags) }
}

function hydrateVaultState(state: StoredVaultState): VaultState {
  return {
    ...state,
    fragments: state.fragments.map(hydrateFragment),
  }
}

function invokeFragment(command: string, args?: Record<string, unknown>) {
  return desktopInvoke<StoredFragment>(command, args).then(hydrateFragment)
}

function invokeVaultState(command: string, args?: Record<string, unknown>) {
  return desktopInvoke<StoredVaultState>(command, args).then(hydrateVaultState)
}

export function listFragments() {
  return invokeVaultState("list_fragments")
}

export function listMindMaps() {
  return desktopInvoke<MindMapSummary[]>("list_mind_maps")
}

export function listDiagramDocuments() {
  return desktopInvoke<DiagramDocumentSummary[]>("list_diagram_documents")
}

export function listCsvFiles() {
  return desktopInvoke<CsvFileSummary[]>("list_csv_files")
}

export function listLibraryTree() {
  return desktopInvoke<LibraryTreeSnapshot>("list_library_tree")
}

export function migrateLegacyNotes() {
  return desktopInvoke<LegacyNoteMigrationResult>("migrate_legacy_notes")
}

function invokeLibraryMutation(command: string, args?: Record<string, unknown>) {
  return desktopInvoke<StoredLibraryMutationResult>(command, args).then(
    (result): LibraryMutationResult => ({
      ...result,
      fragment: result.fragment ? hydrateFragment(result.fragment) : undefined,
    })
  )
}

export function createLibraryNote(parentPath: string, title: string) {
  return invokeLibraryMutation("create_library_note", { parentPath, title })
}

export function createLibraryDirectory(parentPath: string, name: string) {
  return invokeLibraryMutation("create_library_directory", { parentPath, name })
}

export function renameLibraryEntry(path: string, newName: string) {
  return invokeLibraryMutation("rename_library_entry", { path, newName })
}

export function moveLibraryEntry(path: string, destinationDirectory: string) {
  return invokeLibraryMutation("move_library_entry", {
    path,
    destinationDirectory,
  })
}

export function deleteLibraryEntry(path: string) {
  return invokeLibraryMutation("delete_library_entry", { path })
}

export function restoreFromTrash(path: string) {
  return invokeLibraryMutation("restore_from_trash", { path })
}

export function purgeFromTrash(path: string) {
  return invokeLibraryMutation("purge_from_trash", { path })
}

export function emptyTrash(scope: "library" | "fragments" = "library") {
  return invokeLibraryMutation("empty_trash", { scope })
}

export function convertFragmentToNote(
  id: string,
  destinationDirectory?: string,
  title?: string
) {
  return invokeLibraryMutation("convert_fragment_to_note", {
    id,
    destinationDirectory: destinationDirectory ?? null,
    title: title ?? null,
  })
}

export function convertNoteToFragment(id: string) {
  return invokeLibraryMutation("convert_note_to_fragment", { id })
}

export function readCsvFile(path: string) {
  return desktopInvoke<number[]>("read_csv_file", { path })
}

export function openCsvFile(path: string) {
  return desktopInvoke<void>("open_csv_file", { path })
}

export function createMindMap(title: string, sourceFragmentId?: string, parentPath?: string) {
  return desktopInvoke<MindMapReadResult>("create_mind_map", {
    title,
    sourceFragmentId: sourceFragmentId ?? null,
    parentPath: parentPath ?? null,
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
  return invokeFragment("create_fragment", { content, tags })
}

export function updateFragment(
  id: string,
  content: string,
  tags: string[],
  expectedSha?: string
) {
  return invokeFragment("update_fragment", { id, content, tags, expectedSha })
}

export function updateFragmentTags(id: string, tags: string[]) {
  return invokeFragment("update_fragment_tags", { id, tags })
}

export type OrganizeTemplate = "summary" | "article" | "weekly"

export function organizeFragments(
  fragmentPaths: string[],
  target: string,
  template: OrganizeTemplate
) {
  return invokeFragment("organize_fragments", {
    request: { fragmentPaths, target, template },
  })
}

export function linkFragments(
  sourceId: string,
  targetId: string,
  origin: FragmentRelation["origin"],
  note?: string
): Promise<Fragment> {
  return invokeFragment("link_fragments", {
    sourceId,
    targetId,
    origin,
    note: note ?? null,
  })
}

export function unlinkFragments(
  sourceId: string,
  targetId: string
): Promise<Fragment> {
  return invokeFragment("unlink_fragments", { sourceId, targetId })
}

/**
 * 兼容既有命令名：公开片段传 `true` 会移入回收站；恢复由回收站命令完成。
 * 密匣仍沿用其内部删除/恢复路径，不会写入明文 `.trash/`。
 * 已处于目标状态时是空操作。
 */
export function setFragmentArchived(id: string, archived: boolean) {
  return invokeFragment("set_fragment_archived", { id, archived })
}

export function pinFragment(id: string, pinned: boolean) {
  return invokeFragment("set_fragment_pinned", { id, pinned })
}

export function moveFragmentToLockbox(id: string) {
  return invokeVaultState("move_fragment_to_lockbox", { id })
}

// Excel / CSV 转成 Markdown 表格文本。只转换、不落盘，结果由调用方插进正文。
export function convertTableDocumentToMarkdown(path: string) {
  return desktopInvoke<string>("convert_table_document_to_markdown", { path })
}

// 返回 assets 目录下的相对路径，可直接写入 Markdown 正文。
export function saveFragmentImage(fileName: string, bytes: number[]) {
  return desktopInvoke<string>("save_fragment_image", { fileName, bytes })
}

export function readFragmentImage(path: string) {
  return desktopInvoke<string>("read_fragment_image", { path })
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

/**
 * 切换画布抓手光标。
 *
 * 走原生而不是 CSS：WebKit 只在指针移动时重算 `cursor`，macOS 又会在按键时
 * 隐藏指针，两者叠加会让空格抓手必须动一下鼠标才出现。
 */
export function setCanvasGrabCursor(active: boolean) {
  return desktopInvoke<void>("set_canvas_grab_cursor", { active })
}

export function restoreWindowFrame() {
  return desktopInvoke<void>("restore_window_frame")
}

export function setVaultPath(path: string, initializeGit: boolean) {
  return invokeVaultState("set_vault_path", { path, initializeGit })
}

export function initializeVaultGit() {
  return invokeVaultState("initialize_vault_git")
}

export function setupLockbox(password: string) {
  return desktopInvoke<StoredLockboxSetupResult>("setup_lockbox", {
    password,
  }).then((result): LockboxSetupResult => ({
    ...result,
    vault: hydrateVaultState(result.vault),
  }))
}

export function unlockLockbox(password: string) {
  return invokeVaultState("unlock_lockbox", { password })
}

export function lockLockbox() {
  return invokeVaultState("lock_lockbox")
}

export function changeLockboxPassword(
  currentPassword: string,
  newPassword: string
) {
  return invokeVaultState("change_lockbox_password", {
    currentPassword,
    newPassword,
  })
}

export function resetLockboxPassword(recoveryKey: string, newPassword: string) {
  return desktopInvoke<StoredLockboxSetupResult>("reset_lockbox_password", {
    recoveryKey,
    newPassword,
  }).then((result): LockboxSetupResult => ({
    ...result,
    vault: hydrateVaultState(result.vault),
  }))
}

export function setVaultRemote(remoteUrl: string) {
  return invokeVaultState("set_vault_remote", { remoteUrl })
}

export function getGithubCliStatus() {
  return desktopInvoke<GithubCliInfo>("github_cli_status")
}

export function createGithubVaultRepo(repoName: string) {
  return invokeVaultState("create_github_vault_repo", { repoName })
}

export function syncVault() {
  return desktopInvoke<GitInfo>("sync_vault")
}

export function checkpointVault(trigger?: string) {
  return desktopInvoke<CheckpointResult>("checkpoint_vault", { trigger })
}
