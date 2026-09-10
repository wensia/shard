import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker } from "@/components/ui/date-picker";
import { SelectControl } from "@/components/ui/select";
import { createTableId, type FilterCondition, type OptionColor, type TableContent, type TableField, type TableView } from "./model";
import type { TableMutation } from "./mutations";
import { FIELD_TYPE_LABELS } from "./table-value-editor";
import { createTableConfigDraft, type TableConfigInitialAction } from "./table-field-actions";
import "./table-field-list.css";

export type { TableConfigInitialAction } from "./table-field-actions";

export type TablePanelHandle = { commit(): Promise<boolean>; isDirty(): boolean };
type Metadata = Omit<TableContent, "records">;
export type TableConfigMode = "fields" | "view" | "filters" | "sorts" | "group";
const PANEL_LABELS: Record<TableConfigMode, string> = { fields: "字段管理", view: "视图设置", filters: "筛选设置", sorts: "排序设置", group: "分组设置" };
type Props = { mode: TableConfigMode; initialFieldId?: string; initialAction?: TableConfigInitialAction; compactField?: boolean; metadata: Metadata; viewId: string; busy: boolean; onMutate(operations: TableMutation[]): Promise<boolean>; onClose(): void; onCancel?(): void; onDirtyChange(): void };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const COLORS: OptionColor[] = ["neutral", "red", "orange", "yellow", "green", "blue", "purple"];
const COLOR_LABELS = ["默认", "红", "橙", "黄", "绿", "蓝", "紫"];
function moved<T>(values: T[], index: number, distance: number): T[] {
  const target = index + distance;
  if (target < 0 || target >= values.length) return values;
  const next = [...values]; [next[index], next[target]] = [next[target], next[index]]; return next;
}
function MoveButtons({ index, count, label, onMove, disabled }: { index: number; count: number; label: string; onMove(delta: number): void; disabled: boolean }) {
  return <><Button size="sm" variant="outline" disabled={disabled || index === 0} aria-label={`${label}上移`} onClick={() => onMove(-1)}>上移</Button><Button size="sm" variant="outline" disabled={disabled || index === count - 1} aria-label={`${label}下移`} onClick={() => onMove(1)}>下移</Button></>;
}

