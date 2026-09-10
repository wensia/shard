import { TABLE_LIMITS, TableValidationError, businessSnapshot, canonicalJson, createTableId, laterTimestamp, objectShape,
  tableAssert, tableContent, validateField, validateHash, validateId, validateRevision, validateTableContent, validateTableFile, validateTimestamp, validateView,
  type MutationId, type TableContent, type TableError, type TableReadResult, type Timestamp } from "./model"
import { assertPreparedTableChange, createOwnedTableContent, ownedTableTimestamp, prepareTableMutations, replaceOwnedTableRecords,
  type ApplyTableMutationsRequest, type ApplyTableMutationsResult, type PreparedTableChange, type TableMutation } from "./mutations"

export type TableSaveTransport = {
  apply(request: ApplyTableMutationsRequest): Promise<ApplyTableMutationsResult>
  read(request: { path: string; expectedTableId: string }): Promise<TableReadResult>
}
export type TableSaveStatus = "saved" | "dirty" | "saving" | "checking" | "error" | "conflict"
export type TableSaveState = { status: TableSaveStatus; generation: number; savedGeneration: number; dirty: boolean; pendingCount: number; error: unknown }
export type TableSaveBaseline = { tableId: string; path: string; revision: number; contentHash: string; updatedAt: Timestamp; content: TableContent }
type PendingGesture = { generation: number; mutationId: MutationId; operations: TableMutation[]; prepared: PreparedTableChange; request?: ApplyTableMutationsRequest; expected?: TableContent; needsRead?: boolean }
type QueueOptions = { now?: () => Timestamp; mutationId?: () => MutationId }
const KNOWN_UNWRITTEN = new Set(["INVALID_JSON", "DUPLICATE_KEY", "UNSUPPORTED_VERSION", "INVALID_MODEL", "INVALID_VALUE", "INVALID_FILTER",
  "LIMIT_EXCEEDED", "INVALID_PATH", "NOT_FOUND", "TARGET_IN_TRASH", "IDENTITY_MISMATCH", "DUPLICATE_TABLE_ID", "STALE_BASE", "IDEMPOTENCY_CONFLICT", "GIT_BUSY"])
const CONFLICT_CODES = new Set(["STALE_BASE", "IDENTITY_MISMATCH", "DUPLICATE_TABLE_ID", "IDEMPOTENCY_CONFLICT", "NOT_FOUND", "TARGET_IN_TRASH"])
function errorCode(error: unknown): string | undefined { return error !== null && typeof error === "object" && typeof (error as TableError).code === "string" ? (error as TableError).code : undefined }

