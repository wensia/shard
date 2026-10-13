import type { CsvFileSummary, Fragment, LibraryTreeEntry, LibraryTreeSnapshot } from "@/types"

/** 后端 `vault_watch` 推来的一条变化（`src-tauri/src/vault_watch.rs`）。 */
export interface VaultFileChange {
  /** vault 相对路径，`/` 分隔。 */
  path: string
  exists: boolean
  /** 整文件 sha256，与 `Fragment.fileSha` 同算法；目录或已删除时为 null。 */
  sha: string | null
}

/** 数据集编辑器订阅：外部改了它打开的 CSV 时，按聚焦重载的同一规则处理。 */
export const VAULT_FILES_CHANGED_DOM_EVENT = "shard:vault-files-changed"

export interface VaultChangePlan {
  /** 碎片或笔记的内容、增删与内存不一致：静默重读碎片列表。 */
  fragments: boolean
  /** 资料库树结构变了（新增、删除、改名），且树已加载。 */
  libraryTree: boolean
  mindMaps: boolean
  csvFiles: boolean
  /** 内容可能变了的 CSV，交给打开中的数据集编辑器与嵌入预览自行比对重载。 */
  datasets: string[]
}

/**
 * 把一批变化换成要做的刷新。App 自己刚保存的文件 sha 已与内存一致、路径也都已知，
 * 不会触发任何刷新；只有外部写入才会。
 */
export function planVaultChanges(
  changes: VaultFileChange[],
  known: {
    fragments: Fragment[]
    libraryTree: LibraryTreeSnapshot | null
    csvFiles: CsvFileSummary[]
  },
): VaultChangePlan {
  const fragmentShas = new Map(known.fragments.map((fragment) => [fragment.path, fragment.fileSha ?? null]))
  const treePaths = known.libraryTree ? libraryPaths(known.libraryTree.entries) : null
  const csvPaths = new Set(known.csvFiles.map((file) => file.path))
  const plan: VaultChangePlan = { fragments: false, libraryTree: false, mindMaps: false, csvFiles: false, datasets: [] }

  for (const change of changes) {
    const { path, exists } = change
    if (path.endsWith(".md")) {
      const knownSha = fragmentShas.get(path)
      const added = exists && knownSha === undefined
      const removed = !exists && knownSha !== undefined
      if (added || removed || (exists && knownSha !== change.sha)) plan.fragments = true
      // 碎片目录视图按月份计数，新增、删除碎片也会改动资料库树。
      if (added || removed) plan.libraryTree = true
      continue
    }
    if (path.endsWith(".csv")) {
      plan.datasets.push(path)
      if (exists !== csvPaths.has(path)) plan.csvFiles = true
    }
    if (path.startsWith("notes/")) {
      const structural = treePaths !== null && exists !== treePaths.has(path)
      if (structural) plan.libraryTree = true
      if (structural && path.endsWith(".shardmap.json")) plan.mindMaps = true
    }
  }
  if (!known.libraryTree) plan.libraryTree = false
  return plan
}

function libraryPaths(entries: LibraryTreeEntry[], into = new Set<string>()) {
  for (const entry of entries) {
    into.add(entry.path)
    if (entry.children) libraryPaths(entry.children, into)
  }
  return into
}
