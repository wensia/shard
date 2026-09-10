import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTableConfigDraft, tableFieldMenuViewChange } from "@/features/tables/table-field-actions";
import { parseTableFile, TABLE_LIMITS, validateView, type TableField } from "@/features/tables/model";

const fixture = () => parseTableFile(readFileSync(new URL("../../tests/fixtures/tables/valid/six-types.json", import.meta.url), "utf8"));

describe("table field shortcuts", () => {
  it("creates an isolated, selected field draft without changing the source metadata", () => {
    const metadata = fixture(); const before = structuredClone(metadata);
    const draft = createTableConfigDraft(metadata, metadata.viewOrder[0], undefined, "newField");
    expect(draft.fields).toHaveLength(metadata.fieldOrder.length + 1);
    expect(draft.fields[draft.fields.length - 1]).toMatchObject({ id: draft.selectedId, name: "新字段", type: "text" });
    draft.fields[0].name = "草稿";
    expect(metadata).toEqual(before);
  });

  it("opens delete confirmation only for an existing non-primary field and keeps all values", () => {
    const metadata = fixture(); const viewId = metadata.viewOrder[0];
    const id = metadata.fieldOrder[1];
    const draft = createTableConfigDraft(metadata, viewId, id, "deleteField");
    expect(draft.confirmDelete).toBe(id);
    expect(draft.fields.map(field => field.id)).toEqual(metadata.fieldOrder);
    expect(createTableConfigDraft(metadata, viewId, metadata.primaryFieldId, "deleteField").confirmDelete).toBe("");
    expect(createTableConfigDraft(metadata, viewId, "missing", "deleteField").confirmDelete).toBe("");
  });

  it("adds a valid filter draft only when the field has no existing condition", () => {
    const metadata = fixture(); const viewId = metadata.viewOrder[0]; const fieldId = metadata.fieldOrder[1];
    metadata.views[viewId].filters.conditions = [{ fieldId, operator: "gt", value: 10 }];
    const existing = createTableConfigDraft(metadata, viewId, fieldId, "filterField");
    expect(existing.view).toEqual(metadata.views[viewId]);
    const next = createTableConfigDraft(metadata, viewId, metadata.primaryFieldId, "filterField");
    expect(next.view.filters.conditions).toEqual([{ fieldId, operator: "gt", value: 10 }, { fieldId: metadata.primaryFieldId, operator: "isNotEmpty" }]);
    expect(metadata.views[viewId].filters.conditions).toHaveLength(1);
    expect(() => validateView(next.view, metadata)).not.toThrow();
  });

  it("respects field and filter limits while opening drafts", () => {
    const metadata = fixture(); const viewId = metadata.viewOrder[0];
    for (let index = metadata.fieldOrder.length; index < TABLE_LIMITS.fields; index++) {
      const id = `fld_${index.toString(16).padStart(32, "0")}`;
      metadata.fieldOrder.push(id); metadata.fields[id] = { id, name: "字段", type: "text" };
    }
    expect(createTableConfigDraft(metadata, viewId, undefined, "newField").fields).toHaveLength(TABLE_LIMITS.fields);
    expect(createTableConfigDraft(metadata, viewId, undefined, "newField").problem).toContain("上限");
    metadata.views[viewId].filters.conditions = Array.from({ length: TABLE_LIMITS.filters }, () => ({ fieldId: metadata.primaryFieldId, operator: "isNotEmpty" }));
    const draft = createTableConfigDraft(metadata, viewId, metadata.fieldOrder[1], "filterField");
    expect(draft.view.filters.conditions).toHaveLength(TABLE_LIMITS.filters);
    expect(draft.problem).toContain("上限");
  });

  it("promotes the chosen sort while retaining the other conditions and source view", () => {
    const metadata = fixture(); const view = metadata.views[metadata.viewOrder[0]];
    const field = metadata.fields[metadata.fieldOrder[1]];
    view.sorts = [{ fieldId: metadata.primaryFieldId, direction: "asc" }, { fieldId: field.id, direction: "asc" }];
    const before = structuredClone(view);
    const next = tableFieldMenuViewChange(view, field, metadata.primaryFieldId, "sortDesc")!;
    expect(next.sorts).toEqual([{ fieldId: field.id, direction: "desc" }, { fieldId: metadata.primaryFieldId, direction: "asc" }]);
    expect(view).toEqual(before);
    expect(next.filters).toEqual(view.filters);
    expect(() => validateView(next, metadata)).not.toThrow();
  });

  it("moves adjacent visible columns without reordering hidden columns or other views", () => {
    const metadata = fixture(); const view = metadata.views[metadata.viewOrder[0]];
    const [primary, hidden, third] = view.fieldOrder;
    view.hiddenFieldIds = [hidden];
    const before = structuredClone(view);
    const next = tableFieldMenuViewChange(view, metadata.fields[third], primary, "moveLeft")!;
    expect(next.fieldOrder.slice(0, 3)).toEqual([third, hidden, primary]);
    expect(next.hiddenFieldIds).toEqual([hidden]);
    expect(view).toEqual(before);
    expect(tableFieldMenuViewChange(view, metadata.fields[primary], primary, "moveLeft")).toBeNull();
    expect(tableFieldMenuViewChange(view, metadata.fields[hidden], primary, "moveRight")).toBeNull();
    expect(() => validateView(next, metadata)).not.toThrow();
  });

  it("cannot hide the primary field, group multi-select, or ungroup a different field", () => {
    const metadata = fixture(); const view = metadata.views[metadata.viewOrder[0]];
    const primary = metadata.fields[metadata.primaryFieldId];
    const multi = Object.values(metadata.fields).find(field => field.type === "multiSelect")!;
    const number = Object.values(metadata.fields).find(field => field.type === "number")!;
    expect(tableFieldMenuViewChange(view, primary, primary.id, "hide")).toBeNull();
    expect(tableFieldMenuViewChange(view, multi, primary.id, "group")).toBeNull();
    const grouped = tableFieldMenuViewChange(view, number, primary.id, "group")!;
    expect(grouped.groupBy).toBe(number.id);
    expect(tableFieldMenuViewChange(grouped, primary, primary.id, "ungroup")).toBeNull();
    expect(tableFieldMenuViewChange(grouped, number, primary.id, "ungroup")?.groupBy).toBeNull();
    expect(tableFieldMenuViewChange(view, { ...number, id: "missing" } as TableField, primary.id, "hide")).toBeNull();
  });
});