export const TableConfigPanel = forwardRef<TablePanelHandle, Props>(function TableConfigPanel({ mode, initialFieldId, initialAction, compactField = false, metadata, viewId, busy, onMutate, onClose, onCancel, onDirtyChange }, ref) {
  const [initial] = useState(() => createTableConfigDraft(metadata, viewId, initialFieldId, initialAction));
  const [fields, setFields] = useState(initial.fields);
  const [view, setView] = useState(initial.view);
  const originalFields = useRef(metadata.fieldOrder.map(id => structuredClone(metadata.fields[id])));
  const originalView = useRef(structuredClone(metadata.views[viewId]));
  const [selectedId, setSelectedId] = useState(initial.selectedId);
  const [confirmDelete, setConfirmDelete] = useState(initial.confirmDelete);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState(initial.problem);
  const committing = useRef<Promise<boolean> | null>(null);
  const composing = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !initialAction) return;
    const target = initialAction === "filterField"
      ? Array.from(scroller.querySelectorAll<HTMLElement>("[data-table-filter-field]")).find(row => row.dataset.tableFilterField === initial.selectedId)?.querySelector<HTMLElement>("button")
      : scroller.querySelector<HTMLElement>(initialAction === "deleteField" ? ".table-confirm button" : "input");
    if (target) {
      scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      target.focus({ preventScroll: true });
    }
    onDirtyChange();
  }, [initial, initialAction]);
  const locked = busy || working;
  const dirty = () => mode === "fields" ? !equal(fields, originalFields.current) : !equal(view, originalView.current);
  const updateFields = (next: TableField[]) => { setFields(next); onDirtyChange(); };
  const updateView = (next: TableView) => { setView(next); onDirtyChange(); };
  function commit(): Promise<boolean> {
    if (composing.current) { setProblem("请先完成中文输入候选词，再应用设置。"); return Promise.resolve(false); }
    if (committing.current) return committing.current;
    if (!dirty()) return Promise.resolve(true);
    setWorking(true); setProblem("");
    const task = (async () => {
      const operations: TableMutation[] = [];
      if (mode !== "fields") operations.push({ type: "putView", view, beforeViewId: null });
      else {
        for (const old of originalFields.current) if (!fields.some(field => field.id === old.id)) operations.push({ type: "deleteField", fieldId: old.id });
        for (const field of fields) if (!equal(field, originalFields.current.find(old => old.id === field.id))) operations.push({ type: "putField", field, beforeFieldId: null });
        if (!equal(fields.map(field => field.id), originalFields.current.map(field => field.id))) operations.push({ type: "setFieldOrder", fieldIds: fields.map(field => field.id) });
      }
      if (!await onMutate(operations)) { setProblem("设置未应用，请检查工作区中的错误提示。已有记录仍被保留。"); return false; }
      originalFields.current = structuredClone(fields); originalView.current = structuredClone(view); onDirtyChange(); return true;
    })();
    committing.current = task.finally(() => { committing.current = null; setWorking(false); });
    return committing.current;
  }
  useImperativeHandle(ref, () => ({ commit, isDirty: dirty }));
  const selected = fields.find(field => field.id === selectedId);
  const compact = compactField && mode === "fields";
  const panelLabel = compact ? initialAction === "newField" ? "新增字段" : "编辑字段" : PANEL_LABELS[mode];
  function updateField(field: TableField) { updateFields(fields.map(current => current.id === field.id ? field : current)); }
  return <aside className={`table-config-panel${compact ? " table-field-editor-compact" : ""}`} aria-label={panelLabel} aria-busy={locked} onCompositionStartCapture={() => { composing.current = true; }} onCompositionEndCapture={() => { composing.current = false; }}>
    <header className="table-panel-header"><strong>{panelLabel}</strong>{!compact && <Button variant="outline" size="sm" disabled={locked} onClick={() => { void commit().then(ok => { if (ok) onClose(); }); }}>关闭</Button>}</header>
    <div ref={scrollRef} className="table-panel-scroll">
      {mode === "fields" ? <>
        {!compact && <><label className="table-form-field">字段<SelectControl value={selectedId} disabled={locked} onValueChange={setSelectedId} options={fields.map(field => ({ value: field.id, label: `${field.name}${field.id === metadata.primaryFieldId ? "（主字段）" : ""}` }))} /></label>
        <Button variant="outline" disabled={locked || fields.length >= 128} onClick={() => { const field: TableField = { id: createTableId("fld"), name: "新字段", type: "text" }; updateFields([...fields, field]); setSelectedId(field.id); }}>新增字段</Button></>}
        {selected && <div className="table-form-stack">
          <label className="table-form-field">名称<Input value={selected.name} disabled={locked} onChange={event => updateField({ ...selected, name: event.target.value })} /></label>
          <label className="table-form-field">类型<SelectControl value={selected.type} disabled={locked || selected.id === metadata.primaryFieldId} onValueChange={value => {
            const type = value as TableField["type"];
            updateField(type === "select" || type === "multiSelect" ? { id: selected.id, name: selected.name, type, options: "options" in selected ? selected.options : [] } : { id: selected.id, name: selected.name, type });
          }} options={Object.entries(FIELD_TYPE_LABELS).map(([value, label]) => ({ value, label }))} /></label>
          <p className="table-muted">字段有值时不能直接改类型。删除正在使用的选项前，请先修改相关记录和筛选条件。</p>
          {"options" in selected && <fieldset className="table-option-list"><legend>选项</legend>{selected.options.map((option, index) => <div className="table-option-row" key={option.id}>
            <Input aria-label={`选项 ${index + 1} 名称`} value={option.label} disabled={locked} onChange={event => updateField({ ...selected, options: selected.options.map(item => item.id === option.id ? { ...item, label: event.target.value } : item) })} />
            <SelectControl aria-label={`选项 ${index + 1} 颜色`} value={option.color} disabled={locked} onValueChange={color => updateField({ ...selected, options: selected.options.map(item => item.id === option.id ? { ...item, color: color as OptionColor } : item) })} options={COLORS.map((value, colorIndex) => ({ value, label: COLOR_LABELS[colorIndex] }))} />
            <div className="table-inline-actions"><MoveButtons index={index} count={selected.options.length} label={`选项 ${index + 1}`} disabled={locked} onMove={delta => updateField({ ...selected, options: moved(selected.options, index, delta) })} /><Button size="sm" variant="destructive" disabled={locked} onClick={() => updateField({ ...selected, options: selected.options.filter(item => item.id !== option.id) })}>移除</Button></div>
          </div>)}<Button variant="outline" size="sm" disabled={locked || selected.options.length >= 256} onClick={() => updateField({ ...selected, options: [...selected.options, { id: createTableId("opt"), label: "新选项", color: "neutral" }] })}>添加选项</Button></fieldset>}
          {!compact && <div className="table-inline-actions"><MoveButtons index={fields.findIndex(field => field.id === selected.id)} count={fields.length} label="字段" disabled={locked} onMove={delta => updateFields(moved(fields, fields.findIndex(field => field.id === selected.id), delta))} />
            {selected.id !== metadata.primaryFieldId && <Button variant="destructive" size="sm" disabled={locked} onClick={() => setConfirmDelete(selected.id)}>删除字段</Button>}</div>}
          {confirmDelete === selected.id && <div className="table-confirm" role="alert"><p>删除“{selected.name}”会移除整列的值和相关视图条件。应用后可撤销。</p><div className="table-inline-actions"><Button variant="outline" size="sm" disabled={locked} onClick={() => setConfirmDelete("")}>取消</Button><Button variant="destructive" size="sm" disabled={locked} onClick={() => { updateFields(fields.filter(field => field.id !== selected.id)); setSelectedId(metadata.primaryFieldId); setConfirmDelete(""); }}>确认删除此字段</Button></div></div>}
        </div>}
      </> : <>
        {mode === "view" && <label className="table-form-field">视图名称<Input value={view.name} disabled={locked} onChange={event => updateView({ ...view, name: event.target.value })} /></label>}
        {(mode === "view" || mode === "filters") && <fieldset className="table-form-stack"><legend>筛选</legend><label className="table-form-field">匹配方式<SelectControl value={view.filters.operator} disabled={locked} onValueChange={value => updateView({ ...view, filters: { ...view.filters, operator: value as "and" | "or" } })} options={[{ value: "and", label: "满足全部条件" }, { value: "or", label: "满足任一条件" }]} /></label>
          {view.filters.conditions.map((condition, index) => <FilterRow key={index} condition={condition} metadata={metadata} disabled={locked} onChange={next => updateView({ ...view, filters: { ...view.filters, conditions: view.filters.conditions.map((item, at) => at === index ? next : item) } })} onDelete={() => updateView({ ...view, filters: { ...view.filters, conditions: view.filters.conditions.filter((_, at) => at !== index) } })} />)}
          <Button variant="outline" size="sm" disabled={locked || view.filters.conditions.length >= 64} onClick={() => updateView({ ...view, filters: { ...view.filters, conditions: [...view.filters.conditions, { fieldId: metadata.primaryFieldId, operator: "isNotEmpty" }] } })}>添加条件</Button>
        </fieldset>}
        {(mode === "view" || mode === "sorts") && <fieldset className="table-form-stack"><legend>排序</legend>{view.sorts.map((sort, index) => <div className="table-form-row" key={sort.fieldId}>
          <SelectControl aria-label={`排序 ${index + 1} 字段`} disabled={locked} value={sort.fieldId} onValueChange={fieldId => updateView({ ...view, sorts: view.sorts.map((item, at) => at === index ? { ...item, fieldId } : item) })} options={metadata.fieldOrder.map(value => ({ value, label: metadata.fields[value].name, disabled: value !== sort.fieldId && view.sorts.some(item => item.fieldId === value) }))} />
          <SelectControl aria-label={`排序 ${index + 1} 方向`} disabled={locked} value={sort.direction} onValueChange={direction => updateView({ ...view, sorts: view.sorts.map((item, at) => at === index ? { ...item, direction: direction as "asc" | "desc" } : item) })} options={[{ value: "asc", label: "升序" }, { value: "desc", label: "降序" }]} />
          <Button variant="outline" size="sm" disabled={locked} onClick={() => updateView({ ...view, sorts: view.sorts.filter((_, at) => at !== index) })}>移除</Button>
        </div>)}<Button variant="outline" size="sm" disabled={locked || view.sorts.length >= Math.min(16, metadata.fieldOrder.length)} onClick={() => { const fieldId = metadata.fieldOrder.find(id => !view.sorts.some(sort => sort.fieldId === id)); if (fieldId) updateView({ ...view, sorts: [...view.sorts, { fieldId, direction: "asc" }] }); }}>添加排序</Button></fieldset>}
        {(mode === "view" || mode === "group") && <label className="table-form-field">分组<SelectControl value={view.groupBy ?? ""} disabled={locked} onValueChange={value => updateView({ ...view, groupBy: value || null })} options={[{ value: "", label: "不分组" }, ...metadata.fieldOrder.filter(id => metadata.fields[id].type !== "multiSelect").map(value => ({ value, label: metadata.fields[value].name }))]} /></label>}
        {mode === "view" && <fieldset className="table-form-stack"><legend>列显示与顺序</legend>{view.fieldOrder.map((id, index) => <div key={id} className="table-column-setting">
          <label><Checkbox checked={!view.hiddenFieldIds.includes(id)} disabled={locked || id === metadata.primaryFieldId} onCheckedChange={checked => updateView({ ...view, hiddenFieldIds: checked ? view.hiddenFieldIds.filter(fieldId => fieldId !== id) : [...view.hiddenFieldIds, id] })} />{metadata.fields[id].name}</label>
          <label className="table-width-setting">宽度<Input type="number" min={64} max={1200} placeholder="自动" value={view.columnWidths[id] ?? ""} disabled={locked} onChange={event => { const columnWidths = { ...view.columnWidths }; if (!event.target.value) delete columnWidths[id]; else columnWidths[id] = Number(event.target.value); updateView({ ...view, columnWidths }); }} /></label>
          <div className="table-inline-actions"><MoveButtons index={index} count={view.fieldOrder.length} label={metadata.fields[id].name} disabled={locked} onMove={delta => updateView({ ...view, fieldOrder: moved(view.fieldOrder, index, delta) })} /></div>
        </div>)}</fieldset>}
      </>}
      {problem && <p role="alert" className="table-error-text">{problem}</p>}
    </div>
    <footer className="table-panel-footer">{compact && <Button variant="outline" disabled={locked} onClick={() => { (onCancel ?? onClose)(); }}>取消</Button>}<Button disabled={locked} onClick={() => { void commit().then(ok => { if (ok && compact) onClose(); }); }}>{working ? "应用中…" : compact ? "确定" : "应用设置"}</Button></footer>
  </aside>;
});