function readBaseline(result: TableReadResult): TableSaveBaseline {
  objectShape(result, "", ["file", "path", "title", "revision", "contentHash"]); validateTableFile(result.file)
  validateHash(result.contentHash, "/contentHash"); tableAssert(result.revision === result.file.revision, "/revision")
  tableAssert(typeof result.path === "string" && result.path.length > 0 && typeof result.title === "string", "/path")
  return { tableId: result.file.id, path: result.path, revision: result.revision, contentHash: result.contentHash, updatedAt: result.file.updatedAt, content: createOwnedTableContent(tableContent(result.file)) }
}
function resultBaseline(base: TableSaveBaseline, request: ApplyTableMutationsRequest, result: ApplyTableMutationsResult, expected: TableContent): TableSaveBaseline {
  objectShape(result, "", ["tableId", "path", "mutationId", "baseRevision", "revision", "contentHash", "updatedAt", "changedRecords", "deletedRecordIds",
    "changedFields", "deletedFieldIds", "changedViews", "deletedViewIds", "fieldOrder", "recordOrder", "viewOrder"], ["fieldOrder", "recordOrder", "viewOrder"])
  tableAssert(result.tableId === request.tableId && result.mutationId === request.mutationId && result.baseRevision === request.expectedRevision && result.revision === request.expectedRevision + 1, "", "保存响应身份或版本不一致")
  validateRevision(result.revision, "/revision"); validateHash(result.contentHash, "/contentHash"); validateTimestamp(result.updatedAt, "/updatedAt")
  tableAssert(typeof result.path === "string" && result.path.length > 0, "/path")
  if (request.operations.every(operation => operation.type === "setCells")) {
    for (const value of [result.changedRecords, result.deletedRecordIds, result.changedFields, result.deletedFieldIds, result.changedViews, result.deletedViewIds])
      tableAssert(Array.isArray(value), "", "保存响应缺少完整变化集合")
    tableAssert(result.deletedRecordIds.length === 0 && result.deletedFieldIds.length === 0 && result.deletedViewIds.length === 0, "", "单元格保存响应包含意外删除")
    const content = replaceOwnedTableRecords(base.content, result.changedRecords)
    const returned = new Set(result.changedRecords.map(record => record.id))
    for (const id of returned) tableAssert(canonicalJson(content.records[id].values) === canonicalJson(expected.records[id]?.values), "", "保存响应包含非预期记录内容")
    const touched = new Set(request.operations.flatMap(operation => operation.type === "setCells" ? operation.cells.map(cell => cell.recordId) : []))
    for (const id of touched) {
      if (canonicalJson(base.content.records[id].values) !== canonicalJson(expected.records[id].values))
        tableAssert(returned.has(id), "", "保存响应未包含全部预期业务变化")
    }
    const fields = new Set<string>(); const views = new Set<string>()
    for (const field of result.changedFields) {
      validateField(field); tableAssert(!fields.has(field.id) && canonicalJson(field) === canonicalJson(expected.fields[field.id]), "", "保存响应包含非预期字段变化")
      fields.add(field.id)
    }
    for (const view of result.changedViews) {
      validateView(view, expected); tableAssert(!views.has(view.id) && canonicalJson(view) === canonicalJson(expected.views[view.id]), "", "保存响应包含非预期视图变化")
      views.add(view.id)
    }
    for (const key of ["fieldOrder", "recordOrder", "viewOrder"] as const) if (result[key] !== undefined)
      tableAssert(canonicalJson(result[key]) === canonicalJson(expected[key]), "", "保存响应包含非预期顺序变化")
    return { tableId: base.tableId, path: result.path, revision: result.revision, contentHash: result.contentHash, updatedAt: result.updatedAt, content }
  }
  const content = structuredClone(base.content)
  function patch<T extends { id: string }>(map: Record<string, T>, changes: T[], deletions: string[], prefix: string) {
    tableAssert(Array.isArray(changes) && Array.isArray(deletions), "", "保存响应缺少完整变化集合")
    const seen = new Set<string>()
    for (const id of deletions) { validateId(id, prefix, ""); tableAssert(!seen.has(id), "", "保存响应包含重复 ID"); seen.add(id); delete map[id] }
    for (const value of changes) { objectShape(value, ""); validateId(value.id, prefix, ""); tableAssert(!seen.has(value.id), "", "保存响应包含重复 ID"); seen.add(value.id); map[value.id] = structuredClone(value) }
  }
  patch(content.records, result.changedRecords, result.deletedRecordIds, "rec")
  patch(content.fields, result.changedFields, result.deletedFieldIds, "fld")
  patch(content.views, result.changedViews, result.deletedViewIds, "view")
  if (result.fieldOrder !== undefined) content.fieldOrder = [...result.fieldOrder]
  if (result.recordOrder !== undefined) content.recordOrder = [...result.recordOrder]
  if (result.viewOrder !== undefined) content.viewOrder = [...result.viewOrder]
  validateTableContent(content)
  tableAssert(businessSnapshot(content) === businessSnapshot(expected), "", "保存响应未包含全部预期业务变化")
  return { tableId: base.tableId, path: result.path, revision: result.revision, contentHash: result.contentHash, updatedAt: result.updatedAt, content: createOwnedTableContent(content) }
}

