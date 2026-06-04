import { invoke } from "@tauri-apps/api/core"

import type { Fragment, GitInfo, VaultState } from "@/types"

export function listFragments() {
  return invoke<VaultState>("list_fragments")
}

export function createFragment(content: string, tags: string[]) {
  return invoke<Fragment>("create_fragment", { content, tags })
}

export function updateFragmentTags(id: string, tags: string[]) {
  return invoke<Fragment>("update_fragment_tags", { id, tags })
}

export function syncVault() {
  return invoke<GitInfo>("sync_vault")
}
