import { cloneCanvasFile, isCanvasContentEqual, validateCanvasFile, type CanvasFile, type CanvasReadResult } from "./model"

export interface CanvasSaveRequest { path: string; file: CanvasFile; expectedRevision: number; lastSavedHash: string }
export type CanvasSaveTransport = (request: CanvasSaveRequest) => Promise<CanvasReadResult>
export interface CanvasSaveState {
  status: "saved" | "dirty" | "saving" | "error"
  dirty: boolean
  saving: boolean
  error: string | null
}

interface PendingSave { request: CanvasSaveRequest }

export class CanvasSaveQueue {
  private baseline: CanvasReadResult
  private draft: CanvasFile
  private error: string | null = null
  private pending: PendingSave | null = null
  private running: Promise<boolean> | null = null
  private saving = false

  constructor(initial: CanvasReadResult, private readonly transport: CanvasSaveTransport, private readonly onState?: (state: CanvasSaveState) => void) {
    validateCanvasFile(initial.file)
    this.baseline = { ...initial, file: cloneCanvasFile(initial.file) }
    this.draft = cloneCanvasFile(initial.file)
  }

  getDraft(): CanvasFile { return cloneCanvasFile(this.draft) }
  getBaseline(): CanvasReadResult { return { ...this.baseline, file: cloneCanvasFile(this.baseline.file) } }
  getState(): CanvasSaveState {
    const dirty = !isCanvasContentEqual(this.draft, this.baseline.file) || this.pending !== null
    return { status: this.error ? "error" : this.saving ? "saving" : dirty ? "dirty" : "saved", dirty, saving: this.saving, error: this.error }
  }

  update(file: CanvasFile): void {
    validateCanvasFile(file)
    if (file.id !== this.baseline.file.id) throw new Error("保存队列不能跨画布使用。")
    this.draft = { ...cloneCanvasFile(file), createdAt: this.baseline.file.createdAt, revision: this.baseline.file.revision }
    this.emit()
  }

  flush(): Promise<boolean> {
    if (this.running) return this.running
    if (this.error) return Promise.resolve(false)
    if (!this.getState().dirty) return Promise.resolve(true)
    this.saving = true
    // Store the promise before callbacks or transport can enqueue more edits / call flush again.
    this.running = Promise.resolve().then(() => this.drain()).finally(() => {
      this.running = null
      this.saving = false
      this.emit()
    })
    this.emit()
    return this.running
  }

  retry(): Promise<boolean> {
    if (this.running) return this.running
    this.error = null
    return this.flush()
  }

  private async drain(): Promise<boolean> {
    try {
      while (this.pending || !isCanvasContentEqual(this.draft, this.baseline.file)) {
        const pending = this.pending ?? {
          request: {
            path: this.baseline.path,
            file: { ...cloneCanvasFile(this.draft), revision: this.baseline.file.revision, createdAt: this.baseline.file.createdAt },
            expectedRevision: this.baseline.file.revision,
            lastSavedHash: this.baseline.lastSavedHash,
          },
        }
        this.pending = pending
        const result = await this.transport({ ...pending.request, file: cloneCanvasFile(pending.request.file) })
        validateCanvasFile(result.file)
        if (result.path !== this.baseline.path || result.file.id !== this.baseline.file.id || result.file.createdAt !== this.baseline.file.createdAt || result.file.revision !== pending.request.expectedRevision + 1 || !result.lastSavedHash || !isCanvasContentEqual(result.file, pending.request.file)) throw new Error("保存响应与请求内容不一致，草稿已保留。")
        this.baseline = { ...result, file: cloneCanvasFile(result.file) }
        this.pending = null
        // Never replace current content with an older response, including after undo during save.
        this.draft = { ...this.draft, revision: result.file.revision, updatedAt: result.file.updatedAt }
        this.emit()
      }
      return true
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.emit()
      return false
    }
  }

  private emit(): void { this.onState?.(this.getState()) }
}
