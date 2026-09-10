import { cloneCanvasFile, estimateCanvasMemoryBytes, isCanvasContentEqual, validateCanvasFile, type CanvasFile } from "./model"

interface HistoryEntry { file: CanvasFile; bytes: number }
export interface CanvasChangeMeta { mergeKey?: string }

// Snapshots share no mutable nodes with the UI; the byte budget also bounds large imported maps.
export class CanvasHistory {
  private draft: CanvasFile
  private past: HistoryEntry[] = []
  private future: HistoryEntry[] = []
  private mergeKey: string | undefined
  private lastCommitAt = 0
  private readonly limit: number
  private readonly maxBytes: number

  constructor(file: CanvasFile, options: { limit?: number; maxBytes?: number } = {}) {
    validateCanvasFile(file)
    this.draft = cloneCanvasFile(file)
    this.limit = options.limit ?? 100
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024
  }

  getDraft(): CanvasFile { return cloneCanvasFile(this.draft) }
  canUndo(): boolean { return this.past.length > 0 }
  canRedo(): boolean { return this.future.length > 0 }
  breakMerge(): void { this.mergeKey = undefined }

  commit(next: CanvasFile, meta: CanvasChangeMeta = {}): CanvasFile {
    validateCanvasFile(next)
    if (next.id !== this.draft.id) throw new Error("撤销历史不能跨画布使用。")
    if (isCanvasContentEqual(next, this.draft)) return this.getDraft()
    const now = Date.now()
    if (!meta.mergeKey || meta.mergeKey !== this.mergeKey || now - this.lastCommitAt > 1000 || this.future.length > 0) this.past.push(this.entry(this.draft))
    this.future = []
    this.draft = cloneCanvasFile(next)
    this.mergeKey = meta.mergeKey
    this.lastCommitAt = now
    this.trim()
    return this.getDraft()
  }

  undo(): CanvasFile | null {
    const previous = this.past.pop()
    if (!previous) return null
    this.future.push(this.entry(this.draft))
    this.draft = previous.file
    this.breakMerge()
    this.trim()
    return this.getDraft()
  }

  redo(): CanvasFile | null {
    const next = this.future.pop()
    if (!next) return null
    this.past.push(this.entry(this.draft))
    this.draft = next.file
    this.breakMerge()
    this.trim()
    return this.getDraft()
  }

  reset(file: CanvasFile): void {
    validateCanvasFile(file)
    this.draft = cloneCanvasFile(file)
    this.past = []
    this.future = []
    this.breakMerge()
  }

  private entry(file: CanvasFile): HistoryEntry {
    return { file: cloneCanvasFile(file), bytes: estimateCanvasMemoryBytes(file) }
  }

  private trim(): void {
    let bytes = [...this.past, ...this.future].reduce((total, entry) => total + entry.bytes, 0)
    while (this.past.length + this.future.length > this.limit || bytes > this.maxBytes) {
      const removed = this.past.length ? this.past.shift() : this.future.shift()
      if (!removed) break
      bytes -= removed.bytes
    }
  }
}