// One queue per table, owned by the table Worker. UI chooses its debounce and calls flush at navigation/save gates.
// No independent timers, automatic background retries, or implicit external-version acceptance.
export class TableSaveQueue {
  private baseline: TableSaveBaseline
  private draft: TableContent
  private pending: PendingGesture[] = []
  private generation = 0
  private savedGeneration = 0
  private status: TableSaveStatus = "saved"
  private error: unknown = null
  private running: Promise<TableSaveState> | null = null
  private readonly now: () => Timestamp
  private readonly mutationId: () => MutationId
  constructor(initial: TableReadResult, private readonly transport: TableSaveTransport, options: QueueOptions = {}) {
    this.baseline = readBaseline(initial); this.draft = this.baseline.content
    this.now = options.now ?? (() => new Date().toISOString()); this.mutationId = options.mutationId ?? (() => createTableId("mut"))
  }
  getState(): TableSaveState { return { status: this.status, generation: this.generation, savedGeneration: this.savedGeneration, dirty: this.pending.length > 0, pendingCount: this.pending.length, error: this.error } }
  getDraft(): TableContent { return structuredClone(this.draft) }
  // Worker-only borrowed snapshot. Recursive freezing prevents callers from altering queue state.
  peekDraft(): TableContent { return this.draft }
  getBaseline(): TableSaveBaseline { return structuredClone(this.baseline) }
  getIdentity(): Omit<TableSaveBaseline, "content"> { const { content: _content, ...identity } = this.baseline; return identity }
  private timestamp(content: TableContent): Timestamp {
    let timestamp = this.now(); validateTimestamp(timestamp, "/updatedAt")
    timestamp = laterTimestamp(timestamp, this.baseline.updatedAt)
    return laterTimestamp(timestamp, ownedTableTimestamp(content))
  }
  enqueue(operations: readonly TableMutation[]): number {
    if (operations.length === 0) return this.generation
    return this.enqueuePrepared(prepareTableMutations(this.draft, operations, this.timestamp(this.draft)))
  }
  enqueuePrepared(change: PreparedTableChange): number {
    assertPreparedTableChange(change, this.draft)
    if (!change.changed) return this.generation
    const mutationId = this.mutationId(); validateId(mutationId, "mut", "/mutationId")
    tableAssert(!this.pending.some(item => item.mutationId === mutationId), "/mutationId", "修改 ID 重复")
    this.generation++; this.pending.push({ generation: this.generation, mutationId, operations: structuredClone(change.operations) as TableMutation[], prepared: change }); this.draft = change.content
    if (this.status === "saved" || this.status === "dirty") this.status = "dirty"
    return this.generation
  }
  flush(): Promise<TableSaveState> {
    if (this.running) return this.running
    if (this.status === "conflict") return Promise.reject(this.error)
    if (this.pending.length === 0) return Promise.resolve(this.getState())
    this.running = this.drain().finally(() => { this.running = null })
    return this.running
  }
  private async drain(): Promise<TableSaveState> {
    this.error = null
    try {
      while (this.pending.length) await this.save(this.pending[0])
      this.status = "saved"; return this.getState()
    } catch (error) {
      this.error = error; this.status = CONFLICT_CODES.has(errorCode(error) ?? "") ? "conflict" : "error"
      throw error
    }
  }
  private accept(base: TableSaveBaseline, gesture: PendingGesture) {
    // Replay only gestures not covered by this response, retaining edits made while IPC was pending.
    let draft = base.content
    for (const pending of this.pending.slice(1)) {
      pending.prepared = prepareTableMutations(draft, pending.operations, this.timestamp(draft)); draft = pending.prepared.content
    }
    this.baseline = base; this.draft = draft; this.savedGeneration = gesture.generation; this.pending.shift()
  }
  private async recover(gesture: PendingGesture): Promise<boolean> {
    const request = gesture.request!
    this.status = "checking"
    const read = await this.transport.read({ path: request.path, expectedTableId: request.tableId })
    const base = readBaseline(read)
    if (base.tableId !== request.tableId) throw new TableValidationError("IDENTITY_MISMATCH", "读取结果属于其他数据表")
    if (read.file.lastMutationId === request.mutationId) {
      if (read.file.lastMutationHash !== null && base.revision > request.expectedRevision && businessSnapshot(base.content) === businessSnapshot(gesture.expected!)) {
        this.accept(base, gesture); return true
      }
      throw new TableValidationError("STALE_BASE", "修改标识匹配，但磁盘完整业务内容与本次保存不同；已保留草稿")
    }
    if (base.revision !== request.expectedRevision || base.contentHash !== request.expectedHash || businessSnapshot(base.content) !== businessSnapshot(this.baseline.content))
      throw new TableValidationError("STALE_BASE", "磁盘已发生其他修改；已保留草稿")
    gesture.needsRead = false
    return false
  }
  private async save(gesture: PendingGesture) {
    if (!gesture.request) {
      const request = { path: this.baseline.path, tableId: this.baseline.tableId, expectedRevision: this.baseline.revision,
        expectedHash: this.baseline.contentHash, mutationId: gesture.mutationId, operations: structuredClone(gesture.operations) }
      tableAssert(new TextEncoder().encode(JSON.stringify(request)).byteLength <= TABLE_LIMITS.mutationBytes, "", "修改请求超过容量限制", "LIMIT_EXCEEDED")
      gesture.expected = gesture.prepared.source === this.baseline.content ? gesture.prepared.content
        : prepareTableMutations(this.baseline.content, gesture.operations, this.timestamp(this.baseline.content)).content
      gesture.request = request
    }
    const request = gesture.request
    if (gesture.needsRead && await this.recover(gesture)) return
    // At most one immediate retry, and only after reading the unchanged original byte hash/revision.
    for (let attempt = 0; attempt < 2; attempt++) {
      this.status = "saving"
      let receivedResponse = false
      try {
        const result = await this.transport.apply(structuredClone(request))
        receivedResponse = true
        this.accept(resultBaseline(this.baseline, request, result, gesture.expected!), gesture)
        return
      } catch (error) {
        if (!receivedResponse && KNOWN_UNWRITTEN.has(errorCode(error) ?? "")) throw error
        gesture.needsRead = true
        if (await this.recover(gesture)) return
        if (attempt === 1) throw error
      }
    }
  }
  // Caller must present the explicit discard/accept-external action and clear TableHistory alongside it.
  acceptExternal(result: TableReadResult) {
    tableAssert(this.running === null, "", "保存或结果核对期间不能替换基线")
    const baseline = readBaseline(result); tableAssert(baseline.tableId === this.baseline.tableId, "/id", "不能切换为另一张表", "IDENTITY_MISMATCH")
    this.baseline = baseline; this.draft = baseline.content; this.pending = []
    this.generation++; this.savedGeneration = this.generation; this.status = "saved"; this.error = null
  }
}
