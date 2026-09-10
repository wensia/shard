import { createTableId, TABLE_LIMITS, type TableContent, type TableField, type TableView } from "./model";

export type TableConfigInitialAction = "newField" | "deleteField" | "filterField";
export type TableFieldMenuAction = "edit" | "sortAsc" | "sortDesc" | "filter" | "group" | "ungroup" | "moveLeft" | "moveRight" | "hide" | "delete";

/** Drafts contain metadata only. Opening a shortcut never mutates table data. */
export function createTableConfigDraft(metadata: Omit<TableContent, "records">, viewId: string, initialFieldId?: string, initialAction?: TableConfigInitialAction) {
  const fields = metadata.fieldOrder.map(id => structuredClone(metadata.fields[id]));
  const view = structuredClone(metadata.views[viewId]);
  let selectedId = initialFieldId && metadata.fields[initialFieldId] ? initialFieldId : metadata.primaryFieldId;
  let problem = "";
  if (initialAction === "newField") {
    if (fields.length >= TABLE_LIMITS.fields) problem = "字段数量已达上限，请先整理现有字段。";
    else {
      const field: TableField = { id: createTableId("fld"), name: "新字段", type: "text" };
      fields.push(field); selectedId = field.id;
    }
  }
  if (initialAction === "filterField" && !view.filters.conditions.some(condition => condition.fieldId === selectedId)) {
    if (view.filters.conditions.length >= TABLE_LIMITS.filters) problem = "筛选条件已达上限，请先移除不再需要的条件。";
    else view.filters.conditions.push({ fieldId: selectedId, operator: "isNotEmpty" });
  }
  const confirmDelete = initialAction === "deleteField" && selectedId !== metadata.primaryFieldId ? selectedId : "";
  return { fields, view, selectedId, confirmDelete, problem };
}

/** Column shortcuts alter only the active view and retain hidden-column positions. */
export function tableFieldMenuViewChange(view: TableView, field: TableField, primaryFieldId: string, action: TableFieldMenuAction): TableView | null {
  if (!view.fieldOrder.includes(field.id)) return null;
  if (action === "sortAsc" || action === "sortDesc") {
    const remaining = view.sorts.filter(sort => sort.fieldId !== field.id);
    if (remaining.length >= TABLE_LIMITS.sorts) return null;
    return { ...view, sorts: [{ fieldId: field.id, direction: action === "sortAsc" ? "asc" : "desc" }, ...remaining] };
  }
  if (action === "group") return field.type === "multiSelect" ? null : { ...view, groupBy: field.id };
  if (action === "ungroup") return view.groupBy === field.id ? { ...view, groupBy: null } : null;
  if (action === "hide") return field.id === primaryFieldId || view.hiddenFieldIds.includes(field.id) ? null : { ...view, hiddenFieldIds: [...view.hiddenFieldIds, field.id] };
  if (action === "moveLeft" || action === "moveRight") {
    const visible = view.fieldOrder.filter(id => !view.hiddenFieldIds.includes(id));
    const index = visible.indexOf(field.id);
    const neighbor = visible[index + (action === "moveLeft" ? -1 : 1)];
    if (index < 0 || !neighbor) return null;
    const fieldOrder = [...view.fieldOrder];
    const from = fieldOrder.indexOf(field.id); const to = fieldOrder.indexOf(neighbor);
    [fieldOrder[from], fieldOrder[to]] = [fieldOrder[to], fieldOrder[from]];
    return { ...view, fieldOrder };
  }
  return null;
}
