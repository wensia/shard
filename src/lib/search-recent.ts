import type { SearchTarget } from "@/lib/search-contract"

const STORAGE_PREFIX = "shard.recent."
const MAX_RECENT_PER_VAULT = 30

interface StoredRecentEntry {
  key: string
  openedAt: number
}

type RecentStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">

export function readPublicOpenRecent(vaultPath: string): ReadonlyMap<string, number> {
  const storage = getStorage()
  if (!storage) return new Map()

  try {
    const raw = storage.getItem(storageKey(vaultPath))
    if (!raw) return new Map()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Map()

    const entries = parsed
      .filter((entry): entry is StoredRecentEntry => isStoredEntry(entry, vaultPath))
      .sort((left, right) => right.openedAt - left.openedAt)
      .slice(0, MAX_RECENT_PER_VAULT)
    return new Map(entries.map(({ key, openedAt }) => [key, openedAt]))
  } catch {
    return new Map()
  }
}

/** Call only after navigation has reported a successful public open. */
export function recordPublicOpen(target: SearchTarget, openedAt: number): void {
  if (target.scope !== "public" || !Number.isFinite(openedAt)) return
  const storage = getStorage()
  if (!storage) return

  try {
    const entries = Array.from(readPublicOpenRecent(target.vaultPath), ([key, at]) => ({
      key,
      openedAt: at,
    })).filter(({ key }) => key !== target.key)
    entries.unshift({ key: target.key, openedAt })
    storage.setItem(
      storageKey(target.vaultPath),
      JSON.stringify(entries.slice(0, MAX_RECENT_PER_VAULT))
    )
  } catch {
    // Recent is best-effort and must never turn a successful open into failure.
  }
}

/** Remove the old public key after delete or a move into the lockbox. */
export function removePublicOpen(vaultPath: string, targetKey: string): void {
  const storage = getStorage()
  if (!storage) return

  try {
    const entries = Array.from(readPublicOpenRecent(vaultPath), ([key, openedAt]) => ({
      key,
      openedAt,
    })).filter(({ key }) => key !== targetKey)
    if (entries.length === 0) {
      storage.removeItem(storageKey(vaultPath))
    } else {
      storage.setItem(storageKey(vaultPath), JSON.stringify(entries))
    }
  } catch {
    // Cleanup is best-effort for the same reason as recording.
  }
}

function isStoredEntry(value: unknown, vaultPath: string): value is StoredRecentEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Partial<StoredRecentEntry>
  return (
    typeof entry.key === "string" &&
    typeof entry.openedAt === "number" &&
    Number.isFinite(entry.openedAt) &&
    isPublicKeyForVault(entry.key, vaultPath)
  )
}

function isPublicKeyForVault(key: string, vaultPath: string) {
  try {
    const identity: unknown = JSON.parse(key)
    return (
      Array.isArray(identity) &&
      identity.length === 3 &&
      identity[0] === vaultPath &&
      identity[1] === "public" &&
      typeof identity[2] === "string"
    )
  } catch {
    return false
  }
}

function storageKey(vaultPath: string) {
  return `${STORAGE_PREFIX}${vaultPath}`
}

function getStorage(): RecentStorage | null {
  try {
    return typeof globalThis.localStorage === "undefined"
      ? null
      : globalThis.localStorage
  } catch {
    return null
  }
}
