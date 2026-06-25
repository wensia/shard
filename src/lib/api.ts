import { invoke, isTauri } from "@tauri-apps/api/core"

import type {
  CodexAgentStatus,
  CodexInsightLens,
  CodexReviewFragment,
  CodexReviewTask,
  CodexReviewTaskResult,
  Fragment,
  GithubCliInfo,
  GitInfo,
  LockboxSetupResult,
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

export function createFragment(content: string, tags: string[]) {
  return desktopInvoke<Fragment>("create_fragment", { content, tags })
}

export function updateFragment(id: string, content: string, tags: string[]) {
  return desktopInvoke<Fragment>("update_fragment", { id, content, tags })
}

export function updateFragmentTags(id: string, tags: string[]) {
  return desktopInvoke<Fragment>("update_fragment_tags", { id, tags })
}

export function archiveFragment(id: string) {
  return desktopInvoke<Fragment>("archive_fragment", { id })
}

export function pinFragment(id: string, pinned: boolean) {
  return desktopInvoke<Fragment>("set_fragment_pinned", { id, pinned })
}

export function moveFragmentToLockbox(id: string) {
  return desktopInvoke<VaultState>("move_fragment_to_lockbox", { id })
}

export function saveFragmentImage(fileName: string, bytes: number[]) {
  return desktopInvoke<string>("save_fragment_image", { fileName, bytes })
}

export function readFragmentImage(path: string) {
  return desktopInvoke<string>("read_fragment_image", { path })
}

export function saveRecoveryKey(path: string, recoveryKey: string) {
  return desktopInvoke<void>("save_recovery_key", { path, recoveryKey })
}

export function saveExportedImage(path: string, bytes: number[]) {
  return desktopInvoke<void>("save_exported_image", { path, bytes })
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

export function initializeVaultGit() {
  return desktopInvoke<VaultState>("initialize_vault_git")
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

export function setVaultRemote(remoteUrl: string) {
  return desktopInvoke<VaultState>("set_vault_remote", { remoteUrl })
}

export function getGithubCliStatus() {
  return desktopInvoke<GithubCliInfo>("github_cli_status")
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

export function createGithubVaultRepo(repoName: string) {
  return desktopInvoke<VaultState>("create_github_vault_repo", { repoName })
}

export function syncVault() {
  return desktopInvoke<GitInfo>("sync_vault")
}