const OPERATOR_LABELS: Record<FilterCondition["operator"], string> = { isEmpty: "为空", isNotEmpty: "不为空", eq: "等于", ne: "不等于", contains: "包含", notContains: "不包含", startsWith: "开头是", endsWith: "结尾是", gt: "大于", gte: "大于等于", lt: "小于", lte: "小于等于", between: "介于", in: "属于任一", notIn: "不属于", hasAny: "包含任一", hasAll: "包含全部", hasNone: "不包含任一" };
function operators(field: TableField): FilterCondition["operator"][] {
  const common: FilterCondition["operator"][] = ["isEmpty", "isNotEmpty"];
  return [...common, ...(field.type === "text" ? ["eq", "ne", "contains", "notContains", "startsWith", "endsWith"] : field.type === "number" || field.type === "date" ? ["eq", "ne", "gt", "gte", "lt", "lte", "between"] : field.type === "select" ? ["eq", "ne", "in", "notIn"] : field.type === "multiSelect" ? ["hasAny", "hasAll", "hasNone"] : ["eq", "ne"]) as FilterCondition["operator"][]];
}
function newCondition(field: TableField, operator: FilterCondition["operator"]): FilterCondition {
  if (operator === "isEmpty" || operator === "isNotEmpty") return { fieldId: field.id, operator };
  if (["in", "notIn", "hasAny", "hasAll", "hasNone"].includes(operator)) return { fieldId: field.id, operator, optionIds: [] } as FilterCondition;
  const value = field.type === "number" ? 0 : field.type === "date" ? new Date().toISOString().slice(0, 10) : field.type === "checkbox" ? true : "options" in field ? field.options[0]?.id ?? "" : "";
  return operator === "between" ? { fieldId: field.id, operator, lower: value as string | number, upper: value as string | number } : { fieldId: field.id, operator, value } as FilterCondition;
}
function FilterRow({ condition, metadata, disabled, onChange, onDelete }: { condition: FilterCondition; metadata: Metadata; disabled: boolean; onChange(value: FilterCondition): void; onDelete(): void }) {
  const field = metadata.fields[condition.fieldId];
  const scalarInput = (value: string | number | boolean, update: (value: string | number | boolean) => void) => {
    if (field.type === "select" || field.type === "checkbox") return <SelectControl aria-label="筛选值" disabled={disabled} value={String(value)} onValueChange={next => update(field.type === "checkbox" ? next === "true" : next)} options={field.type === "checkbox" ? [{ value: "true", label: "是" }, { value: "false", label: "否" }] : [{ value: "", label: "选择选项", disabled: true }, ...("options" in field ? field.options : []).map(option => ({ value: option.id, label: option.label }))]} />;
    if (field.type === "date") return <DatePicker aria-label="筛选值" disabled={disabled} value={String(value)} onValueChange={update} />;
    return <Input aria-label="筛选值" disabled={disabled} type={field.type === "number" ? "number" : "text"} value={String(value)} onChange={event => update(field.type === "number" ? Number(event.target.value) : event.target.value)} />;
  };
  return <div className="table-filter-condition" data-table-filter-field={field.id}><div className="table-form-row"><SelectControl aria-label="筛选字段" value={field.id} disabled={disabled} onValueChange={value => onChange(newCondition(metadata.fields[value], "isNotEmpty"))} options={metadata.fieldOrder.map(value => ({ value, label: metadata.fields[value].name }))} />
    <SelectControl aria-label="筛选关系" value={condition.operator} disabled={disabled} onValueChange={value => onChange(newCondition(field, value as FilterCondition["operator"]))} options={operators(field).map(value => ({ value, label: OPERATOR_LABELS[value] }))} />
    <Button variant="outline" size="sm" disabled={disabled} onClick={onDelete}>移除</Button></div>
    {"value" in condition && scalarInput(condition.value, value => onChange({ ...condition, value } as FilterCondition))}
    {"lower" in condition && <div className="table-form-row">{scalarInput(condition.lower, lower => onChange({ ...condition, lower } as FilterCondition))}<span>至</span>{scalarInput(condition.upper, upper => onChange({ ...condition, upper } as FilterCondition))}</div>}
    {"optionIds" in condition && "options" in field && <div className="table-option-checks">{field.options.map(option => <label key={option.id}><Checkbox disabled={disabled} checked={condition.optionIds.includes(option.id)} onCheckedChange={checked => onChange({ ...condition, optionIds: checked ? [...condition.optionIds, option.id] : condition.optionIds.filter(id => id !== option.id) })} />{option.label}</label>)}</div>}
  </div>;
}
