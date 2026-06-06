export type FragmentStatus =
  | "saved"
  | "committed"
  | "sync_pending"
  | "commit_failed"

export type FragmentFilter = "inbox" | "tagged" | "ai" | "archive"

export interface Fragment {
  id: string
  content: string
  createdAt: string
  updatedAt: string
  tags: string[]
  category: string | null
  path: string
  gitStatus: FragmentStatus
  error: string | null
  aiStatus?: "none" | "pending" | "suggested" | "accepted" | "skipped"
  archived: boolean
}

export interface GitInfo {
  branch: string
  shortCommit: string
  hasRemote: boolean
  status: "ready" | "no_git" | "dirty" | "syncing" | "error"
  error: string | null
}

export interface GithubCliInfo {
  installed: boolean
  authenticated: boolean
  login: string | null
  protocol: string | null
  error: string | null
}

export interface VaultState {
  vaultPath: string
  fragments: Fragment[]
  git: GitInfo
}
