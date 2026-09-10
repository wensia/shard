// Rectangle traversal and text conversion run only inside the table Worker.
import { createTableId, isDateOnly, TABLE_LIMITS, tableAssert, validateCellValue, type CellValue, type TableContent, type TableField } from "./model";
import type { CellEdit, TableMutation } from "./mutations";
import type { TableProjection } from "./views";
import type { TableCopyCell } from "./worker-protocol";

export type TableRectangle = { x: number; y: number; width: number; height: number };
function fieldsFor(content: TableContent, projection: TableProjection) {
  const view = content.views[projection.viewId]; const hidden = new Set(view.hiddenFieldIds);
  return view.fieldOrder.filter(id => !hidden.has(id));
}
function checkRectangle(rectangle: TableRectangle, columns: number, rows: number, addRows = false) {
  const { x, y, width, height } = rectangle;
  tableAssert([x, y, width, height].every(Number.isSafeInteger) && x >= 0 && y >= 0 && width > 0 && height > 0, "/selection", "选区无效");
  tableAssert(x + width <= columns && y <= rows && (addRows || y + height <= rows), "/selection", "选区超出当前视图；粘贴不会自动增加字段");
}
function optionFromLabel(field: Extract<TableField, { type: "select" | "multiSelect" }>, label: string, pointer: string) {
  const matches = field.options.filter(option => option.label === label);
  tableAssert(matches.length === 1, pointer, matches.length ? "选项名称重复，请在单元格中明确选择" : `选项「${label}」不存在`, "INVALID_VALUE");
  return matches[0].id;
}
export function clipboardCellValue(field: TableField, raw: string, pointer: string): CellValue {
  let value: CellValue = raw;
  if (field.type !== "text" && raw === "") return null;
  const trimmed = raw.trim();
  switch (field.type) {
    case "text": break;
    case "number":
      tableAssert(/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed), pointer, "数值无效；带前导零的编号请保留为文本", "INVALID_VALUE");
      value = Number(trimmed); break;
    case "date": tableAssert(isDateOnly(trimmed), pointer, "日期需要 YYYY-MM-DD", "INVALID_VALUE"); value = trimmed; break;
    case "checkbox": tableAssert(/^(true|false|1|0)$/i.test(trimmed), pointer, "复选框只接受 true、false、1 或 0", "INVALID_VALUE"); value = /^(true|1)$/i.test(trimmed); break;
    case "select": value = optionFromLabel(field, raw, pointer); break;
    case "multiSelect": {
      let labels: unknown;
      try { labels = JSON.parse(raw); } catch { tableAssert(false, pointer, '多选使用标签 JSON 数组，例如 ["甲","乙"]', "INVALID_VALUE"); }
      tableAssert(Array.isArray(labels) && labels.every(label => typeof label === "string"), pointer, "多选需要标签数组", "INVALID_VALUE");
      value = labels.map(label => optionFromLabel(field, label, pointer)); break;
    }
  }
  validateCellValue(field, value, pointer); return value;
}
export function clipboardCellText(field: TableField, value: CellValue | undefined): string {
  if (value == null) return "";
  if (field.type === "select") return field.options.find(option => option.id === value)!.label;
  if (field.type === "multiSelect") return JSON.stringify(field.options.filter(option => (value as string[]).includes(option.id)).map(option => option.label));
  return String(value);
}
export function prepareTablePaste(content: TableContent, projection: TableProjection, column: number, row: number, values: string[][]): { operations: TableMutation[]; insertedIds: string[] } {
  tableAssert(Array.isArray(values) && values.length > 0 && values.every(line => Array.isArray(line) && line.every(value => typeof value === "string")), "/values", "粘贴内容无效");
  const width = values[0].length;
  tableAssert(values.every(line => line.length === width), "/values", "粘贴内容必须是矩形选区");
  tableAssert(values.length * width <= TABLE_LIMITS.mutationCells, "/values", "一次粘贴最多 50000 个单元格", "LIMIT_EXCEEDED");
  const fields = fieldsFor(content, projection);
  checkRectangle({ x: column, y: row, width, height: values.length }, fields.length, projection.recordIds.length, true);
  const insertedIds = Array.from({ length: Math.max(0, row + values.length - projection.recordIds.length) }, () => createTableId("rec"));
  tableAssert(content.recordOrder.length + insertedIds.length <= TABLE_LIMITS.rows, "/values", "新增记录超过容量", "LIMIT_EXCEEDED");
  const targetIds = [...projection.recordIds, ...insertedIds]; const cells: CellEdit[] = [];
  values.forEach((line, dy) => line.forEach((raw, dx) => {
    const fieldId = fields[column + dx];
    cells.push({ recordId: targetIds[row + dy], fieldId, value: clipboardCellValue(content.fields[fieldId], raw, `/values/${dy}/${dx}`) });
  }));
  return { insertedIds, operations: [
    ...(insertedIds.length ? [{ type: "insertRecords" as const, records: insertedIds.map(id => ({ id, values: {} })), beforeRecordId: null }] : []),
    { type: "setCells", cells },
  ] };
}
export function copyTableRectangle(content: TableContent, projection: TableProjection, rectangle: TableRectangle): TableCopyCell[][] {
  const fields = fieldsFor(content, projection); checkRectangle(rectangle, fields.length, projection.recordIds.length);
  return Array.from({ length: rectangle.height }, (_, dy) => Array.from({ length: rectangle.width }, (_, dx) => {
    const field = content.fields[fields[rectangle.x + dx]];
    const data = clipboardCellText(field, content.records[projection.recordIds[rectangle.y + dy]].values[field.id]);
    return { kind: "text", data, displayData: data, allowOverlay: false };
  }));
}
export function clearTableRectangle(content: TableContent, projection: TableProjection, rectangle: TableRectangle): TableMutation[] {
  const fields = fieldsFor(content, projection); checkRectangle(rectangle, fields.length, projection.recordIds.length);
  tableAssert(rectangle.width * rectangle.height <= TABLE_LIMITS.mutationCells, "/selection", "一次清空最多 50000 个单元格", "LIMIT_EXCEEDED");
  const cells: CellEdit[] = [];
  for (let dy = 0; dy < rectangle.height; dy++) for (let dx = 0; dx < rectangle.width; dx++) cells.push({ recordId: projection.recordIds[rectangle.y + dy], fieldId: fields[rectangle.x + dx], value: null });
  return [{ type: "setCells", cells }];
}
