import { describe, expect, it } from "vitest"

import cases from "../../tests/fixtures/datasets/ops-cases.json"
import { applyDatasetOps, DatasetOpError, invertDatasetOps, newRowId } from "@/features/datasets/ops"
import type { CsvTable, DatasetOp, DatasetSchema } from "@/features/datasets/types"

describe("dataset operations", () => {
  it.each(cases.cases)("matches Rust fixture: $id", ({ table, schema, ops, expected, error }) => {
    const run = () => applyDatasetOps(table, schema, ops as DatasetOp[])
    if (error) {
      expect(run).toThrowError(DatasetOpError)
      try { run() } catch (caught) { expect((caught as DatasetOpError).code).toBe(error) }
    } else {
      expect(run()).toEqual(expected)
      expect(applyDatasetOps(run(), schema, invertDatasetOps(table, ops as DatasetOp[]))).toEqual(table)
    }
  })

  it("covers all six operations and ordered indices", () => {
    const before: CsvTable = { header: ["a", "b"], rows: [["1", "2"], ["3", "4"]] }
    const ops: DatasetOp[] = [
      { op: "insertRows", at: 1, rows: [["5", "6"]] },
      { op: "deleteRows", rows: [0] },
      { op: "insertColumn", at: 1, name: "c" },
      { op: "setCells", cells: [{ row: 0, column: 1, value: "新" }] },
      { op: "renameColumn", column: 2, name: "d" },
      { op: "deleteColumn", column: 0 },
    ]
    const after = applyDatasetOps(before, null, ops)
    expect(after).toEqual({ header: ["c", "d"], rows: [["新", "6"], ["", "4"]] })
    expect(applyDatasetOps(after, null, invertDatasetOps(before, ops))).toEqual(before)
    expect(before).toEqual({ header: ["a", "b"], rows: [["1", "2"], ["3", "4"]] })
  })

  it("protects primary key but permits unchanged values", () => {
    const table: CsvTable = { header: ["id", "value"], rows: [["one", "x"]] }
    const schema: DatasetSchema = { schemaVersion: 1, datasetId: "ds_00000000000000000000000000000001", title: "x", primaryKey: "id" }
    expect(applyDatasetOps(table, schema, [{ op: "setCells", cells: [{ row: 0, column: 0, value: "one" }] }])).toEqual(table)
    for (const op of [
      { op: "renameColumn", column: 0, name: "other" },
      { op: "deleteColumn", column: 0 },
      { op: "insertRows", at: 1, rows: [["", "y"]] },
    ] as DatasetOp[]) {
      expect(() => applyDatasetOps(table, schema, [op])).toThrowError(DatasetOpError)
    }
  })

  it("enforces operation, cell and table limits", () => {
    const table: CsvTable = { header: ["x"], rows: [["a"]] }
    expect(() => applyDatasetOps(table, null, Array.from({ length: 65 }, () => ({ op: "deleteRows", rows: [] })))).toThrow("LIMIT_EXCEEDED")
    expect(() => applyDatasetOps(table, null, [{ op: "setCells", cells: [{ row: 0, column: 0, value: "a".repeat(16_385) }] }])).toThrow("LIMIT_EXCEEDED")
    expect(() => applyDatasetOps(table, null, [{ op: "insertRows", at: 1, rows: Array.from({ length: 10_000 }, () => ["x"]) }])).toThrow("LIMIT_EXCEEDED")
  })

  it("rebuilds rows when a sparse delete needs more than 64 inverse inserts", () => {
    const before: CsvTable = { header: ["value"], rows: Array.from({ length: 200 }, (_, index) => [`${index}`]) }
    const ops: DatasetOp[] = [{ op: "deleteRows", rows: Array.from({ length: 100 }, (_, index) => index * 2) }]
    const after = applyDatasetOps(before, null, ops)
    const inverse = invertDatasetOps(before, ops)
    expect(inverse).toHaveLength(2)
    expect(applyDatasetOps(after, null, inverse)).toEqual(before)
  })

  it("round trips 200 deterministic small batches", () => {
    let seed = 0x12345678
    const random = (size: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % size
    }
    for (let trial = 0; trial < 200; trial++) {
      const before: CsvTable = {
        header: ["a", "b", "c"],
        rows: Array.from({ length: 1 + random(5) }, (_, row) => [`${row}`, "中", `v${row}`]),
      }
      let current = before
      const ops: DatasetOp[] = []
      for (let step = 0; step < 5; step++) {
        const choice = random(6)
        const op: DatasetOp = choice === 0 && current.rows.length > 0
          ? { op: "setCells", cells: [{ row: random(current.rows.length), column: random(current.header.length), value: `v${trial}-${step}` }] }
          : choice === 1
            ? { op: "insertRows", at: random(current.rows.length + 1), rows: [current.header.map((_, column) => `n${column}`)] }
            : choice === 2 && current.rows.length > 0
              ? { op: "deleteRows", rows: [random(current.rows.length)] }
              : choice === 3
                ? { op: "insertColumn", at: random(current.header.length + 1), name: `col${trial}-${step}` }
                : choice === 4
                  ? { op: "renameColumn", column: random(current.header.length), name: `renamed${trial}-${step}` }
                  : { op: "deleteColumn", column: random(current.header.length) }
        if (op.op === "deleteColumn" && current.header.length === 1) continue
        current = applyDatasetOps(current, null, [op])
        ops.push(op)
      }
      expect(applyDatasetOps(before, null, ops)).toEqual(current)
      expect(applyDatasetOps(current, null, invertDatasetOps(before, ops))).toEqual(before)
    }
  })

  it("generates 12 lowercase hex digits", () => {
    expect(newRowId()).toMatch(/^r_[0-9a-f]{12}$/u)
  })
})
