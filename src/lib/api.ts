import { invoke } from "@tauri-apps/api/core"

import type { Fragment, GithubCliInfo, GitInfo, VaultState } from "@/types"

export function listFragments() {
  return invoke<VaultState>("list_fragments")
}

export function createFragment(content: string, tags: string[]) {
  return invoke<Fragment>("create_fragment", { content, tags })
}

export function updateFragment(id: string, content: string, tags: string[]) {
  return invoke<Fragment>("update_fragment", { id, content, tags })
}

export function updateFragmentTags(id: string, tags: string[]) {
  return invoke<Fragment>("update_fragment_tags", { id, tags })
}

export function archiveFragment(id: string) {
  return invoke<Fragment>("archive_fragment", { id })
}

export function saveFragmentImage(fileName: string, bytes: number[]) {
  return invoke<string>("save_fragment_image", { fileName, bytes })
}

export function setWindowControlsHidden(hidden: boolean) {
  return invoke<void>("set_window_controls_hidden", { hidden })
}

export function setVaultPath(path: string, initializeGit: boolean) {
  return invoke<VaultState>("set_vault_path", { path, initializeGit })
}

export function initializeVaultGit() {
  return invoke<VaultState>("initialize_vault_git")
}

export function setVaultRemote(remoteUrl: string) {
  return invoke<VaultState>("set_vault_remote", { remoteUrl })
}

export function getGithubCliStatus() {
  return invoke<GithubCliInfo>("github_cli_status")
}

export function createGithubVaultRepo(repoName: string) {
  return invoke<VaultState>("create_github_vault_repo", { repoName })
}

export function syncVault() {
  return invoke<GitInfo>("sync_vault")
}
