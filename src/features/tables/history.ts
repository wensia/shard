import { businessSnapshot, type TableContent, type Timestamp } from "./model"
import { applyTableMutations, prepareTableMutations, restorationMutations, validateMutationBatch, type PreparedTableChange, type TableMutation } from "./mutations"

type HistoryEntry = { forward: TableMutation[]; inverse: TableMutation[]; bytes: number }
export type HistoryChange = { content: TableContent; operations: TableMutation[] }

// Stores reversible domain deltas, never entire table files or stale save baselines.
export class TableHistory {
  private undoEntries: HistoryEntry[] = []
  private redoEntries: HistoryEntry[] = []
  constructor(private readonly maxEntries = 50, private readonly maxBytes = 32 * 1024 * 1024) {}
  get canUndo() { return this.undoEntries.length > 0 }
  get canRedo() { return this.redoEntries.length > 0 }
  clear() { this.undoEntries = []; this.redoEntries = [] }

  applyPrepared(content: TableContent, operations: readonly TableMutation[], timestamp: Timestamp, accept?: (change: PreparedTableChange) => void): PreparedTableChange {
    const change = prepareTableMutations(content, operations, timestamp)
    if (!change.changed) return change
    const inverse = structuredClone(change.inverse) as TableMutation[]
    const forward = structuredClone(change.operations) as TableMutation[]
    for (const operation of forward) if (operation.type === "insertRecords") for (const record of operation.records) {
      if (record.createdAt === undefined) record.createdAt = change.content.records[record.id]?.createdAt
    }
    validateMutationBatch(inverse); validateMutationBatch(forward)
    const entry = { inverse, forward, bytes: new TextEncoder().encode(JSON.stringify({ inverse, forward })).byteLength }
    accept?.(change)
    this.undoEntries.push(entry); this.redoEntries = []
    let bytes = this.undoEntries.reduce((sum, item) => sum + item.bytes, 0)
    while (this.undoEntries.length > 1 && (this.undoEntries.length > this.maxEntries || bytes > this.maxBytes)) bytes -= this.undoEntries.shift()!.bytes
    return change
  }
  undoPrepared(content: TableContent, timestamp: Timestamp, accept?: (change: PreparedTableChange) => void): PreparedTableChange | null {
    const entry = this.undoEntries[this.undoEntries.length - 1]; if (!entry) return null
    const change = prepareTableMutations(content, entry.inverse, timestamp)
    accept?.(change); this.undoEntries.pop(); this.redoEntries.push(entry); return change
  }
  redoPrepared(content: TableContent, timestamp: Timestamp, accept?: (change: PreparedTableChange) => void): PreparedTableChange | null {
    const entry = this.redoEntries[this.redoEntries.length - 1]; if (!entry) return null
    const change = prepareTableMutations(content, entry.forward, timestamp)
    accept?.(change); this.redoEntries.pop(); this.undoEntries.push(entry); return change
  }

  apply(content: TableContent, operations: readonly TableMutation[], timestamp: Timestamp, accept?: (change: HistoryChange) => void): HistoryChange {
    const next = applyTableMutations(content, operations, timestamp)
    if (businessSnapshot(content) === businessSnapshot(next)) return { content, operations: [] }
    const inverse = restorationMutations(next, content)
    const forward = structuredClone(operations) as TableMutation[]
    for (const operation of forward) if (operation.type === "insertRecords") for (const record of operation.records) {
      if (record.createdAt === undefined && next.records[record.id]) record.createdAt = next.records[record.id].createdAt
    }
    // A gesture must remain representable as a single atomic request in both directions.
    validateMutationBatch(inverse); validateMutationBatch(forward)
    const entry = { inverse, forward, bytes: new TextEncoder().encode(JSON.stringify({ inverse, forward })).byteLength }
    const change = { content: next, operations: structuredClone(operations) as TableMutation[] }
    accept?.(change)
    this.undoEntries.push(entry); this.redoEntries = []
    let bytes = this.undoEntries.reduce((sum, item) => sum + item.bytes, 0)
    while (this.undoEntries.length > 1 && (this.undoEntries.length > this.maxEntries || bytes > this.maxBytes)) bytes -= this.undoEntries.shift()!.bytes
    return change
  }
  undo(content: TableContent, timestamp: Timestamp, accept?: (change: HistoryChange) => void): HistoryChange | null {
    const entry = this.undoEntries[this.undoEntries.length - 1]; if (!entry) return null
    const next = applyTableMutations(content, entry.inverse, timestamp)
    const change = { content: next, operations: structuredClone(entry.inverse) }
    accept?.(change)
    this.undoEntries.pop(); this.redoEntries.push(entry)
    return change
  }
  redo(content: TableContent, timestamp: Timestamp, accept?: (change: HistoryChange) => void): HistoryChange | null {
    const entry = this.redoEntries[this.redoEntries.length - 1]; if (!entry) return null
    const next = applyTableMutations(content, entry.forward, timestamp)
    const change = { content: next, operations: structuredClone(entry.forward) }
    accept?.(change)
    this.redoEntries.pop(); this.undoEntries.push(entry)
    return change
  }
}
