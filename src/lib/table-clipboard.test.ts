import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseTableFile, tableContent } from "@/features/tables/model";
import { applyTableMutations } from "@/features/tables/mutations";
import { projectTableView } from "@/features/tables/views";
import { clipboardCellValue, copyTableRectangle, prepareTablePaste } from "@/features/tables/clipboard";

const content = () => tableContent(parseTableFile(readFileSync(new URL("../../tests/fixtures/tables/valid/six-types.json", import.meta.url), "utf8")));
it("paste captures projected record IDs, appends rows once, and leaves input unchanged", () => {
  const source = content(); const viewId = source.viewOrder[0];
  const projection = { ...projectTableView(source, viewId, 4), recordIds: [...source.recordOrder].reverse() };
  const before = structuredClone(source);
  const prepared = prepareTablePaste(source, projection, 0, projection.recordIds.length - 1, [["改名"], ["追加"]]);
  expect(prepared.insertedIds).toHaveLength(1);
  const next = applyTableMutations(source, prepared.operations, "2030-01-01T00:00:00.000Z");
  expect(next.records[projection.recordIds[projection.recordIds.length - 1]].values[source.primaryFieldId]).toBe("改名");
  expect(next.records[prepared.insertedIds[0]].values[source.primaryFieldId]).toBe("追加");
  expect(source).toEqual(before);
});
it("rejects overflowing columns or invalid typed cells before returning any mutation", () => {
  const source = content(); const projection = projectTableView(source, source.viewOrder[0], 0);
  expect(() => prepareTablePaste(source, projection, source.fieldOrder.length - 1, 0, [["x", "y"]])).toThrow("不会自动增加字段");
  const number = source.fieldOrder.find(id => source.fields[id].type === "number")!;
  expect(() => clipboardCellValue(source.fields[number], "00123", "/0/0")).toThrow("前导零");
  expect(() => clipboardCellValue(source.fields[number], "9007199254740993", "/0/0")).toThrow();
  expect(clipboardCellValue(source.fields[number], "0", "/0/0")).toBe(0);
});
it("copy exposes option labels and distinguishes empty text from checkbox false", () => {
  const source = content(); const projection = projectTableView(source, source.viewOrder[0], 0);
  const cells = copyTableRectangle(source, projection, { x: 0, y: 0, width: source.fieldOrder.length, height: 1 });
  expect(cells[0]).toHaveLength(source.fieldOrder.length);
  const select = source.fieldOrder.find(id => source.fields[id].type === "select")!;
  const field = source.fields[select];
  if (field.type !== "select") throw new Error("fixture");
  expect(clipboardCellValue(field, field.options[0].label, "/0/0")).toBe(field.options[0].id);
  const checkbox = source.fieldOrder.find(id => source.fields[id].type === "checkbox")!;
  expect(clipboardCellValue(source.fields[checkbox], "false", "/0/0")).toBe(false);
  expect(clipboardCellValue(source.fields[source.primaryFieldId], "", "/0/0")).toBe("");
});
